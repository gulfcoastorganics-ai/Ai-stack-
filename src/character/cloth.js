/**
 * Garment simulation — verlet cloth on coarse grids.
 *
 * Each garment is a grid of particles, `cols` around (or across) by `rows`
 * down. Most panels are a closed ring, as every SNOWFLOW garment was; the
 * split coat skirts and the scarf tail are open sheets instead — see
 * `ClothPanel.closed`. The grids are deliberately coarse (twenty by eleven
 * for a coat skirt) because the render mesh does not use them directly: the
 * vertex shader reconstructs a smooth surface from them with Catmull-Rom, so
 * tessellation and simulation cost are completely decoupled. Doubling the
 * visible smoothness costs nothing here.
 *
 * Every particle carries a bind-pose position and one bone. Its kinematic target
 * each frame is that bind position pushed through the bone's skinning matrix —
 * exactly what a rigidly-skinned vertex would do. A per-particle `pinRate`
 * decides how hard it is pulled toward that target, in units of 1/second:
 *
 *   Infinity   the waistband, the collar, the throat of the scarf. Welded.
 *   10-60      follows the body closely, with a frame or two of give.
 *   1-5        follows loosely — this is where a garment starts to read as cloth.
 *   0.2-0.5    shape memory only. Stops a free hem from slowly collapsing into
 *              a rope without meaningfully resisting motion.
 *
 * Expressing the pull as a rate rather than a per-frame blend is not a detail:
 * a "0.05 blend" applied 165 times a second is a 12 ms time constant, which is
 * a weld. Anything time-based in a system that also has to survive a frame-rate
 * change has to be written as a rate.
 *
 * Wind is *apparent* wind — the field wind minus the character's own velocity —
 * with quadratic drag, so the coat and scarf whip back hard during a sand-surf
 * run without needing a special case for it. The direction and strength come
 * from the same `S.windDirection`/`S.windStrength` the terrain and particles
 * read — there is no separate cloth wind.
 *
 * Allocation: none per frame. All state is typed arrays sized at construction.
 */

import { S } from "../core/settings.js";
import {
    B_ROOT, B_CHEST, B_UPPER_L, B_FORE_L, B_HAND_L,
    B_UPPER_R, B_FORE_R, B_HAND_R, B_NECK, B_SHIN_L, B_SHIN_R,
    B_THIGH_L, B_THIGH_R, B_FOOT_L, B_FOOT_R,
} from "./figure.js";
import { M_ROBE, M_MANTLE, M_TRIM } from "./build.js";

/** Which body capsules a panel is allowed to collide against. */
const C_TORSO = 1;
const C_LEGS = 2;
const C_ARM_L = 4;
const C_ARM_R = 8;

export class ClothPanel {
    constructor(spec) {
        this.name = spec.name;
        this.cols = spec.cols;
        this.rows = spec.rows;
        this.matId = spec.matId;
        this.renderCols = spec.renderCols;
        this.renderRows = spec.renderRows;
        this.weaveU = spec.weaveU;
        this.weaveV = spec.weaveV;
        this.aoTop = spec.aoTop;
        this.aoBottom = spec.aoBottom;
        this.collide = spec.collide;
        /** Rows at the bottom that check the sand surface. */
        this.groundRows = spec.groundRows || 0;
        /**
         * Whether column `cols-1` wraps back to column `0` — true for a tube
         * (the shoulder wrap), false for an open sheet whose two edges are
         * real, independent boundaries (the split coat skirts, the scarf
         * tail). Defaults true so any panel that doesn't set it keeps
         * SNOWFLOW's original closed-ring behaviour.
         */
        this.closed = spec.closed !== false;
        /** Row in the shared transform texture where this panel's grid starts. */
        this.nodeRow = 0;

        const n = this.cols * this.rows;
        this.count = n;
        this.bindPos = new Float32Array(n * 3);
        this.pos = new Float32Array(n * 3);
        this.prev = new Float32Array(n * 3);
        this.target = new Float32Array(n * 3);
        this.bone = new Int32Array(n);
        this.pinRate = new Float32Array(n);

        // Rest lengths: around the ring, down the panel, and the bending pair
        // two rows apart. Measured from the bind pose, so the garment's rest
        // shape *is* its authored shape.
        this.restU = new Float32Array(n);
        this.restV = new Float32Array(n);
        this.restB = new Float32Array(n);
    }

