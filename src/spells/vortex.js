/**
 * Spell 5 — Sand Vortex.
 *
 * SANDSTORM Phase 6: SNOWFLOW's Vortex, redesigned rather than retinted. A
 * rotating column of airborne sand around the player that visibly *excavates*
 * a shallow spiral depression in the ground beneath it, pulls loose surface
 * mass toward its centre, holds a swirling mass of grain aloft, and lets it
 * settle back as the spell fades.
 *
 * The ground interaction is the point, and it is the one thing here that no
 * other ability does in quite this shape: this is the only effect that takes
 * the terrain state buffer *back* before giving it. A brush with a negative
 * depression is a perfectly ordinary brush as far as the simulation is
 * concerned — the accumulation is additive and the clamp floors it at zero —
 * so "pull sand from a ring toward the centre" and "let it back down" are the
 * same code path as everything else, with a sign on it.
 *
 * The airborne mass is three layers working from one description, matching
 * the phase brief's inner-core/main-helix/outer-dust structure:
 *
 *   the helices    swept tubes of dense, compacted sand, wound around the
 *                  player and rotating. These give the column a readable
 *                  *shape* — a vortex made only of particles is a cloud, and a
 *                  cloud does not spiral. This is the "main helix" layer.
 *   the core       a fast, narrow, tightly-wound population of grains emitted
 *                  close to the axis with a strong upward bias — the inner
 *                  core the brief calls for, distinct from the helices'
 *                  visible ribbons.
 *   the dust       a broader, slower, wind-stretched population riding further
 *                  out — see `_dust`. Both grain populations are emitted
 *                  continuously *along the same helices* that give the column
 *                  its shape, with the helix's own tangential velocity, and
 *                  short-lived enough that they never get far from the path
 *                  that launched them. That is how the spray swirls without
 *                  the particle simulation needing to know what a vortex is —
 *                  the same trick the surf plume uses to leave the crest the
 *                  mesh is actually drawing.
 */

import { PROFILE_TUBE } from "./waterBody.js";
import { clamp01, smooth01, bell, transport } from "./bending.js";
import { S } from "../core/settings.js";

/** How many helices. Three reads as a spiral; two reads as a double helix. */
const HELICES = 3;
/** Spine samples per helix. See the note on `STRAND_COLS` — this curve is tight. */
const COLS = 64;
/** Seconds of full-strength spin, before the ease-out. */
const HOLD = 3.0;
const RAMP = 0.55;
const FADE = 1.1;
/** Height of the column, metres. */
const TOP = 4.8;
/** Turns each helix makes from the ground to the top. */
const TURNS = 1.35;

const _rgt = new Float32Array(3);

export class Vortex {
    /** @param {import("./spellSystem.js").SpellContext} ctx */
    constructor(ctx) {
        this.ctx = ctx;
        this.active = false;
        /** @type {number[]} */
        this.strands = [-1, -1, -1];

        this.t = 0;
        this.x = 0;
        this.z = 0;
        this.spin = 0;
        this._stripOwed = 0;
        this._grainOwed = 0;
        this._dustOwed = 0;
        /** Slow downwind drift accumulated since trigger, metres. */
        this._driftX = 0;
        this._driftZ = 0;
        /** How far out the stripping ring has reached, metres. */
        this.ring = 0.9;
        this._shakeOwed = 0;
    }

    trigger() {
        const ctx = this.ctx;
        for (let i = 0; i < HELICES; i++) {
            if (this.strands[i] < 0) this.strands[i] = ctx.water.acquire();
        }
        this.t = 0;
        this.ring = 0.9;
        this._stripOwed = 0;
        this._grainOwed = 0;
        this._dustOwed = 0;
        this._driftX = 0;
        this._driftZ = 0;
        this._shakeOwed = 0;
        this.active = true;
    }

