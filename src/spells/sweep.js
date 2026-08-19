/**
 * Spell 1 — Dune Surge.
 *
 * SANDSTORM Phase 6: SNOWFLOW's Sweep, redesigned rather than retinted. The
 * traveler slams a hand forward and a curved dune crest rises out of the
 * ground ahead of them and runs outward — not a projectile floating above the
 * terrain, the ground itself moving. It ploughs a shallow channel and throws
 * displaced mass to either side as it goes, exactly the shape SNOWFLOW's
 * crescent of slush had; what changed is the cross-section reads as granular
 * sand piling and cascading rather than a wave curling.
 *
 * It is still the wake's cross-section on a different spine, and that is still
 * not a shortcut. A carve's wall of thrown sand and a travelling dune crest are
 * the same object — mass pushed out of the ground and held up by its own
 * momentum — so they are drawn by the same section integral out of
 * `lib/wake.wgsl`, reached through the shared sand-mass material's sheet
 * profile (`waterBody.js`, `water.fragment.wgsl` — see those files' own notes
 * on why the names did not change). What differs is what the spine is: the
 * wake's is a record of where the board went, and this one is an arc that
 * grows outward from where the spell was cast.
 *
 * The channel is not a decal chased after the fact. Each frame the live crest
 * writes brushes into the terrain state buffer at the position the mesh is
 * actually drawing, so the mark and the wave cannot disagree — the same rule the
 * plume follows in the surf wake.
 */

import { PROFILE_SHEET } from "./waterBody.js";
import { clamp01, clampRange, smooth01, bell } from "./bending.js";
import { S } from "../core/settings.js";

/** Spine samples across the crescent. */
const COLS = 48;

/**
 * Curvature radius of the crescent, metres — *fixed*, and this is the whole
 * shape of the spell.
 *
 * Not the distance travelled. Using that as the radius makes the wave an arc of
 * a circle centred on the caster, and ten metres out the crescent is twenty
 * metres wide — a ridge in the terrain rather than something thrown. A wave
 * front has a curvature of its own that has nothing to do with how far it has
 * run, so the arc keeps its shape and *translates*, and only its span opens up
 * as the ends spread.
 */
const CURVE = 5.5;
/** Half-angle of the arc at cast and at full spread, radians. */
const ARC0 = 0.52;
const ARC1 = 0.96;
/** Seconds from cast to fully collapsed. */
const LIFE = 2.4;
/**
 * Peak crest height at the centre of the arc, metres.
 *
 * Taller than the character, on the same reasoning as the surf wake's 2.4 m: at
 * the distance this demo actually frames from, a crest the height of the relief
 * the terrain already has does not read as thrown mass, it reads as a dune.
 */
const PEAK = 2.15;

export class Sweep {
    /** @param {import("./spellSystem.js").SpellContext} ctx */
    constructor(ctx) {
        this.ctx = ctx;
        this.active = false;
        this.strand = -1;

        this.t = 0;
        this.ox = 0;
        this.oz = 0;
        this.dx = 0;
        this.dz = 1;
        /** Metres the crest has travelled from the origin. */
        this.reach = 0;
        this._brushOwed = 0;
        this._sprayOwed = 0;
    }

    /** @param {number} ax @param {number} az flat aim direction */
    trigger(ax, az) {
        const ctx = this.ctx;
        const ch = ctx.controller;

        // A recast restarts rather than stacking: two crescents from the same
        // point are one crescent with a seam in it.
        if (this.strand < 0) this.strand = ctx.water.acquire();
        if (this.strand < 0) return;

        const fl = Math.hypot(ax, az) || 1;
        this.dx = ax / fl;
        this.dz = az / fl;
        // Born a little ahead of the feet, so the player is never inside it.
        this.ox = ch.position.x + this.dx * 1.1;
        this.oz = ch.position.z + this.dz * 1.1;
        this.t = 0;
        this.reach = 1.4;
        this._brushOwed = 0;
        this._sprayOwed = 0;
        this.active = true;
    }

