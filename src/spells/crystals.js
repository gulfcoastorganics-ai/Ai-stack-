/**
 * The ice formations Crystallise grows.
 *
 * A fixed pool of prisms in one data-driven mesh: one draw, one 3 x 96 upload,
 * and no geometry generated at any point. A crystal that is not alive has zero
 * height, which collapses every one of its triangles onto its base point.
 *
 * Lifetime is deliberately long. This spell alters the surface semi-permanently
 * through the ice channel of the terrain state buffer, which decays on a
 * fifteen-minute constant, so a patch of glazed snow is still there long after
 * the geometry has gone. The prisms themselves sublimate over
 * about forty seconds, which is long enough that the player can walk around a
 * formation and look at it, and short enough that a session does not silently
 * fill up with ice.
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

/** Pool size. Two full formations' worth. */
export const CRYSTAL_MAX = 96;

/** Vertices per crystal: two rings of six, plus an apex. Matches the include. */
const VERTS = 13;
const RING = 6;

/** How many cascades a 40 cm prism is worth drawing into. */
const CRYSTAL_CASCADES = 2;

const _splits = new Vector4();

export class CrystalField {
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

        // Rows: (x,y,z,height) / (axis,radius) / (growth, seed, tint, -)
        this._texData = new Float32Array(CRYSTAL_MAX * 3 * 4);
        this.dataTex = RawTexture.CreateRGBATexture(
            this._texData, CRYSTAL_MAX, 3, scene,
            false, false,
            Constants.TEXTURE_NEAREST_SAMPLINGMODE,
            Constants.TEXTURETYPE_FLOAT
        );
        this.dataTex.wrapU = Constants.TEXTURE_CLAMP_ADDRESSMODE;
        this.dataTex.wrapV = Constants.TEXTURE_CLAMP_ADDRESSMODE;

        // CPU-side lifetime. Kept out of the texture because none of it is read
        // by a shader and packing it there would mean re-uploading to age.
        this.age = new Float32Array(CRYSTAL_MAX);
        this.life = new Float32Array(CRYSTAL_MAX);
        /** Seconds the crystal spends growing from nothing to full size. */
        this.grow = new Float32Array(CRYSTAL_MAX);
        this.alive = new Uint8Array(CRYSTAL_MAX);
        this._next = 0;
        this.liveCount = 0;

        this.mesh = buildMesh(scene);
        this.material = this._makeMaterial();
        this.mesh.material = this.material;
        // Opaque, with the terrain. See the note at the top of the fragment
        // shader: the refracted lookup already carries what is behind the ice, so
        // blending buys nothing and costs correct depth.
        this.mesh.renderingGroupId = 1;
        this.mesh.isVisible = false;

        /** @type {ShaderMaterial[]} */
        this._depthMats = [];
        shadows.registerCaster(
            this.mesh, (c) => this._makeDepthMaterial(c), CRYSTAL_CASCADES
        );

