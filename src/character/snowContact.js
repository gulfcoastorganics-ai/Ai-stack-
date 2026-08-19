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

/** Dash streak geometry, metres — narrower and far more elongated than a
 *  boot print, so it reads as a scored line rather than a smeared footpath. */
const DASH_WIDTH = 0.16;
const DASH_ELONG = 3.4;

/** Reference ground speed a jump launch's kick scales against, m/s — a
 *  fixed read of "how fast counts as fast" for this one effect, same spirit
 *  as `_kick`'s own hardcoded speed terms below, not a live settings tunable. */
const JUMP_LAUNCH_SPEED_REF = 7.2;

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

        // ---- Phase 7 traversal signatures ---------------------------------
        // Every one of these reads a flag the controller already computed —
        // see `controller.js`'s class doc on why it never writes a brush
        // itself. Grounded-only by construction: `_walk`/`_surf` below are
        // gated the same way, and none of these fire while genuinely
        // airborne (a dash mid-air gets its own, much lighter, trail).
        if (ch.jumpFired) this._jumpLaunch();
        if (ch.dashFired) this._dashLaunch(ch.dashKind === 1);
        if (ch.dashing) this._dashTrail(dt);
        if (ch.hardCut) this._hardCutSpray();
        if (ch.sandStepFired) this._sandStep();
        if (ch.justLanded) this._landing();

        // Both gated on `grounded`: a surf blend that is still easing down
        // (or never eased down at all — see `controller.js`'s note on why
        // the blend survives a jump) must not keep gouging a groove into
        // thin air while the character is actually flying over the dune.
        if (ch.surf > 0.02 && ch.grounded) this._surf(dt, moved);
        if (ch.surf < 0.98 && ch.grounded && !ch.dashing && !ch.evading) this._walk(dt, moved);

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

    // ----------------------------------------------------------- Phase 7

    /**
     * The instant the primary jump fires: a shallow compression under both
     * feet plus a light, mostly-vertical kick of grain — the push-off read,
     * distinct from a dash's dig-in (lateral, aggressive) and a Sand Step's
     * ring (a fast-fading burst with no ground contact at all, since there
     * is nothing solid under the foot by then). Scaled by how hard the
     * character was already moving, so a standing jump barely marks the
     * ground while a running crest-leap throws a visible little cloud.
     */
    _jumpLaunch() {
        const ch = this.character;
        const x = ch.position.x, y = ch.position.y, z = ch.position.z;
        const k = Math.min(1, ch.speed / JUMP_LAUNCH_SPEED_REF);

        this.field.brush(
            x, z, 0.22 + 0.06 * k,
            0.05 + 0.03 * k, 0.05 + 0.05 * k, 0.6, 0,
            ch.facing, 1.3, 0.9
        );

        const sp = this.spray;
        if (!sp) return;
        const n = 8 + ((k * 14) | 0);
        for (let i = 0; i < n; i++) {
            const a = Math.random() * Math.PI * 2;
            const r = 0.05 + Math.random() * 0.16;
            const ca = Math.cos(a), sa = Math.sin(a);
            sp.emit(
                x + ca * r, y + 0.03, z + sa * r,
                ca * (0.6 + Math.random() * 1.1) + ch.velocity.x * 0.15,
                1.1 + Math.random() * 1.6,
                sa * (0.6 + Math.random() * 1.1) + ch.velocity.z * 0.15,
                0.010 + Math.random() * 0.014,
                0.4 + Math.random() * 0.35,
                0
            );
        }
    }

    /**
     * The instant a dash fires: a compressed launch patch under the feet,
     * plus a burst of grain thrown laterally off both sides — the "dig in
     * and go" read the phase brief asks for. An air dash gets a lighter
     * version: no ground brush (there is no ground under it), just a
     * scatter of grains flung from around the character to sell the impulse.
     * @param {boolean} grounded true for a ground dash, false for an air dash
     */
    _dashLaunch(grounded) {
        const ch = this.character;
        const sp = this.spray;
        const x = ch.position.x, y = ch.position.y, z = ch.position.z;
        const dx = ch.dashDirX, dz = ch.dashDirZ;

        if (grounded) {
            // Same (x, z) yaw convention every other brush call in this file
            // uses — `ch.facing` is already the dash direction by the time
            // this fires, since the controller snaps facing to it on launch.
            this.field.brush(
                x, z, 0.30,
                0.16, 0.10, 0.85, 0,
                ch.facing, 1.2, 1.0
            );
        }

        if (!sp) return;
        // Perpendicular to the dash — a launch throws grain sideways off the
        // dig-in, not forward along the direction of travel.
        const px = -dz, pz = dx;
        const n = grounded ? 46 : 30;
        for (let k = 0; k < n; k++) {
            const side = Math.random() < 0.5 ? -1 : 1;
            const out = 1.2 + Math.random() * 2.6;
            const up = grounded ? 0.8 + Math.random() * 2.0 : 0.5 + Math.random() * 1.2;
            const clod = Math.random() < 0.24 ? 1 : 0;
            sp.emit(
                x + px * side * 0.12, y + 0.05 + Math.random() * 0.15, z + pz * side * 0.12,
                px * side * out - dx * 1.5, up, pz * side * out - dz * 1.5,
                clod ? 0.020 + Math.random() * 0.022 : 0.012 + Math.random() * 0.016,
                0.5 + Math.random() * 0.5,
                clod
            );
        }
    }

    /**
     * The thin streak scored while a dash is actively travelling — a much
     * narrower, more elongated mark than the walking scuff, and it only
     * writes while `dashing` is true so it stops the instant the burst ends
     * rather than trailing off gradually. Grounded dashes only: an air
     * dash's trail is a particle effect, handled by the ability-style spray
     * in `_dashLaunch`/the figure's own wind response, not a ground mark.
     */
    _dashTrail(dt) {
        const ch = this.character;
        if (!ch.grounded || ch.speed < 1) return;
        this.field.brush(
            ch.position.x, ch.position.z,
            DASH_WIDTH,
            0.10, 0.06, 0.9, 0,
            ch.facing, DASH_ELONG, 0.7
        );
    }

    /**
     * Lateral sand spray on a hard directional cut — the phase brief's "on a
     * hard 90-degree cut... lateral sand spray is generated" and "on a 180
     * reversal... deeper sand disturbance." One shot, fired the same frame
     * the controller flags the cut, scaled by how sharp it was.
     */
    _hardCutSpray() {
        const ch = this.character;
        const sp = this.spray;
        const k = ch.cutStrength;

        // A short skid scar under the pivoting foot.
        this.field.brush(
            ch.position.x, ch.position.z,
            0.16 + 0.10 * k,
            0.10 * k, 0.14 * k, 0.7, 0,
            ch.facing, 1.8, 1.0
        );

        if (!sp) return;
        const fx = Math.sin(ch.facing), fz = Math.cos(ch.facing);
        // Perpendicular to the *new* facing — a plant throws grain out to
        // both sides of the direction just committed to, not straight back.
        const px = -fz, pz = fx;
        const n = 10 + ((k * 24) | 0);
        for (let i = 0; i < n; i++) {
            const side = Math.random() < 0.5 ? -1 : 1;
            const out = (1.0 + Math.random() * 2.4) * (0.5 + 0.5 * k);
            sp.emit(
                ch.position.x + px * side * 0.1, ch.position.y + 0.04, ch.position.z + pz * side * 0.1,
                px * side * out, 0.6 + Math.random() * 1.4, pz * side * out,
                0.010 + Math.random() * 0.016,
                0.4 + Math.random() * 0.4,
                0
            );
        }
    }

    /**
     * Sand Step: the expanding ring of grain under the foot at the moment of
     * the aerial second jump — the visual explanation for where the extra
     * impulse came from. A shallow, wide, fast-fading brush (mass barely
     * displaced, since the foot never really contacted anything solid) plus
     * a burst of grains in a genuine ring rather than a random scatter.
     */
    _sandStep() {
        const ch = this.character;
        const x = ch.position.x, y = ch.position.y, z = ch.position.z;

        this.field.brush(x, z, 0.5, 0, 0.05, 0.1, 0, ch.facing, 1.1, 1.0);

        const sp = this.spray;
        if (!sp) return;
        const n = 34;
        for (let i = 0; i < n; i++) {
            const a = (i / n) * Math.PI * 2 + Math.random() * 0.2;
            const r = 0.15 + Math.random() * 0.15;
            const ca = Math.cos(a), sa = Math.sin(a);
            sp.emit(
                x + ca * r, y + 0.03, z + sa * r,
                ca * (1.6 + Math.random() * 1.4), 1.0 + Math.random() * 1.6, sa * (1.6 + Math.random() * 1.4),
                0.010 + Math.random() * 0.014,
                0.35 + Math.random() * 0.3,
                0
            );
        }
    }

    /**
     * Landing: centre compression, an outward granular puff, and a subtle
     * ring in the terrain state buffer, all scaled by `landImpact`. A soft
     * landing barely marks the ground at all; a hard one from a real height
     * visibly displaces a wide patch.
     */
    _landing() {
        const ch = this.character;
        const k = ch.landImpact;
        if (k < 0.02) return;
        const x = ch.position.x, y = ch.position.y, z = ch.position.z;

        this.field.brush(
            x, z,
            0.28 + 0.30 * k,
            0.08 + 0.18 * k,
            0.06 + 0.16 * k,
            0.9,
            0,
            ch.facing, 1.15, 1.0
        );

        const sp = this.spray;
        if (!sp) return;
        const n = 10 + ((k * 40) | 0);
        for (let i = 0; i < n; i++) {
            const a = Math.random() * Math.PI * 2;
            const r = Math.random() * (0.25 + 0.5 * k);
            const ca = Math.cos(a), sa = Math.sin(a);
            const clod = Math.random() < 0.2 * k ? 1 : 0;
            sp.emit(
                x + ca * r, y + 0.03, z + sa * r,
                ca * (1.0 + Math.random() * 2.5 * k), 0.6 + Math.random() * 2.2 * k, sa * (1.0 + Math.random() * 2.5 * k),
                clod ? 0.022 + Math.random() * 0.024 : 0.012 + Math.random() * 0.018,
                0.5 + Math.random() * 0.6,
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
