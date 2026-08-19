/**
 * The character system.
 *
 * Owns the skeleton, the garment simulation, the three meshes and the seven
 * pipelines that draw them, and the single small texture that carries every
 * per-frame transform to the GPU.
 *
 * The transform texture is the spine of the whole thing. Rows 0-3 hold bone
 * skinning matrices, rows 4 and beyond hold simulated cloth nodes, and one
 * `update()` per frame writes both into a pre-allocated staging array and
 * uploads it once. Nothing else crosses to the GPU: no per-frame buffers, no
 * matrix uniforms, no vertex data.
 *
 * Allocation per frame: none.
 */

import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Constants } from "@babylonjs/core/Engines/constants";
import { Vector2, Vector3, Vector4, Color3 } from "@babylonjs/core/Maths/math";

import { Figure, BONE_COUNT } from "./figure.js";
import { makePanels, ClothSolver } from "./cloth.js";
import { buildBody, buildFur, buildClothMesh } from "./build.js";
import { S } from "../core/settings.js";
import { whenReady, bindMatrixArray } from "../core/gpuUtil.js";
import { CASCADE_COUNT } from "../render/shadows.js";
import { SPELL_LIGHT_UNIFORMS } from "../spells/spellLights.js";

/** Transform texture geometry. Width covers the widest of bones or panel cols. */
const TEX_W = 48;
const TEX_H = 64;
/** First texture row available to cloth panels; 0-3 are the bone matrices. */
const CLOTH_ROW0 = 4;

/** How many cascades the figure casts into. See `ShadowSystem.registerCaster`. */
const CHAR_CASCADES = 2;

/**
 * Material palette. Eight slots, uploaded as two vec4 arrays so every value is
 * live-tunable and nothing is baked into the shader.
 *
 * SANDSTORM Phase 5: retinted from SNOWFLOW's blue-indigo winter palette onto
 * a desert traveler's layered charcoal / weathered sandstone / rust palette
 * (see the file header for the layer assignment `M_ROBE`..`M_METAL` follow).
 * The slot *indices* and what geometry reads which slot (`build.js`,
 * `cloth.js`) are unchanged from SNOWFLOW — only the eight colours are new,
 * plus one previously-spare slot (7) now carries a real material (metal
 * accents) instead of sitting unused.
 *
 * Two properties of these numbers are deliberate and carried over from
 * SNOWFLOW's own reasoning, restated for the new hue:
 *
 * They are still fairly saturated, just on the rust/ochre axis rather than
 * blue. At a low, warm sun the direct beam is strongly red-shifted, so a
 * weak, desaturated brown reads as flat grey once lit — the accent slot
 * especially needs real saturation to survive as a rust colour rather than
 * washing out to the same tan as the ground.
 *
 * They are still dark. AgX compresses hard, so a dark garment several stops
 * down from the sand's own albedo is what keeps the traveler read as a
 * silhouette against the field rather than blending into it — sand's albedo
 * dropped from SNOWFLOW's ~0.86 to Phase 1's ~0.6-0.8, so the character no
 * longer needs to be *quite* as dark as SNOWFLOW's figure to still separate,
 * but "not beige" is still the operative constraint (item 7).
 */
// Phase 8B: lightened off SNOWFLOW-derived near-black toward genuinely
// separable hues — the brief's explicit "the character remains too dark,
// establish clear PBR separation" — without brightening the frame globally
// (that stays a `settings.js`/tonemap question, untouched here). Each slot
// still sits several stops under the sand's own albedo, so the silhouette
// read the file header explains is preserved; only the *relative* spread
// between slots widened; charcoal-brown coat, reddish-brown leather, faded
// rust/saffron trim, and a warm bronze-toned metal instead of a neutral
// dark grey.
const PALETTE = [
    // rgb, roughness
    [0.058, 0.044, 0.034, 0.80], // 0 M_ROBE:   outer coat, charcoal-brown rough cloth
    [0.178, 0.146, 0.106, 0.74], // 1 M_MANTLE: shoulder wrap, dusty beige/khaki
    [0.238, 0.200, 0.152, 0.78], // 2 M_TUNIC:  inner tunic lining, warm sandstone
    [0.078, 0.044, 0.030, 0.52], // 3 M_LEATHER: belt, boots, wraps — dark reddish-brown leather
    [0.145, 0.100, 0.075, 0.85], // 4 M_SKIN:   deep in shadow under the hood/scarf
    [0.470, 0.220, 0.095, 0.60], // 5 M_TRIM:   the one controlled accent — faded rust/saffron
    [0.370, 0.300, 0.215, 0.88], // 6 M_FUR:    frayed scarf/hem fibres, dusty beige
    [0.115, 0.088, 0.058, 0.36], // 7 M_METAL:  buckle/clip/strap accents, weathered bronze
];

