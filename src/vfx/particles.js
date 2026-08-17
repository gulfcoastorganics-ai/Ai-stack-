/**
 * Sand spray — a pooled, CPU-simulated, GPU-billboarded particle system.
 *
 * SANDSTORM note: this is SNOWFLOW's snow spray, carried over unchanged in
 * architecture — one pool, one pipeline, CPU simulation with GPU billboard
 * expansion. Only the per-grain physics below (wind coupling, fall speed, puff
 * growth) and the shading in `spray.fragment.wgsl` moved from snow to sand.
 * Also gained one more emission source this phase: `_ambientDrift`, a sparse,
 * rate-limited scan for exposed dune crests near the camera that lofts a few
 * grains downwind on its own, the way wind picks sand off a ridge without the
 * player doing anything. Everything else about it still serves every source of
 * airborne sand in the demo: footfalls, the dune-surf plume, ambient wind, and
 * the spells later. That is deliberate. A separate emitter per effect means
 * separate pipelines, separate warm-up, separate sorting, and several slightly
 * different ideas about what lit sand looks like. There is one pipeline here
 * and one lighting model.
 *
 * Simulation is on the CPU because the particle count is small (a footfall is
 * eighteen grains) and the alternative — a compute pass plus indirect draw —
 * costs more in dispatch overhead than the whole simulation costs to run. What
 * *is* on the GPU is the expansion: the mesh is a static grid of quads whose
 * only vertex attribute is a particle index and a corner, and the vertex shader
 * fetches the particle's state out of a small data texture. So the CPU writes
 * eight floats per live particle per frame and nothing else crosses the bus.
 *
 * Allocation: none per frame. Everything is a typed array sized at construction,
 * and dead particles are recycled through a free ring rather than compacted.
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
import { SPELL_LIGHT_UNIFORMS } from "../spells/spellLights.js";

/**
 * Pool size. A hard cap, not a target — an emission is simply dropped when it is
 * exhausted.
 *
 * Sized for the surf plume, which is the heaviest consumer by an order of
 * magnitude and which needs sheer count more than it needs anything else: at
 * 1200 live grains the plume renders as a field of separated soft discs — legible
 * as bokeh, not as snow — and the only thing that turns that into a continuous
 * mass is enough of them to overlap. 75 a metre at 19.5 m/s across two
 * populations lands near 3500 live, and the footfall kick and the spells still
 * have to fit alongside.
 *
 * The cost of the headroom is one pass over the array per frame — 5120 iterations
 * of a dozen flops, which does not register — plus 160 KB of data texture.
 */
const CAPACITY = 5120;

/**
 * Terminal fall speed of a sand grain, m/s. Drag is tuned to land here.
 *
 * Raised from SNOWFLOW's 1.9 (a snow flake's terminal speed): mineral grains
 * are denser than ice crystals and fall — and therefore settle back toward the
 * ground — faster, which is also what "denser close to the ground" asks for:
 * a spray population that pulls itself back down instead of hanging in the
 * air the way snow powder does.
 */
const TERMINAL = 2.6;

const _right = new Vector3();
const _up = new Vector3();
const _splits = new Vector4();

export class SprayField {
    /**
     * @param {import("@babylonjs/core/scene").Scene} scene
     * @param {import("../terrain/terrain.js").Terrain} terrain
     * @param {import("../render/sky.js").Sky} sky
     * @param {import("../render/shadows.js").ShadowSystem} shadows
     */
    constructor(scene, terrain, sky, shadows) {
        this.scene = scene;
        this.terrain = terrain;
        this.sky = sky;
        this.shadows = shadows;

        this.pos = new Float32Array(CAPACITY * 3);
        this.vel = new Float32Array(CAPACITY * 3);
        this.age = new Float32Array(CAPACITY);
        this.life = new Float32Array(CAPACITY);
        this.size = new Float32Array(CAPACITY);
        this.seed = new Float32Array(CAPACITY);
        /** 0 = powder puff, 1 = heavy clod. Drives edge hardness and opacity. */
        this.kind = new Float32Array(CAPACITY);
        /**
         * Linear drag coefficient, 1/s. Separate from `kind` on purpose.
         *
         * A plume has to look like powder — soft-edged, translucent, puffy —
         * and fly like a stone, because it is a mass of snow launched off a
         * wave at eight metres a second rather than a grain drifting down. With
         * drag welded to appearance, asking for the look costs 5.2/s of drag,
         * which stops the grain dead in 120 ms and inside the wave that threw
         * it.
         */
        this.drag = new Float32Array(CAPACITY);
        /** Index of the next slot to try. Wraps; a live slot is skipped. */
        this._next = 0;
        this.liveCount = 0;

        // Texture rows: 0 = (x, y, z, size), 1 = (age01, seed, kind, alpha).
        this._texData = new Float32Array(CAPACITY * 2 * 4);
        this.dataTex = RawTexture.CreateRGBATexture(
            this._texData, CAPACITY, 2, scene,
            false, false,
            Constants.TEXTURE_NEAREST_SAMPLINGMODE,
            Constants.TEXTURETYPE_FLOAT
        );
        this.dataTex.wrapU = Constants.TEXTURE_CLAMP_ADDRESSMODE;
        this.dataTex.wrapV = Constants.TEXTURE_CLAMP_ADDRESSMODE;

        this.mesh = buildQuadMesh(scene);
        this.material = this._makeMaterial();
        this.mesh.material = this.material;
        // After the opaque pass: these are alpha-blended and write no depth.
        this.mesh.renderingGroupId = 2;

        this._camPos = new Vector3();
        this._t = 0;
        /** Seconds until `_ambientDrift` is next allowed to fire. */
        this._driftClock = 0;
    }

