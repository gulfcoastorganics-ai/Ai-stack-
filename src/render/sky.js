/**
 * Procedural sky, image-based lighting, and the sun's own colour.
 *
 * No HDRI. The whole look rests on a sun 5-15 degrees up, and with an analytic
 * model the elevation slider drags the horizon warmth, the zenith gradient and
 * the ambient tint along with it, consistently. A captured HDRI would freeze
 * those relationships at whatever elevation it was shot at.
 *
 * The scattering integral is far too heavy for per-pixel work, so it bakes into
 * an equirectangular LUT once, and again only when the sun actually moves.
 * Everything downstream — skybox, ambient SH, specular reflections, aerial
 * inscatter — reads that one texture.
 */

import { Vector2, Vector3, Color3 } from "@babylonjs/core/Maths/math";
import { ProceduralTexture } from "@babylonjs/core/Materials/Textures/Procedurals/proceduralTexture";
import { Constants } from "@babylonjs/core/Engines/constants";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder";
import { S } from "../core/settings.js";
import { whenReady } from "../core/gpuUtil.js";

const LUT_W = 512;
const LUT_H = 256;
const SH_W = 64; // low-res copy, read back on the CPU for the SH projection
const SH_H = 32;

/**
 * Converts the `sunIntensity` slider into the shared radiometric scale used by
 * both the sky integral and the direct sun. Its absolute value is arbitrary —
 * exposure handles overall brightness — but it must be *one* number, applied to
 * both, or the sun/sky ratio stops meaning anything.
 */
const SUN_SCALE_BASE = 5.5;

const _dir = new Vector3();

function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
}

export class Sky {
    /** @param {import("@babylonjs/core/scene").Scene} scene */
    constructor(scene) {
        this.scene = scene;
        this.engine = scene.getEngine();

        /** Unit vector pointing *toward* the sun. */
        this.sunDir = new Vector3(0, 0.2, 1);
        /** Normalised hue of direct sunlight, for tinting effects. */
        this.sunColor = new Color3(1, 0.85, 0.66);
        /**
         * Direct solar irradiance reaching the ground, in the *same units the
         * sky LUT stores radiance in*. Everything downstream reads this rather
         * than an intensity-times-colour pair, because the sun and the sky have
         * to be on one scale or the balance between them is arbitrary — and
         * that balance is the entire cool-shadow / warm-light look.
         */
        this.sunRadiance = new Color3(1, 1, 1);
        /** Shared radiometric scale for the sun and the baked sky. */
        this.sunScale = 1;
        /** Radiance leaving the snow field, solved iteratively. */
        this.groundBounce = new Color3(0, 0, 0);
        /** 36 floats: 9 SH coefficients as vec4, for the shader UBO. */
        this.sh = new Float32Array(36);

        this._dirty = true;

        // ------------------------------------------------------------- LUTs
        this.lut = new ProceduralTexture(
            "skyLUT",
            { width: LUT_W, height: LUT_H },
            "skyBake",
            scene,
            {
                generateMipMaps: true,
                type: Constants.TEXTURETYPE_HALF_FLOAT,
                format: Constants.TEXTUREFORMAT_RGBA,
                samplingMode: Constants.TEXTURE_TRILINEAR_SAMPLINGMODE,
                shaderLanguage: ShaderLanguage.WGSL,
                skipSceneRegistration: true,
            }
        );
        this.lut.wrapU = Constants.TEXTURE_WRAP_ADDRESSMODE;
        this.lut.wrapV = Constants.TEXTURE_CLAMP_ADDRESSMODE;
        this.lut.refreshRate = 0; // manual

        this.shLut = new ProceduralTexture(
            "skySH",
            { width: SH_W, height: SH_H },
            "skyBake",
            scene,
            {
                generateMipMaps: false,
                type: Constants.TEXTURETYPE_FLOAT,
                format: Constants.TEXTUREFORMAT_RGBA,
                samplingMode: Constants.TEXTURE_BILINEAR_SAMPLINGMODE,
                shaderLanguage: ShaderLanguage.WGSL,
                skipSceneRegistration: true,
            }
        );
        this.shLut.refreshRate = 0;

        // ----------------------------------------------------------- skybox
        this.mesh = CreateBox("sky", { size: 2 }, scene);
        this.mesh.infiniteDistance = false; // positioned manually in the shader
        this.mesh.alwaysSelectAsActiveMesh = true;
        this.mesh.isPickable = false;
        this.mesh.renderingGroupId = 0;

        const mat = new ShaderMaterial(
            "skyMat",
            scene,
            { vertex: "sky", fragment: "sky" },
            {
                attributes: ["position"],
                uniforms: [
                    "viewProjection",
                    "cameraPosition",
                    "skyScale",
                    "sunDir",
                    "sunColor",
                    "sunIntensity",
                    "time",
                    "windDir",
                    "cloudAmount",
                    "sunRadiance",
                    "shR",
                    "ambientIntensity",
                    "ridgeAmp",
                    "fogDensity",
                    "fogHeightFalloff",
                    "fogStart",
                    "aerialStrength",
                ],
                samplers: ["skyLUT"],
                shaderLanguage: ShaderLanguage.WGSL,
            }
        );
        mat.backFaceCulling = false;
        mat.disableDepthWrite = true;
        mat.setTexture("skyLUT", this.lut);
        this.mesh.material = mat;
        this.material = mat;

        this._shReadback = null;
    }