/**
 * (sheen, anisotropy, transmission, weave depth) per slot.
 *
 * Transmission is still the number to be careful with — a generous value on
 * a dark garment does not make it glow, it washes the albedo out toward the
 * warm sun's own colour. Heavy coat fabric stays close to opaque; only the
 * thin tunic lining gets a real value. `M_METAL` carries near-zero sheen and
 * weave (bare, hard-edged accents, not fabric) and the lowest roughness in
 * the palette, which is as close to a specular metal read as this shader's
 * dielectric-only Fresnel can get without extending the BRDF itself.
 */
const PARAMS = [
    [0.20, 0.50, 0.04, 1.00], // robe: heavy outer coat, low transmission
    [0.30, 0.40, 0.08, 0.85], // mantle: lighter wrap, breathes a little more
    [0.38, 0.25, 0.20, 1.05], // tunic: thin under-layer, the one real glow
    [0.05, 0.15, 0.01, 0.30], // leather: minimal sheen, no weave
    [0.05, 0.00, 0.08, 0.00], // skin: unchanged role from SNOWFLOW
    [0.30, 0.55, 0.10, 0.95], // trim/rust: coarse wrapped-fabric weave, strong fold shading
    [0.85, 0.00, 0.35, 0.00], // fur-as-fray: still sheen-driven, less transmissive than snow fur was
    [0.04, 0.00, 0.00, 0.00], // metal: sharp, unweathered highlight
];

// ------------------------------------------------------- module-scope scratch
const _droop = new Vector3();
const _screen = new Vector2();
// SANDSTORM: was a pale blue-grey (0.74, 0.755, 0.795) for snow-hood fur.
// Repurposed to a dusty, sun-bleached khaki fibre tone — see build.js's note
// on why the hood fur band itself was removed and only the cuff/wrap band
// (now read as frayed wrap fibres, not fur) remains.
const _furCol = new Color3(0.58, 0.50, 0.38);