    /** @param {number} dt */
    update(dt) {
        if (!this.active) return;
        const ctx = this.ctx;
        this.t += dt;

        const total = RAMP + HOLD + FADE;
        if (this.t >= total) {
            this._end();
            return;
        }

        // The column follows the player, plus a slow downwind drift — the
        // phase brief allows the vortex to drift with prevailing wind, and the
        // existing spell control (the column is already re-centred every
        // frame) supports it cleanly: accumulate a small offset from the wind
        // vector and add it on top of the player's position instead of
        // replacing it. Capped well short of a metre so it reads as "leaning
        // with the wind" rather than "wandering off".
        const wa = (S.windDirection * Math.PI) / 180;
        this._driftX += Math.sin(wa) * S.windStrength * 0.35 * dt;
        this._driftZ += Math.cos(wa) * S.windStrength * 0.35 * dt;
        const driftMag = Math.hypot(this._driftX, this._driftZ);
        if (driftMag > 1.1) {
            const k = 1.1 / driftMag;
            this._driftX *= k; this._driftZ *= k;
        }
        this.x = ctx.controller.position.x + this._driftX;
        this.z = ctx.controller.position.z + this._driftZ;

        const env = smooth01(this.t / RAMP) * (1 - smooth01((this.t - RAMP - HOLD) / FADE));
        // Spins up and keeps spinning: the rotation does not ease out with the
        // envelope, so the last frame is a fading column that is still turning
        // rather than one that is winding down.
        this.spin += dt * (5.2 + 2.4 * env);

        this._helices(env);
        this._strip(dt, env);
        this._core(dt, env);
        this._dust(dt, env);
        this._shake(dt, env);

        // Little to no emission — see the phase's lighting-integration note.
        // What is left is a faint contact hint at the base, not a glow filling
        // the column; Fulgurite Garden is where the strong light budget goes.
        ctx.lights.add(
            this.x, ctx.terrain.heightAt(this.x, this.z) + 0.4, this.z,
            3.5, 0.55, 0.46, 0.32, 1.4 * env
        );
    }

    /**
     * A subtle rotational vibration while the vortex holds, rather than one
     * discrete impulse. Small, frequent pulses timed off the spin rather than
     * a single `addTrauma` call at trigger — this is meant to read as standing
     * near a turbulent, spinning mass, not as a single event's kick.
     */
    _shake(dt, env) {
        if (env < 0.1) return;
        this._shakeOwed += dt;
        const per = 1 / (HELICES * 1.7); // roughly once per helix per rotation-ish beat
        if (this._shakeOwed < per) return;
        this._shakeOwed -= per;
        this.ctx.rig.addTrauma(0.025 * env);
    }

    /** Lay the three helices. */
    _helices(env) {
        const ctx = this.ctx;
        const water = ctx.water;
        const groundY = ctx.terrain.heightAt(this.x, this.z);

        for (let hIdx = 0; hIdx < HELICES; hIdx++) {
            const s = this.strands[hIdx];
            if (s < 0) continue;
            const phase = (hIdx / HELICES) * Math.PI * 2;

            let px = 0, py = 0, pz = 0;
            let rx = 1, ry = 0, rz = 0;
            let t0x = 1, t0y = 0, t0z = 0;
            let dist = 0;

            for (let c = 0; c < COLS; c++) {
                const u = c / (COLS - 1);
                // Column 0 is the top of the helix — the leading edge of the
                // lift — so `u` runs downward, matching every other strand.
                const h = 1 - u;
                const ang = phase + this.spin + h * TURNS * Math.PI * 2;
                // Wide at the bottom where it is picking sand up, narrower and
                // faster at the top. Not a cone: the waist is what makes it read
                // as a vortex rather than as a party hat.
                const r = (2.55 - 1.15 * h) * (0.78 + 0.34 * bell(clamp01(h * 1.2))) * S.vortexRadiusScale;

                const x = this.x + Math.cos(ang) * r;
                const z = this.z + Math.sin(ang) * r;
                const y = groundY + TOP * h * env + 0.05;

                if (c > 0) {
                    let t1x = x - px, t1y = y - py, t1z = z - pz;
                    const l = Math.hypot(t1x, t1y, t1z) || 1e-4;
                    t1x /= l; t1y /= l; t1z /= l;
                    dist += l;
                    transport(_rgt, 0, rx, ry, rz, t0x, t0y, t0z, t1x, t1y, t1z);
                    rx = _rgt[0]; ry = _rgt[1]; rz = _rgt[2];
                    t0x = t1x; t0y = t1y; t0z = t1z;
                } else {
                    rx = 0; ry = 1; rz = 0;
                }

                // Both ends taper to nothing: the top because the sand is
                // dispersing, the bottom because it is still on the ground.
                //
                // Thin. The helices are here to give the column a readable
                // *shape*, not to be the column: the mass of it is the grains,
                // and a fat ribbon takes the reading away from them and turns
                // the spell into three solid loops with some sand near it.
                // Monotonic in `u`, with one slow modulation and nothing else.
                // Several terms keyed to world distance reach the sample Nyquist
                // and pinch the tube shut wherever their zeros line up, which
                // reads as vertebrae. Anything finer than the samples can carry
                // has to live in the relief field, which is band-limited on
                // purpose; see `waterRelief`.
                const taper = bell(u * 0.92 + 0.04);
                const rad = 0.125 * taper * env
                          * (0.78 + 0.34 * Math.sin(u * 3.4 + ctx.time * 2.2 + hIdx));

                // The section roll carries *no* distance term.
                //
                // A roll that advances along the spine spirals everything keyed
                // to the section angle — including the relief field — so the
                // surface comes out cut with a screw thread, which on a thin
                // tube reads as vertebrae. The ribbon wants that
                // spiral, because it has an elliptical section and the twist is
                // the point; a round section gains nothing from it but the
                // artefact.
                water.column(
                    s, c, x, y, z, rad,
                    rx, ry, rz, ctx.time * 0.7 + hIdx * 2.1,
                    dist, u, 0.22 + 0.3 * (1 - h), 1
                );

                px = x; py = y; pz = z;
            }

            // Almost entirely opaque: this is lifted, compacted sand, not
            // water. The small amount of transparency left is what lets the
            // far side of the column show through the near side, which is
            // most of what makes it read as a rotating volume.
            water.setParams(s, PROFILE_TUBE, 0.88, clamp01(env * 1.3), COLS);
        }
    }

