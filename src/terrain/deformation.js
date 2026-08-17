/**
 * The terrain state buffer — persistent, additive snow deformation.
 *
 * Two RGBA16F targets ping-ponged by one full-screen pass per frame
 * (`deformSim.fragment.wgsl`). The pass scrolls, relaxes and splats in a single
 * dispatch; there is no separate clear, no copy and no readback.
 *
 * Geometry:
 *   COVERAGE metres of world, RES texels across, centred on the player and
 *   snapped to texel boundaries so the field does not swim under the surface.
 *   Addressing is toroidal, so following the player costs nothing.
 *
 * Everything that touches the snow writes here through `brush()` — feet, the
 * surf wake, every spell. That shared write path is what makes the effects part
 * of the snow rather than decals floating above it.
 *
 * Allocation: none per frame. The brush staging array is sized once at
 * construction and written in place.
 */

import { ProceduralTexture } from "@babylonjs/core/Materials/Textures/Procedurals/proceduralTexture";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Constants } from "@babylonjs/core/Engines/constants";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { Vector2 } from "@babylonjs/core/Maths/math.vector";

import { S } from "../core/settings.js";
import { whenReady } from "../core/gpuUtil.js";

/**
 * Window coverage in metres: 80 m at 2048², so 3.9 cm texels.
 *
 * The trade favours area. A surf run crosses 80 m in four seconds and the whole
 * groove should stay in frame; halving the texel instead would mean a 4096²
 * target — 4x the VRAM and 4x the cost of a pass that runs every frame — to
 * resolve detail the fragment shader's grain layer already synthesises.
 */
export const COVERAGE = 80;

/** Rows in the brush data texture. Must match `deformSim.fragment.wgsl`. */
const BRUSH_ROWS = 3;
const MAX_BRUSHES = 96;

/** Seconds of relaxation banked before it is worth applying. See `_relaxOwed`. */
const RELAX_STEP = 0.4;

export class DeformationField {
    /** @param {import("@babylonjs/core/scene").Scene} scene */
    constructor(scene) {
        this.scene = scene;
        this.res = Math.max(512, S.deformResolution | 0);
        this.size = COVERAGE;
        this.texel = this.size / this.res;

        /** Window centre this frame, texel-snapped. */
        this.center = new Vector2(0, 0);
        this._prevCenter = new Vector2(0, 0);

        // ------------------------------------------------------------ brushes
        // (x, z, radius, elongation) / (cos, sin, depth, berm) /
        // (compression, ice, edgeRoughness, seed)
        this._brushData = new Float32Array(MAX_BRUSHES * BRUSH_ROWS * 4);
        this._brushCount = 0;

        this.brushTex = RawTexture.CreateRGBATexture(
            this._brushData,
            MAX_BRUSHES,
            BRUSH_ROWS,
            scene,
            false, // no mipmaps
            false, // don't invert Y
            Constants.TEXTURE_NEAREST_SAMPLINGMODE,
            Constants.TEXTURETYPE_FLOAT
        );
        this.brushTex.wrapU = Constants.TEXTURE_CLAMP_ADDRESSMODE;
        this.brushTex.wrapV = Constants.TEXTURE_CLAMP_ADDRESSMODE;

        // -------------------------------------------------------- ping-pong
        this._targets = [this._makeTarget(0), this._makeTarget(1)];
        this._write = 0;

        /**
         * Seconds of relaxation owed to the buffer but not yet spent.
         *
         * The relax terms are too slow to survive a half-float store at frame
         * cadence: a 400-second decay asks for a change well under one ULP, and
         * the rounding turns it into a ten-second decay. Time is banked here and
         * spent in steps big enough to land on a different number.
         */
        this._relaxOwed = 0;

        /** The target holding this frame's state. Bound by the terrain. */
        this.texture = this._targets[0];

        this._warmed = false;
    }

    /** @param {number} i */
    _makeTarget(i) {
        const pt = new ProceduralTexture(
            "deform" + i,
            { width: this.res, height: this.res },
            "deformSim",
            this.scene,
            {
                generateMipMaps: false,
                // Half float, not full: the channels are metres in a range of
                // roughly ±1, where half float resolves well under a tenth of a
                // millimetre. Full float would double the bandwidth of a pass
                // that runs every frame and buy nothing.
                type: Constants.TEXTURETYPE_HALF_FLOAT,
                format: Constants.TEXTUREFORMAT_RGBA,
                samplingMode: Constants.TEXTURE_BILINEAR_SAMPLINGMODE,
                shaderLanguage: ShaderLanguage.WGSL,
                skipSceneRegistration: true,
            }
        );
        // Toroidal addressing depends on this.
        pt.wrapU = Constants.TEXTURE_WRAP_ADDRESSMODE;
        pt.wrapV = Constants.TEXTURE_WRAP_ADDRESSMODE;
        pt.refreshRate = 0;
        // The pass writes every texel unconditionally, so clearing first is pure
        // bandwidth.
        pt.autoClear = false;
        pt.setTexture("brushTex", this.brushTex);
        return pt;
    }

