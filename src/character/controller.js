/**
 * Character locomotion, traversal and dune-surf physics.
 *
 * SANDSTORM Phase 7: this is the phase where SANDSTORM stops feeling like
 * SNOWFLOW with a paint job. Four modes now share one integrator instead of
 * two, and translation is never gated behind rotation in any of them:
 *
 *  - GROUND: camera-relative desired velocity, eased facing, distance-driven
 *    gait phase so footfalls land where the feet actually are (no sliding).
 *    Higher-response acceleration and turn-rate than SNOWFLOW's walk — see
 *    `_walkStep` — plus slope-aware speed/accel and hard-cut detection.
 *  - AIR: real vertical physics (`verticalVelocity`/gravity), not a snap to
 *    terrain height. Bounded air steering, one Sand Step (an aerial second
 *    jump), one air dash, coyote time and a small jump buffer.
 *  - SURF: momentum-carrying, exactly as before, with one deliberate change —
 *    steering now comes from movement intent alone, never from camera yaw,
 *    so the player can spin the camera 180° without the board turning with
 *    it. See `_surfStep`'s note and the phase's independence acceptance test.
 *  - DASH / EVADE: short, camera-relative directional impulses layered on
 *    top of ground or air movement, not separate physics systems.
 *
 * Blending between GROUND and SURF is eased in both directions, as before;
 * there is no snap. The transient actions (dash, evade, jump, air dash,
 * landing) are plain booleans and timers rather than a formal state-machine
 * framework — see the class body for the full list — because five or six
 * flags read directly are easier to audit than a state graph would be for a
 * controller this size.
 *
 * This file owns motion and one-frame *event* flags only (`footfall`,
 * `justLanded`, `dashFired`, `sandStepFired`, `hardCut`). It does not touch
 * the terrain state buffer, spawn a single particle, or know the deformation
 * field exists — `snowContact.js` reads these flags and turns them into sand.
 * That split is unchanged from SNOWFLOW and stays load-bearing: the
 * controller should never need to know what a brush is, and the brush code
 * should never need to know what a jump is.
 */

import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scalar } from "@babylonjs/core/Maths/math.scalar";
import { input } from "../core/input.js";
import { expDamp } from "../core/camera.js";
import { S } from "../core/settings.js";

const _wish = new Vector3();
const _fwd = new Vector3();
const _right = new Vector3();
const _n = new Vector3();

// -------------------------------------------------------------- ground speed
//
// Control-revision pass: there is one ground-movement target now, not a
// Shift-gated tier. WASD/arrows always drive full-speed camera-relative
// traversal — "the player does not explicitly toggle WALK versus RUN versus
// SPRINT" — and Shift is a discrete jump/Sand Step button instead (see
// `_tryJump`). A slower presentation at low input/velocity still exists —
// see `figure.js`'s idle→light-run→sprint pose blend — but it is read off
// actual speed, not chosen by the player through a modifier key.
//
// `moveRunSpeed`/ground-accel/turn-rate are all live-tunable — see
// `settings.js`'s `moveRunSpeed`/`moveGroundAccel`/`moveTurnRate` and the
// "Locomotion" debug group.

const SURF_MAX = 19.5;
const SURF_THRUST = 11.0;
const SURF_DRAG = 0.42;
const SURF_TURN = 2.8; // rad/s at full steer — raised from SNOWFLOW's 2.35
const SURF_GRIP = 7.5;

/** Gait: metres of travel per full stride cycle, scaled by speed. */
const STRIDE_BASE = 1.55;