    /** Called once the bind positions are filled in. */
    finalise() {
        const { cols, rows, bindPos } = this;
        for (let j = 0; j < rows; j++) {
            for (let i = 0; i < cols; i++) {
                const a = (j * cols + i) * 3;
                const bu = (j * cols + ((i + 1) % cols)) * 3;
                this.restU[j * cols + i] = dist3(bindPos, a, bindPos, bu);
                if (j + 1 < rows) {
                    const bv = ((j + 1) * cols + i) * 3;
                    this.restV[j * cols + i] = dist3(bindPos, a, bindPos, bv);
                }
                if (j + 2 < rows) {
                    const bb = ((j + 2) * cols + i) * 3;
                    this.restB[j * cols + i] = dist3(bindPos, a, bindPos, bb);
                }
            }
        }
        this.pos.set(bindPos);
        this.prev.set(bindPos);
    }
}

function dist3(a, ia, b, ib) {
    return Math.hypot(a[ia] - b[ib], a[ia + 1] - b[ib + 1], a[ia + 2] - b[ib + 2]);
}

// -----------------------------------------------------------------------------
//  Garment shapes
// -----------------------------------------------------------------------------

/** Piecewise-linear lookup over a table of `[t, a, b]` control points. */
function curve(table, t) {
    let i = 0;
    while (i < table.length - 2 && t > table[i + 1][0]) i++;
    const A = table[i], Bb = table[i + 1];
    const s = Bb[0] > A[0] ? (t - A[0]) / (Bb[0] - A[0]) : 0;
    const k = Math.min(1, Math.max(0, s));
    return [A[1] + (Bb[1] - A[1]) * k, A[2] + (Bb[2] - A[2]) * k];
}

/**
 * One half of the outer coat's lower skirt.
 *
 * SNOWFLOW's robe was one closed tube all the way round the waist. Item 19
 * rules that shape out here — floor-length, unbroken cloth around both legs
 * reads as implausible the moment the traveller sprints, dashes or surfs —
 * so the skirt is cut into two open panels instead, seamed only at
 * centre-front (`a=0`) and centre-back (`a=pi`). Each half swings on its own
 * side of the stride rather than one cone dragging across both legs, and
 * because the panels are `closed: false` the solver never links column
 * `cols-1` back to column `0` — see `_distance`'s guard and `clothNode`'s
 * clamp-instead-of-wrap in charSkin.wgsl.
 */
function makeCoatSkirt(side) {
    const p = new ClothPanel({
        name: "coatSkirt" + side, cols: 20, rows: 11, matId: M_ROBE,
        renderCols: 40, renderRows: 30,
        weaveU: 0.95, weaveV: 1.00,
        aoTop: 0.55, aoBottom: 0.4,
        collide: C_TORSO | C_LEGS, groundRows: 2,
        closed: false,
    });

    // Lighter and looser than SNOWFLOW's robe rates: dry desert cloth, not
    // wet-heavy winter wool.
    const RATE = [Infinity, 26, 9, 3.6, 1.5, 0.85, 0.55, 0.4, 0.32, 0.28, 0.26];

    // side 0 = left half, running centre-back round to centre-front on -x;
    // side 1 = right half, centre-front round to centre-back on +x. The two
    // spans meet exactly at a=0 and a=pi, which is where the seam sits.
    const aStart = side === 0 ? Math.PI : 0;
    const aSpan = Math.PI;

    for (let j = 0; j < p.rows; j++) {
        const v = j / (p.rows - 1);
        for (let i = 0; i < p.cols; i++) {
            const t = i / (p.cols - 1);
            const a = aStart + t * aSpan;
            const sa = Math.sin(a), ca = Math.cos(a);
            // The flare accelerates downward, same reasoning as SNOWFLOW's robe.
            const f = Math.pow(v, 1.25);

            // Pleats in the rest shape, not a normal map, so the folds deepen
            // toward the hem and travel with the sim. Three incommensurate
            // frequencies so the two skirts never fold identically even
            // though they share a formula.
            const fold =
                0.100 * Math.sin(a * 5 + 0.6 + side * 3.1) +
                0.048 * Math.sin(a * 9 + 2.1) +
                0.022 * Math.sin(a * 14 + 4.4);
            const pleat = 1 + f * fold;

            // Mid-thigh at the longest point, clearing the knee at both
            // seams — short enough that a sprint or a wall-run never catches
            // it, unlike SNOWFLOW's ankle-length hem.
            const hemY = 0.620 + 0.130 * ca - 0.040 * Math.sin(a * 5 + 0.6);
            const y = 0.990 + (hemY - 0.990) * v;

            const rx = (0.158 + (0.300 - 0.158) * f) * pleat;
            const rz = (0.128 + (0.280 - 0.128) * f) * pleat;

            const o = (j * p.cols + i) * 3;
            p.bindPos[o] = rx * sa;
            p.bindPos[o + 1] = y;
            p.bindPos[o + 2] = rz * ca - 0.010 * v;
            p.bone[j * p.cols + i] = B_ROOT;
            p.pinRate[j * p.cols + i] = RATE[j];
        }
    }
    p.finalise();
    return p;
}

