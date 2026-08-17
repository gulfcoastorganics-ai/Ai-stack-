/**
 * Where the character meets the sand.
 *
 * SANDSTORM note: this is SNOWFLOW's snow-contact module — same three writers,
 * same brush-based hand-off into the terrain state buffer, same gait/IK plant
 * timing. Only the numbers each writer stamps have moved: shallower boot sink
 * (packed and loose sand compress under a boot far more readily than snow
 * does, so it takes less depth to read), subtler raised edges (a berm of
 * grains, not a mounded snow lip), and a footprint radius that widens with
 * impact so a hard landing visibly compresses more sand than a light step.
 *
 * Translates locomotion state into brushes on the terrain state buffer. This is
 * the only thing standing between the physics in `controller.js` and the marks
 * left on the field, and it is deliberately separate from both: the controller
 * should not know a deformation buffer exists, and the buffer should not know
 * what a foot is.
 *
 * Three writers:
 *
 *   footfall   one splat per plant, frame-accurate with the gait event. A boot
 *              is longer than it is wide and oriented with the body, so the
 *              brush is elongated and yawed rather than round.
 *   body drag  a shallow continuous scuff under a walking character, so the
 *              trail is a trail and not a row of disconnected prints.
 *   surf wake  a deep continuous groove with berms thrown to the outside of the
 *              turn. This is the centrepiece's mark on the world.
 *
 * Zero allocation: brushes are pushed straight into the field's staging array.
 */

/**
 * Boot geometry, metres. `WIDTH` is the short-axis radius at a light footfall —
 * see `_walk`'s footfall branch, which widens it with impact so a hard landing
 * visibly compresses a wider patch of sand than a light step. Narrower than
 * this and the print is only a few texels wide and the rim detail has nowhere
 * to live.
 */
const BOOT_WIDTH = 0.10;
const BOOT_ELONG = 1.7;

/** Surf groove geometry, metres. */
const SURF_WIDTH = 0.30;
const SURF_ELONG = 2.6;

export class SnowContact {
    /**
     * @param {import("./controller.js").CharacterController} character
     * @param {import("../terrain/deformation.js").DeformationField} field
     * @param {import("./figure.js").Figure} [figure] posed skeleton, if built
     * @param {import("../vfx/particles.js").SprayField} [spray]
     */
    constructor(character, field, figure, spray) {
        this.character = character;
        this.field = field;
        this.spray = spray || null;
        /**
         * The posed figure, when there is one.
         *
         * The controller also produces footfall events, and they are close
         * enough to be tempting. But "close enough" is exactly what a footprint
         * cannot be: the print has to be under the boot, and only the figure
         * knows where the boot actually planted, because it is the thing that
         * decided. Taking the event from the same state machine that freezes the
         * stance foot makes the two agree by construction rather than by
         * matching two sets of constants.
         */
        this.figure = figure || null;

        /** Distance travelled since the last continuous splat, metres. */
        this._sinceSplat = 0;
        this._prevX = character.position.x;
        this._prevZ = character.position.z;
    }

