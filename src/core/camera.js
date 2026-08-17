/**
 * Third-person spring-arm rig — action-camera framing.
 *
 * The arm is deliberately *not* rigid: the pivot chases the character through a
 * critically-damped spring, so hard acceleration pulls the camera back and the
 * character drifts forward in frame. FOV widens with speed, the rig banks into
 * carves, and everything eases. Nothing here snaps.
 *
 * Open dune field, so there is no obstacle collision solve — only the ground
 * itself pushes the arm up, which buys a rig that never pops through a dune.
 *
 * SANDSTORM Phase 7: the rig belongs to the player, unconditionally. Yaw is
 * unbounded (see `update` — there is no clamp and never was; orbiting 1080°
 * is just adding to a float) and is *never* driven by anything but raw mouse
 * delta and the explicit `recenter()` action below. Movement derives its
 * direction from wherever the player left the camera — the rig does not
 * chase the character to stay useful, the character's desired direction
 * chases the rig. `recenter()` is the one exception, and it is opt-in: the
 * player presses C, the yaw eases to behind the character over ~180ms, and
 * the moment they touch the mouse again it is theirs.
 */

import { Vector3, Matrix, Quaternion } from "@babylonjs/core/Maths/math.vector";
import { Scalar } from "@babylonjs/core/Maths/math.scalar";
import { UniversalCamera } from "@babylonjs/core/Cameras/universalCamera";
import { input } from "./input.js";
import { S } from "./settings.js";

// ------------------------------------------------------- module-scope scratch
const _pivot = new Vector3();
const _desired = new Vector3();
const _fwd = new Vector3();
const _right = new Vector3();
const _up = new Vector3();
const _tmp = new Vector3();

/** Height probes taken along the spring arm each frame. */
const ARM_SAMPLES = 5;

// Phase 7: widened from SNOWFLOW's ±0.62/1.05 rad toward the brief's
// -55..-65° / +60..+70° targets. Still short of vertical either way — a
// camera looking straight up or down loses the horizon, which is the one
// thing a third-person action rig cannot afford to lose.
const PITCH_MIN = -1.03; // looking up, ~-59°
const PITCH_MAX = 1.15; // looking down, ~+66°
const DIST_MIN = 2.6;
const DIST_MAX = 11.0;

/** Seconds the `C` recenter takes to ease yaw/pitch back behind the character. */
const RECENTER_TIME = 0.19;
/** Default gameplay pitch — where `recenter()` eases pitch back to. */
const DEFAULT_PITCH = 0.17;

export class CameraRig {
    /**
     * @param {import("@babylonjs/core/scene").Scene} scene
     * @param {HTMLCanvasElement} canvas
     */
    constructor(scene, canvas) {
        const cam = new UniversalCamera("cam", new Vector3(0, 3, -6), scene);
        cam.minZ = 0.12;
        cam.maxZ = 4200;
        cam.fov = 1.02; // ~58deg vertical
        cam.inertia = 0;
        cam.rotation.set(0, 0, 0);
        // No attachControl — this rig drives the transform itself.

        this.camera = cam;
        this.scene = scene;

        this.yaw = 2.4;
        this.pitch = 0.17;

        this.distance = 6.2;
        this.distanceTarget = 6.2;

        /** Smoothed pivot position (the thing the spring chases). */
        this.pivot = new Vector3(0, 0, 0);
        this.pivotVel = new Vector3(0, 0, 0);

        /** Over-the-shoulder offset, in camera space. */
        this.shoulder = 0.85;
        this.pivotHeight = 1.62;

        this.baseFov = 1.02;
        this.fov = 1.02;

        this.roll = 0;
        this.rollTarget = 0;

        // ------------------------------------------------------- Phase 7 state
        /** Seconds left in an active `recenter()`; 0 when idle. */
        this._recenterT = 0;
        this._recenterYaw = 0;
        /** Brief additive FOV bump for dash/air-dash impulses — see `pulseFov`. */
        this._fovPulse = 0;
        /** Vertical camera dip on a hard landing, eases back to 0 quickly. */
        this._landKick = 0;
        /** Eased extra follow distance for surf/dash, added on top of the
         *  player's own zoom so it never overwrites their preference. */
        this._extraDist = 0;

        /**
         * The rig's basis, republished every frame. The spells aim with the
         * same three vectors, so there is only one place the convention for
         * "forward" is written down.
         */
        this.forward = new Vector3(0, 0, 1);
        this.right = new Vector3(1, 0, 0);
        this.up = new Vector3(0, 1, 0);

        // Trauma-based shake (Squirrel Eiserloh style): shake = trauma^2, so it
        // falls off perceptually rather than linearly.
        this.trauma = 0;
        this.shakeTime = 0;

        /**
         * Height sampler, injected once the terrain exists.
         * @type {((x:number, z:number) => number)|null}
         */
        this.groundAt = null;
        /** Metres of snow the camera must keep beneath it. */
        this.groundClearance = 1.35;
        /** Eased lift currently being applied to stay above the surface. */
        this.groundLift = 0;

        this._first = true;
    }

