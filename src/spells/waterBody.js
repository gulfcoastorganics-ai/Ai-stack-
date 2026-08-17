/**
 * The bent-water renderer — one mesh, one material, one draw, eight strands.
 *
 * Four of the five spells move a coherent body of water, and they are all the
 * same object: a swept surface along a spine, with a radius, a transported frame
 * and a foam channel. Giving each spell its own mesh would mean four pipelines,
 * four warm-ups, four sets of shadow-and-fog uniforms, and four slightly
 * different ideas about what lit water looks like. There is one of each here.
 *
 * A strand is claimed with `acquire()`, written per frame with `column()`, and
 * dropped with `release()`. Releasing zeroes the strand's rows, which is also how
 * it is switched off: a zero radius puts every vertex of that strand on one
 * point, so its triangles have no area and the rasteriser skips them. The draw
 * call and the vertex count therefore do not depend on how many spells are up.
 *
 * The frame is parallel-transported along the spine on the CPU rather than
 * rebuilt from a fixed up-vector. A ribbon drawn through the air passes through
 * vertical, and a Frenet or up-referenced frame flips there — the section spins
 * 180 degrees in one sample and the ribbon visibly folds. Transport has no such
 * degeneracy: each frame is the previous one rotated by the minimum rotation
 * taking the old tangent to the new one.
 *
 * Allocation per frame: none.
 */

import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Constants } from "@babylonjs/core/Engines/constants";
import { Vector3, Vector4 } from "@babylonjs/core/Maths/math";

import { S } from "../core/settings.js";
import { whenReady, bindMatrixArray } from "../core/gpuUtil.js";
import { CASCADE_COUNT } from "../render/shadows.js";
import { SPELL_LIGHT_UNIFORMS } from "./spellLights.js";

/** Must match `array<vec4f, 8>` in `water.vertex.wgsl`. */
export const STRAND_MAX = 8;

/**
 * Spine *samples* per strand — the width of the data texture, and the most
 * columns any spell may write.
 *
 * Raised from 48 for the Vortex, whose helices are the tightest curve anything
 * here draws. A cubic through samples on a circular arc carries a radial error
 * that is zero at every knot and peaks in the middle of each span — which is
 * exactly a scallop per sample, and on a 12 cm tube wound round a 2.5 m helix at
 * thirty samples a turn it was a tenth of the radius. The helices came out
 * looking like vertebrae. The error falls with the square of the sample spacing,
 * so going to sixty-four samples takes it under a percent.
 */
export const STRAND_COLS = 64;

/**
 * Spine *vertices* per strand — the width of the lattice.
 *
 * Decoupled from the sample count, and it has to be. The surface is a spline
 * through the samples, so it has real curvature between them; drawing it at
 * barely more than one vertex per sample renders that curvature as a polygon and
 * the body comes out visibly segmented — the thing that makes a swept tube look
 * like a length of pipe rather than like moving water. Nearly three vertices per
 * sample is where the segmentation stops being findable.
 *
 * It is also the sampling rate the relief field has to stay under; see the note
 * on `waterRelief`.
 */
const LATTICE_COLS = 176;

/**
 * Vertices around the section.
 *
 * The last one coincides with the first — a tube is closed, so ring 17 sits at
 * theta = 2*PI which is theta = 0. Duplicating the seam vertex rather than
 * wrapping the index is what lets the same lattice serve the open sheet profile,
 * where ring 17 is genuinely the far edge and not the near one.
 *
 * Twenty-four rather than twelve. A twelve-sided tube seen at two metres has a
 * readable dodecagonal silhouette, and once you have noticed it you cannot stop:
 * it is the single clearest tell that the water is a mesh. It also caps how much
 * detail the relief field is allowed to put *around* the section — and detail
 * around the section, rather than along it, is exactly what stops a tube reading
 * as a string of beads.
 */
const RING = 24;

export const PROFILE_TUBE = 0;
export const PROFILE_SHEET = 1;

const _splits = new Vector4();