// ------------------------------------------------------------------ vertical
const GRAVITY = 22.0; // m/s^2 — heavier than real gravity, for a snappy arc
/** Seconds a jump is still honoured after walking off a crest. */
const COYOTE_TIME = 0.10;
/** Seconds a jump press is remembered before landing. */
const JUMP_BUFFER = 0.10;
/**
 * Metres the ground can drop out from under a grounded step, in one frame,
 * before it counts as a real edge rather than terrain ripple. Below this the
 * character's `position.y` keeps following the surface as it always did;
 * above it, the character starts falling instead of teleporting down to
 * meet the new height — see `_integrateVertical`. This is also what makes
 * coyote time meaningful on a heightfield: without a real fall, there is
 * nothing to be forgiving *about*.
 */
const CLIFF_FALL_DROP = 0.42;
/** Vertical impact speed at which `landImpact` saturates to 1. */
const LANDING_HARD_SPEED = 11;
/** Fraction of the primary jump impulse a Sand Step gives. */
const SAND_STEP_SCALE = 0.82;

// --------------------------------------------------------------- dash/evade
const DASH_COOLDOWN = 0.30; // seconds, from trigger — just enough to stop spam
const AIR_DASH_SPEED = 13.5;
const AIR_DASH_TIME = 0.14;
const EVADE_SPEED = 9.5;
const EVADE_TIME = 0.15;
const EVADE_COOLDOWN = 0.22;
/** Vertical impulse a backward evade adds — "a compact evasive hop". */
const EVADE_HOP = 2.6;

// ------------------------------------------------------------ high-level state
export const STATE_GROUND = "ground";
export const STATE_AIR = "air";
export const STATE_SURF = "surf";

export class CharacterController {
    /**
     * @param {{ heightAt(x:number,z:number):number, normalAt(x:number,z:number,out:Vector3):Vector3 }} terrain
     */
    constructor(terrain) {
        this.terrain = terrain;

        this.position = new Vector3(0, 0, 0);
        this.velocity = new Vector3(0, 0, 0);
        this.prevVelocity = new Vector3(0, 0, 0);
        this.acceleration = new Vector3(0, 0, 0);

        this.facing = 0; // yaw, radians
        this.speed = 0;
        this.speed01 = 0; // normalised against SURF_MAX, for FOV/wind

        /** 0 = walking, 1 = fully surfing. Eased. Driven by intent alone
         *  (RMB/F held) — see the note in `update` on why this is *not*
         *  gated by `grounded`, which is what lets surf resume instantly on
         *  landing rather than re-ramping from zero. */
        this.surf = 0;
        this.surfActive = false;

        /**
         * 0 = not casting, 1 = fully in the bending stance. Written by the spell
         * system, read by the figure.
         */
        this.cast = 0;
        this.castAimX = 0;
        this.castAimY = 0;
        this.castAimZ = 1;
        this.castKind = 0;

        /** Signed lean, -1..1 (right positive), from lateral acceleration. */
        this.lean = 0;
        /** Signed carve amount for wake shaping. Positive = turning right. */
        this.carve = 0;
        this.streak01 = 0;

        // ------------------------------------------------------------- gait
        this.gaitPhase = 0;
        this.stepping = true;
        this.footfall = false;
        this.footIndex = 0;
        this.footPos = new Vector3();
        this.footImpact = 0;

        this.groundY = 0;
        this.groundNormal = new Vector3(0, 1, 0);

        // ---------------------------------------------------- Phase 7: vertical
        /** m/s, +up. Zero while grounded. */
        this.verticalVelocity = 0;
        this.grounded = true;
        /** Seconds since last grounded. */
        this.airTime = 0;
        /** One frame true on the frame the character lands. */
        this.justLanded = false;
        /** 0..1 landing severity, valid on the `justLanded` frame. */
        this.landImpact = 0;
        /** 0 grounded, 1 after the primary jump, 2 after the Sand Step. */
        this.jumpCount = 0;
        this._coyoteT = 0;
        this._jumpBufferT = 0;
        /** One air dash per airborne sequence; clears on landing. */
        this.airDashUsed = false;
        /** One frame true on the frame a Sand Step fires. */
        this.sandStepFired = false;

        // ------------------------------------------------------- Phase 7: dash
        this.dashing = false;
        this.dashT = 0;
        /** 0 none, 1 ground dash, 2 air dash. */
        this.dashKind = 0;
        this.dashDirX = 0;
        this.dashDirZ = 1;
        /** One frame true on the frame a dash (ground or air) fires. */
        this.dashFired = false;
        this._dashCooldownT = 0;

        // ----------------------------------------------------- Phase 7: evade
        this.evading = false;
        this.evadeT = 0;
        this._evadeCooldownT = 0;

        // ---------------------------------------------------- Phase 7: hard cut
        /** One frame true on a sharp (>60°) directional change at real speed. */
        this.hardCut = false;
        /** 0..1, how sharp — valid on the `hardCut` frame. */
        this.cutStrength = 0;
        this._prevWishAngle = null;

        /** High-level state for animation/diagnostics — see the class doc. */
        this.state = STATE_GROUND;

        this._prevSpeed = 0;
    }