    /** @param {number} amount 0..1 */
    addTrauma(amount) {
        this.trauma = Math.min(1, this.trauma + amount);
    }

    /**
     * A brief additive FOV bump — dash, air dash, a hard landing. Decays on
     * its own each frame; callers do not need to clear it.
     * @param {number} amount radians, small
     */
    pulseFov(amount) {
        this._fovPulse = Math.max(this._fovPulse, amount);
    }

    /**
     * A brief downward camera dip on landing, scaled by impact strength.
     * Low-frequency and small by construction — this is not `addTrauma`'s
     * jittery shake, it is one smooth dip-and-recover.
     * @param {number} amount metres, small
     */
    addLandingImpulse(amount) {
        this._landKick = Math.max(this._landKick, amount);
    }

    /**
     * Player-commanded camera recenter (`C`). Eases yaw to `targetYaw` — the
     * character's current facing — and pitch back to the default gameplay
     * pitch, over `RECENTER_TIME`. Re-armable: pressing `C` again while one is
     * already running just restarts the window, so a mashed key never fights
     * itself.
     * @param {number} targetYaw
     */
    recenter(targetYaw) {
        this._recenterYaw = targetYaw;
        this._recenterT = RECENTER_TIME;
    }

    /**
     * @param {number} dt seconds
     * @param {Vector3} targetPos character world position (feet)
     * @param {Vector3} targetVel character world velocity
     * @param {import("../character/controller.js").CharacterController} ch
     *   the controller — read for `facing`, `lean`, `speed01`, and the
     *   airborne/surf state that shapes the framing. Passed whole rather than
     *   as five more positional numbers so this signature does not have to
     *   grow again the next time framing wants one more piece of state.
     */
    update(dt, targetPos, targetVel, ch) {
        const lean = ch.lean;
        const speed01 = ch.speed01;

        // ------------------------------------------------------------- look
        //
        // Raw mouse delta, added directly and with no smoothing on the way
        // in — Phase 7's "camera response must be immediate" requirement.
        // Everything downstream of this (the pivot spring, the FOV ease, the
        // ground-clearance lift) is where smoothing belongs instead.
        //
        // `yaw` is never clamped and never wrapped: it is a plain running
        // float, so orbiting 1080° is arithmetically identical to orbiting
        // 360° three times. `Math.sin`/`Math.cos` below don't care how large
        // the angle is, so there is no boundary to hit and nothing to wrap
        // for numerically — see the class doc for why it stays that way.
        this.yaw += input.lookX;
        this.pitch = Scalar.Clamp(this.pitch + input.lookY, PITCH_MIN, PITCH_MAX);

        // Any manual look input cancels an in-flight recenter — the player
        // touching the mouse always wins over the assist.
        if (input.lookX !== 0 || input.lookY !== 0) this._recenterT = 0;

        if (this._recenterT > 0) {
            this._recenterT = Math.max(0, this._recenterT - dt);
            const k = 1 - Math.exp(-dt / (RECENTER_TIME * 0.4));
            this.yaw += angleDeltaC(this.yaw, this._recenterYaw) * k;
            this.pitch = expDamp(this.pitch, DEFAULT_PITCH, 14, dt);
        }

        // ------------------------------------------------------------- zoom
        this.distanceTarget = Scalar.Clamp(
            this.distanceTarget + input.zoomDelta * (this.distanceTarget * 0.35),
            DIST_MIN,
            DIST_MAX
        );
        // Eased zoom — expDamp is framerate-independent.
        this.distance = expDamp(this.distance, this.distanceTarget, 9, dt);

        // Extra follow distance on top of the player's own zoom — surf pulls
        // the rig back so the wake and the dune ahead both stay in frame; a
        // dash adds a small amount for the same reason speed lines exist,
        // it emphasises that something fast just happened. Additive, so a
        // player who has zoomed in tight keeps that framing at every speed
        // rather than the state override fighting their own zoom choice.
        const surf01 = ch.surf;
        const extraWant = surf01 * (0.9 + 1.6 * speed01) + Math.min(1, this._fovPulse * 6) * 0.4;
        this._extraDist = expDamp(this._extraDist, extraWant, surf01 > 0.3 ? 3.0 : 6.0, dt);
        const followDist = this.distance + this._extraDist;

        // ------------------------------------------------------------ pivot
        _pivot.copyFrom(targetPos);
        _pivot.y += this.pivotHeight;

        // Airborne framing: raise the pivot target a little so a jump arc,
        // an air dash and the landing spot are all still in frame instead of
        // the top of the screen. Bounded and gentle — the player keeps full
        // mouse control of pitch regardless; this only nudges what the arm
        // is centred on, never forces the look direction.
        if (!ch.grounded) {
            const rise = Scalar.Clamp(Math.max(0, -ch.verticalVelocity) * 0.05 + ch.airTime * 0.35, 0, 0.9);
            _pivot.y += rise;
        }

        // Lead the camera slightly into the direction of travel so fast motion
        // shows more of what's ahead.
        const lead = Math.min(1, speed01) * 1.35;
        _pivot.x += targetVel.x * lead * 0.09;
        _pivot.z += targetVel.z * lead * 0.09;

        if (this._first) {
            this.pivot.copyFrom(_pivot);
            this._first = false;
        } else {
            // Softer spring under acceleration = the arm stretches, then recovers.
            springDamp(this.pivot, this.pivotVel, _pivot, S.cameraFollowRate, 1.0, dt);
        }

        // -------------------------------------------------------------- fov
        // Base speed widen, plus a decaying pulse for discrete impulses
        // (dash, air dash, a hard landing) — see `pulseFov`. The pulse is
        // additive and decays on its own, so a dash fired mid-sprint stacks
        // briefly on top of the sprint's own widen rather than replacing it.
        const fovWant = this.baseFov * (1 + speed01 * 0.19) + this._fovPulse;
        this.fov = expDamp(this.fov, fovWant, 3.2, dt);
        this._fovPulse = expDamp(this._fovPulse, 0, 7.0, dt);

        // ------------------------------------------------------------- bank
        this.rollTarget = -lean * 0.085;
        this.roll = expDamp(this.roll, this.rollTarget, 5.0, dt);

        // ------------------------------------------------------------ shake
        this.trauma = Math.max(0, this.trauma - dt * 1.15);
        this.shakeTime += dt;
        const shake = this.trauma * this.trauma;

        // Landing dip: one smooth low-frequency sag rather than shake's
        // high-frequency jitter, so a hard landing reads as weight settling
        // rather than as an impact rattle.
        this._landKick = expDamp(this._landKick, 0, 9.0, dt);

        // ------------------------------------------------------ compose xform
        const cp = Math.cos(this.pitch);
        _fwd.set(
            Math.sin(this.yaw) * cp,
            -Math.sin(this.pitch),
            Math.cos(this.yaw) * cp
        );
        _right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
        Vector3.CrossToRef(_right, _fwd, _up);
        _up.normalize();

        this.forward.copyFrom(_fwd);
        this.right.copyFrom(_right);
        this.up.copyFrom(_up);

        _desired.copyFrom(this.pivot);
        _desired.addInPlace(_tmp.copyFrom(_fwd).scaleInPlace(-followDist));
        _desired.addInPlace(_tmp.copyFrom(_right).scaleInPlace(this.shoulder));
        _desired.addInPlace(_tmp.copyFrom(_up).scaleInPlace(0.22));
        _desired.y -= this._landKick;

        // ---- keep the arm out of the snow --------------------------------
        // The lift rises quickly and relaxes slowly: snapping down the instant a
        // crest passes under the arm reads as a jolt, while being slow to rise
        // means a frame or two actually inside the snow.
        if (this.groundAt) {
            // Worst case over the whole arm, not just the eye: a crest between
            // the player and the camera can fill the view while the eye itself
            // is legally above the snow.
            let need = 0;
            for (let i = 0; i <= ARM_SAMPLES; i++) {
                const t = i / ARM_SAMPLES;
                const x = this.pivot.x + (_desired.x - this.pivot.x) * t;
                const z = this.pivot.z + (_desired.z - this.pivot.z) * t;
                const y = this.pivot.y + (_desired.y - this.pivot.y) * t;
                // Clearance eases in along the arm so it does not shove the
                // camera up merely for being near the player's own feet.
                const gh = this.groundAt(x, z) + this.groundClearance * (0.35 + 0.65 * t);
                const d = gh - y;
                if (d > need) need = d;
            }

            this.groundLift = expDamp(
                this.groundLift, need, need > this.groundLift ? 26 : 4.5, dt
            );
            _desired.y += this.groundLift;
        }

        if (shake > 0.0001) {
            const t = this.shakeTime * 26;
            _desired.x += (noise1(t) * 2 - 1) * shake * 0.16;
            _desired.y += (noise1(t + 31.7) * 2 - 1) * shake * 0.16;
            _desired.z += (noise1(t + 71.3) * 2 - 1) * shake * 0.10;
        }

        const cam = this.camera;
        cam.position.copyFrom(_desired);
        cam.fov = this.fov;
        cam.rotation.set(
            this.pitch + (shake > 0.0001 ? (noise1(this.shakeTime * 31 + 11) * 2 - 1) * shake * 0.02 : 0),
            this.yaw + (shake > 0.0001 ? (noise1(this.shakeTime * 29 + 53) * 2 - 1) * shake * 0.02 : 0),
            this.roll + (shake > 0.0001 ? (noise1(this.shakeTime * 23 + 97) * 2 - 1) * shake * 0.05 : 0)
        );
    }