    /** @param {number} dt */
    update(dt) {
        if (!this.active) return;
        const ctx = this.ctx;
        const water = ctx.water;
        const terrain = ctx.terrain;
        const s = this.strand;
        if (s < 0) {
            this.active = false;
            return;
        }

        this.t += dt;
        const life01 = this.t / LIFE;
        if (life01 >= 1) {
            this._end();
            return;
        }

        // Terrain response: sample the ground's slope directly under and just
        // ahead of the crest, along the direction of travel. Not a physical
        // coupling — the crest's shape is still the same analytic section
        // integral it always was — but a cheap read of the one number that
        // matters (is the ground rising or falling under the leading edge) is
        // enough to make the wave visibly react to the dune field it is
        // crossing, which is the believable illusion the phase asks for
        // without a real granular simulation underneath it.
        const cx0 = this.ox + this.dx * this.reach;
        const cz0 = this.oz + this.dz * this.reach;
        const hFwd = terrain.heightAt(cx0 + this.dx * 1.4, cz0 + this.dz * 1.4);
        const hBack = terrain.heightAt(cx0 - this.dx * 1.4, cz0 - this.dz * 1.4);
        // >0 climbing, <0 descending, clamped so a cliff cannot stall or launch it.
        const slope = clampRange((hFwd - hBack) / 2.8, -0.5, 0.5);
        const uphill = Math.max(0, slope);
        const downhill = Math.max(0, -slope);

        // Speed decays: the wave is launched, not driven. Ten metres a second
        // down to a walking pace, which is what makes it read as something that
        // was thrown rather than something being pushed. The slope then leans
        // that decayed speed up or down: climbing a face costs it pace, running
        // down one adds pace back — a real dune surge slumping downhill under
        // its own weight, not just decaying with time.
        const baseSpeed = 11.5 * Math.exp(-this.t * 1.15) + 1.2;
        const speed = baseSpeed * (1 - uphill * 0.55 + downhill * 0.75);
        const travelled = speed * dt;
        this.reach += travelled;

        // Rise fast, hold, fall. The fall is quadratic to exactly zero so the
        // last frame of the wave is flat rather than a step.
        const rise = smooth01(this.t / 0.26);
        const fall = 1 - clamp01((life01 - 0.55) / 0.45);
        const env = rise * fall * fall;

        // A wave spreads as it runs: the arc opens up and the crest thins, so
        // the same mass covers more ground. A downhill run spreads faster still
        // — the same "more ground for the same mass" logic, pushed further by
        // gravity doing some of the work — and an uphill climb piles the mass
        // up instead of spreading it, which is where the extra crest height
        // below comes from.
        const spread = clamp01((this.reach - 1.4) / 14) * (1 + downhill * 0.5);
        const arc = ARC0 + (ARC1 - ARC0) * Math.min(spread, 1);
        const height = PEAK * S.duneSurgeHeightScale * env / (1 + spread * 0.45) * (1 + uphill * 0.6 - downhill * 0.15);

        // Circle centre, one curvature radius behind the leading point.
        const kx = this.ox + this.dx * (this.reach - CURVE);
        const kz = this.oz + this.dz * (this.reach - CURVE);
        // The crest's own right, for the arc parametrisation.
        const wx = this.dz;
        const wz = -this.dx;

        let px = 0, py = 0, pz = 0;
        for (let c = 0; c < COLS; c++) {
            const u = c / (COLS - 1);
            const th = (u - 0.5) * 2 * arc;
            const cs = Math.cos(th);
            const sn = Math.sin(th);
            // Outward radial at this angle: the direction the section faces, and
            // the direction the horn at that end of the crescent is running.
            const rx = this.dx * cs + wx * sn;
            const rz = this.dz * cs + wz * sn;

            const x = kx + rx * CURVE;
            const z = kz + rz * CURVE;
            // Sunk, so the base of the wall meets the trench floor it is cutting
            // rather than floating on the undisturbed surface.
            const y = terrain.heightAt(x, z) - 0.13;

            // Horns taper to nothing. The bell is on `u` rather than on the
            // angle so the two ends close symmetrically however wide the arc has
            // opened, and the sheet degenerates onto its own spine there instead
            // of ending on a cut edge.
            const amp = height * bell(u);

            // The crest curls harder in the middle, where the mass is. Pushed
            // most of the way to the section integral's plunging limit: at the
            // low end the sheet is a bank, and a bank lying on a dune field is
            // indistinguishable from the dune field. It has to hook over its own
            // face to read as a wave at all.
            const curl = 0.48 + 0.47 * bell(u) * (0.45 + 0.55 * rise);
            // Foam along the whole leading edge, heaviest at the centre.
            const foam = 0.30 + 0.45 * bell(u);

            water.column(
                s, c, x, y, z, amp,
                rx, 0, rz, curl,
                this.reach + u * 2.0, life01, foam, 1
            );

            if (c === (COLS >> 1)) { px = x; py = y; pz = z; }
        }

        // Mid-compaction: loose enough to still be catching the sun as
        // individual grains at the crest, not yet the dense packed mass a
        // footpath or a Sand Lance groove leaves behind.
        water.setParams(s, PROFILE_SHEET, 0.48, clamp01(env * 1.4), COLS);

        // Almost no emission — see the phase's lighting-integration note: a
        // travelling ridge of sand is not a light source, and a bright glow
        // riding it would be the single fastest way to make it read as a
        // magic effect rather than as displaced ground. What is left is barely
        // a contact hint, not a glow.
        ctx.lights.add(
            px, py + height * 0.55, pz,
            6.0, 0.55, 0.46, 0.32, 1.6 * env
        );

        this._plough(travelled, env);
        this._spray(travelled, env, height);
    }