    /**
     * Excavate the ground, then give it back.
     *
     * The ring grows outward while the spell holds and retreats while it fades,
     * so the sand comes back from the outside in — which is what settling
     * sand does, since the outermost material was lifted the least far. This
     * is also where the phase's "pull loose mass toward centre" and "disturb
     * nearby footprints" terrain-interaction requirements live: the excavation
     * ring itself *is* the pull, scouring a shallow spiral trench inward as it
     * rotates rather than lifting sand from a static footprint of holes.
     */
    _strip(dt, env) {
        const ctx = this.ctx;
        const f = ctx.deform;

        const holding = this.t < RAMP + HOLD;
        const ringMax = 3.1 * S.vortexRadiusScale;
        this.ring = holding
            ? Math.min(ringMax, this.ring + dt * 0.85)
            : Math.max(0.9, this.ring - dt * 2.2);

        this._stripOwed += dt;
        if (this._stripOwed < 1 / 45) return;
        const k = Math.min(this._stripOwed, 0.05);
        this._stripOwed = 0;

        const N = 9;
        // Holding: take sand away — depression up, no berm, because the mass
        // is in the air rather than piled at the rim. Fading: put it back, as
        // negative depression plus a little loose berm, because what lands is
        // broken sand sitting proud of what it fell on.
        const give = holding ? -1 : 1;

        const sp = ctx.spray;
        for (let i = 0; i < N; i++) {
            // Rotating with the column, so the ring is scoured rather than
            // stamped: a fixed set of angles leaves nine radial scars, and the
            // rotation itself is what reads as a spiral being drawn inward
            // rather than a ring of static pits.
            const a = (i / N) * Math.PI * 2 + this.spin * 0.6;
            const r = this.ring * (0.82 + Math.random() * 0.3);
            const bx = this.x + Math.cos(a) * r;
            const bz = this.z + Math.sin(a) * r;
            f.brush(
                bx, bz,
                0.55,
                give < 0 ? 0.95 * k * env : -1.7 * k,
                give < 0 ? 0.05 * k * env : 0.85 * k,
                give < 0 ? 0.30 * k * env : -0.6 * k,
                0,
                a + Math.PI * 0.5, 1.9, 1.0
            );

            // Occasional heavier clumps thrown clear of the excavation ring —
            // the phase's "throw occasional clumps outward" ground-interaction
            // note. Sparse and only while actively holding, so it reads as an
            // occasional heavier fragment rather than a constant spray on top
            // of the core/dust populations above.
            if (sp && holding && Math.random() < 0.05 * env) {
                const by = ctx.terrain.heightAt(bx, bz);
                sp.emit(
                    bx, by + 0.1, bz,
                    Math.cos(a) * (2.0 + Math.random() * 2.5),
                    1.5 + Math.random() * 2.5,
                    Math.sin(a) * (2.0 + Math.random() * 2.5),
                    0.05 + Math.random() * 0.05,
                    0.7 + Math.random() * 0.6,
                    1,
                    0.7
                );
            }
        }
    }

