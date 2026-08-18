/**
 * Adapter for the authored Quaternius Male Ranger glTF — a parallel hero
 * character to the procedural `Character` (see `character.js`), not a
 * replacement of it. `CharacterController` stays the single source of
 * gameplay motion; this class only ever *reads* its position/facing and
 * writes them onto a transform node each frame (`sync()`). It never drives
 * movement, never owns physics, and never touches the terrain/deformation/
 * contact systems — those already work off `CharacterController` and the
 * procedural figure's own foot-IK solve (see `snowContact.js`), which keeps
 * running underneath regardless of which model is on screen.
 *
 * Lighting/shadow integration, second pass: the first version of this file
 * used Babylon's own `PBRMaterial` (from the glTF loader) plus a parallel
 * `DirectionalLight`/`HemisphericLight`/`ShadowGenerator` rig — a real
 * approximation of the scene's actual lighting, not the thing itself. This
 * version replaces that with `rangerChar.vertex/fragment.wgsl`: a custom
 * shader built from the SAME shared lighting library every other material
 * in the scene uses (`snowShading`/`snowShadowLookup`/`snowAtmosphere` —
 * see those files) — the same sun radiance, the same SH sky ambient, the
 * same cascade shadow lookup, the same aerial perspective, sampling the
 * glTF's own baseColor/normal/ORM textures through a standard metallic-
 * roughness BRDF instead of the ground/cloth's bespoke terms. The Ranger is
 * registered as a caster into the *actual* cascade shadow system
 * (`ShadowSystem.registerCaster`, `rangerDepth.vertex.wgsl`) and the scene
 * depth prepass (`DepthPass.registerCaster`, `rangerPrepass.vertex.wgsl`),
 * the same two registrations the procedural character makes — so it now
 * casts a real shadow onto the sand from the same cascades the terrain
 * reads, not a separate self-shadow-only rig.
 *
 * What is still an honest gap, not silently smoothed over: the Ranger's
 * geometry is rigid (`world`-transformed only, no bone skinning) because it
 * carries 0 animation clips right now and sits permanently in its bind
 * pose — see the audit note in `load()`. That is *correct* for the
 * character's current state, not a shortcut around it, but it means the
 * shadow/depth casters below will need real skinning support the moment
 * animation retargeting lands, or the cast shadow will stop matching a
 * posed mesh. Flagged here so that follow-up doesn't get missed.
 */

import { ImportMeshAsync } from "@babylonjs/core/Loading/sceneLoader";
// Side-effect import: registers the .gltf/.glb SceneLoader plugin. Nothing
// in this module calls anything exported from it directly.
import "@babylonjs/loaders/glTF/2.0";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Vector3, Vector4 } from "@babylonjs/core/Maths/math.vector";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { S } from "../core/settings.js";
import { whenReady, bindMatrixArray } from "../core/gpuUtil.js";
import { CASCADE_COUNT } from "../render/shadows.js";

const ASSET_ROOT = "/assets/character/quaternius/ranger/";
const ASSET_FILE = "Male_Ranger.gltf";

/**
 * Standing height the glTF is actually authored at, metres — measured
 * directly from the union of every mesh's own POSITION accessor bounds
 * (feet at y ≈ -0.004, the hood's own top at y ≈ 1.865), not assumed from
 * any README or product metadata.
 */
const RANGER_SOURCE_HEIGHT = 1.869;
/** The procedural traveler's own height — figure.js's `HIP_HEIGHT` note
 *  ("a 1.79 m figure with the pelvis at 0.95"). Matched so switching
 *  `characterModel` doesn't change the player's apparent scale. */
const TARGET_HEIGHT = 1.79;
const RANGER_SCALE = TARGET_HEIGHT / RANGER_SOURCE_HEIGHT;