    _makeMaterial() {
        const mat = new ShaderMaterial(
            "spray", this.scene, { vertex: "spray", fragment: "spray" },
            {
                attributes: ["position"],
                uniforms: [
                    "viewProjection", "cameraPos", "camRight", "camUp",
                    "sunDir", "sunRadiance", "shR",
                    "cascadeMatrices", "cascadeSplits", "cascadeParams",
                    "shadowTexel", "shadowSoftness", "shadowBias",
                    "fogDensity", "fogHeightFalloff", "fogStart", "aerialStrength",
                    "ambientIntensity",
                    ...SPELL_LIGHT_UNIFORMS,
                ],
                samplers: ["sprayTex", "skyLUT", "cascade0", "cascade1", "cascade2"],
                shaderLanguage: ShaderLanguage.WGSL,
                needAlphaBlending: true,
            }
        );
        mat.backFaceCulling = false;
        mat.disableDepthWrite = true;
        mat.alphaMode = Constants.ALPHA_COMBINE;
        // ShaderMaterial decides blending from `alpha` and its option flag; this
        // makes it unambiguous whichever version is underneath.
        mat.needAlphaBlending = () => true;
        mat.setTexture("sprayTex", this.dataTex);
        mat.setTexture("skyLUT", this.sky.lut);
        for (let i = 0; i < CASCADE_COUNT; i++) {
            mat.setTexture("cascade" + i, this.shadows.maps[i]);
        }
        return mat;
    }

    /**
     * Emit one grain. Everything is world space.
     *
     * @param {number} x @param {number} y @param {number} z
     * @param {number} vx @param {number} vy @param {number} vz
     * @param {number} size metres, radius
     * @param {number} life seconds
     * @param {number} kind 0 powder, 1 clod — appearance only
     * @param {number} [drag] 1/s. Defaults to the fall-in-place value for a
     *   grain of settling powder; pass something near 1 for anything thrown.
     */
    emit(x, y, z, vx, vy, vz, size, life, kind, drag) {
        // Find a free slot. Bounded scan: after CAPACITY tries the pool is full
        // and the emission is simply dropped, which at these counts never
        // happens and is the right failure anyway — a hitch is worse than a
        // missing grain.
        let i = this._next;
        for (let n = 0; n < CAPACITY; n++) {
            if (this.age[i] >= this.life[i]) break;
            i = (i + 1) % CAPACITY;
            if (n === CAPACITY - 1) return;
        }
        this._next = (i + 1) % CAPACITY;

        const o = i * 3;
        this.pos[o] = x; this.pos[o + 1] = y; this.pos[o + 2] = z;
        this.vel[o] = vx; this.vel[o + 1] = vy; this.vel[o + 2] = vz;
        this.age[i] = 0;
        this.life[i] = life;
        this.size[i] = size;
        this.kind[i] = kind;
        this.drag[i] = drag === undefined ? (kind > 0.5 ? 1.1 : 5.2) : drag;
        this.seed[i] = (i * 0.618033 + x * 0.137 + z * 0.311) % 1;
    }