    /**
     * The inner core — fast, narrow-radius grains with a strong upward bias,
     * hugging the column's own axis well inside the helices' own radius. This
     * is the layer that reads as "something violently lifting mass," distinct
     * from the helices' visible spiral shape and the broader outer dust below.
     *
     * Emitted at a point loosely following the nearest helix's rotation, but
     * pulled in hard toward the axis rather than riding the helix's own
     * radius, and given a life short enough that a straight-line integration
     * never visibly departs from the curve it was launched along. Nothing in
     * the particle system knows this is a vortex; the swirl is entirely in
     * where and how the grains are born.
     */
    _core(dt, env) {
        const ctx = this.ctx;
        const sp = ctx.spray;
        if (!sp || env < 0.05) return;

        const rate = 2600 * ctx.sprayScale * env;
        this._grainOwed += dt * rate;
        let count = this._grainOwed | 0;
        if (count <= 0) return;
        this._grainOwed -= count;
        if (count > 260) count = 260;

        const groundY = ctx.terrain.heightAt(this.x, this.z);

        for (let k = 0; k < count; k++) {
            // Weighted toward the bottom, where the sand is being picked up.
            const h = Math.random() * Math.random();
            const hIdx = (Math.random() * HELICES) | 0;
            const phase = (hIdx / HELICES) * Math.PI * 2;
            const ang = phase + this.spin + h * TURNS * Math.PI * 2
                      + (Math.random() - 0.5) * 0.9;
            // Narrow: a fraction of the helices' own radius, so the core reads
            // as a distinct tight column inside the wider spiral shape.
            const r = (0.55 - 0.20 * h) * (0.7 + 0.5 * Math.random());

            const cs = Math.cos(ang);
            const sn = Math.sin(ang);
            // Tangential: perpendicular to the radius, in the direction of spin.
            const speed = 7.5 - 2.6 * h;
            const vx = -sn * speed;
            const vz = cs * speed;

            sp.emit(
                this.x + cs * r,
                groundY + TOP * h * env + 0.06 + Math.random() * 0.2,
                this.z + sn * r,
                vx + cs * (Math.random() - 0.6) * 1.2,
                // Strong upward velocity — the core's defining trait per the
                // phase brief, raised from the helix-radius population this
                // replaced so it visibly outruns the helices on its way up.
                3.2 + Math.random() * 4.6 + (1 - h) * 3.0,
                vz + sn * (Math.random() - 0.6) * 1.2,
                0.028 + Math.random() * 0.062,
                0.30 + Math.random() * 0.26,
                0,
                // Low drag, short life: it holds the launch velocity for the
                // whole of its life, which is what keeps it on the spiral.
                0.9
            );
        }
    }

    /**
     * The outer dust — broad, turbulent, slower-rotating, and stretched
     * downwind. The phase brief's third layer, and the one place a vortex is
     * explicitly asked to respond to the *same* prevailing wind the terrain
     * and the character's cloth already do: the further out a grain is
     * emitted, the more its velocity is nudged toward the wind vector rather
     * than staying purely tangential, so the whole outer envelope leans and
     * trails downwind while the inner core and the helices stay put on axis.
     */
    _dust(dt, env) {
        const ctx = this.ctx;
        const sp = ctx.spray;
        if (!sp || env < 0.05) return;

        const rate = 700 * ctx.sprayScale * env;
        this._dustOwed += dt * rate;
        let count = this._dustOwed | 0;
        if (count <= 0) return;
        this._dustOwed -= count;
        if (count > 90) count = 90;

        const groundY = ctx.terrain.heightAt(this.x, this.z);
        const wa = (S.windDirection * Math.PI) / 180;
        const windX = Math.sin(wa) * (1.5 + 2.5 * S.windStrength);
        const windZ = Math.cos(wa) * (1.5 + 2.5 * S.windStrength);

        for (let k = 0; k < count; k++) {
            const h = Math.random();
            // Wider than the helices' own radius and wider still than the
            // core — the broad, loosely-held envelope around the coherent
            // shape.
            const r = (2.55 - 1.15 * h) * (1.15 + 0.55 * Math.random()) * S.vortexRadiusScale;
            const ang = this.spin * 0.6 + h * TURNS * Math.PI * 1.2
                      + Math.random() * Math.PI * 2;
            const cs = Math.cos(ang);
            const sn = Math.sin(ang);
            // Slower rotation than the core or the helices, and blended
            // toward the wind vector rather than staying purely tangential —
            // the further out, the more the wind wins.
            const speed = 2.2 + 1.6 * (1 - h);
            const windMix = 0.55;
            const vx = -sn * speed * (1 - windMix) + windX * windMix;
            const vz = cs * speed * (1 - windMix) + windZ * windMix;

            sp.emit(
                this.x + cs * r,
                groundY + TOP * h * env * 0.7 + 0.1 + Math.random() * 0.6,
                this.z + sn * r,
                vx + (Math.random() - 0.5) * 0.8,
                0.6 + Math.random() * 1.6,
                vz + (Math.random() - 0.5) * 0.8,
                0.032 + Math.random() * 0.05,
                0.9 + Math.random() * 0.9,
                0,
                // Higher drag than the core: this is loose, wind-dominated
                // dust, not grain still carrying launch momentum.
                2.6
            );
        }
    }

    _end() {
        this.active = false;
        for (let i = 0; i < HELICES; i++) {
            if (this.strands[i] >= 0) {
                this.ctx.water.release(this.strands[i]);
                this.strands[i] = -1;
            }
        }
    }

    cancel() {
        this._end();
    }
}
