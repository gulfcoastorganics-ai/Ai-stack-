/**
 * Spell 3 — Sand Eruption.
 *
 * SANDSTORM Phase 6: SNOWFLOW's Bloom, redesigned rather than retinted. A
 * targeted eruption: the ground pulls inward first, then a column of sand
 * bursts up out of it, blowing a crater with a raised rim, then falls back as
 * a slow, sun-caught curtain of granular fallout.
 *
 * Four things run on different clocks and that is the whole design — one more
 * than SNOWFLOW's Bloom had, because the brief asks the terrain to visibly
 * contract *before* it erupts rather than cratering on the same frame the
 * column appears:
 *
 *   the contraction  fast but not instant — a quarter second of the surface
 *                    visibly pulling down and in at the target, so the burst
 *                    reads as something that built up rather than something
 *                    that simply switched on.
 *   the column       fast. Up in a third of a second, held for a beat, then it
 *                    collapses back down its own axis rather than fading — the
 *                    mass goes back where it came from.
 *   the crater       fires at the same instant the column reaches the surface,
 *                    permanent from that frame on.
 *   the fallout      slow. Four seconds of it, and it is what the player is
 *                    actually looking at for most of the spell — heavy grains
 *                    ballistic, fine dust suspended, larger sheets falling near
 *                    the column, all three populations distinct. A burst with
 *                    no fallout is a flash; a burst with fallout is weather.
 *
 * The column leans. A perfectly vertical cylinder of sand reads as a rendered
 * primitive no matter what is on it, and two degrees of drift with a little
 * sway takes that away completely.
 */

import { PROFILE_TUBE } from "./waterBody.js";
import { clamp01, smooth01, bell, transport } from "./bending.js";
import { S } from "../core/settings.js";

const COLS = 34;
/** Full height of the column at peak, metres. */
const HEIGHT = 5.6;
/**
 * Radius of the column at its widest, metres.
 *
 * An eruption is a *mass* of material leaving the ground, and the aspect ratio
 * is most of what says so. The sand material's compaction darkening is keyed
 * to the milkiness/radius relationship as well, so a thin column also reads
 * as thinner mass rather than just a smaller shape.
 */
const GIRTH = 0.66;
/** Seconds from cast to the column being gone. */
const LIFE = 1.75;
/** Seconds of fallout after that. */
const FALLOUT = 3.4;
/** Seconds the pre-burst surface contraction runs before the column appears. */
const CONTRACT_TIME = 0.10;

const _rgt = new Float32Array(3);

export class Bloom {
    /** @param {import("./spellSystem.js").SpellContext} ctx */
    constructor(ctx) {
        this.ctx = ctx;
        this.active = false;
        this.strand = -1;

        this.t = 0;
        this.x = 0;
        this.y = 0;
        this.z = 0;
        this._leanX = 0;
        this._leanZ = 0;
        this._burst = false;
        this._curtainOwed = 0;
    }

    /** @param {number} x @param {number} y @param {number} z ground target */
    trigger(x, y, z) {
        if (this.strand < 0) this.strand = this.ctx.water.acquire();
        this.x = x;
        this.y = y;
        this.z = z;
        this.t = 0;
        this._burst = false;
        this._curtainOwed = 0;
        // The lean is mostly downwind, with a random component so two
        // eruptions in the same wind are not the same object twice. This is
        // the phase's wind-composition requirement in miniature: a Sand
        // Eruption cast in a strong crosswind visibly leans with it, the way a
        // real column of ejected material would, while a calm cast still gets
        // some organic asymmetry from the random term.
        const wa = (S.windDirection * Math.PI) / 180;
        const windLean = Math.min(1, S.windStrength * 0.5);
        const a = Math.random() * Math.PI * 2;
        this._leanX = Math.cos(a) * 0.16 * (1 - windLean) + Math.sin(wa) * 0.30 * windLean;
        this._leanZ = Math.sin(a) * 0.16 * (1 - windLean) + Math.cos(wa) * 0.30 * windLean;
        this.active = true;
    }

    /** @param {number} dt */
    update(dt) {
        if (!this.active) return;
        const ctx = this.ctx;
        this.t += dt;

        if (this.t >= LIFE + FALLOUT) {
            this._end();
            return;
        }

        // ---- pre-burst contraction -----------------------------------------
        // The surface visibly pulls down and in for a quarter of a second
        // before the column appears — stage 1 of the phase's eruption spec.
        // A small, growing depression with no berm and no compaction: mass
        // being drawn inward, not yet displaced anywhere. Writing it every
        // frame up to the burst (rather than once) is what makes it read as
        // building rather than switching on.
        if (!this._burst) {
            const k = smooth01(this.t / CONTRACT_TIME);
            ctx.deform.brush(
                this.x, this.z, 0.55 + 0.35 * k,
                0.10 * k, 0, 0, 0,
                0, 1, 1.0
            );
        }

        // ---- the burst ----------------------------------------------------
        // Fires once, on the frame the column reaches the surface. Everything
        // that happens at that instant — the crater, the ring of thrown sand,
        // the light spike — happens here rather than at trigger time, so they
        // are all the same event.
        if (!this._burst && this.t >= CONTRACT_TIME) {
            this._burst = true;
            this._crater();
            this._throw();
        }

        this._column();
        this._curtain(dt);
    }