/**
 * The shoulder wrap: a short cape clearing the shoulders and falling only to
 * the small of the back — SNOWFLOW's over-mantle, shortened and retuned
 * rather than redesigned, since a closed ring this short already reads as
 * "layered outerwear" without blocking leg movement (item 19 only rules out
 * long, restrictive skirts, not a short torso wrap). Stays `closed: true`,
 * the one garment panel that still is.
 */
function makeMantle() {
    const p = new ClothPanel({
        name: "mantle", cols: 28, rows: 7, matId: M_MANTLE,
        renderCols: 64, renderRows: 22,
        weaveU: 1.35, weaveV: 0.72,
        aoTop: 0.85, aoBottom: 0.6,
        collide: C_TORSO | C_ARM_L | C_ARM_R,
    });

    const RATE = [Infinity, 34, 10, 3.4, 1.3, 0.7, 0.4];
    // The collar has to clear the torso it sits on: start it inside the
    // shoulders (0.176 across) and the top of the mantle only emerges at the
    // shoulder line, which reads as a flat plate bolted to the chest.
    const RAD = [
        [0.00, 0.176, 0.148],
        [0.20, 0.222, 0.176],
        [0.55, 0.235, 0.196],
        [1.00, 0.246, 0.214],
    ];
    // Stops well above the elbow, so the forearm wraps stay visible below it.
    const YT = [
        [0.00, 1.442, 0],
        [0.20, 1.372, 0],
        [0.55, 1.290, 0],
        [1.00, 0.000, 0], // filled per column below
    ];

    for (let j = 0; j < p.rows; j++) {
        const v = j / (p.rows - 1);
        const [rx, rz] = curve(RAD, v);
        for (let i = 0; i < p.cols; i++) {
            const a = (i / p.cols) * Math.PI * 2;
            const sa = Math.sin(a), ca = Math.cos(a);
            // Front hangs shorter than the back, and the edge scallops with the
            // folds rather than cutting a clean arc.
            YT[3][1] = 1.195 + 0.095 * ca + 0.030 * Math.sin(a * 7 + 1.4);
            const y = curve(YT, v)[0];
            const pleat = 1 + v * (0.062 * Math.sin(a * 7 + 1.4) + 0.026 * Math.sin(a * 11 + 3.0));

            const o = (j * p.cols + i) * 3;
            p.bindPos[o] = rx * sa * pleat;
            p.bindPos[o + 1] = y;
            p.bindPos[o + 2] = rz * ca * pleat - 0.012;
            p.bone[j * p.cols + i] = B_CHEST;
            p.pinRate[j * p.cols + i] = RATE[j];
        }
    }
    p.finalise();
    return p;
}

/**
 * The long scarf tail — a flat open strip, not a ring, welded at the throat
 * and trailing free down the back. This is where wind response (item 11) is
 * most legible: it barely stirs at rest and streams near-horizontal in a
 * strong blow, using the same `S.windDirection`/`S.windStrength` the terrain
 * and particles read, via the shared apparent-wind calculation in `update`.
 */