    /**
     * @param {number} dt
     * @param {import("../core/camera.js").CameraRig} rig
     */
    update(dt, rig) {
        const h = Math.min(dt, 1 / 30);

        this.prevVelocity.copyFrom(this.velocity);
        this.surfActive = input.surf;
        this.surf = expDamp(this.surf, this.surfActive ? 1 : 0, this.surfActive ? 2.6 : 3.4, h);

        rig.getFlatForward(_fwd);
        rig.getFlatRight(_right);

        // One-frame event flags, reset before anything below can set them.
        this.justLanded = false;
        this.dashFired = false;
        this.sandStepFired = false;
        this.hardCut = false;

        if (this._coyoteT > 0) this._coyoteT -= h;
        if (this._jumpBufferT > 0) this._jumpBufferT -= h;
        if (this._dashCooldownT > 0) this._dashCooldownT -= h;
        if (this._evadeCooldownT > 0) this._evadeCooldownT -= h;
        if (input.jumpPressed) this._jumpBufferT = JUMP_BUFFER;

        // ------------------------------------------------------------ dispatch
        // Surf only actually runs its own physics while grounded — see the
        // note on `this.surf` above. Dash and evade sit above ground/air
        // movement as short overrides rather than as separate integrators.
        if (this.grounded && this.surf > 0.5) this._surfStep(h, rig);
        else if (this.dashing) this._dashStep(h);
        else if (this.evading) this._evadeStep(h);
        else if (this.grounded) this._walkStep(h);
        else this._airStep(h);

        // Discrete actions can trigger regardless of which branch just ran,
        // as long as their own preconditions hold. Jump first: it is allowed
        // to cancel a dash or an evade (the "dash → jump" / action-chain
        // requirement), so it needs first refusal on `this.dashing`/`evading`
        // before dash/evade's own triggers re-check them.
        this._tryJump();
        this._tryDash();
        this._tryEvade();

        // ---------------------------------------------------- integrate + snap
        this.position.x += this.velocity.x * h;
        this.position.z += this.velocity.z * h;
        this._integrateVertical(h);

        // --------------------------------------------------------- bookkeeping
        this.speed = Math.hypot(this.velocity.x, this.velocity.z);
        this.speed01 = Scalar.Clamp(this.speed / SURF_MAX, 0, 1);

        this.acceleration.x = (this.velocity.x - this.prevVelocity.x) / h;
        this.acceleration.z = (this.velocity.z - this.prevVelocity.z) / h;

        // Lateral acceleration → lean. Project accel onto the character's right.
        const rx = Math.cos(this.facing);
        const rz = -Math.sin(this.facing);
        const latAcc = this.acceleration.x * rx + this.acceleration.z * rz;
        const leanWant = Scalar.Clamp(latAcc / 26, -1, 1) * (0.35 + 0.65 * this.surf);
        this.lean = expDamp(this.lean, leanWant, 6.5, h);
        this.carve = expDamp(this.carve, leanWant, 9, h);

        this.streak01 = this.surf * Scalar.Clamp((this.speed - 7) / 11, 0, 1);

        this.state = this.grounded && this.surf > 0.5 ? STATE_SURF
            : this.grounded ? STATE_GROUND : STATE_AIR;

        this._gait(h);
    }

