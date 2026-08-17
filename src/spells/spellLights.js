/**
 * The dynamic lights spells emit.
 *
 * A tiny fixed pool — four slots, two pre-allocated Float32Arrays, no objects.
 * Spells declare their light each frame while they update; whatever is declared
 * by the end of the frame is what the materials see. Nothing is retained between
 * frames, so a spell that stops updating stops lighting with no teardown.
 *
 * Every material that shades something the player can see reads the same two
 * arrays through `snowSpellLights`. That is the point: a spell has to light the
 * snow, the robe, the wake and the airborne spray out of one description, or it
 * reads as a glow pasted over a scene rather than as a light in it.
 *
 * Allocation per frame: none.
 */

/** Must match `SPELL_LIGHT_MAX` in `lib/spellLights.wgsl`. */
export const MAX_SPELL_LIGHTS = 4;

/**
 * Uniform names every consumer material must declare. Exported so the material
 * constructors cannot drift from the include.
 */
export const SPELL_LIGHT_UNIFORMS = [
    "spellLightPos", "spellLightCol", "spellLightCount",
];

export class SpellLights {
    constructor() {
        /** (x, y, z, radius) per slot. */
        this.pos = new Float32Array(MAX_SPELL_LIGHTS * 4);
        /** (r, g, b, intensity) per slot. */
        this.col = new Float32Array(MAX_SPELL_LIGHTS * 4);
        this.count = 0;
        /** Multiplier the overlay drives, so the whole effect can be A/B'd. */
        this.scale = 1;
    }

    /** Drop last frame's declarations. Called once, before the spells update. */
    begin() {
        this.count = 0;
    }

    /**
     * Declare a light for this frame.
     *
     * Dropped silently once the pool is full. That is the right failure: the
     * fifth light in a frame is by definition the least important one on screen,
     * and the alternative — growing the array — means a shader loop the whole
     * snow field pays for.
     *
     * @param {number} x @param {number} y @param {number} z
     * @param {number} radius metres; the falloff reaches exactly zero here
     * @param {number} r @param {number} g @param {number} b linear, unnormalised
     * @param {number} intensity
     */
    add(x, y, z, radius, r, g, b, intensity) {
        if (this.count >= MAX_SPELL_LIGHTS) return;
        if (intensity <= 0 || radius <= 0) return;
        const i = this.count++;
        const o = i * 4;
        this.pos[o] = x;
        this.pos[o + 1] = y;
        this.pos[o + 2] = z;
        this.pos[o + 3] = radius;
        const k = intensity * this.scale;
        this.col[o] = r;
        this.col[o + 1] = g;
        this.col[o + 2] = b;
        this.col[o + 3] = k;
    }

    /**
     * Push the pool into one material.
     *
     * The whole array goes up whether or not every slot is live — a partial
     * upload would leave the tail holding a stale radius, and the shader's own
     * gate is the count rather than the contents.
     *
     * @param {import("@babylonjs/core/Materials/shaderMaterial").ShaderMaterial} m
     */
    apply(m) {
        m.setArray4("spellLightPos", this.pos);
        m.setArray4("spellLightCol", this.col);
        m.setFloat("spellLightCount", this.count);
    }
}
