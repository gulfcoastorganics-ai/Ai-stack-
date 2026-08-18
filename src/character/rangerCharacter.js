/**
 * Adapter for the authored Quaternius Male Ranger glTF — a parallel hero
 * character to the procedural `Character` (see `character.js`), not a
 * replacement of it. `CharacterController` stays the single source of
 * gameplay motion; this class only ever *reads* its position/facing and
 * writes them onto a transform node. It never drives movement, never owns
 * physics, and never touches the terrain/deformation/contact systems —
 * those already work off `CharacterController` and the procedural figure's
 * own foot-IK solve (see `snowContact.js`), which keeps running underneath
 * regardless of which model is on screen, so footprints/dash streaks/
 * landing compression are unaffected by this file existing at all.
 *
 * Architectural note this file does NOT attempt to paper over: the rest of
 * SANDSTORM's characters and terrain are lit by a fully bespoke pipeline —
 * hand-rolled cascaded shadow maps with a custom prepass material per
 * caster (see `render/shadows.js`'s own header on why: nothing in this
 * scene has CPU geometry a generic depth pass could render), spherical-
 * harmonic sky ambient, and a hand-written WGSL BRDF reading `sunDir`/
 * `sunRadiance` uniforms directly. A glTF-loaded mesh arrives with
 * Babylon's own skeleton/bone system and standard `PBRMaterial` instances,
 * which know nothing about any of that custom machinery. Bridging the two
 * *exactly* — a custom WGSL replacement shader for the Ranger's materials
 * that samples the same cascades and SH data the rest of the scene does —
 * is real, substantial follow-up work, explicitly out of scope for this
 * milestone. What this file does instead: a `DirectionalLight` synced every
 * frame to the scene's actual sun direction/color, a `HemisphericLight` for
 * sky/ground bounce fill, and a Babylon `ShadowGenerator` off that
 * directional light for the Ranger to self-shadow. The Ranger will be lit
 * from the correct direction with the correct color and will self-shadow
 * (hood onto shoulders, etc.); it will NOT appear in the terrain's own
 * shadow cascades (no Ranger-shaped shadow on the sand yet) and the terrain
 * will not cast into the Ranger's shadow map either — see the class doc for
 * why that isn't a quick fix. Flagged clearly in the integration report,
 * not silently left out.
 */

import { ImportMeshAsync } from "@babylonjs/core/Loading/sceneLoader";
// Side-effect import: registers the .gltf/.glb SceneLoader plugin. Nothing
// in this module calls anything exported from it directly.
import "@babylonjs/loaders/glTF/2.0";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator";

const ASSET_ROOT = "/assets/character/quaternius/ranger/";
const ASSET_FILE = "Male_Ranger.gltf";

/**
 * Standing height the glTF is actually authored at, metres — measured
 * directly from the union of every mesh's own POSITION accessor bounds
 * (feet at y ≈ -0.004, the hood's own top at y ≈ 1.865), not assumed from
 * any README or product metadata. See the integration report for the exact
 * per-mesh figures this was read from.
 */
const RANGER_SOURCE_HEIGHT = 1.869;
/** The procedural traveler's own height — figure.js's `HIP_HEIGHT` note
 *  ("a 1.79 m figure with the pelvis at 0.95"). Matched so switching
 *  `characterModel` doesn't change the player's apparent scale. */
const TARGET_HEIGHT = 1.79;
const RANGER_SCALE = TARGET_HEIGHT / RANGER_SOURCE_HEIGHT;

/**
 * Yaw applied on top of `CharacterController.facing` to align the Ranger's
 * own local forward with SANDSTORM's convention (+Z at yaw 0 — see
 * `figure.js`'s `composeBasis`). The glTF's `asset.generator` reads
 * "Khronos glTF Blender I/O", whose standard axis conversion puts a
 * Blender-authored character's forward on local -Z after export — hence PI
 * here. This is inferred from the export tool's documented convention, not
 * visually confirmed: flagged explicitly in the integration report as one
 * of the checks a real WebGPU browser still needs to make. If the Ranger
 * ends up facing backward, flip this to 0.
 */
const YAW_OFFSET = Math.PI;

export class RangerCharacter {
    /**
     * @param {import("@babylonjs/core/scene").Scene} scene
     */
    constructor(scene) {
        this.scene = scene;
        this.root = null;
        /** @type {import("@babylonjs/core/Meshes/abstractMesh").AbstractMesh[]} */
        this.meshes = [];
        this.loaded = false;
        this.failed = false;

        this._light = null;
        this._ambient = null;
        this._shadowGen = null;
    }