    /**
     * The column.
     *
     * Radius runs wide at the base, waists in the middle and flares at the head,
     * which is what a real ejection does: the mass at the top has had the
     * longest to spread and the least to hold it together.
     */
    _column() {
        const ctx = this.ctx;
        const water = ctx.water;
        const s = this.strand;
        if (s < 0) return;

        const t = this.t;
        // Rise, hold, collapse. The collapse runs the height back down rather
        // than fading the alpha, so the column withdraws into the crater.
        const rise = smooth01((t - 0.10) / 0.34);
        const drop = 1 - smooth01((t - 0.95) / 0.80);
        const env = rise * drop;
        if (env <= 0.002) {
            water.setParams(s, PROFILE_TUBE, 0.5, 0, 0);
            return;
        }

        const top = HEIGHT * S.eruptionHeightScale * env;
        const sway = Math.sin(t * 3.1) * 0.12;

        let px = 0, py = 0, pz = 0;
        let rx = 1, ry = 0, rz = 0;
        let t0x = 0, t0y = 1, t0z = 0;

        for (let c = 0; c < COLS; c++) {
            const u = c / (COLS - 1);
            // Column 0 is the *head*, so `u` runs downward. That matches every
            // other strand in the project — u is always "distance behind the
            // leading edge" — and keeps the relief field drifting the right way.
            const h = 1 - u;
            const y = this.y + top * h;
            const lean = h * h;
            const x = this.x + (this._leanX + sway) * lean * top * 0.5;
            const z = this.z + (this._leanZ - sway * 0.6) * lean * top * 0.5;

            if (c > 0) {
                let t1x = x - px, t1y = y - py, t1z = z - pz;
                const l = Math.hypot(t1x, t1y, t1z) || 1e-4;
                t1x /= l; t1y /= l; t1z /= l;
                transport(_rgt, 0, rx, ry, rz, t0x, t0y, t0z, t1x, t1y, t1z);
                rx = _rgt[0]; ry = _rgt[1]; rz = _rgt[2];
                t0x = t1x; t0y = t1y; t0z = t1z;
            } else {
                rx = 1; ry = 0; rz = 0;
                t0x = 0; t0y = -1; t0z = 0;
            }

            // Flared head, waisted middle, broad foot.
            const shape =
                0.42 + 0.58 * bell(clamp01(h * 1.15))       // waist
                + 0.55 * smooth01((h - 0.72) / 0.28)        // flare
                + 0.75 * (1 - smooth01(h / 0.22));          // foot
            const rad = GIRTH * shape * env * (0.9 + 0.2 * Math.sin(u * 9 + t * 6));

            // The head is where it is coming apart; the foot is where it is
            // grinding against the crater rim.
            const foam = clamp01(0.30 + 0.55 * smooth01((h - 0.55) / 0.45)
                               + 0.4 * (1 - smooth01(h / 0.18)));

            water.column(
                s, c, x, y, z, rad,
                rx, ry, rz, t * 1.5 + u * 4,
                u * top, u, foam, 1
            );

            px = x; py = y; pz = z;
        }

        water.setParams(s, PROFILE_TUBE, 0.42, clamp01(env * 1.5), COLS);

        // One light, at the origin only — the phase's lighting note is
        // explicit that this ability gets "subtle illumination near origin
        // only," not the SNOWFLOW-era pair riding the crater and the column
        // head both. What is left is enough to keep the crater rim and the
        // base of the fallout from going flat, without the column reading as
        // lit from inside the way Fulgurite Garden's glass is meant to.
        ctx.lights.add(
            this.x, this.y + 0.35, this.z,
            8.0, 0.60, 0.48, 0.30, 6.0 * env
        );
    }

    /** The crater: one brush, deep, with a heavy rim. */
    _crater() {
        const ctx = this.ctx;
        ctx.deform.brush(
            this.x, this.z,
            1.15,
            0.52,   // deep central excavation
            0.40,   // large rim mass — the mass has to go somewhere
            0.72,   // packed by the blast
            0.30,   // and a little local stabilised crust from the heat of it
            Math.random() * Math.PI,
            1.15,   // very slightly oval, so it is not a stamped circle
            1.0
        );
        // A broken outer ring, thrown clear of the rim. Four smaller brushes
        // rather than one wide one: a crater with a perfectly even rim is the
        // tell that gives a single radial brush away.
        for (let i = 0; i < 4; i++) {
            const a = (i / 4) * Math.PI * 2 + Math.random() * 1.2;
            const d = 1.5 + Math.random() * 0.7;
            ctx.deform.brush(
                this.x + Math.cos(a) * d, this.z + Math.sin(a) * d,
                0.5 + Math.random() * 0.35,
                0, 0.20 + Math.random() * 0.14, 0.15, 0,
                a, 1.4, 1.0
            );
        }
        ctx.rig.addTrauma(0.28);
    }