    // ------------------------------------------------------------- ground
    /**
     * Camera-relative desired velocity, applied immediately — translation is
     * never gated behind facing. Facing eases toward the resulting movement
     * direction on its own clock, faster at higher speed so a sprinting
     * reversal turns hard rather than drifting at a walk's rate.
     */
    _walkStep(h) {
        const maxSpeed = S.moveRunSpeed;

        _wish.set(
            _fwd.x * input.moveZ + _right.x * input.moveX,
            0,
            _fwd.z * input.moveZ + _right.z * input.moveX
        );

        const wishLen = Math.hypot(_wish.x, _wish.z);
        if (wishLen > 0.001) {
            const wx = _wish.x / wishLen, wz = _wish.z / wishLen;

            // ---- slope response --------------------------------------------
            // Read off the terrain normal already sampled last frame. A dead
            // zone below ~12% grade keeps ordinary dune ripples from ever
            // being felt — only a real face changes the numbers.
            const slopeAlong = -(this.groundNormal.x * wx + this.groundNormal.z * wz);
            const uphill = Math.max(0, slopeAlong - 0.12);
            const downhill = Math.max(0, -slopeAlong - 0.12);
            const speedMul = 1 - Math.min(0.30, uphill * 0.9);
            const accelMul = 1 + Math.min(0.40, downhill * 1.1);

            const speed = maxSpeed * speedMul;
            _wish.x = wx * speed;
            _wish.z = wz * speed;

            const a = S.moveGroundAccel * accelMul * h;
            this.velocity.x += Scalar.Clamp(_wish.x - this.velocity.x, -a, a);
            this.velocity.z += Scalar.Clamp(_wish.z - this.velocity.z, -a, a);

            const want = Math.atan2(_wish.x, _wish.z);
            const turnRate = S.moveTurnRate * (1 + 0.5 * this.speed01);
            this.facing = angleDamp(this.facing, want, turnRate, h);

            // ---- hard cut ----------------------------------------------------
            // Only worth flagging at real speed — a standing character
            // changing its mind about which way to walk is not a cut, and
            // firing the sand-spray/skid VFX for it would look like a bug.
            if (this._prevWishAngle !== null && this.speed > S.moveRunSpeed * 0.4) {
                const delta = Math.abs(angleDelta(this._prevWishAngle, want));
                if (delta > 1.05) {
                    this.hardCut = true;
                    this.cutStrength = Scalar.Clamp(delta / Math.PI, 0, 1);
                }
            }
            this._prevWishAngle = want;
        } else {
            this._prevWishAngle = null;
            // Release-to-stop, a touch brisker than the accel that built the
            // speed up — matches the phase's "100-180ms at running speed" feel
            // target without needing a second tuned constant.
            const d = S.moveGroundAccel * 1.15 * h;
            const s = Math.hypot(this.velocity.x, this.velocity.z);
            if (s > 0.0001) {
                const k = Math.max(0, s - d) / s;
                this.velocity.x *= k;
                this.velocity.z *= k;
            }
        }
    }

