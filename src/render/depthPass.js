/**
 * Scene depth prepass — linear view depth and a specular mask, for the post chain.
 *
 * Every screen-space effect needs to know how far away a pixel is: TAA
 * reprojects last frame's colour through it, the light shafts test occlusion
 * along it, depth of field takes its circle of confusion from it, and the
 * screen-space reflections march it.
 *
 * Babylon's own `DepthRenderer` cannot supply it. Nothing in this scene has CPU
 * geometry that matches what is drawn: the terrain's vertices are grid indices
 * placed by the clipmap vertex shader, the character is skinned from a transform
 * texture, the wake is a lattice evaluated from a spine, and the crystals are
 * generated from a growth curve. A generic depth pass would render five
 * undisplaced lattices. So this owns the pass, exactly as the shadow cascades do,
 * and for the same reason — a caster registers the vertex program it is actually
 * drawn with.
 *
 * Channels, RGBA16F:
 *
 *   r   linear view depth in metres — the clip-space w, which for a perspective
 *       projection *is* the view-space z, carried through as a varying rather
 *       than reconstructed from the depth buffer. Exact, and it costs one
 *       interpolant.
 *   g   specular mask: 0 matte snow, 1 mirror ice. Only the reflection pass
 *       reads it, and only where it is non-zero.
 *   ba  spare.
 *
 * Half float rather than full: the relative precision is 2^-11, so the error is
 * 0.05% of the distance — five millimetres at ten metres, fifteen centimetres at
 * three hundred. Every consumer works in units of "fraction of the distance to
 * the pixel", so that is far below anything any of them can resolve, and it
 * halves the bandwidth of a target that is written once and read a dozen times.
 */

import { RenderTargetTexture } from "@babylonjs/core/Materials/Textures/renderTargetTexture";
import { Constants } from "@babylonjs/core/Engines/constants";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector2 } from "@babylonjs/core/Maths/math.vector";
import { whenReady } from "../core/gpuUtil.js";

/**
 * Cleared depth. Beyond the camera's far plane, so the sky reads as "nothing
 * here" to every consumer without any of them needing a separate mask.
 */
export const DEPTH_FAR = 9000;

export class DepthPass {
    /** @param {import("@babylonjs/core/scene").Scene} scene */
    constructor(scene) {
        this.scene = scene;
        this.engine = scene.getEngine();

        /** @type {import("@babylonjs/core/Materials/shaderMaterial").ShaderMaterial[]} */
        this.materials = [];

        /** Render-target size in pixels, republished for the shaders that read it. */
        this.size = new Vector2(1, 1);

        const w = this.engine.getRenderWidth();
        const h = this.engine.getRenderHeight();

        this.rtt = new RenderTargetTexture(
            "scenePrepass",
            { width: w, height: h },
            scene,
            {
                generateMipMaps: false,
                generateDepthBuffer: true,
                type: Constants.TEXTURETYPE_HALF_FLOAT,
                format: Constants.TEXTUREFORMAT_RGBA,
                // Nearest, deliberately. Every consumer reconstructs a position
                // from this, and a bilinear tap across a silhouette returns a
                // depth that belongs to neither surface — which shows up as a
                // halo of wrong occlusion around every edge.
                samplingMode: Constants.TEXTURE_NEAREST_SAMPLINGMODE,
            }
        );
        this.rtt.wrapU = Constants.TEXTURE_CLAMP_ADDRESSMODE;
        this.rtt.wrapV = Constants.TEXTURE_CLAMP_ADDRESSMODE;
        this.rtt.clearColor = new Color4(DEPTH_FAR, 0, 0, 1);
        this.rtt.refreshRate = RenderTargetTexture.REFRESHRATE_RENDER_ONEVERYFRAME;
        this.rtt.renderList = [];
        this.rtt.skipInitialClear = false;
        this.size.set(w, h);

        // Before the main pass and after the shadow cascades, which is where the
        // scene renders its custom targets in registration order.
        scene.customRenderTargets.push(this.rtt);

        this.engine.onResizeObservable.add(() => this._resize());
    }

    _resize() {
        const w = this.engine.getRenderWidth();
        const h = this.engine.getRenderHeight();
        if (w === this.size.x && h === this.size.y) return;
        this.size.set(w, h);
        this.rtt.resize({ width: w, height: h });
    }

    /**
     * Draw `mesh` into the prepass with `material`.
     *
     * The material must declare `viewProjection` — Babylon binds the active
     * camera's, which during this target's render is the jittered one the beauty
     * pass will use, so the depth and the colour line up to the subpixel.
     *
     * @param {import("@babylonjs/core/Meshes/mesh").Mesh} mesh
     * @param {import("@babylonjs/core/Materials/shaderMaterial").ShaderMaterial} material
     */
    registerCaster(mesh, material) {
        this.rtt.renderList.push(mesh);
        this.rtt.setMaterialForRendering(mesh, material);
        this.materials.push(material);
    }

    /** Compile every registered prepass pipeline, behind the loading screen. */
    async warmUp() {
        const list = this.rtt.renderList || [];
        for (let i = 0; i < this.materials.length; i++) {
            await whenReady(
                this.materials[i], "prepass:" + this.materials[i].name, [list[i], false]
            );
        }
    }

    dispose() {
        this.rtt.dispose();
        for (let i = 0; i < this.materials.length; i++) this.materials[i].dispose();
    }
}