    /** @param {number} dt seconds */
    update(dt) {
        const ch = this.character;
        const f = this.field;

        const dx = ch.position.x - this._prevX;
        const dz = ch.position.z - this._prevZ;
        const moved = Math.hypot(dx, dz);
        this._prevX = ch.position.x;
        this._prevZ = ch.position.z;

        if (ch.surf > 0.02) this._surf(dt, moved);
        if (ch.surf < 0.98) this._walk(dt, moved);

        // Footfalls fire regardless of mode; the gait suppresses them while
        // surfing because the feet are on the board.
        const fig = this.figure;
        for (let i = 0; i < 2; i++) {
            let px, pz;
            if (fig) {
                if (!fig.touchdown[i] || !ch.stepping) continue;
                px = fig.plant[i * 3];
                pz = fig.plant[i * 3 + 2];
            } else {
                if (!ch.footfall || i !== ch.footIndex) continue;
                px = ch.footPos.x;
                pz = ch.footPos.z;
            }

            // Recomputed here rather than read off the controller, so it cannot
            // be a frame stale relative to the plant it is describing.
            const impact = Math.min(1.3, 0.35 + ch.speed / 5.4);
            // A hard landing compresses a wider patch of sand than a light
            // step, not just a deeper one — unlike snow, which mostly just
            // sinks. Radius grows up to 60% over the light-footfall width.
            const footRadius = BOOT_WIDTH * (1 + 0.46 * impact);
            f.brush(
                px, pz,
                footRadius,
                // Depth: a boot sinks noticeably less into sand than it did
                // into unpacked snow — dry sand compacts and resists underfoot
                // well before it reaches snow's 13-27 cm — so this stays
                // shallower across the same impact range.
                0.07 + 0.08 * impact,
                // The berm is still the point — mass pushed out of the hole has
                // to go somewhere — but it is a subtler ridge of grains than
                // snow's mounded lip, not a dramatic pile.
                0.045 + 0.045 * impact,
                0.9,                    // compaction: trodden sand packs dense
                0,                      // no crust from an ordinary footfall
                ch.facing,
                BOOT_ELONG,
                1.0                     // full rim roughness — boots tear edges
            );

            const py = fig ? fig.plant[i * 3 + 1] : ch.position.y;
            this._kick(px, py, pz, impact);
        }
    }

    /**
     * Sand thrown by a boot landing.
     *
     * Fired from the same branch that stamps the print, so the grains leave the
     * ground on the exact frame the foot arrives — one event, rather than two
     * systems agreeing about when it happened.
     *
     * The kick goes up and *backward* relative to travel. A boot in loose sand
     * scoops: it enters forward, compresses, and throws the displaced grain out
     * behind the heel as the weight rolls over it. Running kicks back
     * noticeably harder than walking — `back` below carries an explicit speed
     * term on top of the impact scaling, so a sprinting footfall throws a
     * visibly longer plume than a stroll at the same landing force would.
     */
    _kick(x, y, z, impact) {
        const sp = this.spray;
        if (!sp) return;
        const ch = this.character;
        if (ch.speed < 0.4) return;

        const fx = Math.sin(ch.facing);
        const fz = Math.cos(ch.facing);
        // Many small grains rather than a few large ones. Sand grains read as
        // smaller and more numerous than snow's powder puffs at the same
        // apparent density.
        const n = 6 + ((impact * 14) | 0);
        const speedKick = Math.min(1.4, ch.speed / 7.0);

        for (let k = 0; k < n; k++) {
            const spread = 0.85;
            const rx = (Math.random() - 0.5) * spread;
            const rz = (Math.random() - 0.5) * spread;
            const up = 0.75 + Math.random() * 1.5;
            const back = 0.5 + Math.random() * 1.5 * impact + speedKick * 0.9;
            // A fifth of it is heavier stuff that flies further and falls faster.
            const clod = Math.random() < 0.22 ? 1 : 0;

            sp.emit(
                x + rx * 0.09, y + 0.03 + Math.random() * 0.05, z + rz * 0.09,
                -fx * back + rx * 1.3 + ch.velocity.x * 0.25,
                up * (clod ? 1.25 : 1.0),
                -fz * back + rz * 1.3 + ch.velocity.z * 0.25,
                clod ? 0.011 + Math.random() * 0.010 : 0.015 + Math.random() * 0.022,
                clod ? 0.55 + Math.random() * 0.35 : 0.55 + Math.random() * 0.60,
                clod
            );
        }
    }