/**
 * Baked default yaw applied on top of `CharacterController.facing` to align
 * the Ranger's own local forward with SANDSTORM's convention (+Z at yaw 0 —
 * see `figure.js`'s `composeBasis`). Inferred from the glTF's
 * `asset.generator` ("Khronos glTF Blender I/O") and that tool's documented
 * Blender→glTF forward-axis convention, still not visually confirmed as of
 * this pass. `S.rangerYawDebug` (settings.js, a live-tunable degrees offset
 * defaulting to 0) sits on top of this for exactly that reason — dial it in
 * a real browser, then report the total corrected angle back so it can be
 * folded into this constant and the debug control removed.
 */
const YAW_OFFSET = Math.PI;

// ------------------------------------------------------- module-scope scratch
const _splits = new Vector4();

export class RangerCharacter {
    /**
     * @param {import("@babylonjs/core/scene").Scene} scene
     * @param {import("../render/sky.js").Sky} sky
     * @param {import("../render/shadows.js").ShadowSystem} shadows
     * @param {import("../render/depthPass.js").DepthPass} depthPass
     */
    constructor(scene, sky, shadows, depthPass) {
        this.scene = scene;
        this.sky = sky;
        this.shadows = shadows;
        this.depthPass = depthPass;

        this.root = null;
        /** @type {import("@babylonjs/core/Meshes/abstractMesh").AbstractMesh[]} */
        this.meshes = [];
        this.loaded = false;
        this.failed = false;

        /** Beauty materials — exactly 2, gear and skin (see the class doc). */
        this._materials = [];
        this._depthMats = [];
        this._prepassMats = [];
        this._textures = [];

        this._cameraPos = new Vector3();
    }

    /**
     * Load the glTF and stand up its shaders/shadow/prepass registration.
     * Never throws — failure is reported through the return value (and
     * `this.failed`) so `main.js` can fall back to the procedural character
     * without the boot sequence crashing on a missing or malformed asset.
     * @returns {Promise<boolean>} true if the Ranger is ready to render.
     */
    async load() {
        try {
            const result = await ImportMeshAsync(ASSET_FILE, this.scene, { rootUrl: ASSET_ROOT });
            const renderable = result.meshes.filter((m) => m.getTotalVertices() > 0);
            if (renderable.length === 0) {
                throw new Error("Male_Ranger.gltf produced no renderable meshes");
            }

            this.root = new TransformNode("rangerRoot", this.scene);
            this.root.scaling.setAll(RANGER_SCALE);

            // Parent whatever Babylon created at the top of the import under
            // our own controller-driven root. Handles both single- and
            // multi-root imports the same way: anything with no parent of
            // its own becomes a child of `this.root`. The glTF's single
            // scene root (the "Armature" node, confirmed from the file's
            // own `scenes[0].nodes`) carries the whole mesh hierarchy as one
            // rigid unit — see the class doc on why "rigid" is currently
            // correct rather than a shortcut.
            const topLevel = new Set();
            for (const node of [...result.meshes, ...(result.transformNodes || [])]) {
                if (!node.parent) topLevel.add(node);
            }
            for (const node of topLevel) node.parent = this.root;

            const gearTex = this._loadTextureSet(
                "T_Ranger_BaseColor.png", "T_Ranger_Normal.png", "T_Ranger_ORM.png"
            );
            const skinTex = this._loadTextureSet(
                "T_Regular_Male_Dark_BaseColor.png", "T_Regular_Male_Normal.png",
                "T_Regular_Male_Roughness.png"
            );
            // MI_Ranger's ORM texture is a real packed (AO, roughness,
            // metalness) map; MI_Regular_Male's is roughness-only — see the
            // fragment shader's own note on why `hasORM` gates two of its
            // three channels off for the latter.
            const gearMat = this._makeSurfaceMaterial("rangerGear", gearTex, true);
            const skinMat = this._makeSurfaceMaterial("rangerSkin", skinTex, false);
            this._materials = [gearMat, skinMat];

            // Replace each mesh's glTF-loader-created PBRMaterial with the
            // matching custom shader above, keyed off the glTF's own
            // material name (confirmed from the raw file: `MI_Ranger` for
            // gear, `MI_Regular_Male` for skin/underlayer — see the audit
            // in this pass's PR report). The loader's PBRMaterial and its
            // own texture instances are disposed here rather than reused:
            // this shader loads the same six PNGs directly by their known
            // asset paths instead, which is simpler and more predictable
            // than depending on Babylon-version-specific internal texture-
            // slot property names.
            for (const m of renderable) {
                const isGear = m.material ? m.material.name === "MI_Ranger" : true;
                if (m.material) m.material.dispose(true, true);
                m.material = isGear ? gearMat : skinMat;
                m.receiveShadows = true;
            }
            this.meshes = renderable;

            this._registerShadowCasters();
            this._registerPrepass();

            this.loaded = true;
        } catch (err) {
            console.error(
                "[RangerCharacter] load failed, falling back to the procedural character:", err
            );
            this.failed = true;
            this.dispose();
        }
        return this.loaded;
    }