function makeScarfTail() {
    const p = new ClothPanel({
        name: "scarfTail", cols: 5, rows: 10, matId: M_TRIM,
        renderCols: 10, renderRows: 26,
        weaveU: 0.16, weaveV: 0.60,
        aoTop: 0.5, aoBottom: 0.35,
        collide: C_TORSO,
        closed: false,
    });

    const RATE = [Infinity, Infinity, 14, 5, 2.2, 1.1, 0.6, 0.4, 0.3, 0.24];
    // Visual-pass target: widened at the throat (0.052 -> 0.064) and tapered
    // harder toward the tip (0.35 -> 0.55) — a thicker root easing into a
    // genuinely narrow trailing end reads as a real wound scarf tail, where
    // the old near-uniform width read as a flat ribbon.
    const HW = 0.064; // half-width at the throat, narrowing toward the tip

    for (let j = 0; j < p.rows; j++) {
        const v = j / (p.rows - 1);
        // Hangs down the back and drifts slightly out and down at rest, so it
        // clears the shoulder wrap instead of resting inside it.
        const y = 1.360 - 0.520 * v - 0.10 * v * v;
        const z = -0.05 - 0.10 * v;
        const w = HW * (1 - 0.55 * v);
        for (let i = 0; i < p.cols; i++) {
            const t = i / (p.cols - 1) - 0.5; // -0.5..0.5 across the width
            const o = (j * p.cols + i) * 3;
            p.bindPos[o] = t * 2 * w;
            p.bindPos[o + 1] = y;
            p.bindPos[o + 2] = z;
            p.bone[j * p.cols + i] = B_NECK;
            p.pinRate[j * p.cols + i] = RATE[j];
        }
    }
    p.finalise();
    return p;
}

// SNOWFLOW also simulated a pair of loose sleeve panels here. They are gone,
// not merely renamed: the skinned body mesh's own upper-arm and forearm loft
// in `build.js` already carries M_ROBE (see its "arms" section) and the
// forearm-wrap fray band sits on top of that, so the arm was never bare
// without them — removing the panels drops two solves and two draw-mesh
// regions for zero visible loss, which is budget item 18 paying for the two
// new coat-skirt panels above.

export function makePanels() {
    return [makeCoatSkirt(0), makeCoatSkirt(1), makeMantle(), makeScarfTail()];
}

// -----------------------------------------------------------------------------
//  Solver
// -----------------------------------------------------------------------------

/** Constraint relaxation iterations. Six is where the robe stops looking rubbery. */
const ITERATIONS = 6;

/** Capsule table: [boneA, boneB, radius, mask]. Rebuilt from joints each frame. */
const CAPSULES = [
    [B_ROOT, B_NECK, 0.175, C_TORSO],
    [B_THIGH_L, B_SHIN_L, 0.125, C_LEGS],
    [B_SHIN_L, B_FOOT_L, 0.098, C_LEGS],
    [B_THIGH_R, B_SHIN_R, 0.125, C_LEGS],
    [B_SHIN_R, B_FOOT_R, 0.098, C_LEGS],
    [B_UPPER_L, B_FORE_L, 0.078, C_ARM_L],
    [B_FORE_L, B_HAND_L, 0.068, C_ARM_L],
    [B_UPPER_R, B_FORE_R, 0.078, C_ARM_R],
    [B_FORE_R, B_HAND_R, 0.068, C_ARM_R],
];

export class ClothSolver {
    /**
     * @param {ClothPanel[]} panels
     * @param {{heightAt(x:number,z:number):number}} terrain
     */
    constructor(panels, terrain) {
        this.panels = panels;
        this.terrain = terrain;
        this._wind = new Float32Array(3);
        this._acc = new Float32Array(3);
        this._t = 0;
    }

    /**
     * @param {number} dt
     * @param {import("./figure.js").Figure} fig
     * @param {import("./controller.js").CharacterController} ch
     */
    update(dt, fig, ch) {
        // Two sub-steps at 30 Hz and below. Verlet with hard pins is stable but
        // a long step lets the hem overshoot through the legs before the
        // collision pass sees it.
        let h = Math.min(dt, 1 / 30);
        let steps = 1;
        if (h > 1 / 55) { steps = 2; h *= 0.5; }
        this._t += dt;

        // ---- apparent wind ----------------------------------------------
        const a = (S.windDirection * Math.PI) / 180;
        const ws = 3.2 * S.windStrength;
        // Gusts, so a standing figure's robe is never dead still.
        const gust = 1 + 0.35 * Math.sin(this._t * 0.7) + 0.18 * Math.sin(this._t * 2.3 + 1.1);
        this._wind[0] = Math.sin(a) * ws * gust - ch.velocity.x;
        this._wind[1] = 0.35 * Math.sin(this._t * 1.9);
        this._wind[2] = Math.cos(a) * ws * gust - ch.velocity.z;

        for (let s = 0; s < steps; s++) {
            for (let i = 0; i < this.panels.length; i++) {
                this._step(this.panels[i], h, fig);
            }
        }
    }