    /**
     * Airborne horizontal control: bounded steering toward the same
     * camera-relative wish direction ground movement uses, but at a much
     * lower acceleration and a much slower facing turn — ground movement
     * stays more authoritative than air movement, and there is no
     * zero-inertia 180° turn in mid-air. With no input, momentum simply
     * carries, as flight should.
     */
    _airStep(h) {
        _wish.set(
            _fwd.x * input.moveZ + _right.x * input.moveX,
            0,
            _fwd.z * input.moveZ + _right.z * input.moveX
        );
        const wishLen = Math.hypot(_wish.x, _wish.z);
        if (wishLen > 0.001) {
            const speed = S.moveRunSpeed;
            _wish.x = (_wish.x / wishLen) * speed;
            _wish.z = (_wish.z / wishLen) * speed;

            const a = S.moveAirControl * h;
            this.velocity.x += Scalar.Clamp(_wish.x - this.velocity.x, -a, a);
            this.velocity.z += Scalar.Clamp(_wish.z - this.velocity.z, -a, a);

            const want = Math.atan2(this.velocity.x, this.velocity.z);
            this.facing = angleDamp(this.facing, want, 5, h);
        }
    }

    /**
     * The dune-surf line. Momentum-carrying, unlike every other mode here on
     * purpose — see the class doc's "SURF" note.
     *
     * Steering comes from `input.moveX` alone. SNOWFLOW's version also pulled
     * facing toward the camera's own yaw, which is exactly the coupling the
     * phase brief rules out: rotate the camera 180° while surfing and the
     * board must keep going the way it was going. Movement chooses the line;
     * the camera is free to look anywhere.
     */
    _surfStep(h, rig) {
        const steer = Scalar.Clamp(input.moveX, -1, 1);
        this.facing += steer * SURF_TURN * h;

        // Camera shake, and only from the one thing that earns it: an edge
        // loaded up at speed.
        const load = Math.abs(steer) * (this.speed / SURF_MAX);
        if (load > 0.25) rig.addTrauma((load - 0.25) * 1.35 * h);

        const fx = Math.sin(this.facing);
        const fz = Math.cos(this.facing);

        // Slope: heading downhill adds speed, uphill scrubs it.
        this.terrain.normalAt(this.position.x, this.position.z, _n);
        const slopeAssist = -(_n.x * fx + _n.z * fz) * 26;

        let thrust = SURF_THRUST + slopeAssist;
        if (input.moveZ < 0) thrust -= 14; // pull back to scrub speed

        this.velocity.x += fx * thrust * h;
        this.velocity.z += fz * thrust * h;

        // Lateral grip: kill sideways velocity, but not entirely — the residual
        // is what reads as a drift when you overcook the turn.
        const rx = Math.cos(this.facing);
        const rz = -Math.sin(this.facing);
        const lat = this.velocity.x * rx + this.velocity.z * rz;
        const grip = Math.min(1, SURF_GRIP * h);
        this.velocity.x -= rx * lat * grip;
        this.velocity.z -= rz * lat * grip;

        // Quadratic drag → a natural terminal speed.
        const s = Math.hypot(this.velocity.x, this.velocity.z);
        if (s > 0.0001) {
            const drag = SURF_DRAG * s * s * 0.02 + 0.9;
            const k = Math.max(0, s - drag * h) / s;
            this.velocity.x *= k;
            this.velocity.z *= k;
        }
        if (s > SURF_MAX) {
            const k = SURF_MAX / s;
            this.velocity.x *= k;
            this.velocity.z *= k;
        }
    }

    // -------------------------------------------------------------- vertical
    /**
     * Ground follow, falling, and landing — the one place `position.y` is
     * written. Grounded follow keeps SNOWFLOW's soft snap for ordinary
     * terrain, but a one-frame drop steeper than `CLIFF_FALL_DROP` now starts
     * a real fall instead of teleporting the character down to meet it, which
     * is both more honest on the Phase 4 dune crests and what makes coyote
     * time meaningful.
     */
    _integrateVertical(h) {
        const groundY = this.terrain.heightAt(this.position.x, this.position.z);
        this.terrain.normalAt(this.position.x, this.position.z, this.groundNormal);
        this.groundY = groundY;

        if (this.grounded) {
            const drop = this.position.y - groundY;
            if (drop > CLIFF_FALL_DROP) {
                this.grounded = false;
                this.verticalVelocity = 0;
                this._coyoteT = COYOTE_TIME;
                this.airTime = 0;
            } else {
                this.position.y = expDamp(this.position.y, groundY, 26, h);
                return;
            }
        }

        // ---- airborne ---------------------------------------------------
        this.airTime += h;
        this.verticalVelocity -= GRAVITY * h;
        this.position.y += this.verticalVelocity * h;

        if (this.position.y <= groundY && this.verticalVelocity <= 0) {
            this.landImpact = Scalar.Clamp(Math.abs(this.verticalVelocity) / LANDING_HARD_SPEED, 0, 1);
            this.position.y = groundY;
            this.verticalVelocity = 0;
            this.grounded = true;
            this.justLanded = true;
            this.jumpCount = 0;
            this.airDashUsed = false;
            this.airTime = 0;
            this.dashing = false; // a dash does not survive its own landing
        }
    }