    /** Flat camera-space forward on the XZ plane, for movement. Writes to `out`. */
    getFlatForward(out) {
        out.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
        return out;
    }

    getFlatRight(out) {
        out.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
        return out;
    }
}

// ------------------------------------------------------------------ helpers

/** Framerate-independent exponential approach. */
export function expDamp(cur, target, rate, dt) {
    return target + (cur - target) * Math.exp(-rate * dt);
}

/**
 * Shortest signed delta from `a` to `b`, wrapped to (-PI, PI], for two angles
 * that are *not* assumed to already be small — `a` (the rig's yaw) is a
 * plain running float that can be arbitrarily large after enough orbiting,
 * unlike `character.js`'s `angleDelta`, which assumes both inputs are already
 * bounded. The extra modulo up front is the only difference.
 */
function angleDeltaC(a, b) {
    const twoPi = Math.PI * 2;
    let d = (b - a) % twoPi;
    if (d > Math.PI) d -= twoPi;
    else if (d < -Math.PI) d += twoPi;
    return d;
}

/**
 * Semi-implicit damped spring toward `target`, mutating `pos` and `vel`.
 * @param {Vector3} pos @param {Vector3} vel @param {Vector3} target
 * @param {number} freq natural frequency (rad/s-ish)
 * @param {number} damping 1 = critical
 */
function springDamp(pos, vel, target, freq, damping, dt) {
    const k = freq * freq;
    const c = 2 * damping * freq;
    // Clamp dt so a hitch can't blow the integrator up.
    const h = Math.min(dt, 1 / 45);
    vel.x += (k * (target.x - pos.x) - c * vel.x) * h;
    vel.y += (k * (target.y - pos.y) - c * vel.y) * h;
    vel.z += (k * (target.z - pos.z) - c * vel.z) * h;
    pos.x += vel.x * h;
    pos.y += vel.y * h;
    pos.z += vel.z * h;
}

/** Cheap smooth 1D value noise for shake. Deterministic, no allocation. */
function noise1(x) {
    const i = Math.floor(x);
    const f = x - i;
    const u = f * f * (3 - 2 * f);
    return hash1(i) * (1 - u) + hash1(i + 1) * u;
}

function hash1(n) {
    const s = Math.sin(n * 127.1) * 43758.5453;
    return s - Math.floor(s);
}