    /**
     * Advance and upload.
     * @param {number} dt
     * @param {Vector3} cameraPos
     */
    update(dt, cameraPos) {
        this._t += dt;
        this._camPos.copyFrom(cameraPos);

        this._ambientDrift(dt, cameraPos);

        const h = Math.min(dt, 1 / 30);
        const wa = (S.windDirection * Math.PI) / 180;
        // Sand is pushed by the wind harder than snow was — raised from
        // SNOWFLOW's 2.4 m/s reference — which is most of "more affected by
        // prevailing wind": a dust grain snaps toward the wind's own velocity
        // much faster once its own launch energy bleeds off.
        const wx = Math.sin(wa) * 4.0 * S.windStrength;
        const wz = Math.cos(wa) * 4.0 * S.windStrength;

        const d = this._texData;
        let live = 0;

        for (let i = 0; i < CAPACITY; i++) {
            const o = i * 3;
            const to = i * 4;
            const t1 = (CAPACITY + i) * 4;

            if (this.age[i] >= this.life[i]) {
                // A dead slot still has to be written, or the last frame's
                // corpse keeps rendering. Zero size collapses the quad.
                d[to + 3] = 0;
                d[t1 + 3] = 0;
                continue;
            }

            this.age[i] += h;
            const a01 = this.age[i] / this.life[i];

            // Drag toward the wind horizontally and toward terminal vertically.
            // A settling grain reaches equilibrium almost at once; anything
            // thrown hard carries its arc. See the note on `drag` above.
            const k = this.drag[i];
            const vy = this.vel[o + 1];
            this.vel[o] += (wx - this.vel[o]) * Math.min(1, k * h);
            this.vel[o + 2] += (wz - this.vel[o + 2]) * Math.min(1, k * h);
            this.vel[o + 1] = vy + (-9.81 - k * (vy + TERMINAL)) * h;

            this.pos[o] += this.vel[o] * h;
            this.pos[o + 1] += this.vel[o + 1] * h;
            this.pos[o + 2] += this.vel[o + 2] * h;

            // Settle on the sand instead of falling through it. The grain does
            // not bounce — it is sand landing on sand — it just stops and fades.
            const g = this.terrain.heightAt(this.pos[o], this.pos[o + 2]);
            if (this.pos[o + 1] < g) {
                this.pos[o + 1] = g;
                this.vel[o] *= 0.2; this.vel[o + 1] = 0; this.vel[o + 2] *= 0.2;
                // Kill it faster once it is down.
                this.age[i] += h * 2.5;
            }

            // Puffs expand as they disperse, but far less than snow powder did —
            // sand dust stays a tighter, more directional streak instead of
            // blooming into a fluffy cloud, which is most of "more directional"
            // for the fine-dust population. Clods do not expand at all.
            const grow = this.kind[i] > 0.5 ? 1.0 : 1.0 + a01 * 0.55;
            // Fade in fast, out slowly.
            const alpha =
                Math.min(1, a01 * 8) * (1 - a01) * (1 - a01);

            d[to] = this.pos[o];
            d[to + 1] = this.pos[o + 1];
            d[to + 2] = this.pos[o + 2];
            d[to + 3] = this.size[i] * grow;
            d[t1] = a01;
            d[t1 + 1] = this.seed[i];
            d[t1 + 2] = this.kind[i];
            d[t1 + 3] = alpha;
            live++;
        }

        this.liveCount = live;
        this.dataTex.update(d);
        this._pushUniforms();
    }

    /**
     * Wind picking sand off an exposed dune crest, with nobody involved.
     *
     * A sparse, rate-limited scan of a handful of points around the camera
     * rather than a field-wide system: only points near the camera are worth
     * the cost, since anything far enough away to be irrelevant to the frame
     * is also too small on screen to read as individual grains. Gated on the
     * same `exposure` channel the ground material's sastrugi cross-fade and the
     * deformation buffer's downhill migration both read — "1 on scoured
     * crests, 0 in sheltered hollows" from `auxBake.fragment.wgsl` — so a lee
     * face gets significantly less transport for free, without a second
     * analytic wind-exposure model to keep in sync with the terrain generator.
     *
     * Reuses the existing pooled particle system entirely: no new draw call, no
     * new pipeline, just a handful of extra `emit()` calls a few times a
     * second.
     */
    _ambientDrift(dt, cameraPos) {
        if (S.windStrength <= 0.05) {
            this._driftClock = 0;
            return;
        }
        this._driftClock += dt;
        const INTERVAL = 0.12;
        if (this._driftClock < INTERVAL) return;
        this._driftClock -= INTERVAL;

        const wa = (S.windDirection * Math.PI) / 180;
        const wx = Math.sin(wa);
        const wz = Math.cos(wa);

        const TRIES = 5;
        for (let i = 0; i < TRIES; i++) {
            const ang = Math.random() * Math.PI * 2;
            const r = 6 + Math.random() * 16;
            const x = cameraPos.x + Math.cos(ang) * r;
            const z = cameraPos.z + Math.sin(ang) * r;

            // Crest gate. Well above the sastrugi cross-fade's own midpoint —
            // ambient drift should read as "the wind is doing something to the
            // sharp edges of this field", not paint every gentle rise.
            const exposure = this.terrain.exposureAt(x, z);
            if (exposure < 0.62) continue;

            const y = this.terrain.heightAt(x, z);
            const n = 1 + ((Math.random() * 2) | 0);
            for (let k = 0; k < n; k++) {
                const jx = (Math.random() - 0.5) * 1.2;
                const jz = (Math.random() - 0.5) * 1.2;
                // Low and mostly horizontal — this is grain skimming off a
                // ridge downwind, not a plume being thrown, so it stays close
                // to the ground and carries little vertical energy.
                this.emit(
                    x + jx, y + 0.05 + Math.random() * 0.25, z + jz,
                    wx * (1.2 + Math.random() * 1.6) * S.windStrength,
                    0.15 + Math.random() * 0.5,
                    wz * (1.2 + Math.random() * 1.6) * S.windStrength,
                    0.009 + Math.random() * 0.012,
                    1.0 + Math.random() * 1.2,
                    0,
                    2.2
                );
            }
        }
    }