    _loadTextureSet(baseColor, normal, orm) {
        const mk = (file) => {
            const t = new Texture(
                ASSET_ROOT + file, this.scene, false, false
            );
            this._textures.push(t);
            return t;
        };
        return { baseColor: mk(baseColor), normal: mk(normal), orm: mk(orm) };
    }

    /**
     * One beauty material — see `rangerChar.fragment.wgsl` for the shared
     * lighting math. `hasORM` distinguishes the gear material's real packed
     * AO/metalness from the skin material's roughness-only texture.
     */
    _makeSurfaceMaterial(name, tex, hasORM) {
        const mat = new ShaderMaterial(
            name, this.scene, { vertex: "rangerChar", fragment: "rangerChar" },
            {
                attributes: ["position", "normal", "uv"],
                uniforms: [
                    "world", "viewProjection", "cameraPos",
                    "sunDir", "sunRadiance", "shR",
                    "cascadeMatrices", "cascadeSplits", "cascadeParams",
                    "shadowTexel", "shadowSoftness", "shadowBias",
                    "fogDensity", "fogHeightFalloff", "fogStart", "aerialStrength",
                    "ambientIntensity", "hasORM",
                ],
                samplers: [
                    "baseColorTex", "normalTex", "ormTex",
                    "skyLUT", "cascade0", "cascade1", "cascade2",
                ],
                shaderLanguage: ShaderLanguage.WGSL,
            }
        );
        mat.backFaceCulling = true;
        mat.setTexture("baseColorTex", tex.baseColor);
        mat.setTexture("normalTex", tex.normal);
        mat.setTexture("ormTex", tex.orm);
        mat.setFloat("hasORM", hasORM ? 1 : 0);
        mat.setTexture("skyLUT", this.sky.lut);
        for (let i = 0; i < CASCADE_COUNT; i++) {
            mat.setTexture("cascade" + i, this.shadows.maps[i]);
        }
        return mat;
    }

    /** Register every mesh as a cascade shadow caster — the real terrain
     *  shadow system, not a separate self-shadow-only rig. */
    _registerShadowCasters() {
        for (const m of this.meshes) {
            this.shadows.registerCaster(
                m, (cascade) => this._makeDepthMaterial(m.name + "_depth" + cascade), CASCADE_COUNT
            );
        }
    }

    _makeDepthMaterial(name) {
        const mat = new ShaderMaterial(
            name, this.scene, { vertex: "rangerDepth", fragment: "terrainDepth" },
            {
                attributes: ["position"],
                uniforms: ["world", "lightViewProjection"],
                shaderLanguage: ShaderLanguage.WGSL,
            }
        );
        mat.backFaceCulling = true;
        this._depthMats.push(mat);
        return mat;
    }