export class Character {
    /**
     * @param {import("@babylonjs/core/scene").Scene} scene
     * @param {import("../terrain/terrain.js").Terrain} terrain
     * @param {import("../render/sky.js").Sky} sky
     * @param {import("../render/shadows.js").ShadowSystem} shadows
     * @param {import("./controller.js").CharacterController} controller
     */
    constructor(scene, terrain, sky, shadows, controller) {
        this.scene = scene;
        this.terrain = terrain;
        this.sky = sky;
        this.shadows = shadows;
        this.controller = controller;

        this.figure = new Figure(terrain);
        this.panels = makePanels();
        this.solver = new ClothSolver(this.panels, terrain);

        // ---- transform texture -------------------------------------------
        this._texData = new Float32Array(TEX_W * TEX_H * 4);
        let row = CLOTH_ROW0;
        /** Flat (rowBase, cols, rows, closed) per panel, for the vertex shaders. */
        this._panelParams = new Float32Array(6 * 4);
        for (let i = 0; i < this.panels.length; i++) {
            const p = this.panels[i];
            if (p.cols > TEX_W) throw new Error("panel wider than the transform texture");
            p.nodeRow = row;
            this._panelParams[i * 4] = row;
            this._panelParams[i * 4 + 1] = p.cols;
            this._panelParams[i * 4 + 2] = p.rows;
            this._panelParams[i * 4 + 3] = p.closed ? 1 : 0;
            row += p.rows;
        }
        if (row > TEX_H) throw new Error("transform texture too short for the panels");

        this.charTex = RawTexture.CreateRGBATexture(
            this._texData, TEX_W, TEX_H, scene,
            false, false,
            Constants.TEXTURE_NEAREST_SAMPLINGMODE,
            Constants.TEXTURETYPE_FLOAT
        );
        this.charTex.wrapU = Constants.TEXTURE_CLAMP_ADDRESSMODE;
        this.charTex.wrapV = Constants.TEXTURE_CLAMP_ADDRESSMODE;

        // ---- palette ------------------------------------------------------
        this._matAlbedo = new Float32Array(32);
        this._matParams = new Float32Array(32);
        for (let i = 0; i < 8; i++) {
            for (let k = 0; k < 4; k++) {
                this._matAlbedo[i * 4 + k] = PALETTE[i][k];
                this._matParams[i * 4 + k] = PARAMS[i][k];
            }
        }

        // ---- meshes and materials -----------------------------------------
        this.bodyMesh = buildBody(scene);
        this.clothMesh = buildClothMesh(scene, this.panels);
        this.furMesh = buildFur(scene);

        this.bodyMat = this._makeSurfaceMaterial("charBody", "char", "char", false);
        this.clothMat = this._makeSurfaceMaterial("charCloth", "cloth", "char", true);
        this.furMat = this._makeFurMaterial();

        this.bodyMesh.material = this.bodyMat;
        this.clothMesh.material = this.clothMat;
        this.furMesh.material = this.furMat;

        for (const m of [this.bodyMesh, this.clothMesh, this.furMesh]) {
            m.renderingGroupId = 1;
        }

        /** @type {ShaderMaterial[]} */
        this._depthMats = [];
        shadows.registerCaster(
            this.bodyMesh, (c) => this._makeDepthMaterial("charDepth", c, false), CHAR_CASCADES
        );
        shadows.registerCaster(
            this.clothMesh, (c) => this._makeDepthMaterial("clothDepth", c, true), CHAR_CASCADES
        );
        // Fur is not registered as a caster. Its shadow lands inside the hood's
        // own, an alpha-tested 22-shell depth pass is not cheap, and what it
        // would contribute is a slightly fuzzier edge on a shadow already an
        // order of magnitude softer than that.

        this.triangles =
            this.bodyMesh.metadata.triangles +
            this.clothMesh.metadata.triangles +
            this.furMesh.metadata.triangles;

        this._cameraPos = new Vector3();
        this._splits = new Vector4(0, 0, 0, 0);
        this._needSettle = true;

        this._visible = true;
        this.setVisible(S.showCharacter !== false);
    }

    /**
     * One surface material. The body and the garments differ only in their
     * vertex program — the fabric shading, the shadow lookup and the aerial
     * perspective are literally the same code.
     */
    _makeSurfaceMaterial(name, vertex, fragment, isCloth) {
        const uniforms = [
            "viewProjection", "cameraPos",
            "sunDir", "sunRadiance", "shR",
            "cascadeMatrices", "cascadeSplits", "cascadeParams",
            "shadowTexel", "shadowSoftness", "shadowBias",
            "matAlbedo", "matParams",
            "fogDensity", "fogHeightFalloff", "fogStart", "aerialStrength",
            "ambientIntensity", "sssStrength", "weaveDensity",
            "screenSize", "groundY",
            ...SPELL_LIGHT_UNIFORMS,
        ];
        const attributes = isCloth
            ? ["position", "uv", "aux"]
            : ["position", "normal", "uv", "aux", "boneIdx", "boneWt"];
        if (isCloth) uniforms.push("panelParams");

        const mat = new ShaderMaterial(
            name, this.scene, { vertex, fragment },
            {
                attributes,
                uniforms,
                samplers: [
                    "charTex", "skyLUT", "cascade0", "cascade1", "cascade2",
                ],
                shaderLanguage: ShaderLanguage.WGSL,
            }
        );
        // Every garment is an open sheet and the cowl is a shell, so both faces
        // are visible. The fragment shader turns the normal toward the viewer
        // rather than trusting winding — see the note there.
        mat.backFaceCulling = false;
        mat.setTexture("charTex", this.charTex);
        mat.setTexture("skyLUT", this.sky.lut);
        for (let i = 0; i < CASCADE_COUNT; i++) {
            mat.setTexture("cascade" + i, this.shadows.maps[i]);
        }
        return mat;
    }