    // -------------------------------------------------------- discrete actions
    /**
     * Jump, and — pressed again while airborne — the Sand Step. Honours a
     * short coyote window after leaving a crest and a short buffer for a
     * press just before landing, so neither has to be perfectly frame-exact.
     * Also recognises a favourable crest: sprinting toward a drop launches a
     * little higher, from two cheap point samples ahead of the facing — see
     * `_crestBoost`.
     */
    _tryJump() {
        const want = this._jumpBufferT > 0;
        if (!want) return;

        const canPrimary = (this.grounded || this._coyoteT > 0) && this.jumpCount === 0;
        if (canPrimary) {
            this.verticalVelocity = S.moveJumpImpulse * this._crestBoost();
            this.grounded = false;
            this.jumpCount = 1;
            this._jumpBufferT = 0;
            this._coyoteT = 0;
            this.airTime = 0;
            this.dashing = false;
            this.evading = false;
            return;
        }

        if (!this.grounded && this.jumpCount === 1) {
            this.verticalVelocity = S.moveJumpImpulse * SAND_STEP_SCALE;
            this.jumpCount = 2;
            this._jumpBufferT = 0;
            this.sandStepFired = true;
        }
    }

    /**
     * A favourable-crest launch bonus: running at speed, and the ground drops
     * away ahead along the current facing. Two `heightAt` point samples — no
     * scanning, no new terrain query.
     */
    _crestBoost() {
        if (!this.grounded || this.speed < S.moveRunSpeed * 0.92) return 1;
        const fx = Math.sin(this.facing), fz = Math.cos(this.facing);
        const nearY = this.terrain.heightAt(this.position.x + fx * 4, this.position.z + fz * 4);
        const farY = this.terrain.heightAt(this.position.x + fx * 8, this.position.z + fz * 8);
        if (nearY < this.groundY - 0.3 && farY < nearY - 0.3) {
            // Headroom above the run target, e.g. from dash/surf carrying
            // into a crest — scaled against a fixed span, not a removed
            // sprint tier.
            return 1.22 + 0.10 * Math.min(1, (this.speed - S.moveRunSpeed) / 4.0);
        }
        return 1;
    }

    /**
     * Directional dash — ground or air, same trigger. Direction is movement
     * intent if the player is holding one, camera-forward-on-terrain
     * otherwise. A ground dash sets velocity outright (it is meant to feel
     * instantaneous); an air dash blends in some of the incoming velocity so
     * it reads as redirection rather than a hard reset.
     */
    _tryDash() {
        if (!input.dashPressed) return;
        if (this.grounded && this.surf > 0.5) return; // surf owns its own momentum
        if (this.evading) return;

        const dx = _wishOrForward("x"), dz = _wishOrForward("z");

        if (this.grounded) {
            if (this.dashing || this._dashCooldownT > 0) return;
            this.velocity.x = dx * S.moveDashSpeed;
            this.velocity.z = dz * S.moveDashSpeed;
            this.dashKind = 1;
            this._dashCooldownT = DASH_COOLDOWN;
        } else {
            if (this.airDashUsed) return;
            this.velocity.x = this.velocity.x * 0.25 + dx * AIR_DASH_SPEED;
            this.velocity.z = this.velocity.z * 0.25 + dz * AIR_DASH_SPEED;
            // Slightly reduce downward velocity — an air dash flattens the arc
            // a little without cancelling gravity outright.
            this.verticalVelocity = Math.max(this.verticalVelocity * 0.3, -1.5);
            this.dashKind = 2;
            this.airDashUsed = true;
        }

        this.dashDirX = dx;
        this.dashDirZ = dz;
        this.facing = Math.atan2(dx, dz);
        this.dashing = true;
        this.dashT = this.dashKind === 1 ? S.moveDashDuration : AIR_DASH_TIME;
        this.dashFired = true;
        this.evading = false;
    }

