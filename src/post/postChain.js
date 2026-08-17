/**
 * The post-processing chain.
 *
 * ## Order, and why the passes are sized the way they are
 *
 * Babylon chains post-processes by having pass *i* render into pass *i+1*'s
 * texture. That is worth stating plainly because it means **the resolution a pass
 * renders at is declared by the pass after it**, which reads backwards and is the
 * single easiest thing to get wrong here. The table is the source of truth:
 *
 * ```
 *   pass        renders at   reads                        writes into
 *   ssr          full        scene, depth                 taa's texture
 *   taa          full        ssr result, history, depth   history[k]   (forced)
 *   shafts       1/4         depth                        bloomA's texture
 *   bloomA       1/4         history[k]  (bright pass)    bloomB's texture
 *   bloomB       1/16        bloomA result               bloomC's texture
 *   bloomC       1/16        bloomB result (tent blur)    dof's texture
 *   dof          full        history[k], depth            composite's texture
 *   composite    full        dof result, bloom, shafts    sharpen's texture
 *   sharpen      full        composite result             the swapchain
 * ```
 *
 * `shafts` carries a forced output texture, which does three things at once: it
 * gives the temporal resolve somewhere persistent to land, it means `shafts`
 * allocates no target of its own, and it puts the resolved frame in a texture
 * this class owns — so `bloomA` and `dof` can read the full-resolution scene
 * even though the chain has moved on to sixteenth-resolution bloom levels by
 * then. Two history textures, alternating, because a pass may not sample the
 * target it is writing to.
 *
 * ## Why every pass stays attached
 *
 * Toggling a post-process off detaches it from the camera and reshuffles which
 * texture every remaining pass renders into, mid-frame. Instead each pass
 * early-outs in its own shader and becomes a full-screen copy — a fraction of a
 * millisecond, for a settings overlay that is hidden by default.
 *
 * ## Jitter
 *
 * The temporal resolve needs the projection offset by a subpixel amount each
 * frame, and everything downstream needs to agree about which offset. This class
 * owns that: it recomputes the projection, records the *unjittered* view-projection
 * for next frame's reprojection, then writes the offset straight into the two
 * matrix elements that shear clip x and y by w, and freezes the result so nothing
 * recomputes it mid-frame. The depth prepass and the beauty pass both read
 * `scene.getTransformMatrix()`, so both get the same jittered matrix and line up
 * to the subpixel — which they have to, or the resolve integrates two different
 * samplings of the same surface.
 */