    /**
     * Queue a brush for this frame. Called from character contact and from
     * spells; accumulates additively into whatever is already there.
     *
     * Positions are absolute world metres — the shader wraps them into the
     * window itself, so callers never think about the toroid.
     *
     * @param {number} x world X
     * @param {number} z world Z
     * @param {number} radius metres, across the short axis
     * @param {number} depth metres of depression at the centre
     * @param {number} berm metres of displaced mass thrown to the rim
     * @param {number} compression 0..1 added to the compression channel
     * @param {number} ice 0..1, taken as a max rather than added
     * @param {number} [yaw] radians, orients the long axis
     * @param {number} [elongation] long-axis multiple of `radius`, 1 = round
     * @param {number} [edge] 0..1 rim roughness; 0 is a clean bevel
     */
    brush(x, z, radius, depth, berm, compression, ice, yaw, elongation, edge) {
        if (this._brushCount >= MAX_BRUSHES) return;
        if (radius <= 0) return;

        // Outside the window entirely — nothing it could write to.
        const halfPlus = this.size * 0.5 + radius * 2;
        if (Math.abs(x - this.center.x) > halfPlus) return;
        if (Math.abs(z - this.center.y) > halfPlus) return;

        const i = this._brushCount++;
        const d = this._brushData;
        const stride = MAX_BRUSHES * 4;
        const a = i * 4;

        const yw = yaw || 0;
        d[a] = x;
        d[a + 1] = z;
        d[a + 2] = radius;
        d[a + 3] = elongation || 1;

        d[stride + a] = Math.cos(yw);
        d[stride + a + 1] = Math.sin(yw);
        d[stride + a + 2] = depth;
        d[stride + a + 3] = berm;

        d[stride * 2 + a] = compression;
        d[stride * 2 + a + 1] = ice;
        d[stride * 2 + a + 2] = edge === undefined ? 1 : edge;
        // Decorrelates the rim wobble and the berm granularity between brushes,
        // so a line of footprints does not repeat one silhouette.
        d[stride * 2 + a + 3] = (x * 0.37 + z * 0.71) % 100;

        this._brushDirty = true;
    }

    /**
     * Advance the simulation one frame and return the texture holding the
     * result.
     *
     * @param {number} dt seconds
     * @param {{x:number, z:number}} focus world position the window follows
     */
    update(dt, focus) {
        this._prevCenter.copyFrom(this.center);

        // Snap to texel boundaries. Without this the toroidal mapping shifts by
        // a fraction of a texel every frame and the whole field crawls.
        const t = this.texel;
        this.center.x = Math.round(focus.x / t) * t;
        this.center.y = Math.round(focus.z / t) * t;

        // Zero out the tail of the brush texture once after a busy frame, so a
        // stale radius can never be picked up by a later, shorter frame.
        if (this._brushDirty || this._brushCount > 0) {
            this._uploadBrushes();
        }

        // Bank the frame's time and spend it only once it is worth spending.
        // 0.4 s of a 400 s decay is a relative change of 1e-3, comfortably clear
        // of the 4.9e-4 half-float ULP, and far too small a step to see.
        this._relaxOwed += dt;
        let relaxDt = 0;
        if (this._relaxOwed >= RELAX_STEP) {
            relaxDt = this._relaxOwed;
            this._relaxOwed = 0;
        }

        const pt = this._targets[this._write];
        const prev = this._targets[1 - this._write];

        pt.setTexture("prevTex", prev);
        pt.setVector2("center", this.center);
        pt.setVector2("prevCenter", this._prevCenter);
        pt.setFloat("size", this.size);
        pt.setFloat("res", this.res);
        pt.setFloat("dt", relaxDt);
        pt.setFloat("brushCount", this._brushCount);
        pt.setFloat("refillRate", S.refillRate);
        pt.setFloat("maxDepth", 0.55 * S.deformDepth);
        pt.setFloat("maxBerm", 0.34 * S.deformBerm);
        pt.setFloat("windAngle", (S.windDirection * Math.PI) / 180);

        pt.render();

        this.texture = pt;
        this._write = 1 - this._write;
        this._brushCount = 0;
        return pt;
    }

    _uploadBrushes() {
        // Only the live brushes carry meaning; the shader reads exactly
        // `brushCount` of them, so the tail can stay stale. But radius 0 is the
        // shader's own skip test, so clearing it is a cheap safety net.
        const d = this._brushData;
        const stride = MAX_BRUSHES * 4;
        for (let i = this._brushCount; i < MAX_BRUSHES; i++) {
            d[i * 4 + 2] = 0;
        }
        this.brushTex.update(d);
        this._brushDirty = false;
    }

    /**
     * Compile the pass and zero both targets, behind the loading screen.
     *
     * The targets start as uninitialised VRAM. Two passes with the previous
     * centre placed far outside the window make every texel read as "just
     * scrolled in", which the shader answers by writing zero — so the buffer is
     * cleared by the same code path that runs every frame, rather than by a
     * special case that could rot.
     */
    async warmUp() {
        await whenReady(this._targets[0], "deform target 0");
        await whenReady(this._targets[1], "deform target 1");

        this._brushCount = 0;
        this._uploadBrushes();

        for (let i = 0; i < 2; i++) {
            const pt = this._targets[this._write];
            pt.setTexture("prevTex", this._targets[1 - this._write]);
            pt.setVector2("center", this.center);
            // Far enough away that no texel can have been inside it.
            _far.set(this.center.x + 1e6, this.center.y + 1e6);
            pt.setVector2("prevCenter", _far);
            pt.setFloat("size", this.size);
            pt.setFloat("res", this.res);
            pt.setFloat("dt", 0);
            pt.setFloat("brushCount", 0);
            pt.setFloat("refillRate", 1);
            pt.setFloat("maxDepth", 1);
            pt.setFloat("maxBerm", 1);
            pt.setFloat("windAngle", 0);
            pt.render();
            this.texture = pt;
            this._write = 1 - this._write;
        }
        this._warmed = true;
    }

    dispose() {
        this._targets[0].dispose();
        this._targets[1].dispose();
        this.brushTex.dispose();
    }
}

const _far = new Vector2();