    /**
     * Recompute the sun vector and colour from the settings, and mark the LUT
     * for a rebake if anything actually moved.
     */
    syncFromSettings() {
        const az = (S.sunAzimuth * Math.PI) / 180;
        const el = (S.sunElevation * Math.PI) / 180;
        const ce = Math.cos(el);
        _dir.set(Math.sin(az) * ce, Math.sin(el), Math.cos(az) * ce);

        if (
            Math.abs(_dir.x - this.sunDir.x) > 1e-6 ||
            Math.abs(_dir.y - this.sunDir.y) > 1e-6 ||
            Math.abs(_dir.z - this.sunDir.z) > 1e-6
        ) {
            this.sunDir.copyFrom(_dir);
            this._dirty = true;
        }

        this.sunScale = S.sunIntensity * SUN_SCALE_BASE;

        // Direct sunlight reddens as it grazes: the lower the sun, the longer
        // the path through the atmosphere and the more of the blue end is
        // scattered out of the beam. At 13 degrees the beam has already lost
        // most of its blue, which is what makes the warm-light / cool-shadow
        // split physical rather than an art choice.
        const zenithDeg = (Math.acos(clamp(this.sunDir.y, -1, 1)) * 180) / Math.PI;

        // Kasten-Young air mass — stays finite at the horizon, unlike 1/cos.
        const denom =
            Math.cos((zenithDeg * Math.PI) / 180) +
            0.50572 * Math.pow(Math.max(1e-3, 96.07995 - zenithDeg), -1.6364);
        const airMass = Math.min(denom > 0 ? 1 / denom : 40, 40);

        // Vertical optical depth: scattering coefficient x scale height.
        const warm = S.sunTempWarm;
        const tauR = [0.0464, 0.108, 0.265];
        const tauM = 0.0252;
        const r = Math.exp(-(tauR[0] * warm + tauM) * airMass);
        const g = Math.exp(-(tauR[1] * warm + tauM) * airMass);
        const b = Math.exp(-(tauR[2] * warm + tauM) * airMass);

        this.sunRadiance.set(r * this.sunScale, g * this.sunScale, b * this.sunScale);

        const m = Math.max(r, Math.max(g, b)) || 1;
        this.sunColor.set(r / m, g / m, b / m);
    }

    /**
     * Rebake the LUTs if the sun moved. Safe to call every frame — it only does
     * work when something actually changed, and it silently skips until the
     * bake shader has finished compiling.
     */
    update() {
        this.syncFromSettings();
        if (!this._dirty) return false;
        if (!this.lut.isReady() || !this.shLut.isReady()) return false;
        this._dirty = false;
        // Live re-solve when the sun slider moves. The SH readback is async, so
        // this settles over the next few frames rather than instantly — which
        // is invisible while dragging a slider and avoids a stall.
        this.solve();
        return true;
    }

    /**
     * Compile the bake shaders, then solve the sky and the snow bounce
     * together. Used during load and after any sun change.
     *
     * The two are mutually dependent: the sky lights the snow, the snow bounces
     * ~85% of that straight back up, and that bounce is itself a major source
     * of sky-hemisphere light. Solved by iteration — bake, project to SH, work
     * out what the ground is now radiating, bake again. It converges in three
     * passes because each round trip is multiplied by the albedo.
     */
    async solve() {
        this.syncFromSettings();
        await whenReady(this.lut, "skyLUT");
        await whenReady(this.shLut, "skySH");
        this._dirty = false;

        this.groundBounce.set(0, 0, 0);
        for (let i = 0; i < 3; i++) {
            this.bake();
            await this.projectSH();
            this._updateGroundBounce();
        }
        // Final bake so the LUT reflects the converged bounce, then one last
        // projection so the SH the shader uses matches the LUT it samples.
        this.bake();
        await this.projectSH();
    }

    /** Radiance leaving the snow, from everything currently landing on it. */
    _updateGroundBounce() {
        // Irradiance arriving on horizontal ground: direct sun (cosine-weighted)
        // plus the whole sky hemisphere, which the SH already integrates.
        const up = this._irradianceUp();
        const c = Math.max(0, this.sunDir.y);
        const er = this.sunRadiance.r * c + up[0];
        const eg = this.sunRadiance.g * c + up[1];
        const eb = this.sunRadiance.b * c + up[2];

        // Lambertian re-emission: L = albedo * E / PI.
        const k = 1 / Math.PI;
        this.groundBounce.set(
            SNOW_ALBEDO[0] * er * k,
            SNOW_ALBEDO[1] * eg * k,
            SNOW_ALBEDO[2] * eb * k
        );
    }