    /**
     * Walking scuff through loose sand. Very shallow, and only while actually
     * moving — a standing character should not slowly bore a hole.
     */
    _walk(dt, moved) {
        const ch = this.character;
        if (ch.speed < 0.25) return;

        const w = 1 - ch.surf;
        // Scaled by distance travelled, not by dt, so the groove has the same
        // depth per metre at any speed or frame rate. A given patch of ground
        // sits under the brush for (2 * radius / moved) frames, so the depth it
        // ends up at is roughly rate * 2 * radius * profile — independent of
        // both speed and frame rate, which is the point.
        const k = Math.min(moved, 0.35);
        // Compression stays deliberately below saturation here. If the scuff
        // packed the whole path to 1.0, the boot prints stamped on top would
        // have nothing left to darken and the trail would read as one flat
        // ribbon instead of as a line of prints in a churned path.
        // Shallower and narrower than the boot prints it links, on purpose. It
        // was originally deep enough to dominate them, which turned a line of
        // footprints into one continuous ski track — fine while the feet were
        // hidden under a floor-length robe, wrong now that they are not.
        this.field.brush(
            ch.position.x, ch.position.z,
            0.22,
            0.20 * k * w,
            0.22 * k * w,
            0.8 * k * w,
            0,
            ch.facing,
            1.5,
            0.85
        );
    }

    /**
     * The dune-surf wake.
     *
     * Three brushes: the groove the board cuts, and one berm on each side
     * weighted by the carve, so the outside of a turn throws a much heavier wall
     * of sand than the inside. That asymmetry is what makes a carve read as a
     * carve rather than as a straight furrow.
     */
    _surf(dt, moved) {
        const ch = this.character;
        const f = this.field;
        const s = ch.surf;

        // Below a walking pace there is no wake to speak of; splatting anyway
        // would just dig a pit wherever the player coasted to a stop.
        const speedK = Math.min(1, ch.speed / 6);
        if (speedK < 0.05) return;

        const k = Math.min(moved, 0.6) * s * speedK;
        if (k <= 0) return;

        // Past the point where the trench stops deepening, extra speed still
        // means extra snow moved — it goes into width and into the walls, which
        // is what makes a fast run's scar read as bigger rather than just longer.
        const fast = Math.min(1, Math.max(0, ch.speed - 6) / 12);

        const yaw = ch.facing;
        const rx = Math.cos(yaw);
        const rz = -Math.sin(yaw);

        // --- the groove ------------------------------------------------------
        // The board rides the inside edge in a turn, so the trench offsets
        // slightly toward the lean.
        const lean = ch.carve;
        const gx = ch.position.x + rx * lean * 0.12;
        const gz = ch.position.z + rz * lean * 0.12;

        f.brush(
            gx, gz,
            SURF_WIDTH * (1 + 0.35 * fast),
            1.20 * k,   // deep — a run should be visible from across the field
            0.30 * k,
            4.0 * k,    // the board packs the trench floor hard
            0,
            yaw,
            SURF_ELONG,
            0.55        // the board's edge is cleaner than a boot's
        );

        // --- thrown mass -----------------------------------------------------
        // The outside of the turn takes most of it, and the outside of a *right*
        // turn is the left-hand side — the board resists the turn and throws snow
        // away from its centre, the same way a carving snowboard's spray arcs out
        // of the turn rather than into it. `carve` is positive turning right, so
        // the weights run against it.
        //
        // The wake mesh in `src/vfx/surfWake.js` resolves its sides from the same
        // sign, so the airborne wave and the mark it leaves agree.
        const outside = Math.min(1, Math.abs(lean));
        const sideL = 0.5 + lean * 0.5; // weight on the left berm
        const sideR = 0.5 - lean * 0.5;

        const off = SURF_WIDTH * (1.5 + 0.5 * fast);
        // Raised a little over SNOWFLOW's throw weight: a berm of dry sand
        // grains reads as a shape from further away than an equivalent mass of
        // snow did, so the outer wall wants to be a touch more generous to stay
        // legible as "raised outer berm" rather than a thin ridge.
        const throwK = 0.85 * k * (0.55 + 0.9 * outside) * (1 + 0.5 * fast);

        f.brush(
            ch.position.x - rx * off, ch.position.z - rz * off,
            SURF_WIDTH * 0.95,
            0, throwK * sideL * 2.0, 0, 0,
            yaw, SURF_ELONG * 0.8, 1.0
        );
        f.brush(
            ch.position.x + rx * off, ch.position.z + rz * off,
            SURF_WIDTH * 0.95,
            0, throwK * sideR * 2.0, 0, 0,
            yaw, SURF_ELONG * 0.8, 1.0
        );
    }
}