        this._camPos = new Vector3();
        this._dirty = true;
    }

    _makeMaterial() {
        const mat = new ShaderMaterial(
            "iceCrystal", this.scene, { vertex: "crystal", fragment: "crystal" },
            {
                attributes: ["position"],
                uniforms: [
                    "viewProjection", "cameraPos",
                    "sunDir", "sunRadiance", "shR",
                    "cascadeMatrices", "cascadeSplits", "cascadeParams",
                    "shadowTexel", "shadowSoftness", "shadowBias",
                    "fogDensity", "fogHeightFalloff", "fogStart", "aerialStrength",
                    "ambientIntensity", "sssStrength",
                    "glintIntensity", "glintGrazing",
                    ...SPELL_LIGHT_UNIFORMS,
                ],
                samplers: ["crystalTex", "skyLUT", "cascade0", "cascade1", "cascade2"],
                shaderLanguage: ShaderLanguage.WGSL,
                needAlphaBlending: true,
            }
        );
        // A prism is a closed solid, but a dead crystal's triangles are
        // degenerate and a growing one is very thin — culling buys nothing here
        // and costs a black inside face wherever the winding flips.
        mat.backFaceCulling = false;
        // Blended *and* depth-writing. See the note at the top of
        // `crystal.fragment.wgsl`: this is what gives transparency against the
        // snow without letting forty prisms blend over each other.
        mat.alphaMode = Constants.ALPHA_COMBINE;
        mat.needAlphaBlending = () => true;
        mat.disableDepthWrite = false;
        mat.forceDepthWrite = true;
        mat.setTexture("crystalTex", this.dataTex);
        mat.setTexture("skyLUT", this.sky.lut);
        for (let i = 0; i < CASCADE_COUNT; i++) {
            mat.setTexture("cascade" + i, this.shadows.maps[i]);
        }
        return mat;
    }

    _makeDepthMaterial(cascade) {
        const mat = new ShaderMaterial(
            "crystalDepth" + cascade, this.scene,
            { vertex: "crystalDepth", fragment: "terrainDepth" },
            {
                attributes: ["position"],
                uniforms: ["lightViewProjection"],
                samplers: ["crystalTex"],
                shaderLanguage: ShaderLanguage.WGSL,
                defines: ["CRYSTAL_CASCADE " + cascade],
            }
        );
        mat.backFaceCulling = false;
        mat.setTexture("crystalTex", this.dataTex);
        this._depthMats.push(mat);
        return mat;
    }

    /**
     * The camera-space depth prepass material.
     *
     * This is the one caster that writes a non-zero specular mask, and the only
     * reason the mask channel exists: ice is the sole mirror in a field of matte
     * snow, so the reflection pass can early-out on it and cost nothing on every
     * frame where nobody has cast Crystallise.
     *
     * @param {import("../render/depthPass.js").DepthPass} depth
     */
    registerPrepass(depth) {
        const mat = new ShaderMaterial(
            "crystalPrepass", this.scene,
            { vertex: "crystalPrepass", fragment: "prepass" },
            {
                attributes: ["position"],
                uniforms: ["viewProjection"],
                samplers: ["crystalTex"],
                shaderLanguage: ShaderLanguage.WGSL,
            }
        );
        mat.backFaceCulling = false;
        mat.setTexture("crystalTex", this.dataTex);
        this.prepassMat = mat;
        depth.registerCaster(this.mesh, mat);
    }

    /**
     * Plant one crystal.
     *
     * @param {number} x @param {number} y @param {number} z base, world
     * @param {number} ax @param {number} ay @param {number} az growth axis
     * @param {number} height metres at full growth
     * @param {number} radius metres at full growth
     * @param {number} growSeconds time from nothing to full size
     * @param {number} life seconds before it starts sublimating
     */
    plant(x, y, z, ax, ay, az, height, radius, growSeconds, life) {
        let i = this._next;
        for (let n = 0; n < CRYSTAL_MAX; n++) {
            if (!this.alive[i]) break;
            i = (i + 1) % CRYSTAL_MAX;
            // Pool full: the oldest formation is the one to sacrifice, but
            // hunting for it costs more than it is worth at this count. Dropping
            // the new crystal loses one prism out of a cluster of forty, which
            // nobody can see.
            if (n === CRYSTAL_MAX - 1) return;
        }
        this._next = (i + 1) % CRYSTAL_MAX;

        const d = this._texData;
        const w = CRYSTAL_MAX * 4;
        let o = i * 4;
        d[o] = x; d[o + 1] = y; d[o + 2] = z; d[o + 3] = height;
        o += w;
        d[o] = ax; d[o + 1] = ay; d[o + 2] = az; d[o + 3] = radius;
        o += w;
        d[o] = 0; d[o + 1] = (i * 0.618034 + x * 0.137 + z * 0.311) % 1;
        d[o + 2] = 0; d[o + 3] = 0;

        this.age[i] = 0;
        this.life[i] = life;
        this.grow[i] = Math.max(growSeconds, 0.05);
        this.alive[i] = 1;
        this._dirty = true;
    }

    /**
     * Age the field and upload.
     * @param {number} dt
     * @param {Vector3} cameraPos
     */
    update(dt, cameraPos) {
        this._camPos.copyFrom(cameraPos);

        const d = this._texData;
        const w = CRYSTAL_MAX * 4;
        const growRow = w * 2;
        let live = 0;

        for (let i = 0; i < CRYSTAL_MAX; i++) {
            if (!this.alive[i]) continue;
            this.age[i] += dt;
            const a = this.age[i];
            const life = this.life[i];

            let g;
            if (a < this.grow[i]) {
                g = a / this.grow[i];
            } else if (a < life) {
                g = 1;
            } else {
                // Sublimation: the prism retreats rather than fading, so it goes
                // back into the drift it came out of. Nothing here pops.
                const t = (a - life) / 6.0;
                if (t >= 1) {
                    this.alive[i] = 0;
                    d[growRow + i * 4] = 0;
                    this._dirty = true;
                    continue;
                }
                g = 1 - t;
            }

            d[growRow + i * 4] = g;
            live++;
        }

        this.liveCount = live;
        this.mesh.isVisible = live > 0 && S.showSpells !== false;

        if (this.mesh.isVisible || this._dirty) {
            this.dataTex.update(d);
            this._dirty = false;
        }
        if (this.mesh.isVisible) this._pushUniforms();
    }

    _pushUniforms() {
        const m = this.material;
        const sky = this.sky;
        const sh = this.shadows;

        m.setVector3("cameraPos", this._camPos);
        m.setVector3("sunDir", sky.sunDir);
        m.setColor3("sunRadiance", sky.sunRadiance);
        m.setArray4("shR", sky.sh);

        bindMatrixArray(m, "cascadeMatrices", sh.matrixData);
        _splits.set(sh.splits[0], sh.splits[1], sh.splits[2], sh.splits[3]);
        m.setVector4("cascadeSplits", _splits);
        m.setArray4("cascadeParams", sh.paramData);
        m.setFloat("shadowTexel", sh.texelSize);
        m.setFloat("shadowSoftness", 1.3);
        m.setFloat("shadowBias", 0.012);

        m.setFloat("fogDensity", S.fogDensity);
        m.setFloat("fogHeightFalloff", S.fogHeightFalloff);
        m.setFloat("fogStart", S.fogStart);
        m.setFloat("aerialStrength", S.aerialStrength);
        m.setFloat("ambientIntensity", S.ambientIntensity);
        m.setFloat("sssStrength", S.sssStrength);
        m.setFloat("glintIntensity", S.glintIntensity);
        m.setFloat("glintGrazing", S.glintGrazing);

        this.lights.apply(m);
    }

    get triangles() {
        return this.mesh.isVisible ? this.liveCount * (RING * 3) : 0;
    }

    /**
     * Compile both pipelines behind the loading screen.
     *
     * The crystal is planted and **left standing** through the warm-up frames.
     * See the same note on `WaterBody.warmUp`: `isReady()` builds the shader
     * module, but the WebGPU render pipeline — blend state, depth state, target
     * formats — is only built when a triangle actually goes through it. Hiding
     * the mesh here moved that cost onto the first cast, where it measured
     * 156 ms.
     */
    async warmUp(x, y, z) {
        this.plant(x, y + 0.02, z, 0.1, 1, 0.05, 0.6, 0.09, 0.2, 999);
        this.update(0.21, this._camPos);
        this.mesh.isVisible = true;
        this._pushUniforms();

        await whenReady(this.material, "crystal material", [this.mesh, false]);
        for (let i = 0; i < this._depthMats.length; i++) {
            await whenReady(this._depthMats[i], this._depthMats[i].name, [this.mesh, false]);
        }
        if (this.prepassMat) {
            await whenReady(this.prepassMat, "crystal prepass", [this.mesh, false]);
        }
    }

    /**
     * Retire the warm-up crystal, after the warm-up frames have drawn it. It
     * must not be standing in the first frame the player sees.
     */
    finishWarmUp() {
        for (let i = 0; i < CRYSTAL_MAX; i++) this.alive[i] = 0;
        this._texData.fill(0);
        this.dataTex.update(this._texData);
        this.liveCount = 0;
        this._next = 0;
        this.mesh.isVisible = false;
    }

    dispose() {
        this.mesh.dispose();
        this.material.dispose();
        for (let i = 0; i < this._depthMats.length; i++) this._depthMats[i].dispose();
        this.dataTex.dispose();
    }
}