    _makeFurMaterial() {
        const mat = new ShaderMaterial(
            "charFur", this.scene, { vertex: "fur", fragment: "fur" },
            {
                attributes: ["position", "normal", "uv", "aux", "boneIdx", "boneWt"],
                uniforms: [
                    "viewProjection", "cameraPos", "furDroop",
                    "sunDir", "sunRadiance", "shR",
                    "cascadeMatrices", "cascadeSplits", "cascadeParams",
                    "shadowTexel", "shadowSoftness", "shadowBias",
                    "fogDensity", "fogHeightFalloff", "fogStart", "aerialStrength",
                    "ambientIntensity", "furDensity", "furColor",
                ],
                samplers: ["charTex", "skyLUT", "cascade0", "cascade1", "cascade2"],
                shaderLanguage: ShaderLanguage.WGSL,
            }
        );
        mat.backFaceCulling = false;
        mat.setTexture("charTex", this.charTex);
        mat.setTexture("skyLUT", this.sky.lut);
        for (let i = 0; i < CASCADE_COUNT; i++) {
            mat.setTexture("cascade" + i, this.shadows.maps[i]);
        }
        return mat;
    }

    _makeDepthMaterial(vertex, cascade, isCloth) {
        const uniforms = ["lightViewProjection"];
        if (isCloth) uniforms.push("panelParams");
        const mat = new ShaderMaterial(
            vertex + cascade, this.scene,
            { vertex, fragment: "terrainDepth" },
            {
                attributes: isCloth ? ["position"] : ["position", "boneIdx", "boneWt"],
                uniforms,
                samplers: ["charTex"],
                shaderLanguage: ShaderLanguage.WGSL,
                // Forces a distinct Effect per cascade, so each can hold its own
                // matrix without any mid-frame uniform juggling.
                defines: ["CHAR_CASCADE " + cascade],
            }
        );
        mat.backFaceCulling = false;
        mat.setTexture("charTex", this.charTex);
        if (isCloth) mat.setArray4("panelParams", this._panelParams);
        this._depthMats.push(mat);
        return mat;
    }

    /**
     * Depth-prepass materials for the body and the garments.
     *
     * The fur is left out on the same grounds it is left out of the shadow
     * cascades: it is an alpha-tested twenty-two-shell pass, and what it would
     * contribute is a fractionally fuzzier occlusion edge on a hood rim that is
     * already inside its own baked cavity.
     *
     * @param {import("../render/depthPass.js").DepthPass} depth
     */
    registerPrepass(depth) {
        this._prepassMats = [];
        for (const spec of [
            { mesh: this.bodyMesh, vertex: "charPrepass", cloth: false },
            { mesh: this.clothMesh, vertex: "clothPrepass", cloth: true },
        ]) {
            const uniforms = ["viewProjection"];
            if (spec.cloth) uniforms.push("panelParams");
            const mat = new ShaderMaterial(
                spec.vertex, this.scene,
                { vertex: spec.vertex, fragment: "prepass" },
                {
                    attributes: spec.cloth
                        ? ["position"]
                        : ["position", "boneIdx", "boneWt"],
                    uniforms,
                    samplers: ["charTex"],
                    shaderLanguage: ShaderLanguage.WGSL,
                }
            );
            mat.backFaceCulling = false;
            mat.setTexture("charTex", this.charTex);
            if (spec.cloth) mat.setArray4("panelParams", this._panelParams);
            this._prepassMats.push(mat);
            depth.registerCaster(spec.mesh, mat);
        }
    }

    setVisible(v) {
        this._visible = !!v;
        this.bodyMesh.isVisible = this._visible;
        this.clothMesh.isVisible = this._visible;
        this.furMesh.isVisible = this._visible;
    }