    /** Active dash window: holds the burst, allows modest steering. */
    _dashStep(h) {
        this.dashT -= h;
        if (this.dashT <= 0) {
            this.dashing = false;
            this.dashKind = 0;
            return;
        }

        _wish.set(
            _fwd.x * input.moveZ + _right.x * input.moveX,
            0,
            _fwd.z * input.moveZ + _right.z * input.moveX
        );
        const wlen = Math.hypot(_wish.x, _wish.z);
        if (wlen > 0.001) {
            const speed = Math.hypot(this.velocity.x, this.velocity.z);
            const k = Math.min(1, 6 * h);
            this.velocity.x += ((_wish.x / wlen) * speed - this.velocity.x) * k;
            this.velocity.z += ((_wish.z / wlen) * speed - this.velocity.z) * k;
        }
        // Faces the dash's own direction throughout, not the steer — a dash
        // that visibly faces sideways mid-burst reads as broken, not agile.
        const want = Math.atan2(this.velocity.x, this.velocity.z);
        this.facing = angleDamp(this.facing, want, 14, h);
    }

    /**
     * Evade: a short directional burst, quicker to return control than a
     * dash and with no separate recovery sub-state — at ~150ms it is over
     * before one would be noticed. Direction is movement intent; with no
     * input it defaults to a backward retreat, which also gets a small hop
     * rather than a flat slide.
     */
    _tryEvade() {
        if (!input.evadePressed) return;
        if (this.grounded && this.surf > 0.5) return;
        if (this.dashing || this.evading || this._evadeCooldownT > 0) return;

        _wish.set(
            _fwd.x * input.moveZ + _right.x * input.moveX,
            0,
            _fwd.z * input.moveZ + _right.z * input.moveX
        );
        const wlen = Math.hypot(_wish.x, _wish.z);
        let dx, dz, backward;
        if (wlen > 0.001) {
            dx = _wish.x / wlen;
            dz = _wish.z / wlen;
            backward = input.moveZ < -0.3 && Math.abs(input.moveX) < 0.5;
        } else {
            dx = -_fwd.x;
            dz = -_fwd.z;
            backward = true;
        }

        this.velocity.x = dx * EVADE_SPEED;
        this.velocity.z = dz * EVADE_SPEED;
        if (backward && this.grounded) {
            this.verticalVelocity = Math.max(this.verticalVelocity, EVADE_HOP);
            this.grounded = false;
            this.airTime = 0;
        }
        this.facing = Math.atan2(dx, dz);
        this.evading = true;
        this.evadeT = EVADE_TIME;
        this._evadeCooldownT = EVADE_COOLDOWN;
    }

    /** Active evade window: light drag, cancels back into locomotion on its own. */
    _evadeStep(h) {
        this.evadeT -= h;
        if (this.evadeT <= 0) {
            this.evading = false;
            return;
        }
        const k = Math.min(1, 3.0 * h) * 0.3;
        this.velocity.x *= 1 - k;
        this.velocity.z *= 1 - k;
    }