    _pushUniforms() {
        const m = this.material;
        const sky = this.sky;
        const sh = this.shadows;
        const cam = this.scene.activeCamera;

        // Billboard basis, straight off the view matrix.
        const v = cam.getViewMatrix();
        _right.set(v.m[0], v.m[4], v.m[8]);
        _up.set(v.m[1], v.m[5], v.m[9]);

        m.setVector3("cameraPos", this._camPos);
        m.setVector3("camRight", _right);
        m.setVector3("camUp", _up);
        m.setVector3("sunDir", sky.sunDir);
        m.setColor3("sunRadiance", sky.sunRadiance);
        m.setArray4("shR", sky.sh);

        bindMatrixArray(m, "cascadeMatrices", sh.matrixData);
        _splits.set(sh.splits[0], sh.splits[1], sh.splits[2], sh.splits[3]);
        m.setVector4("cascadeSplits", _splits);
        m.setArray4("cascadeParams", sh.paramData);
        m.setFloat("shadowTexel", sh.texelSize);
        m.setFloat("shadowSoftness", 1.6);
        m.setFloat("shadowBias", 0.05);

        m.setFloat("fogDensity", S.fogDensity);
        m.setFloat("fogHeightFalloff", S.fogHeightFalloff);
        m.setFloat("fogStart", S.fogStart);
        m.setFloat("aerialStrength", S.aerialStrength);
        m.setFloat("ambientIntensity", S.ambientIntensity);
    }

    async warmUp() {
        await whenReady(this.material, "spray material", [this.mesh, false]);
    }

    dispose() {
        this.mesh.dispose();
        this.material.dispose();
        this.dataTex.dispose();
    }
}

/**
 * A static grid of quads. `position` is `(particleIndex, cornerX, cornerY)` and
 * carries no geometry at all — the vertex shader places every corner.
 */
function buildQuadMesh(scene) {
    const pos = new Float32Array(CAPACITY * 4 * 3);
    const idx = new Uint32Array(CAPACITY * 6);
    const CORNERS = [-1, -1, 1, -1, 1, 1, -1, 1];

    for (let i = 0; i < CAPACITY; i++) {
        for (let c = 0; c < 4; c++) {
            const o = (i * 4 + c) * 3;
            pos[o] = i;
            pos[o + 1] = CORNERS[c * 2];
            pos[o + 2] = CORNERS[c * 2 + 1];
        }
        const b = i * 4;
        const q = i * 6;
        idx[q] = b; idx[q + 1] = b + 1; idx[q + 2] = b + 2;
        idx[q + 3] = b; idx[q + 4] = b + 2; idx[q + 5] = b + 3;
    }

    const mesh = new Mesh("spray", scene);
    const vd = new VertexData();
    vd.positions = pos;
    vd.indices = idx;
    vd.applyToMesh(mesh, false);
    mesh.alwaysSelectAsActiveMesh = true;
    mesh.isPickable = false;
    mesh.freezeWorldMatrix();
    mesh.doNotSyncBoundingInfo = true;
    mesh.metadata = { triangles: CAPACITY * 2, vertices: CAPACITY * 4 };
    return mesh;
}

export { CAPACITY as SPRAY_CAPACITY };