    /**
     * Advance the figure and the garments, then push one texture upload and one
     * set of uniforms.
     *
     * Order matters: the skeleton has to be posed before the cloth can find its
     * kinematic targets, and both have to be written before the texture goes up,
     * or the garments render one frame behind the body they hang from.
     *
     * @param {number} dt
     */
    update(dt) {
        const ch = this.controller;
        this.figure.update(dt, ch);
        if (this._needSettle) {
            this._settleCloth();
            this._needSettle = false;
        }
        this.solver.update(dt, this.figure, ch);
        this._uploadTransforms();
    }

    /**
     * Push this frame's uniforms. Split from `update` because the garments have
     * to be solved before the contact system reads the feet, while the uniforms
     * cannot be written until the camera has moved and the cascades have been
     * refitted. Doing both at one point in the frame means one of them is a
     * frame stale, and the visible symptom — a shadow that lags the figure by a
     * frame during a fast carve — is exactly the sort of thing that reads as
     * "cheap" without being identifiable.
     *
     * @param {Vector3} cameraPos
     */
    sync(cameraPos) {
        this._cameraPos.copyFrom(cameraPos);
        this._pushUniforms();
    }

    /**
     * Drop every garment straight onto its kinematic target.
     *
     * Done once, on the first update. The panels are authored in bind space at
     * the world origin, and letting them fall from there to wherever the player
     * actually spawned takes a second of visible flapping — behind the loading
     * screen if we are lucky, in shot if we are not.
     */
    _settleCloth() {
        const skin = this.figure.skin;
        for (let pi = 0; pi < this.panels.length; pi++) {
            const p = this.panels[pi];
            for (let k = 0; k < p.count; k++) {
                const b = p.bone[k] * 16;
                const o = k * 3;
                const x = p.bindPos[o], y = p.bindPos[o + 1], z = p.bindPos[o + 2];
                p.pos[o] = skin[b] * x + skin[b + 4] * y + skin[b + 8] * z + skin[b + 12];
                p.pos[o + 1] = skin[b + 1] * x + skin[b + 5] * y + skin[b + 9] * z + skin[b + 13];
                p.pos[o + 2] = skin[b + 2] * x + skin[b + 6] * y + skin[b + 10] * z + skin[b + 14];
            }
            p.prev.set(p.pos);
        }
    }

    _uploadTransforms() {
        const d = this._texData;
        const skin = this.figure.skin;

        // Rows 0-3: bone matrices, one column per bone, one row per matrix
        // column. Written as four separate row writes rather than one blit,
        // because the texture is column-major in bones and row-major in memory.
        for (let b = 0; b < BONE_COUNT; b++) {
            const s = b * 16;
            for (let c = 0; c < 4; c++) {
                const o = (c * TEX_W + b) * 4;
                d[o] = skin[s + c * 4];
                d[o + 1] = skin[s + c * 4 + 1];
                d[o + 2] = skin[s + c * 4 + 2];
                d[o + 3] = skin[s + c * 4 + 3];
            }
        }

        for (let pi = 0; pi < this.panels.length; pi++) {
            const p = this.panels[pi];
            const pos = p.pos;
            for (let j = 0; j < p.rows; j++) {
                const rowO = ((p.nodeRow + j) * TEX_W) * 4;
                for (let i = 0; i < p.cols; i++) {
                    const s = (j * p.cols + i) * 3;
                    const o = rowO + i * 4;
                    d[o] = pos[s];
                    d[o + 1] = pos[s + 1];
                    d[o + 2] = pos[s + 2];
                    d[o + 3] = 1;
                }
            }
        }

        this.charTex.update(d);
    }