/** Static lattice: `position` is (crystal, vertex, 0). */
function buildMesh(scene) {
    const pos = new Float32Array(CRYSTAL_MAX * VERTS * 3);
    const idx = new Uint32Array(CRYSTAL_MAX * RING * 3 * 3);

    let vi = 0;
    let ii = 0;
    for (let i = 0; i < CRYSTAL_MAX; i++) {
        for (let v = 0; v < VERTS; v++) {
            pos[vi++] = i;
            pos[vi++] = v;
            pos[vi++] = 0;
        }
        const b = i * VERTS;
        for (let k = 0; k < RING; k++) {
            const k2 = (k + 1) % RING;
            const b0 = b + k;
            const b1 = b + k2;
            const s0 = b + RING + k;
            const s1 = b + RING + k2;
            const apex = b + RING * 2;
            // Side quad.
            idx[ii++] = b0; idx[ii++] = s0; idx[ii++] = s1;
            idx[ii++] = b0; idx[ii++] = s1; idx[ii++] = b1;
            // Tip.
            idx[ii++] = s0; idx[ii++] = apex; idx[ii++] = s1;
        }
    }

    const mesh = new Mesh("iceCrystals", scene);
    const vd = new VertexData();
    vd.positions = pos;
    vd.indices = idx;
    vd.applyToMesh(mesh, false);
    mesh.alwaysSelectAsActiveMesh = true;
    mesh.isPickable = false;
    mesh.freezeWorldMatrix();
    mesh.doNotSyncBoundingInfo = true;
    mesh.metadata = { triangles: idx.length / 3, vertices: CRYSTAL_MAX * VERTS };
    return mesh;
}