    /** Register every mesh into the scene's own camera-space depth prepass,
     *  so post effects (TAA/DOF/SSR) see the Ranger like any other caster. */
    _registerPrepass() {
        for (const m of this.meshes) {
            const mat = new ShaderMaterial(
                m.name + "_prepass", this.scene,
                { vertex: "rangerPrepass", fragment: "prepass" },
                {
                    attributes: ["position"],
                    uniforms: ["world", "viewProjection"],
                    shaderLanguage: ShaderLanguage.WGSL,
                }
            );
            mat.backFaceCulling = true;
            this._prepassMats.push(mat);
            this.depthPass.registerCaster(m, mat);
        }
    }

    /** Compile every registered pipeline behind the loading screen. */
    async warmUp() {
        if (!this.loaded) return;
        for (const m of this._materials) {
            await whenReady(m, m.name, [this.meshes[0], false]);
        }
        for (let i = 0; i < this._depthMats.length; i++) {
            const mesh = this.meshes[Math.floor(i / CASCADE_COUNT)];
            await whenReady(this._depthMats[i], this._depthMats[i].name, [mesh, false]);
        }
        for (let i = 0; i < this._prepassMats.length; i++) {
            await whenReady(this._prepassMats[i], this._prepassMats[i].name, [this.meshes[i], false]);
        }
    }

    /**
     * Follow `CharacterController`'s position/facing and push this frame's
     * lighting/shadow uniforms. Called every frame regardless of whether
     * the Ranger is the visible model — cheap, and it means flipping
     * `characterModel` never shows a stale pose or stale lighting.
     * @param {import("@babylonjs/core/Maths/math.vector").Vector3} position
     * @param {number} facing
     * @param {import("@babylonjs/core/Maths/math.vector").Vector3} cameraPos
     */
    sync(position, facing, cameraPos) {
        if (!this.loaded) return;

        this.root.position.set(position.x, position.y, position.z);
        // `S.rangerYawDebug` is degrees, live-tunable — see the class doc
        // and settings.js for why this exists on top of the baked default.
        this.root.rotation.y = facing + YAW_OFFSET + (S.rangerYawDebug * Math.PI) / 180;

        this._cameraPos.copyFrom(cameraPos);
        const sky = this.sky;
        const sh = this.shadows;
        _splits.set(sh.splits[0], sh.splits[1], sh.splits[2], sh.splits[3]);

        for (const m of this._materials) {
            m.setVector3("cameraPos", this._cameraPos);
            m.setVector3("sunDir", sky.sunDir);
            m.setColor3("sunRadiance", sky.sunRadiance);
            m.setArray4("shR", sky.sh);

            bindMatrixArray(m, "cascadeMatrices", sh.matrixData);
            m.setVector4("cascadeSplits", _splits);
            m.setArray4("cascadeParams", sh.paramData);
            m.setFloat("shadowTexel", sh.texelSize);
            // Same values character.js's own materials use — see that
            // file's note on why the bias stays tight: a large one detaches
            // the contact shadow between the boots and the sand, which is
            // the one shadow that reads as "standing on the ground".
            m.setFloat("shadowSoftness", 1.4);
            m.setFloat("shadowBias", 0.012);

            m.setFloat("fogDensity", S.fogDensity);
            m.setFloat("fogHeightFalloff", S.fogHeightFalloff);
            m.setFloat("fogStart", S.fogStart);
            m.setFloat("aerialStrength", S.aerialStrength);
            m.setFloat("ambientIntensity", S.ambientIntensity);
        }
    }

    setVisible(visible) {
        if (this.root) this.root.setEnabled(visible);
    }

    dispose() {
        for (const m of this.meshes) m.dispose();
        this.meshes = [];
        for (const m of this._materials) m.dispose();
        for (const m of this._depthMats) m.dispose();
        for (const m of this._prepassMats) m.dispose();
        for (const t of this._textures) t.dispose();
        this._materials = [];
        this._depthMats = [];
        this._prepassMats = [];
        this._textures = [];
        if (this.root) { this.root.dispose(); this.root = null; }
    }
}