    _pushUniforms() {
        const sky = this.sky;
        const sh = this.shadows;
        const ch = this.controller;

        // Fur droop: gravity, plus the apparent wind, plus the character's own
        // acceleration thrown the other way. Scaled to metres of tip travel.
        const a = (S.windDirection * Math.PI) / 180;
        const ws = 0.6 * S.windStrength;
        _droop.set(
            Math.sin(a) * ws * 0.006 - ch.velocity.x * 0.0016 - ch.acceleration.x * 0.00018,
            -0.018,
            Math.cos(a) * ws * 0.006 - ch.velocity.z * 0.0016 - ch.acceleration.z * 0.00018
        );

        this._splits.set(sh.splits[0], sh.splits[1], sh.splits[2], sh.splits[3]);

        const mats = [this.bodyMat, this.clothMat, this.furMat];
        for (let i = 0; i < mats.length; i++) {
            const m = mats[i];
            m.setVector3("cameraPos", this._cameraPos);
            m.setVector3("sunDir", sky.sunDir);
            m.setColor3("sunRadiance", sky.sunRadiance);
            m.setArray4("shR", sky.sh);

            bindMatrixArray(m, "cascadeMatrices", sh.matrixData);
            m.setVector4("cascadeSplits", this._splits);
            m.setArray4("cascadeParams", sh.paramData);
            m.setFloat("shadowTexel", sh.texelSize);
            m.setFloat("shadowSoftness", 1.4);
            // Tighter than the terrain's: the figure is small, its cascade is
            // the near one, and a large bias here detaches the contact shadow
            // between the boots and the sand — which is the shadow that tells
            // you the character is standing on the ground rather than in it.
            m.setFloat("shadowBias", 0.012);

            m.setFloat("fogDensity", S.fogDensity);
            m.setFloat("fogHeightFalloff", S.fogHeightFalloff);
            m.setFloat("fogStart", S.fogStart);
            m.setFloat("aerialStrength", S.aerialStrength);
            m.setFloat("ambientIntensity", S.ambientIntensity);
        }

        // World Y of the ground under the character right now — `Figure` already
        // computes this every frame for the pelvis solve, exposed here purely for
        // the fabric shader's procedural weathering (dust low, sun-bleach high).
        // Only the body/cloth materials read it; the fur material has no
        // weathering term.
        const groundY = this.figure.groundY || 0;

        const eng = this.scene.getEngine();
        _screen.set(eng.getRenderWidth(), eng.getRenderHeight());

        for (const m of [this.bodyMat, this.clothMat]) {
            m.setArray4("matAlbedo", this._matAlbedo);
            m.setArray4("matParams", this._matParams);
            m.setFloat("sssStrength", S.sssStrength);
            m.setVector2("screenSize", _screen);
            // Threads per metre. Coarser than SNOWFLOW's wool, closer to a
            // hand-woven cotton/linen weave — still faded out by pixel footprint
            // in the shader well before the figure is far enough away to alias.
            m.setFloat("weaveDensity", 170);
            m.setFloat("groundY", groundY);
        }
        this.clothMat.setArray4("panelParams", this._panelParams);

        this.furMat.setVector3("furDroop", _droop);
        this.furMat.setFloat("furDensity", 250);
        this.furMat.setColor3("furColor", _furCol);
    }

    /** Compile every pipeline behind the loading screen. */
    async warmUp() {
        await whenReady(this.bodyMat, "character body material", [this.bodyMesh, false]);
        await whenReady(this.clothMat, "character cloth material", [this.clothMesh, false]);
        await whenReady(this.furMat, "character fur material", [this.furMesh, false]);
        for (let i = 0; i < this._depthMats.length; i++) {
            const m = this._depthMats[i];
            const mesh = m.name.indexOf("cloth") === 0 ? this.clothMesh : this.bodyMesh;
            await whenReady(m, m.name, [mesh, false]);
        }
        if (this._prepassMats) {
            for (let i = 0; i < this._prepassMats.length; i++) {
                const m = this._prepassMats[i];
                const mesh = m.name.indexOf("cloth") === 0 ? this.clothMesh : this.bodyMesh;
                await whenReady(m, m.name, [mesh, false]);
            }
        }
    }

    dispose() {
        this.bodyMesh.dispose();
        this.clothMesh.dispose();
        this.furMesh.dispose();
        this.bodyMat.dispose();
        this.clothMat.dispose();
        this.furMat.dispose();
        this.charTex.dispose();
    }
}