    _step(p, h, fig) {
        const n = p.count;
        const pos = p.pos;
        const prev = p.prev;
        const target = p.target;
        const skin = fig.skin;

        // ---- kinematic targets, from the skeleton -------------------------
        for (let k = 0; k < n; k++) {
            const b = p.bone[k] * 16;
            const o = k * 3;
            const x = p.bindPos[o], y = p.bindPos[o + 1], z = p.bindPos[o + 2];
            target[o] = skin[b] * x + skin[b + 4] * y + skin[b + 8] * z + skin[b + 12];
            target[o + 1] = skin[b + 1] * x + skin[b + 5] * y + skin[b + 9] * z + skin[b + 13];
            target[o + 2] = skin[b + 2] * x + skin[b + 6] * y + skin[b + 10] * z + skin[b + 14];
        }

        // ---- integrate ----------------------------------------------------
        // Quadratic drag against the apparent wind. At walking pace this is a
        // fraction of gravity; at nineteen metres a second it is four times it,
        // which is what lays the robe out flat behind a surf run with no special
        // case anywhere.
        // Dry desert cloth is lighter than SNOWFLOW's winter garments: more
        // drag per unit wind, less velocity damping, so the same wind field
        // visibly scales from a light stir to a full whip (item 11) instead
        // of the heavier fabric's sluggish response.
        const wx = this._wind[0], wy = this._wind[1], wz = this._wind[2];
        const wmag = Math.hypot(wx, wy, wz);
        const drag = 0.13 * wmag;
        const damp = Math.pow(0.88, h * 60);
        const h2 = h * h;

        for (let k = 0; k < n; k++) {
            if (!isFinite(p.pinRate[k])) continue; // welded; skip the integrator
            const o = k * 3;
            // Turbulence, hashed off the particle index so it does not pulse in
            // unison across the garment.
            const ph = k * 1.7 + this._t * 4.5;
            const tx = Math.sin(ph) * 0.9;
            const ty = Math.sin(ph * 1.31 + 2.1) * 0.7;
            const tz = Math.cos(ph * 0.87 + 0.4) * 0.9;

            const ax = wx * drag + tx * drag * 0.25;
            const ay = wy * drag - 9.81 + ty * drag * 0.25;
            const az = wz * drag + tz * drag * 0.25;

            const vx = (pos[o] - prev[o]) * damp;
            const vy = (pos[o + 1] - prev[o + 1]) * damp;
            const vz = (pos[o + 2] - prev[o + 2]) * damp;

            prev[o] = pos[o]; prev[o + 1] = pos[o + 1]; prev[o + 2] = pos[o + 2];
            pos[o] += vx + ax * h2;
            pos[o + 1] += vy + ay * h2;
            pos[o + 2] += vz + az * h2;
        }

        // ---- constraints ---------------------------------------------------
        for (let it = 0; it < ITERATIONS; it++) {
            this._anchors(p, h);
            this._distance(p, it);
        }
        this._collide(p, fig);
    }

    /** Pull each particle toward its skinned target at its own rate. */
    _anchors(p, h) {
        const n = p.count;
        const pos = p.pos;
        const target = p.target;
        for (let k = 0; k < n; k++) {
            const rate = p.pinRate[k];
            const o = k * 3;
            if (!isFinite(rate)) {
                pos[o] = target[o];
                pos[o + 1] = target[o + 1];
                pos[o + 2] = target[o + 2];
                continue;
            }
            if (rate <= 0) continue;
            // Divided by the iteration count so the total pull over one frame is
            // the rate the table asks for, not six times it.
            const w = (1 - Math.exp(-rate * h)) / ITERATIONS;
            pos[o] += (target[o] - pos[o]) * w;
            pos[o + 1] += (target[o + 1] - pos[o + 1]) * w;
            pos[o + 2] += (target[o + 2] - pos[o + 2]) * w;
        }
    }

