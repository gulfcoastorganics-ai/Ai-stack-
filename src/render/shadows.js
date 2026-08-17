/**
 * Cascaded shadow maps, hand-rolled.
 *
 * Babylon's CascadedShadowGenerator is perfectly good, and is not used here for
 * a specific reason: the terrain has no CPU-side geometry. Its vertices are
 * grid indices, and where they actually land is decided by the clipmap vertex
 * shader from the camera position. Any generic depth pass would render the
 * undisplaced lattice — a flat sheet at y=0 — and the terrain would shadow
 * against a surface that does not exist. The depth pass has to run the same
 * displacement code, which means owning the pass.
 *
 * Owning it also buys the filtering: depth goes into plain R32F colour targets,
 * so PCSS can run a real blocker search. A hardware comparison sampler only
 * ever returns a pre-thresholded result, which a blocker search cannot use.
 *
 * Three cascades, not four. The fourth would cover 320 m and beyond, where the
 * aerial perspective has already compressed contrast to the point that no
 * shadow in it is legible — it would be four milliseconds of shadow map nobody
 * can see.
 */

import { Vector3, Vector4, Matrix } from "@babylonjs/core/Maths/math.vector";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { RenderTargetTexture } from "@babylonjs/core/Materials/Textures/renderTargetTexture";
import { Constants } from "@babylonjs/core/Engines/constants";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";

export const CASCADE_COUNT = 3;
const RESOLUTION = 2048;

/** Far distance of each cascade, metres. */
const SPLITS = [26, 95, 330];

// ------------------------------------------------------- module-scope scratch
const _corners = [];
for (let i = 0; i < 8; i++) _corners.push(new Vector3());
const _center = new Vector3();
const _eye = new Vector3();
const _up = new Vector3(0, 1, 0);
const _right = new Vector3();
const _lup = new Vector3();
const _tmp = new Vector3();
const _edge = new Vector3();
const _invViewProj = new Matrix();
const _lightView = new Matrix();
const _lightProj = new Matrix();

// NDC cube corners. WebGPU depth range is [0,1], not [-1,1].
const NDC = [
    [-1, -1, 0], [1, -1, 0], [1, 1, 0], [-1, 1, 0],
    [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1],
];

export class ShadowSystem {
    /**
     * @param {import("@babylonjs/core/scene").Scene} scene
     */
    constructor(scene) {
        this.scene = scene;
        this.engine = scene.getEngine();

        /** @type {RenderTargetTexture[]} */
        this.maps = [];
        /** @type {ShaderMaterial[]} */
        this.materials = [];
        /** @type {Matrix[]} */
        this.matrices = [];
        /** Flat array of 16*CASCADE_COUNT floats for the snow material UBO. */
        this.matrixData = new Float32Array(16 * CASCADE_COUNT);
        this.splits = new Float32Array(4);
        for (let i = 0; i < CASCADE_COUNT; i++) this.splits[i] = SPLITS[i];
        this.splits[3] = SPLITS[CASCADE_COUNT - 1];

        this.texelSize = 1 / RESOLUTION;
        this.resolution = RESOLUTION;

        /**
         * Per cascade, as vec4s for the shader: (depth range m, ortho width m,
         * 0, 0). PCSS needs both to work in metres rather than in NDC.
         * @type {Vector4[]}
         */
        this.params = [];
        for (let i = 0; i < CASCADE_COUNT; i++) this.params.push(new Vector4(1, 1, 0, 0));
        /** Flat mirror of `params` for the UBO upload. */
        this.paramData = new Float32Array(4 * CASCADE_COUNT);

        for (let i = 0; i < CASCADE_COUNT; i++) {
            const rtt = new RenderTargetTexture(
                "cascade" + i,
                { width: RESOLUTION, height: RESOLUTION },
                scene,
                {
                    generateMipMaps: false,
                    generateDepthBuffer: true,
                    type: Constants.TEXTURETYPE_FLOAT,
                    format: Constants.TEXTUREFORMAT_RED,
                    samplingMode: Constants.TEXTURE_BILINEAR_SAMPLINGMODE,
                }
            );
            rtt.wrapU = Constants.TEXTURE_CLAMP_ADDRESSMODE;
            rtt.wrapV = Constants.TEXTURE_CLAMP_ADDRESSMODE;
            // Cleared to the far plane: anything unwritten occludes nothing.
            rtt.clearColor = new Color4(1, 1, 1, 1);
            rtt.refreshRate = RenderTargetTexture.REFRESHRATE_RENDER_ONEVERYFRAME;
            rtt.renderList = [];
            rtt.skipInitialClear = false;

            scene.customRenderTargets.push(rtt);
            this.maps.push(rtt);
            this.matrices.push(new Matrix());
        }

        this.lightDir = new Vector3(0, -1, 0);

        /**
         * World height range the casters occupy. Feeds the light volume's depth
         * solve in `_fitCascade`; conservative defaults until the heightfield is
         * baked and `setHeightBounds` narrows them.
         */
        this.minHeight = -60;
        this.maxHeight = 60;
        /** Slack on the cascade's Y extent, covering the texel snap. */
        this.texelWorldPad = 2;
    }