    /**
     * The instant of the burst: a hard ring of thrown sand — the eruption's
     * "fast, heavy grains, ballistic" population (`clod`, kind 1) mixed with
     * finer grain (kind 0), same split SNOWFLOW's throw always had.
     */
    _throw() {
        const ctx = this.ctx;
        const sp = ctx.spray;
        if (!sp) return;
        const n = (430 * ctx.sprayScale) | 0;

        for (let k = 0; k < n; k++) {
            const a = Math.random() * Math.PI * 2;
            // Biased toward the rim, because that is where the mass leaves.
            const r = 0.35 + Math.sqrt(Math.random()) * 1.25;
            const up = 5.5 + Math.random() * 8.5;
            const out = 1.6 + Math.random() * 5.0;
            const clod = Math.random() < 0.26 ? 1 : 0;

            sp.emit(
                this.x + Math.cos(a) * r,
                this.y + 0.10 + Math.random() * 0.5,
                this.z + Math.sin(a) * r,
                Math.cos(a) * out,
                up * (clod ? 0.7 : 1.0),
                Math.sin(a) * out,
                clod ? 0.028 + Math.random() * 0.038 : 0.075 + Math.random() * 0.115,
                clod ? 1.1 + Math.random() * 0.8 : 1.4 + Math.random() * 1.5,
                clod,
                // Ballistic, or it never leaves the crater.
                clod ? 0.65 : 1.1 + Math.random() * 0.8
            );
        }
    }

    /**
     * The fallout curtain — the eruption's "fine dust, slowly suspended"
     * population.
     *
     * Fine, slow, high drag, and *emitted above the player's eye line* over a
     * wide disc, so it drifts down through the frame rather than sitting in a
     * cone over the crater. This is the part of the spell that lasts, and it is
     * also where the glinting has the best chance of being seen — dust this
     * fine, this high, catches a low sun dramatically on its way down, which
     * is most of "weather" rather than "flash".
     */
    _curtain(dt) {
        const ctx = this.ctx;
        const sp = ctx.spray;
        if (!sp) return;

        const t = this.t;
        // Ramps in behind the burst and decays over the whole fallout window.
        const k = smooth01((t - 0.25) / 0.5) * (1 - smooth01((t - 0.9) / (FALLOUT * 0.9)));
        if (k <= 0.01) return;

        const rate = 360 * ctx.sprayScale * k;
        this._curtainOwed += dt * rate;
        let count = this._curtainOwed | 0;
        if (count <= 0) return;
        this._curtainOwed -= count;
        if (count > 60) count = 60;

        for (let i = 0; i < count; i++) {
            const a = Math.random() * Math.PI * 2;
            const r = Math.sqrt(Math.random()) * 3.6;
            sp.emit(
                this.x + Math.cos(a) * r,
                this.y + 2.2 + Math.random() * 4.2,
                this.z + Math.sin(a) * r,
                (Math.random() - 0.5) * 0.9,
                0.2 + Math.random() * 1.1,
                (Math.random() - 0.5) * 0.9,
                0.028 + Math.random() * 0.055,
                1.6 + Math.random() * 1.9,
                0,
                // High drag: this is meant to hang and settle, not to fly.
                4.6
            );
        }

        this._sheets(dt, k);
    }

    /**
     * Larger sand sheets falling near the column — the eruption's third
     * granular regime, distinct from the ballistic throw and the wide, fine
     * dust curtain above. Bigger, heavier clumps that separate from the column
     * close to its own axis and drop almost straight down rather than
     * dispersing across the wide disc the fine dust covers — the visible
     * "chunks" of a real sand-fall, not just haze.
     */
    _sheets(dt, k) {
        const ctx = this.ctx;
        const sp = ctx.spray;
        if (!sp || k <= 0.02) return;

        const rate = 55 * ctx.sprayScale * k;
        this._sheetOwed = (this._sheetOwed || 0) + dt * rate;
        let count = this._sheetOwed | 0;
        if (count <= 0) return;
        this._sheetOwed -= count;
        if (count > 16) count = 16;

        for (let i = 0; i < count; i++) {
            const a = Math.random() * Math.PI * 2;
            // Tight to the column's own axis, not the fine dust's wide disc.
            const r = Math.sqrt(Math.random()) * 1.1;
            sp.emit(
                this.x + Math.cos(a) * r,
                this.y + 1.2 + Math.random() * 2.6,
                this.z + Math.sin(a) * r,
                (Math.random() - 0.5) * 0.5,
                -0.6 - Math.random() * 1.4,
                (Math.random() - 0.5) * 0.5,
                0.07 + Math.random() * 0.06,
                0.9 + Math.random() * 0.7,
                1,
                // Moderate drag: heavier than the dust, but still a clump of
                // loose grain, not a solid clod — it falls, it does not fly.
                1.6
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