export class WaterBody {
    /**
     * @param {import("@babylonjs/core/scene").Scene} scene
     * @param {import("../render/sky.js").Sky} sky
     * @param {import("../render/shadows.js").ShadowSystem} shadows
     * @param {import("./spellLights.js").SpellLights} lights
     */
    constructor(scene, sky, shadows, lights) {
        this.scene = scene;
        this.sky = sky;
        this.shadows = shadows;
        this.lights = lights;

        // Three rows per strand: (pos, radius) / (right, twist) / (dist, age, foam, flatten)
        this._texData = new Float32Array(STRAND_COLS * STRAND_MAX * 3 * 4);
        this.dataTex = RawTexture.CreateRGBATexture(
            this._texData, STRAND_COLS, STRAND_MAX * 3, scene,
            false, false,
            Constants.TEXTURE_NEAREST_SAMPLINGMODE,
            Constants.TEXTURETYPE_FLOAT
        );
        this.dataTex.wrapU = Constants.TEXTURE_CLAMP_ADDRESSMODE;
        this.dataTex.wrapV = Constants.TEXTURE_CLAMP_ADDRESSMODE;

        /** (profile, milkiness, alpha, column count) per strand. */
        this._params = new Float32Array(STRAND_MAX * 4);
        /** @type {boolean[]} */
        this._used = new Array(STRAND_MAX).fill(false);

        this.mesh = buildLattice(scene);
        this.material = this._makeMaterial();
        this.mesh.material = this.material;
        // With the spray, after the opaque pass. Water first: mist hanging in
        // front of a body of water is much commoner than the reverse, and
        // neither writes depth.
        this.mesh.renderingGroupId = 2;
        this.mesh.alphaIndex = 0;
        this.mesh.isVisible = false;

        this._camPos = new Vector3();
        this._t = 0;
        this._live = 0;
    }

    _makeMaterial() {
        const mat = new ShaderMaterial(
            "spellWater", this.scene, { vertex: "water", fragment: "water" },
            {
                attributes: ["position"],
                uniforms: [
                    "viewProjection", "cameraPos",
                    "waterCols", "waterRings", "waterTime", "strandParams",
                    "sunDir", "sunRadiance", "shR",
                    "cascadeMatrices", "cascadeSplits", "cascadeParams",
                    "shadowTexel", "shadowSoftness", "shadowBias",
                    "fogDensity", "fogHeightFalloff", "fogStart", "aerialStrength",
                    "ambientIntensity", "sssStrength",
                    "glintIntensity", "glintGrazing", "waterDepthTint",
                    ...SPELL_LIGHT_UNIFORMS,
                ],
                samplers: ["waterTex", "skyLUT", "cascade0", "cascade1", "cascade2"],
                shaderLanguage: ShaderLanguage.WGSL,
                needAlphaBlending: true,
            }
        );
        // A transparent body seen from both sides — looking through the near wall
        // at the far one is most of what makes it read as a volume.
        mat.backFaceCulling = false;
        mat.disableDepthWrite = true;
        mat.alphaMode = Constants.ALPHA_COMBINE;
        mat.needAlphaBlending = () => true;
        mat.setTexture("waterTex", this.dataTex);
        mat.setTexture("skyLUT", this.sky.lut);
        for (let i = 0; i < CASCADE_COUNT; i++) {
            mat.setTexture("cascade" + i, this.shadows.maps[i]);
        }
        mat.setFloat("waterCols", LATTICE_COLS);
        mat.setFloat("waterRings", RING);
        return mat;
    }

    // ------------------------------------------------------------ strand pool

    /** @returns {number} strand index, or -1 when the pool is exhausted. */
    acquire() {
        for (let i = 0; i < STRAND_MAX; i++) {
            if (!this._used[i]) {
                this._used[i] = true;
                this.clear(i);
                return i;
            }
        }
        return -1;
    }

    /** @param {number} s */
    release(s) {
        if (s < 0 || s >= STRAND_MAX) return;
        this._used[s] = false;
        this.clear(s);
    }

    /** Zero a strand's rows and parameters. */
    clear(s) {
        const d = this._texData;
        const base = s * 3 * STRAND_COLS * 4;
        d.fill(0, base, base + STRAND_COLS * 3 * 4);
        const p = s * 4;
        this._params[p] = 0;
        this._params[p + 1] = 0;
        this._params[p + 2] = 0;
        this._params[p + 3] = 0;
    }