    /**
     * Tell the cascade fitter how tall the world actually is.
     * @param {number} min @param {number} max metres
     */
    setHeightBounds(min, max) {
        this.minHeight = min;
        this.maxHeight = max;
    }

    /**
     * Register a mesh as a shadow caster, rendered with `material` (which must
     * declare a `lightViewProjection` uniform).
     *
     * One material instance per cascade, so each can hold its own matrix without
     * any mid-frame uniform-buffer juggling.
     *
     * `cascades` limits how far out a caster is drawn. The terrain needs all
     * three; a two-metre character does not — cascade 2 covers 330 m at 32 cm
     * per texel, where the whole figure is two texels wide and its shadow is a
     * grey smudge nobody can distinguish from the dune it is standing on. Skipping
     * it saves a full re-skin and re-solve of the cloth grid per frame.
     *
     * @param {import("@babylonjs/core/Meshes/mesh").Mesh} mesh
     * @param {(cascade:number) => ShaderMaterial} makeMaterial
     * @param {number} [cascades] how many cascades to cast into, from the near end
     */
    registerCaster(mesh, makeMaterial, cascades) {
        const n = Math.min(cascades === undefined ? CASCADE_COUNT : cascades, CASCADE_COUNT);
        for (let i = 0; i < n; i++) {
            const mat = makeMaterial(i);
            this.maps[i].renderList.push(mesh);
            this.maps[i].setMaterialForRendering(mesh, mat);
            this.materials.push(mat);
            if (!this._perCascade) this._perCascade = [];
            (this._perCascade[i] ||= []).push(mat);
        }
    }

    /**
     * Refit every cascade to the current camera frustum and sun direction.
     * @param {import("@babylonjs/core/Cameras/camera").Camera} camera
     * @param {Vector3} sunDir unit vector pointing *toward* the sun
     */
    update(camera, sunDir) {
        this.lightDir.copyFrom(sunDir).scaleInPlace(-1).normalize();

        const view = camera.getViewMatrix();
        const proj = camera.getProjectionMatrix();
        view.multiplyToRef(proj, _invViewProj);
        _invViewProj.invert();

        const near = camera.minZ;
        // The camera's *far plane*, not the last cascade split: `_fitCascade`
        // re-parameterises the frustum's corner edges, which run minZ..maxZ, so
        // that is the span each cut must be normalised against.
        const farPlane = camera.maxZ;

        let sliceNear = near;
        for (let c = 0; c < CASCADE_COUNT; c++) {
            const sliceFar = SPLITS[c];
            this._fitCascade(c, sliceNear, sliceFar, near, farPlane);
            // Overlap slices slightly so the cross-fade band has real data in
            // both cascades.
            sliceNear = sliceFar * 0.88;
        }

        // Flatten for the UBO upload.
        for (let c = 0; c < CASCADE_COUNT; c++) {
            this.matrices[c].copyToArray(this.matrixData, c * 16);
            const p = this.params[c];
            this.paramData[c * 4] = p.x;
            this.paramData[c * 4 + 1] = p.y;
            this.paramData[c * 4 + 2] = p.z;
            this.paramData[c * 4 + 3] = p.w;
        }
    }