    /**
     * Distance and bending constraints, Gauss-Seidel.
     *
     * Welded particles have infinite mass: they take none of the correction, so
     * a hem cannot drag the waistband off the hips.
     */
    _distance(p, iteration) {
        const { cols, rows, pos, restU, restV, restB, pinRate, closed } = p;
        // Bending is solved softly and only on the later iterations. Solved hard
        // it fights the distance constraints and the garment goes stiff.
        const bendK = iteration >= ITERATIONS - 3 ? 0.22 : 0;

        for (let j = 0; j < rows; j++) {
            for (let i = 0; i < cols; i++) {
                const k = j * cols + i;

                // Around the ring — skipped on an open panel's last column,
                // which is a real free edge, not a seam back to column 0.
                if (closed || i + 1 < cols) {
                    solveLink(pos, k, j * cols + ((i + 1) % cols), restU[k], pinRate, 1);
                }
                // down the panel
                if (j + 1 < rows) {
                    solveLink(pos, k, (j + 1) * cols + i, restV[k], pinRate, 1);
                }
                // bending, two rows apart
                if (bendK > 0 && j + 2 < rows) {
                    solveLink(pos, k, (j + 2) * cols + i, restB[k], pinRate, bendK);
                }
            }
        }
    }

    /** Push particles out of the body capsules and off the sand. */
    _collide(p, fig) {
        const n = p.count;
        const pos = p.pos;
        const joint = fig.joint;

        for (let c = 0; c < CAPSULES.length; c++) {
            const cap = CAPSULES[c];
            if ((p.collide & cap[3]) === 0) continue;
            const a = cap[0] * 3, b = cap[1] * 3;
            const ax = joint[a], ay = joint[a + 1], az = joint[a + 2];
            const bx = joint[b], by = joint[b + 1], bz = joint[b + 2];
            const ex = bx - ax, ey = by - ay, ez = bz - az;
            const elen2 = ex * ex + ey * ey + ez * ez || 1e-6;
            const r = cap[2];

            for (let k = 0; k < n; k++) {
                if (!isFinite(p.pinRate[k])) continue;
                const o = k * 3;
                let t = ((pos[o] - ax) * ex + (pos[o + 1] - ay) * ey + (pos[o + 2] - az) * ez) / elen2;
                t = t < 0 ? 0 : t > 1 ? 1 : t;
                const cx = ax + ex * t, cy = ay + ey * t, cz = az + ez * t;
                let dx = pos[o] - cx, dy = pos[o + 1] - cy, dz = pos[o + 2] - cz;
                const d = Math.hypot(dx, dy, dz);
                if (d >= r || d < 1e-6) continue;
                const push = (r - d) / d;
                pos[o] += dx * push;
                pos[o + 1] += dy * push;
                pos[o + 2] += dz * push;
            }
        }

        // The hem rides on the sand rather than through it. Only the bottom rows
        // check, because that is the only place it can happen and `heightAt` is
        // a filtered lookup, not free.
        if (p.groundRows > 0) {
            const start = (p.rows - p.groundRows) * p.cols;
            for (let k = start; k < n; k++) {
                const o = k * 3;
                const g = this.terrain.heightAt(pos[o], pos[o + 2]) + 0.012;
                if (pos[o + 1] < g) pos[o + 1] = g;
            }
        }
    }
}

/**
 * One distance constraint. Mass weighting is binary — a welded particle does not
 * move at all — which is both correct and much cheaper than carrying inverse
 * masses through the inner loop.
 */
function solveLink(pos, ka, kb, rest, pinRate, stiffness) {
    const a = ka * 3, b = kb * 3;
    const dx = pos[b] - pos[a];
    const dy = pos[b + 1] - pos[a + 1];
    const dz = pos[b + 2] - pos[a + 2];
    const d = Math.hypot(dx, dy, dz);
    if (d < 1e-7) return;
    const diff = ((d - rest) / d) * stiffness;

    const fa = isFinite(pinRate[ka]);
    const fb = isFinite(pinRate[kb]);
    if (fa && fb) {
        const h = diff * 0.5;
        pos[a] += dx * h; pos[a + 1] += dy * h; pos[a + 2] += dz * h;
        pos[b] -= dx * h; pos[b + 1] -= dy * h; pos[b + 2] -= dz * h;
    } else if (fa) {
        pos[a] += dx * diff; pos[a + 1] += dy * diff; pos[a + 2] += dz * diff;
    } else if (fb) {
        pos[b] -= dx * diff; pos[b + 1] -= dy * diff; pos[b + 2] -= dz * diff;
    }
}