    /**
     * Per-strand constants for this frame.
     * @param {number} s
     * @param {number} profile PROFILE_TUBE or PROFILE_SHEET
     * @param {number} milkiness 0 clear water, 1 opaque slush
     * @param {number} alpha global fade, 0 hides the strand
     * @param {number} count live columns, 2..STRAND_COLS
     */
    setParams(s, profile, milkiness, alpha, count) {
        const p = s * 4;
        this._params[p] = profile;
        this._params[p + 1] = milkiness;
        this._params[p + 2] = alpha;
        this._params[p + 3] = count < 2 ? 0 : Math.min(count, STRAND_COLS);
    }

    /**
     * Write one spine sample.
     *
     * `rx/ry/rz` is the reference right vector; it does not have to be exactly
     * perpendicular to the tangent, since the shader re-orthogonalises. It does
     * have to be *transported* — see the note at the top of the file.
     *
     * @param {number} s strand
     * @param {number} c column, 0 = head
     * @param {number} x @param {number} y @param {number} z world position
     * @param {number} radius metres. Must taper to ~0 at both ends.
     * @param {number} rx @param {number} ry @param {number} rz reference right
     * @param {number} twist section roll (tube) or curl (sheet)
     * @param {number} dist metres along the spine, drives the relief field
     * @param {number} age 0..1
     * @param {number} foam 0..1
     * @param {number} flatten vertical squash of the section, 1 = round
     */
    column(s, c, x, y, z, radius, rx, ry, rz, twist, dist, age, foam, flatten) {
        if (c < 0 || c >= STRAND_COLS) return;
        const d = this._texData;
        const row = s * 3;
        const w = STRAND_COLS * 4;
        let o = row * w + c * 4;
        d[o] = x; d[o + 1] = y; d[o + 2] = z; d[o + 3] = radius;
        o += w;
        d[o] = rx; d[o + 1] = ry; d[o + 2] = rz; d[o + 3] = twist;
        o += w;
        d[o] = dist; d[o + 1] = age; d[o + 2] = foam; d[o + 3] = flatten;
    }

    // ---------------------------------------------------------------- frame

    /**
     * Upload and push uniforms. Called after every spell has written its strands.
     * @param {number} dt
     * @param {Vector3} cameraPos
     */
    update(dt, cameraPos) {
        this._t += dt;
        this._camPos.copyFrom(cameraPos);

        let live = 0;
        for (let i = 0; i < STRAND_MAX; i++) {
            if (this._params[i * 4 + 2] > 0.003 && this._params[i * 4 + 3] >= 2) live++;
        }
        this._live = live;

        this.mesh.isVisible = live > 0 && S.showSpells !== false;
        if (!this.mesh.isVisible) return;

        this.dataTex.update(this._texData);
        this._pushUniforms();
    }

    _pushUniforms() {
        const m = this.material;
        const sky = this.sky;
        const sh = this.shadows;

        m.setVector3("cameraPos", this._camPos);
        m.setFloat("waterTime", this._t);
        m.setArray4("strandParams", this._params);

        m.setVector3("sunDir", sky.sunDir);
        m.setColor3("sunRadiance", sky.sunRadiance);
        m.setArray4("shR", sky.sh);

        bindMatrixArray(m, "cascadeMatrices", sh.matrixData);
        _splits.set(sh.splits[0], sh.splits[1], sh.splits[2], sh.splits[3]);
        m.setVector4("cascadeSplits", _splits);
        m.setArray4("cascadeParams", sh.paramData);
        m.setFloat("shadowTexel", sh.texelSize);
        m.setFloat("shadowSoftness", 1.4);
        m.setFloat("shadowBias", 0.03);

        m.setFloat("fogDensity", S.fogDensity);
        m.setFloat("fogHeightFalloff", S.fogHeightFalloff);
        m.setFloat("fogStart", S.fogStart);
        m.setFloat("aerialStrength", S.aerialStrength);
        m.setFloat("ambientIntensity", S.ambientIntensity);
        m.setFloat("sssStrength", S.sssStrength);
        m.setFloat("glintIntensity", S.glintIntensity);
        m.setFloat("glintGrazing", S.glintGrazing);
        m.setFloat("waterDepthTint", S.waterDepthTint);

        this.lights.apply(m);
    }