    /**
     * The channel and its berms.
     *
     * Written per metre travelled rather than per second, so the trench has the
     * same depth at any speed or frame rate: a patch of ground sits under the
     * brush for (2 * radius / travelled) frames, and the depth it ends at is
     * therefore independent of both.
     */
    _plough(travelled, env) {
        if (env < 0.05) return;
        const ctx = this.ctx;
        const f = ctx.deform;
        const terrain = ctx.terrain;

        this._brushOwed += travelled;
        // One rank of brushes every 25 cm of advance. Denser than that just
        // re-cuts the same trench; sparser leaves it scalloped.
        if (this._brushOwed < 0.25) return;
        const k = Math.min(this._brushOwed, 0.7);
        this._brushOwed = 0;

        const spread = clamp01((this.reach - 1.4) / 14);
        const arc = ARC0 + (ARC1 - ARC0) * spread;
        const N = 13;

        // Slightly behind the crest: the channel is what the wave has already
        // passed over, not what it is about to.
        const kx = this.ox + this.dx * (this.reach - 0.5 - CURVE);
        const kz = this.oz + this.dz * (this.reach - 0.5 - CURVE);
        const wx = this.dz;
        const wz = -this.dx;

        for (let i = 0; i < N; i++) {
            const u = i / (N - 1);
            const w = bell(u);
            if (w < 0.06) continue;
            const th = (u - 0.5) * 2 * arc;
            const cs = Math.cos(th);
            const sn = Math.sin(th);
            const rx = this.dx * cs + wx * sn;
            const rz = this.dz * cs + wz * sn;

            const x = kx + rx * CURVE;
            const z = kz + rz * CURVE;

            // The brush's long axis runs *along* the arc, so the trench is
            // continuous rather than a row of round pits. Yaw is the tangent.
            const yaw = Math.atan2(rz, -rx);

            f.brush(
                x, z,
                0.34,
                0.95 * k * env * w,   // channel
                0.62 * k * env * w,   // displaced mass at the rim
                0.55 * k * env * w,   // compacted by the mass running over it
                0.16 * k * env * w,   // a little of the trench floor stabilises
                yaw,
                2.2,
                0.9
            );
        }
    }

    /** Spray off the crest — thrown outward and back over the top. */
    _spray(travelled, env, height) {
        const ctx = this.ctx;
        const sp = ctx.spray;
        if (!sp || env < 0.08) return;

        const perMetre = 120 * ctx.sprayScale;
        this._sprayOwed += travelled;
        let count = (this._sprayOwed * perMetre) | 0;
        if (count <= 0) return;
        this._sprayOwed -= count / perMetre;
        if (count > 150) count = 150;

        const spread = clamp01((this.reach - 1.4) / 14);
        const arc = ARC0 + (ARC1 - ARC0) * spread;
        const terrain = ctx.terrain;
        const wx = this.dz;
        const wz = -this.dx;
        const kx = this.ox + this.dx * (this.reach - CURVE);
        const kz = this.oz + this.dz * (this.reach - CURVE);

        for (let k = 0; k < count; k++) {
            const u = Math.random();
            const w = bell(u);
            if (w < 0.12) continue;
            const th = (u - 0.5) * 2 * arc;
            const cs = Math.cos(th);
            const sn = Math.sin(th);
            const rx = this.dx * cs + wx * sn;
            const rz = this.dz * cs + wz * sn;

            const amp = height * w;
            const d = CURVE + (Math.random() - 0.2) * 0.6;
            const x = kx + rx * d;
            const z = kz + rz * d;
            const y = terrain.heightAt(x, z) + amp * (0.55 + 0.6 * Math.random());

            // Thrown forward and up, off the front of the crest.
            const out = 1.4 + Math.random() * 3.2;
            const clod = Math.random() < 0.2 ? 1 : 0;
            sp.emit(
                x, y, z,
                rx * out + (Math.random() - 0.5) * 1.4,
                1.5 + Math.random() * 3.2 + amp * 1.6,
                rz * out + (Math.random() - 0.5) * 1.4,
                clod ? 0.022 + Math.random() * 0.024 : 0.050 + Math.random() * 0.075,
                clod ? 0.6 + Math.random() * 0.5 : 0.55 + Math.random() * 0.7,
                clod,
                clod ? 0.8 : 1.6 + Math.random() * 1.4
            );
        }
    }

    _end() {
        this.active = false;
        if (this.strand >= 0) {
            this.ctx.water.release(this.strand);
            this.strand = -1;
        }
    }

    cancel() {
        this._end();
    }
}