    _fitCascade(c, sliceNear, sliceFar, camNear, camFar) {
        // Frustum slice corners, by unprojecting the NDC cube and re-cutting it
        // at the slice distances along each edge.
        for (let i = 0; i < 8; i++) {
            const n = NDC[i];
            _tmp.set(n[0], n[1], n[2]);
            Vector3.TransformCoordinatesToRef(_tmp, _invViewProj, _corners[i]);
        }
        for (let i = 0; i < 4; i++) {
            const nearC = _corners[i];
            const farC = _corners[i + 4];
            _tmp.copyFrom(farC).subtractInPlace(nearC);
            const len = _tmp.length();
            _tmp.scaleInPlace(1 / len);
            // The unprojected corners span camNear..camFar; re-parameterise.
            const t0 = (sliceNear - camNear) / (camFar - camNear);
            const t1 = (sliceFar - camNear) / (camFar - camNear);
            farC.copyFrom(nearC).addInPlace(_tmp.scale(len * t1));
            nearC.addInPlace(_tmp.scale(len * t0));
        }

        // Bounding *sphere*, not box. A sphere is rotation-invariant, so the
        // fitted extent does not change as the camera turns — which is what
        // stops the shadow edges crawling when you look around.
        _center.setAll(0);
        for (let i = 0; i < 8; i++) _center.addInPlace(_corners[i]);
        _center.scaleInPlace(1 / 8);

        let radius = 0;
        for (let i = 0; i < 8; i++) {
            const d = Vector3.Distance(_center, _corners[i]);
            if (d > radius) radius = d;
        }

        // Quantise the radius *relatively*, not to a fixed fraction of a metre.
        // The radius depends only on the FOV, the aspect and the two splits, but
        // it is measured by unprojecting the NDC cube through an inverted
        // view-projection, so it carries a few ULPs of round-trip noise. An
        // absolute quantum lets that noise cross a step, and a radius change
        // rescales the whole map and defeats the snapping below. ~0.4% of the
        // radius sits well above the noise floor at every cascade size and still
        // tracks a real FOV change (the rig widens the FOV with speed).
        radius = Math.max(radius, 0.5);
        const q = Math.pow(2, Math.ceil(Math.log2(radius)) - 8);
        radius = Math.ceil(radius / q) * q;

        // Degenerate up-vector guard for a sun near the zenith.
        if (Math.abs(this.lightDir.y) > 0.995) _up.set(0, 0, 1);
        else _up.set(0, 1, 0);

        // ---- how deep the light volume actually has to be ------------------
        //
        // Solved rather than budgeted. At a grazing sun the ground lies almost
        // *along* the light: it gains cot(elevation) metres of light-space depth
        // per metre travelled across the light's view, which at 13 degrees is
        // 4.33. Across cascade 2 that is thousands of metres of depth, so any
        // fixed budget clips most of the terrain out of the depth map — and
        // because `radius` is fitted to the camera frustum, the clipping planes
        // then move whenever the camera turns.
        //
        // `_right` is horizontal by construction (up x forward, with up = +Y),
        // so a point's height depends only on its light-space Y and depth:
        //
        //     p.y - c.y = yRel * up.y + depth * fwd.y
        //
        // Rearranged for depth and evaluated at the four combinations of the
        // box's Y extent and the terrain's height extent, that gives the exact
        // range of light-space depth the snow can occupy inside this cascade.
        Vector3.CrossToRef(_up, this.lightDir, _right);
        _right.normalize();
        Vector3.CrossToRef(this.lightDir, _right, _lup);

        // ---- texel snapping ---------------------------------------------
        // Quantise the cascade centre onto the shadow map's own texel lattice,
        // in world space, along the light's two lateral axes. Without it the map
        // resamples every frame and every shadow edge crawls — which TAA smears
        // rather than fixes, and which on this content shows up as the sastrugi's
        // own self-shadowing shimmering as the camera moves.
        //
        // This has to happen here, in world space, *before* the light view matrix
        // is built. Snapping afterwards by projecting `_center` through the matrix
        // that was built to look at it is self-referential: that maps it to
        // light-space (0, 0, backoff) by construction, so both quantised
        // coordinates are identically zero and the snap does nothing. `_right`
        // and `_lup` are the same orthonormal pair `LookAtLH` rebuilds below.
        const texelWorld = (radius * 2) / RESOLUTION;
        const cr = Math.floor(Vector3.Dot(_center, _right) / texelWorld) * texelWorld;
        const cu = Math.floor(Vector3.Dot(_center, _lup) / texelWorld) * texelWorld;
        const cf = Vector3.Dot(_center, this.lightDir);
        _center.set(
            _right.x * cr + _lup.x * cu + this.lightDir.x * cf,
            _right.y * cr + _lup.y * cu + this.lightDir.y * cf,
            _right.z * cr + _lup.z * cu + this.lightDir.z * cf
        );

        // Grazing enough and this runs away — cot(0.5 deg) is 114. Clamped to
        // 2 degrees, past which the sun carries no useful energy anyway and the
        // whole field is in shadow regardless.
        const fy = Math.min(this.lightDir.y, -0.0349);
        const relief = radius + this.texelWorldPad;

        let gMin = Infinity;
        let gMax = -Infinity;
        for (let i = 0; i < 4; i++) {
            const yRel = i < 2 ? -relief : relief;
            const py = i % 2 === 0 ? this.minHeight : this.maxHeight;
            const g = (py - _center.y - yRel * _lup.y) / fy;
            if (g < gMin) gMin = g;
            if (g > gMax) gMax = g;
        }

        // Margin absorbs carved berms, the character and anything else standing
        // proud of the baked heightfield.
        const MARGIN = 12;
        const backoff = MARGIN - gMin;
        _eye.copyFrom(this.lightDir).scaleInPlace(-backoff).addInPlace(_center);

        Matrix.LookAtLHToRef(_eye, _center, _up, _lightView);

        // Both ends now come from the solve above, so the whole terrain inside
        // this cascade is inside the volume — at any sun elevation.
        const near = MARGIN * 0.5;
        const far = backoff + gMax + MARGIN;

        // The 8th argument is `halfZRange` and it is not optional here. It
        // defaults to false, which maps view depth to NDC z in [-1, 1] — the
        // OpenGL convention. WebGPU clips at [0, 1], so everything at z < 0
        // would be thrown away by the rasteriser: half the volume, and the half
        // nearest the sun, which is the half that casts.
        //
        // Centred on light-space zero, which is where `_lightView` puts the
        // (already snapped) cascade centre.
        Matrix.OrthoOffCenterLHToRef(
            -radius, radius,
            -radius, radius,
            near, far,
            _lightProj,
            true
        );

        _lightView.multiplyToRef(_lightProj, this.matrices[c]);

        // World-space extents, so the shader's penumbra estimate is in metres.
        this.params[c].set(far - near, radius * 2, 0, 0);

        const mats = this._perCascade?.[c];
        if (mats) {
            for (let i = 0; i < mats.length; i++) {
                mats[i].setMatrix("lightViewProjection", this.matrices[c]);
            }
        }
    }

    dispose() {
        for (const m of this.maps) m.dispose();
        for (const m of this.materials) m.dispose();
    }
}