    /** Live strand count, for the overlay. */
    get liveStrands() {
        return this._live;
    }

    get triangles() {
        return this.mesh.isVisible ? (this._live / STRAND_MAX) * this.mesh.metadata.triangles : 0;
    }

    /**
     * Compile behind the loading screen.
     *
     * Two synthetic strands are laid and **left standing**, so the warm-up frames
     * in `main` actually rasterise water. `finishWarmUp` takes them down
     * afterwards.
     *
     * Leaving them up is the whole point. `isReady()` compiles the shader
     * *modules*; it does not create the WebGPU *render pipeline*, which is keyed
     * on the blend state, the depth state, the cull mode and the target formats
     * and is only built when the mesh is actually drawn. Hide the mesh here and
     * the warm-up frames draw nothing, so the pipeline is built on the first
     * frame of the first cast instead — a ~250 ms freeze behind a warm-up that
     * looks complete.
     */
    async warmUp(x, y, z) {
        for (let c = 0; c < 24; c++) {
            const t = c / 23;
            this.column(
                0, c, x + t * 3, y + 1.2 + Math.sin(t * 3) * 0.5, z,
                0.22 * Math.sin(t * Math.PI),
                0, 0, 1, 0, t * 3, t, t < 0.2 ? 1 : 0, 1
            );
        }
        this.setParams(0, PROFILE_TUBE, 0.2, 1, 24);
        // And a sheet, because the two profiles are different code paths through
        // the same vertex shader and only one of them being exercised is exactly
        // how a warm-up quietly stops covering half of what it claims to.
        for (let c = 0; c < 24; c++) {
            const t = c / 23;
            this.column(
                1, c, x + t * 4 - 2, y, z + 2,
                0.5 * Math.sin(t * Math.PI),
                0, 0, 1, 0.6, t * 4, t, 0.4, 1
            );
        }
        this.setParams(1, PROFILE_SHEET, 0.6, 1, 24);

        this.dataTex.update(this._texData);
        this.mesh.isVisible = true;
        this._pushUniforms();
        await whenReady(this.material, "water material", [this.mesh, false]);
    }

    /** Take the synthetic strands down, after the warm-up frames have drawn. */
    finishWarmUp() {
        this.clear(0);
        this.clear(1);
        this.dataTex.update(this._texData);
        this.mesh.isVisible = false;
    }

    dispose() {
        this.mesh.dispose();
        this.material.dispose();
        this.dataTex.dispose();
    }
}

/**
 * The static lattice: (column, ring, strand), no geometry at all.
 *
 * Strands are separate index ranges in one buffer rather than separate meshes,
 * so the whole system is a single draw however many spells are up.
 */
function buildLattice(scene) {
    const perStrand = LATTICE_COLS * RING;
    const pos = new Float32Array(perStrand * STRAND_MAX * 3);
    const idx = new Uint32Array((LATTICE_COLS - 1) * (RING - 1) * 6 * STRAND_MAX);

    let vi = 0;
    let ii = 0;
    for (let s = 0; s < STRAND_MAX; s++) {
        const base = s * perStrand;
        for (let c = 0; c < LATTICE_COLS; c++) {
            for (let r = 0; r < RING; r++) {
                pos[vi++] = c;
                pos[vi++] = r;
                pos[vi++] = s;
            }
        }
        for (let c = 0; c < LATTICE_COLS - 1; c++) {
            for (let r = 0; r < RING - 1; r++) {
                const a = base + c * RING + r;
                const b = a + RING;
                idx[ii++] = a; idx[ii++] = b; idx[ii++] = b + 1;
                idx[ii++] = a; idx[ii++] = b + 1; idx[ii++] = a + 1;
            }
        }
    }

    const mesh = new Mesh("spellWater", scene);
    const vd = new VertexData();
    vd.positions = pos;
    vd.indices = idx;
    vd.applyToMesh(mesh, false);
    mesh.alwaysSelectAsActiveMesh = true;
    mesh.isPickable = false;
    mesh.freezeWorldMatrix();
    mesh.doNotSyncBoundingInfo = true;
    mesh.metadata = { triangles: idx.length / 3, vertices: perStrand * STRAND_MAX };
    return mesh;
}