    /** SH irradiance for an up-facing normal. */
    _irradianceUp() {
        const sh = this.sh;
        const out = _irrTmp;
        for (let k = 0; k < 3; k++) {
            // Only the bands that survive n = (0,1,0).
            out[k] =
                sh[0 * 4 + k] * 0.886227 +
                sh[1 * 4 + k] * 2 * 0.511664 +
                sh[6 * 4 + k] * -0.247708 +
                sh[8 * 4 + k] * -0.429043;
        }
        return out;
    }

    bake() {
        for (const t of [this.lut, this.shLut]) {
            t.setVector3("sunDir", this.sunDir);
            t.setFloat("sunIntensity", this.sunScale);
            // Color3, so setColor3 — setVector3 would read .x/.y/.z off it,
            // find undefined, and write NaN straight into the uniform buffer.
            t.setColor3("groundBounce", this.groundBounce);
            t.render();
        }
    }

    /**
     * Project the baked sky into 9 SH coefficients on the CPU.
     *
     * Done here rather than on the GPU because it is a one-off reduction over
     * 2048 texels — dispatching that would cost more to set up than to run —
     * and because the coefficients need to reach a uniform buffer anyway.
     */
    async projectSH() {
        const data = await this.shLut.readPixels(0, 0);
        if (!data) return;
        const px = /** @type {Float32Array} */ (data);

        const sh = this.sh;
        const Y = _shBasis;
        sh.fill(0);

        // Each texel subtends dω = sinθ · (2π/W) · (π/H).
        const dOmega = ((2 * Math.PI) / SH_W) * (Math.PI / SH_H);

        for (let y = 0; y < SH_H; y++) {
            const theta = ((y + 0.5) / SH_H) * Math.PI;
            const st = Math.sin(theta);
            const ct = Math.cos(theta);
            const w = st * dOmega;

            for (let x = 0; x < SH_W; x++) {
                const phi = ((x + 0.5) / SH_W - 0.5) * 2 * Math.PI;
                const dx = st * Math.sin(phi);
                const dy = ct;
                const dz = st * Math.cos(phi);

                // Real SH basis, bands 0..2.
                Y[0] = 0.282095;
                Y[1] = 0.488603 * dy;
                Y[2] = 0.488603 * dz;
                Y[3] = 0.488603 * dx;
                Y[4] = 1.092548 * dx * dy;
                Y[5] = 1.092548 * dy * dz;
                Y[6] = 0.315392 * (3 * dz * dz - 1);
                Y[7] = 1.092548 * dx * dz;
                Y[8] = 0.546274 * (dx * dx - dy * dy);

                const i = (y * SH_W + x) * 4;
                const r = px[i] * w;
                const g = px[i + 1] * w;
                const b = px[i + 2] * w;

                for (let c = 0; c < 9; c++) {
                    sh[c * 4] += r * Y[c];
                    sh[c * 4 + 1] += g * Y[c];
                    sh[c * 4 + 2] += b * Y[c];
                }
            }
        }
    }

    /** @param {import("../core/camera.js").CameraRig} rig */
    render(rig, time) {
        const a = (S.windDirection * Math.PI) / 180;
        _wind.set(Math.sin(a), Math.cos(a));

        const m = this.material;
        m.setVector3("cameraPosition", rig.camera.position);
        m.setFloat("skyScale", rig.camera.maxZ * 0.5);
        m.setVector3("sunDir", this.sunDir);
        m.setColor3("sunColor", this.sunColor);
        m.setFloat("sunIntensity", this.sunScale);
        m.setFloat("time", time);
        m.setVector2("windDir", _wind);
        m.setFloat("cloudAmount", 0.55);

        // The far range. Lit by the same radiance and the same SH the snow is —
        // see `shadeRidge` in the fragment shader.
        m.setColor3("sunRadiance", this.sunRadiance);
        m.setArray4("shR", this.sh);
        m.setFloat("ambientIntensity", S.ambientIntensity);
        m.setFloat("ridgeAmp", S.showMountains ? S.mountainHeight : 0);

        // The field's own haze, so the range is hazed by the same atmosphere the
        // dunes are and the two meet at one colour rather than two.
        m.setFloat("fogDensity", S.fogDensity);
        m.setFloat("fogHeightFalloff", S.fogHeightFalloff);
        m.setFloat("fogStart", S.fogStart);
        m.setFloat("aerialStrength", S.aerialStrength);
    }

    dispose() {
        this.lut.dispose();
        this.shLut.dispose();
        this.mesh.dispose();
        this.material.dispose();
    }
}

const _shBasis = new Float32Array(9);
const _irrTmp = new Float32Array(3);
const _wind = new Vector2(0, 1);

/** Fresh snow reflects most of what hits it, slightly more at the blue end. */
const SNOW_ALBEDO = [0.83, 0.86, 0.91];