    /**
     * Load the glTF and stand up its lighting/shadow rig. Never throws —
     * failure is reported through the return value (and `this.failed`) so
     * `main.js` can fall back to the procedural character without the boot
     * sequence crashing on a missing or malformed asset.
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
            // our own controller-driven root, rather than reparenting every
            // mesh individually — the glTF's single scene root (the
            // "Armature" node, confirmed from the file's own `scenes[0].nodes`)
            // carries the whole skeleton/mesh hierarchy as one rigid unit, and
            // reparenting it once is what keeps that hierarchy intact. Handles
            // both single- and multi-root imports the same way: anything with
            // no parent of its own becomes a child of `this.root`.
            const topLevel = new Set();
            for (const node of [...result.meshes, ...(result.transformNodes || [])]) {
                if (!node.parent) topLevel.add(node);
            }
            for (const node of topLevel) node.parent = this.root;

            for (const m of renderable) m.receiveShadows = true;
            this.meshes = renderable;

            this._setupLighting();
            this._setupShadows();

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

    /**
     * A directional light for the sun and a hemispheric light for sky/sand
     * bounce fill, both scoped to the Ranger's own meshes via
     * `includedOnlyMeshes` so they never touch the custom-shaded terrain,
     * procedural traveler, wake, or particles — those already compute their
     * own lighting analytically and have no use for a generic scene light
     * landing on them too.
     */
    _setupLighting() {
        this._light = new DirectionalLight("rangerSun", new Vector3(0, -1, 0), this.scene);
        this._light.diffuse = new Color3(1, 1, 1);
        this._light.specular = new Color3(1, 1, 1);
        this._light.includedOnlyMeshes = this.meshes;

        // Cool sky above, warm sand bounce below — the same split every other
        // material in this scene is built around, approximated here with two
        // flat colours rather than the full SH data the custom shaders read
        // (`HemisphericLight` only has room for two). Scaled by the same
        // `ambientIntensity` slider everything else answers to.
        this._ambient = new HemisphericLight("rangerAmbient", new Vector3(0, 1, 0), this.scene);
        this._ambient.diffuse = new Color3(0.58, 0.64, 0.72);
        this._ambient.groundColor = new Color3(0.42, 0.32, 0.20);
        this._ambient.specular = new Color3(0, 0, 0);
        this._ambient.includedOnlyMeshes = this.meshes;
    }

    /** Self-shadowing only — see the class doc for why the terrain and the
     *  Ranger can't cast into each other's shadow system yet. */
    _setupShadows() {
        this._shadowGen = new ShadowGenerator(1024, this._light);
        this._shadowGen.useContactHardeningShadow = true;
        for (const m of this.meshes) this._shadowGen.addShadowCaster(m, false);
    }

    /**
     * Sync light direction/color to the scene's actual sun.
     * @param {import("../render/sky.js").Sky} sky
     * @param {number} ambientIntensity
     */
    updateLighting(sky, ambientIntensity) {
        if (!this.loaded) return;
        this._light.direction.set(-sky.sunDir.x, -sky.sunDir.y, -sky.sunDir.z);
        this._light.diffuse.copyFrom(sky.sunColor);
        // `sky.sunScale` is calibrated for the scene's own radiometric
        // shader units, not Babylon's default light-intensity scale — this
        // factor is an untested starting point (documented as such in the
        // class doc), not a calibrated photometric match.
        this._light.intensity = Math.min(4, sky.sunScale * 0.6);
        this._ambient.intensity = 0.5 * ambientIntensity;
    }

    /**
     * Follow `CharacterController`'s position/facing. Called every frame
     * regardless of whether the Ranger is the visible model — cheap, and it
     * means flipping `characterModel` never shows a stale pose.
     * @param {import("@babylonjs/core/Maths/math.vector").Vector3} position
     * @param {number} facing
     */
    sync(position, facing) {
        if (!this.loaded) return;
        this.root.position.set(position.x, position.y, position.z);
        this.root.rotation.y = facing + YAW_OFFSET;
    }

    setVisible(visible) {
        if (this.root) this.root.setEnabled(visible);
    }

    dispose() {
        for (const m of this.meshes) m.dispose();
        this.meshes = [];
        if (this.root) { this.root.dispose(); this.root = null; }
        if (this._shadowGen) { this._shadowGen.dispose(); this._shadowGen = null; }
        if (this._light) { this._light.dispose(); this._light = null; }
        if (this._ambient) { this._ambient.dispose(); this._ambient = null; }
    }
}