import { PostProcess } from "@babylonjs/core/PostProcesses/postProcess";
import { RenderTargetTexture } from "@babylonjs/core/Materials/Textures/renderTargetTexture";
import { Constants } from "@babylonjs/core/Engines/constants";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";
import { Matrix, Vector2, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { S } from "../core/settings.js";

import postCommonLib from "../shaders/lib/postCommon.wgsl?raw";
import taaFrag from "../shaders/post/taa.fragment.wgsl?raw";
import ssrFrag from "../shaders/post/ssr.fragment.wgsl?raw";
import shaftsFrag from "../shaders/post/shafts.fragment.wgsl?raw";
import bloomDownFrag from "../shaders/post/bloomDown.fragment.wgsl?raw";
import bloomBlurFrag from "../shaders/post/bloomBlur.fragment.wgsl?raw";
import dofFrag from "../shaders/post/dof.fragment.wgsl?raw";
import tonemapFrag from "../shaders/post/tonemap.fragment.wgsl?raw";
import sharpenFrag from "../shaders/post/sharpen.fragment.wgsl?raw";

const TONEMAP_MODES = { agx: 0, aces: 1, none: 2 };

/**
 * Halton(2,3). Eight subpixel positions, low-discrepancy so the accumulated
 * sample pattern is even at every prefix length rather than only after all eight
 * — which matters because the history is continuously being partially rejected
 * and rarely gets a clean run of eight.
 */
const JITTER = buildHalton(8);

let registered = false;
function registerPostShaders() {
    if (registered) return;
    registered = true;
    ShaderStore.IncludesShadersStoreWGSL["snowPostCommon"] = postCommonLib;
    ShaderStore.ShadersStoreWGSL["snowTaaPixelShader"] = taaFrag;
    ShaderStore.ShadersStoreWGSL["snowSsrPixelShader"] = ssrFrag;
    ShaderStore.ShadersStoreWGSL["snowShaftsPixelShader"] = shaftsFrag;
    ShaderStore.ShadersStoreWGSL["snowBloomDownPixelShader"] = bloomDownFrag;
    ShaderStore.ShadersStoreWGSL["snowBloomBlurPixelShader"] = bloomBlurFrag;
    ShaderStore.ShadersStoreWGSL["snowDofPixelShader"] = dofFrag;
    ShaderStore.ShadersStoreWGSL["snowTonemapPixelShader"] = tonemapFrag;
    ShaderStore.ShadersStoreWGSL["snowSharpenPixelShader"] = sharpenFrag;
}

// ------------------------------------------------------- module-scope scratch
const _view = new Matrix();
const _proj = new Matrix();
const _sunWorld = new Vector3();
const _sunClip = new Vector3();

export class PostChain {
    /**
     * @param {import("@babylonjs/core/scene").Scene} scene
     * @param {import("@babylonjs/core/Cameras/camera").Camera} camera
     * @param {import("../render/depthPass.js").DepthPass} depth
     * @param {import("../render/sky.js").Sky} sky
     */
    constructor(scene, camera, depth, sky) {
        registerPostShaders();
        this.scene = scene;
        this.camera = camera;
        this.engine = scene.getEngine();
        this.depth = depth;
        this.sky = sky;
        this.time = 0;

        /**
         * 0..1, written each frame by the surf state. Drives the radial smear
         * and the spindrift strands in the display transform.
         */
        this.speedStreak = 0;

        /** Eased focal distance, metres. Tracks the spring arm. */
        this.focusDist = 6.2;

        this._frame = 0;
        this._historyValid = 0;
        this._k = 0;

        this._prevViewProj = new Matrix();
        this._curViewProj = new Matrix();
        this._invView = new Matrix();
        this._projInfo = new Vector2(1, 1);
        this._invRes = new Vector2(1, 1);
        this._jitterNdc = new Vector2(0, 0);
        this._sunUV = new Vector2(0.5, 0.5);
        this._sunOnScreen = 0;
        this._sunColor = new Color3(1, 1, 1);
        this._bloomCurve = { x: 1, y: 1, z: 1, w: 1 };

        // ---------------------------------------------------------- history
        this.history = [this._makeHistory(0), this._makeHistory(1)];

        // ------------------------------------------------------------ passes
        // Attached in this order; see the table at the top of the file for what
        // each one's declared ratio actually controls.
        this.ssr = this._pass("snowSsr", 1.0, ["projInfo", "invRes", "enabled", "strength"],
            ["depthTex"], Constants.TEXTURETYPE_HALF_FLOAT);
        this.taa = this._pass("snowTaa", 1.0,
            ["prevViewProj", "invView", "projInfo", "invRes", "jitterNdc",
             "historyValid", "enabled", "feedback"],
            ["historyTex", "depthTex"], Constants.TEXTURETYPE_HALF_FLOAT);
        this.shafts = this._pass("snowShafts", 1.0,
            ["sunUV", "sunOnScreen", "sunColor", "enabled", "strength", "aspect"],
            ["depthTex"], Constants.TEXTURETYPE_HALF_FLOAT);
        this.bloomA = this._pass("snowBloomDown", 0.25,
            ["srcTexel", "prefilter", "curve"], ["sourceTex"],
            Constants.TEXTURETYPE_HALF_FLOAT);
        this.bloomB = this._pass("snowBloomDown", 0.25,
            ["srcTexel", "prefilter", "curve"], ["sourceTex"],
            Constants.TEXTURETYPE_HALF_FLOAT);
        this.bloomC = this._pass("snowBloomBlur", 0.0625, ["srcTexel"], [],
            Constants.TEXTURETYPE_HALF_FLOAT);
        this.dof = this._pass("snowDof", 0.0625,
            ["invRes", "enabled", "focusDist", "maxCoc"], ["sceneTex", "depthTex"],
            Constants.TEXTURETYPE_HALF_FLOAT);
        this.composite = this._pass("snowTonemap", 1.0,
            ["exposure", "contrast", "mode", "grainAmount", "time", "vignette",
             "speedStreak", "bloomAmount", "shaftAmount"],
            ["bloomNear", "bloomFar", "shaftsTex"], Constants.TEXTURETYPE_HALF_FLOAT);
        this.sharpen = this._pass("snowSharpen", 1.0, ["invRes", "amount"], [],
            // The last stage before the swapchain, and the only one working on
            // display-encoded values — eight bits is exactly what it needs.
            Constants.TEXTURETYPE_UNSIGNED_BYTE);

        this.passes = [
            this.ssr, this.taa, this.shafts, this.bloomA, this.bloomB,
            this.bloomC, this.dof, this.composite, this.sharpen,
        ];

        this._bind();

        this.engine.onResizeObservable.add(() => {
            for (let i = 0; i < 2; i++) {
                this.history[i].resize({
                    width: this.engine.getRenderWidth(),
                    height: this.engine.getRenderHeight(),
                });
            }
            // The reprojection would be against a differently-shaped frustum and
            // the history against a differently-sized buffer.
            this._historyValid = 0;
        });
    }

    _makeHistory(i) {
        const t = new RenderTargetTexture(
            "taaHistory" + i,
            {
                width: this.engine.getRenderWidth(),
                height: this.engine.getRenderHeight(),
            },
            this.scene,
            {
                generateMipMaps: false,
                generateDepthBuffer: false,
                type: Constants.TEXTURETYPE_HALF_FLOAT,
                format: Constants.TEXTUREFORMAT_RGBA,
                samplingMode: Constants.TEXTURE_BILINEAR_SAMPLINGMODE,
            }
        );
        t.wrapU = Constants.TEXTURE_CLAMP_ADDRESSMODE;
        t.wrapV = Constants.TEXTURE_CLAMP_ADDRESSMODE;
        // Never rendered by the scene — the temporal resolve writes it directly.
        t.refreshRate = RenderTargetTexture.REFRESHRATE_RENDER_ONCE;
        t.renderList = [];
        return t;
    }

    _pass(shader, ratio, uniforms, samplers, textureType) {
        return new PostProcess(shader + "_" + this._nextId(), shader, {
            uniforms,
            samplers,
            size: ratio,
            camera: this.camera,
            samplingMode: Constants.TEXTURE_BILINEAR_SAMPLINGMODE,
            engine: this.engine,
            reusable: false,
            textureType,
            shaderLanguage: ShaderLanguage.WGSL,
        });
    }

    _nextId() {
        this._id = (this._id || 0) + 1;
        return this._id;
    }

    _bind() {
        const depthTex = this.depth.rtt;

        this.ssr.onApply = (e) => {
            e.setVector2("projInfo", this._projInfo);
            e.setVector2("invRes", this._invRes);
            e.setFloat("enabled", S.ssr ? 1 : 0);
            e.setFloat("strength", 1.0);
            e.setTexture("depthTex", depthTex);
        };

        this.taa.onApply = (e) => {
            e.setMatrix("prevViewProj", this._prevViewProj);
            e.setMatrix("invView", this._invView);
            e.setVector2("projInfo", this._projInfo);
            e.setVector2("invRes", this._invRes);
            e.setVector2("jitterNdc", this._jitterNdc);
            e.setFloat("historyValid", this._historyValid);
            e.setFloat("enabled", S.taa ? 1 : 0);
            e.setFloat("feedback", 0.90);
            e.setTexture("historyTex", this.history[1 - this._k]);
            e.setTexture("depthTex", depthTex);
        };

        this.shafts.onApply = (e) => {
            e.setVector2("sunUV", this._sunUV);
            e.setFloat("sunOnScreen", this._sunOnScreen);
            e.setColor3("sunColor", this._sunColor);
            e.setFloat("enabled", S.showLightShafts ? 1 : 0);
            e.setFloat("strength", S.shaftStrength);
            e.setFloat(
                "aspect", this.engine.getRenderWidth() / this.engine.getRenderHeight()
            );
            e.setTexture("depthTex", depthTex);
        };

        // Level 0: the bright pass, reading the resolved frame at full resolution.
        //
        // The tap spacing is *twice* a source texel, not one. Each of these
        // levels is a 4x reduction, so one destination pixel covers a 4x4 block
        // of the source; a thirteen-tap kernel spaced at one texel only reaches
        // half of it, and the half it misses aliases straight into the glow. On a
        // field that emits discrete single-pixel glints by design, that shows up
        // as a bloom that seethes.
        this.bloomA.onApply = (e) => {
            e.setFloat2("srcTexel", this._invRes.x * 2, this._invRes.y * 2);
            e.setFloat("prefilter", 1);
            const c = this._bloomCurve;
            e.setFloat4("curve", c.x, c.y, c.z, c.w);
            e.setTexture("sourceTex", this.history[this._k]);
        };

        // Level 1: a straight 4x reduction of level 0.
        this.bloomB.onApply = (e) => {
            const t = _texelOf(this.bloomA, _tmpTexel);
            e.setFloat2("srcTexel", t.x * 2, t.y * 2);
            e.setFloat("prefilter", 0);
            e.setFloat4("curve", 0, 0, 0, 0);
            e.setTextureFromPostProcessOutput("sourceTex", this.bloomA);
        };

        this.bloomC.onApply = (e) => {
            // Spread wider than one texel: this is the level that has to read as
            // haze in the air rather than as a ring around the sun.
            const t = _texelOf(this.bloomB, _tmpTexel);
            e.setFloat2("srcTexel", t.x * 2.0, t.y * 2.0);
        };

        this.dof.onApply = (e) => {
            e.setVector2("invRes", this._invRes);
            e.setFloat("enabled", S.dof ? 1 : 0);
            e.setFloat("focusDist", this.focusDist);
            // Scaled to the frame height, so the look does not change with
            // resolution or with the resolution-scale slider. 0.0024 is 3.5 px
            // at 1440p; against the pass's own 1.5 px early-out only pixels past
            // roughly three hundred metres run a gather at all.
            e.setFloat("maxCoc", this.engine.getRenderHeight() * 0.0024);
            e.setTexture("sceneTex", this.history[this._k]);
            e.setTexture("depthTex", depthTex);
        };

        this.composite.onApply = (e) => {
            e.setFloat("exposure", S.exposure);
            e.setFloat("contrast", S.contrast);
            e.setFloat("mode", TONEMAP_MODES[S.tonemap] ?? 0);
            e.setFloat("grainAmount", S.grain ? S.grainStrength : 0);
            e.setFloat("time", this.time);
            e.setFloat("vignette", 0.22);
            e.setFloat(
                "speedStreak",
                S.windStreaks ? this.speedStreak * S.streakStrength : 0
            );
            e.setFloat("bloomAmount", S.bloom ? S.bloomStrength : 0);
            e.setFloat("shaftAmount", S.showLightShafts ? 1 : 0);
            e.setTextureFromPostProcessOutput("bloomNear", this.bloomA);
            e.setTextureFromPostProcessOutput("bloomFar", this.bloomC);
            e.setTextureFromPostProcessOutput("shaftsTex", this.shafts);
        };

        this.sharpen.onApply = (e) => {
            e.setVector2("invRes", this._invRes);
            e.setFloat("amount", S.sharpen ? S.sharpenStrength : 0);
        };
    }

    /**
     * Recompute the projection with this frame's subpixel offset, and publish
     * everything the screen-space passes derive from the camera.
     *
     * Must run after the rig has moved the camera and set its field of view, and
     * before `scene.render()` — the depth prepass and the beauty pass both take
     * their matrix from the scene at render time.
     *
     * @param {number} dt
     * @param {number} [streak] 0..1 speed-streak amount for this frame
     * @param {number} [focus] metres to the subject, for depth of field
     */
    update(dt, streak, focus) {
        this.time += dt;
        if (streak !== undefined) this.speedStreak = streak;
        if (focus !== undefined) {
            // Eased: a focal plane that snaps when the spring arm re-lengthens is
            // the one thing a restrained depth of field can still make obvious.
            this.focusDist += (focus - this.focusDist) * Math.min(1, dt * 4.0);
        }

        const cam = this.camera;
        const w = this.engine.getRenderWidth();
        const h = this.engine.getRenderHeight();
        this._invRes.set(1 / w, 1 / h);

        // ---- unjittered matrices, for reprojection and for the sun ---------
        cam.unfreezeProjectionMatrix();
        _view.copyFrom(cam.getViewMatrix(true));
        _proj.copyFrom(cam.getProjectionMatrix(true));
        _view.multiplyToRef(_proj, this._curViewProj);
        _view.invertToRef(this._invView);

        const tanHalf = Math.tan(cam.fov * 0.5);
        this._projInfo.set(tanHalf * (w / h), tanHalf);

        // ---- the sun on screen, for the shafts -----------------------------
        _sunWorld.copyFrom(this.sky.sunDir).scaleInPlace(2000).addInPlace(cam.position);
        Vector3.TransformCoordinatesToRef(_sunWorld, this._curViewProj, _sunClip);
        // TransformCoordinates divides by w internally, so a point behind the
        // camera comes back mirrored rather than flagged. The dot product against
        // the view direction is the only honest test.
        const fwdDot = Vector3.Dot(this.sky.sunDir, _camForward(cam));
        this._sunUV.set(_sunClip.x * 0.5 + 0.5, _sunClip.y * 0.5 + 0.5);
        this._sunOnScreen = fwdDot > 0.05 ? 1 : 0;
        this._sunColor.copyFrom(this.sky.sunRadiance);

        // ---- bloom knee ----------------------------------------------------
        // Threshold in exposed units, so it does not move when the exposure
        // slider does. Sunlit snow here exposes to ~1.26, so anything near 1.0
        // puts the entire lit half of the frame above the knee and the bloom
        // becomes a uniform milky veil. At 3.0 the field sits a stop and a half
        // below it and only the sun disc, the glints and lit spray reach it.
        const th = 3.0;
        const knee = 1.4;
        this._bloomCurve.x = th;
        this._bloomCurve.y = th - knee;
        this._bloomCurve.z = knee * 2;
        this._bloomCurve.w = 0.25 / Math.max(knee, 1e-4);

        // ---- jitter ---------------------------------------------------------
        let jx = 0;
        let jy = 0;
        if (S.taa) {
            const idx = (this._frame % (JITTER.length >> 1)) * 2;
            jx = JITTER[idx];
            jy = JITTER[idx + 1];
        }
        this._jitterNdc.set((2 * jx) / w, (2 * jy) / h);

        const pm = cam.getProjectionMatrix();
        pm.m[8] += this._jitterNdc.x;
        pm.m[9] += this._jitterNdc.y;
        pm.markAsUpdated();
        // Nothing may recompute this between here and the end of the frame, or
        // the depth prepass and the beauty pass would be jittered differently.
        cam.freezeProjectionMatrix();

        // ---- history ping-pong ---------------------------------------------
        this._k = 1 - this._k;
        this.shafts._forcedOutputTexture = this.history[this._k].renderTarget;

        this._frame++;
    }

    /**
     * Latch this frame's camera for next frame's reprojection. Called after
     * `scene.render()`.
     */
    endFrame() {
        this._prevViewProj.copyFrom(this._curViewProj);
        // Two frames of grace: the first fills history[0], the second history[1],
        // and only then is there something at `1 - k` worth reading.
        if (this._historyValid < 1) this._historyValid += 0.5;
    }

    /** Discard the temporal history — after a teleport, or a resolution change. */
    resetHistory() {
        this._historyValid = 0;
    }

    dispose() {
        for (let i = 0; i < this.passes.length; i++) this.passes[i].dispose(this.camera);
        this.history[0].dispose();
        this.history[1].dispose();
    }
}

// --------------------------------------------------------------------- helpers

const _tmpTexel = new Vector2();
const _fwdScratch = new Vector3();

/** One texel of a post-process's *output*, in UV. */
function _texelOf(pass, out) {
    const t = pass._outputTexture;
    const w = t ? t.width : pass.width;
    const h = t ? t.height : pass.height;
    return out.set(1 / Math.max(1, w), 1 / Math.max(1, h));
}

/** The camera's world-space forward, without allocating. */
function _camForward(cam) {
    const m = cam.getViewMatrix().m;
    // Third column of the view matrix is the world-space view direction.
    return _fwdScratch.set(m[2], m[6], m[10]);
}

/**
 * Halton(2,3) on [-0.5, 0.5], flattened to (x, y) pairs.
 * @param {number} n
 */
function buildHalton(n) {
    const out = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
        out[i * 2] = radical(i + 1, 2) - 0.5;
        out[i * 2 + 1] = radical(i + 1, 3) - 0.5;
    }
    return out;
}

function radical(i, base) {
    let f = 1;
    let r = 0;
    let k = i;
    while (k > 0) {
        f /= base;
        r += f * (k % base);
        k = Math.floor(k / base);
    }
    return r;
}