    /**
     * Distance-driven gait. Phase advances with ground travelled, not with time,
     * which is what keeps feet planted instead of sliding.
     */
    _gait(h) {
        this.footfall = false;

        // Feet stay on the board while surfing, and off the ground entirely
        // while airborne, dashing or evading — none of those are a walk cycle.
        this.stepping =
            this.grounded && this.surf <= 0.5 && !this.dashing && !this.evading &&
            this.speed <= S.moveRunSpeed * 1.8;
        if (!this.stepping) {
            this.gaitPhase = 0;
            return;
        }

        const dist = this.speed * h;
        const stride = STRIDE_BASE * (0.72 + 0.28 * Math.min(1, this.speed / S.moveRunSpeed));
        const prev = this.gaitPhase;
        this.gaitPhase = (this.gaitPhase + dist / stride) % 1;

        if (this.speed < 0.15) return;

        // Two plants per cycle, at phase 0.0 and 0.5.
        const crossed =
            (prev < 0.5 && this.gaitPhase >= 0.5) || this.gaitPhase < prev;
        if (!crossed) return;

        this.footfall = true;
        this.footIndex = this.gaitPhase < 0.5 ? 0 : 1;
        this.footImpact = Scalar.Clamp(0.35 + this.speed / S.moveRunSpeed, 0, 1.3);

        // Offset the plant to the correct side of the body.
        const side = this.footIndex === 0 ? -0.17 : 0.17;
        const rx = Math.cos(this.facing);
        const rz = -Math.sin(this.facing);
        this.footPos.set(
            this.position.x + rx * side,
            this.position.y,
            this.position.z + rz * side
        );
    }
}

// -------------------------------------------------------------- wall run (audited, not built)
//
// Phase 7's brief makes wall running conditional on the world actually
// exposing collision-capable near-vertical surfaces to run along. It does
// not: the terrain is a single heightfield mesh (`terrain/heightfield.js`),
// SANDSTORM's "rock" is a baked height/albedo modulation on that same
// heightfield rather than separate geometry (`lib/terrain.wgsl`'s
// `rockField`), and there is no ruins/structure system anywhere in this
// codebase yet — `grep`-verified before writing this file. Running a
// contextual wall-run against open dune slope would not be a wall run, it
// would be a slope grab with a different name, and the brief explicitly
// rules that out.
//
// The hook for later: a future ruins/structure phase that adds real vertical
// collision geometry can add a `_tryWallRun()` alongside `_tryDash`/
// `_tryEvade` above, following the same shape — a precondition check, a short
// state with its own timer, and one-frame event flags for `snowContact.js`'s
// sibling system (or whatever contact system the new surface type needs) to
// turn into VFX. Nothing here needs to change to make room for it.

// ------------------------------------------------------------------ helpers

/**
 * Movement intent if the player is holding one, else camera-forward
 * projected onto the ground — the shared "which way does a dash/evade go"
 * rule. Reads the module-scope `_fwd`/`_right`/`_wish` already resolved for
 * this frame, so it costs one more `Math.hypot` rather than a fresh basis
 * fetch.
 * @param {"x"|"z"} axis
 */
function _wishOrForward(axis) {
    _wish.set(
        _fwd.x * input.moveZ + _right.x * input.moveX,
        0,
        _fwd.z * input.moveZ + _right.z * input.moveX
    );
    const len = Math.hypot(_wish.x, _wish.z);
    if (len > 0.001) return axis === "x" ? _wish.x / len : _wish.z / len;
    return axis === "x" ? _fwd.x : _fwd.z;
}

/** Shortest signed delta from a to b, wrapped to [-PI, PI]. */
export function angleDelta(a, b) {
    let d = b - a;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return d;
}

/** Framerate-independent easing across the shortest arc. */
export function angleDamp(cur, target, rate, dt) {
    return cur + angleDelta(cur, target) * (1 - Math.exp(-rate * dt));
}
