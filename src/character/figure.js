/**
 * The figure — skeleton, bind pose, and the procedural locomotion that poses it.
 *
 * There is no rig file and no animation data. Everything here is solved from the
 * motion state the controller already produces. The one thing that buys has to
 * be paid for in exchange: **feet plant rather than slide**.
 *
 * Planting is not approximated. When a foot enters stance its world position is
 * recorded and then held absolutely fixed while the body travels over it; the
 * leg is solved by two-bone IK to reach that fixed point. A foot in this rig
 * cannot slide, because during stance nothing in the code is capable of moving
 * it. The gait phase itself is driven by distance travelled, not by a clock, so
 * the stride length and the ground speed are the same number by construction.
 *
 * Bone convention: a bone's local +Y runs from its own joint toward its child,
 * so a hanging arm has +Y pointing at the floor. Geometry is authored in
 * bind-pose world space and skinned by `world * inverseBind`.
 *
 * Allocation: none per frame. Everything lives in flat arrays sized at
 * construction.
 */

import { setFrameFromDir, invertRigid, mul, xformPoint } from "../core/mat4.js";

// --------------------------------------------------------------- bone indices
export const B_ROOT = 0;
export const B_SPINE = 1;
export const B_CHEST = 2;
export const B_NECK = 3;
export const B_HEAD = 4;
export const B_HOOD = 5;
export const B_UPPER_L = 6;
export const B_FORE_L = 7;
export const B_HAND_L = 8;
export const B_UPPER_R = 9;
export const B_FORE_R = 10;
export const B_HAND_R = 11;
export const B_THIGH_L = 12;
export const B_SHIN_L = 13;
export const B_FOOT_L = 14;
export const B_THIGH_R = 15;
export const B_SHIN_R = 16;
export const B_FOOT_R = 17;
export const BONE_COUNT = 18;

/**
 * Bind pose, nine floats per bone: joint position, bone direction, front
 * reference. A 1.79 m figure with the pelvis at 0.95 — deliberately a little
 * long in the leg and narrow in the shoulder, because the silhouette is read at
 * fifteen metres through a robe and slightly heroic proportions survive that
 * better than accurate ones.
 */
const BIND = new Float32Array([
    /* ROOT    */ 0, 0.95, 0, 0, 1, 0, 0, 0, 1,
    /* SPINE   */ 0, 1.06, 0, 0, 1, 0, 0, 0, 1,
    /* CHEST   */ 0, 1.26, 0, 0, 1, 0, 0, 0, 1,
    /* NECK    */ 0, 1.46, 0, 0, 1, 0, 0, 0, 1,
    /* HEAD    */ 0, 1.55, 0, 0, 1, 0, 0, 0, 1,
    /* HOOD    */ 0, 1.55, 0, 0, 1, 0, 0, 0, 1,

    /* UPPER_L */ -0.185, 1.400, 0.000, -0.16, -0.987, 0, 0, 0, 1,
    /* FORE_L  */ -0.230, 1.123, 0.000, -0.05, -0.997, 0.06, 0, 0, 1,
    /* HAND_L  */ -0.243, 0.866, 0.016, -0.02, -0.992, 0.12, 0, 0, 1,
    /* UPPER_R */ 0.185, 1.400, 0.000, 0.16, -0.987, 0, 0, 0, 1,
    /* FORE_R  */ 0.230, 1.123, 0.000, 0.05, -0.997, 0.06, 0, 0, 1,
    /* HAND_R  */ 0.243, 0.866, 0.016, 0.02, -0.992, 0.12, 0, 0, 1,

    /* THIGH_L */ -0.100, 0.900, 0, 0, -1, 0, 0, 0, 1,
    /* SHIN_L  */ -0.100, 0.460, 0, 0, -1, 0, 0, 0, 1,
    /* FOOT_L  */ -0.100, 0.090, 0, 0, 0, 1, 0, 1, 0,
    /* THIGH_R */ 0.100, 0.900, 0, 0, -1, 0, 0, 0, 1,
    /* SHIN_R  */ 0.100, 0.460, 0, 0, -1, 0, 0, 0, 1,
    /* FOOT_R  */ 0.100, 0.090, 0, 0, 0, 1, 0, 1, 0,
]);

/** Segment lengths implied by the bind table, metres. */
const THIGH_LEN = 0.44;
const SHIN_LEN = 0.37;
const UPPER_LEN = 0.28;
const FORE_LEN = 0.26;

/** Pelvis height above the feet in the bind pose. */
const HIP_HEIGHT = 0.95;

/**
 * Speed the pose blends normalise "how much run" against, 0..1. The
 * control-revision pass collapsed the controller down to one ground-speed
 * target (`settings.js`'s `moveRunSpeed`, ~7.2 m/s by default), well past
 * SNOWFLOW's single 5.4 m/s reference, so a pose blend still keyed to 5.4
 * would sit fully saturated the moment the character started moving —
 * leaving no extra visual intensity as dash/surf push speed higher. Not read
 * from `settings.js` directly: this is a fixed normalisation range for how
 * the *pose* grades in, not a live gameplay tunable, and the two are allowed
 * to drift apart.
 */
const RUN_NORM = 9.0;

// ------------------------------------------------------- module-scope scratch
const _axes = new Float32Array(9);   // X, Y, Z of a composed basis
const _p = new Float32Array(3);
const _knee = new Float32Array(3);
const _hip = new Float32Array(3);
const _sh = new Float32Array(3);

/**
 * Compose an orthonormal basis from yaw, then pitch about its own right axis,
 * then roll about its own forward axis. Writes X, Y, Z into `_axes`.
 *
 * Positive pitch leans forward, positive roll tips the head to the character's
 * right — which is the sign the controller's `lean` already uses.
 */
function composeBasis(yaw, pitch, roll) {
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    let xx = cy, xy = 0, xz = -sy;
    let yx = 0, yy = 1, yz = 0;
    let zx = sy, zy = 0, zz = cy;

    if (pitch !== 0) {
        const c = Math.cos(pitch), s = Math.sin(pitch);
        const nyx = yx * c + zx * s, nyy = yy * c + zy * s, nyz = yz * c + zz * s;
        const nzx = zx * c - yx * s, nzy = zy * c - yy * s, nzz = zz * c - yz * s;
        yx = nyx; yy = nyy; yz = nyz; zx = nzx; zy = nzy; zz = nzz;
    }
    if (roll !== 0) {
        const c = Math.cos(roll), s = Math.sin(roll);
        const nxx = xx * c - yx * s, nxy = xy * c - yy * s, nxz = xz * c - yz * s;
        const nyx = yx * c + xx * s, nyy = yy * c + xy * s, nyz = yz * c + xz * s;
        xx = nxx; xy = nxy; xz = nxz; yx = nyx; yy = nyy; yz = nyz;
    }

    _axes[0] = xx; _axes[1] = xy; _axes[2] = xz;
    _axes[3] = yx; _axes[4] = yy; _axes[5] = yz;
    _axes[6] = zx; _axes[7] = zy; _axes[8] = zz;
}

/**
 * Two-bone IK. Given a root joint, an end target and a pole direction, writes
 * the middle joint's world position into `out`.
 *
 * The target is pulled inside reach rather than clamped at it: a fully extended
 * leg reads as a stiff peg, and the last centimetre of reach is where all the
 * knee-lock artefacts live.
 */
function solveTwoBone(rx, ry, rz, tx, ty, tz, px, py, pz, l1, l2, out) {
    let dx = tx - rx, dy = ty - ry, dz = tz - rz;
    let dist = Math.hypot(dx, dy, dz);
    const maxReach = (l1 + l2) * 0.995;
    if (dist < 1e-4) { dx = 0; dy = -1; dz = 0; dist = 1e-4; }
    if (dist > maxReach) dist = maxReach;
    const inv = 1 / Math.hypot(dx, dy, dz);
    dx *= inv; dy *= inv; dz *= inv;

    // Cosine rule: how far along the root→target axis the middle joint projects.
    const a = (l1 * l1 - l2 * l2 + dist * dist) / (2 * dist);
    const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));

    // Pole, orthogonalised against the axis — this is what decides which way the
    // knee or elbow bends, and it has to be re-derived every frame because the
    // axis swings through it during a stride.
    const d = px * dx + py * dy + pz * dz;
    let ox = px - dx * d, oy = py - dy * d, oz = pz - dz * d;
    let ol = Math.hypot(ox, oy, oz);
    if (ol < 1e-5) { ox = 0; oy = 0; oz = 1; ol = 1; }
    ox /= ol; oy /= ol; oz /= ol;

    out[0] = rx + dx * a + ox * h;
    out[1] = ry + dy * a + oy * h;
    out[2] = rz + dz * a + oz * h;
}

/** Framerate-independent exponential approach. */
function damp(cur, target, rate, dt) {
    return target + (cur - target) * Math.exp(-rate * dt);
}

function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
}

export class Figure {
    /**
     * @param {{heightAt(x:number,z:number):number, normalAt(x:number,z:number,out:any):any}} terrain
     */
    constructor(terrain) {
        this.terrain = terrain;

        /** World matrix per bone. */
        this.world = new Float32Array(BONE_COUNT * 16);
        /** Bind-pose world matrix per bone. */
        this.bind = new Float32Array(BONE_COUNT * 16);
        /** Inverse of the above. */
        this.invBind = new Float32Array(BONE_COUNT * 16);
        /** `world * invBind` — the matrix geometry is actually skinned by. */
        this.skin = new Float32Array(BONE_COUNT * 16);

        /** World joint positions, three floats per bone. Cloth collision reads these. */
        this.joint = new Float32Array(BONE_COUNT * 3);

        for (let b = 0; b < BONE_COUNT; b++) {
            const o = b * 9;
            setFrameFromDir(
                this.bind, b * 16,
                BIND[o], BIND[o + 1], BIND[o + 2],
                BIND[o + 3], BIND[o + 4], BIND[o + 5],
                BIND[o + 6], BIND[o + 7], BIND[o + 8]
            );
            invertRigid(this.invBind, b * 16, this.bind, b * 16);
        }

        // ------------------------------------------------------------- gait
        /** Where each foot is planted, world. Frozen for the whole stance phase. */
        this.plant = new Float32Array(6);
        /** Live foot position (equals `plant` during stance). */
        this.footPos = new Float32Array(6);
        /** Ground normal under each planted foot. */
        this.footNormal = new Float32Array([0, 1, 0, 0, 1, 0]);
        /** 1 while the foot carries weight, 0 mid-swing. Eased. */
        this.footWeight = new Float32Array([1, 1]);
        this._wasStance = [true, true];
        /** Set for one frame when a foot touches down. Drives spray and splats. */
        this.touchdown = [false, false];

        // ------------------------------------------------- smoothed pose state
        this.hipY = HIP_HEIGHT;
        this.pitch = 0;
        this.roll = 0;
        this.bob = 0;
        this.headYaw = 0;
        this.headPitch = 0;
        this.hoodYaw = 0;
        this.hoodPitch = 0;
        this.armPhase = 0;
        /** How far the figure has settled into the snow, metres. */
        this.sink = 0.04;

        // --------------------------------------------------- Phase 7: pose kicks
        // Both are one-shot decaying values rather than states: something
        // sets them at most as high as they already are (`Math.max`), and
        // they ease back to zero on their own every frame after. Neither
        // gates input or movement — see `controller.js`'s note on why the
        // gameplay layer never waits on the body's presentation of it.
        /** Extra crouch depth from a landing, decaying. */
        this._landDip = 0;
        /** Extra bank/lean from a hard directional cut, decaying. */
        this._cutKick = 0;
        /**
         * Phase 8B jump anticipation/launch. A signed one-shot: driven
         * negative (compressed) the instant `ch.jumpFired` fires, then
         * springs up through zero to a brief positive (extended) peak before
         * decaying — the "crouch, then snap straight" read of a real jump's
         * anticipation-into-launch, compressed into a single decaying value
         * since there is no pre-liftoff buffer to key a true anticipation
         * beat off. Never gates input — same rule every other one-shot pose
         * kick in this file follows.
         */
        this._launchKick = 0;

        this._t = 0;
        this._prevGait = 0;
    }

    /**
     * Pose the skeleton for this frame.
     * @param {number} dt
     * @param {import("./controller.js").CharacterController} ch
     */
    update(dt, ch) {
        const h = Math.min(dt, 1 / 30);
        this._t += h;

        const surf = ch.surf;
        const speed = ch.speed;
        const run = Math.min(1, speed / RUN_NORM);

        // ---------------------------------------------------------- footfalls
        // Stance/swing is derived from the same distance-driven phase the
        // controller uses to fire footfall events, so the visual plant and the
        // snow splat are the same instant by construction.
        this._updateFeet(h, ch);

        // -------------------------------------------------------- body attitude
        //
        // Phase 7 pose kicks — set at most once a frame by the event that
        // caused them, decayed every frame regardless. `_landDip` deepens the
        // crouch below; `_cutKick` sharpens the bank a hard cut already
        // produces through `ch.lean` (see the roll term) rather than
        // replacing it with a separate mechanism.
        if (ch.justLanded) this._landDip = Math.max(this._landDip, ch.landImpact);
        this._landDip = damp(this._landDip, 0, 5, h);
        if (ch.hardCut) this._cutKick = Math.max(this._cutKick, ch.cutStrength);
        this._cutKick = damp(this._cutKick, 0, 8, h);

        // Phase 8B jump choreography: anticipation/compression into launch.
        // `_launchT` is seconds since the last primary jump fired (a large
        // number when idle); `_launchKick` is a deterministic three-segment
        // curve driven off it — compress (0 -> -1), snap through to extend
        // (-1 -> +1), decay back to neutral (+1 -> 0). This is the one beat
        // the existing pose kicks didn't cover: `_landDip` already reads as
        // landing compression, and `airPitch` below already differentiates
        // rising/falling/apex off real vertical velocity, but nothing marked
        // the instant of takeoff itself.
        this._launchT += h;
        if (ch.jumpFired) this._launchT = 0;
        {
            const LC = 0.06, LE = 0.10, LD = 0.20;
            const t = this._launchT;
            if (t < LC) this._launchKick = -(t / LC);
            else if (t < LC + LE) this._launchKick = -1 + ((t - LC) / LE) * 2;
            else if (t < LC + LE + LD) this._launchKick = 1 - (t - LC - LE) / LD;
            else this._launchKick = 0;
        }

        const grounded = ch.grounded;

        // Lean forward with speed, and *into* acceleration — the classic read
        // that a figure is pushing rather than being dragged. Raised from
        // 0.10 to 0.16: at a full sprint the old value left too upright a
        // torso for a "powerful forward-biased action silhouette".
        const fwdAcc =
            ch.acceleration.x * Math.sin(ch.facing) + ch.acceleration.z * Math.cos(ch.facing);
        // Clamped, because the accelerations at either end of a surf run are an
        // order of magnitude larger than anything walking produces: letting go at
        // top speed decelerates at 30 m/s^2, which unclamped throws the torso
        // twenty degrees backwards and reads as a fall rather than as a scrub.
        //
        // Airborne, the same pitch term instead answers vertical velocity:
        // rising leans back a little, falling leans forward in anticipation
        // of landing, and the two naturally cross through a neutral, upright
        // pitch right at the apex where vertical velocity itself crosses
        // zero — the "apex transition" beat, for free, from the same number
        // that already drives rising/falling. Clamped tight, since this is
        // attitude, not a diving animation. A dash adds its own forward
        // commitment on top; the launch kick adds a brief backward pop as
        // the legs finish extending.
        const airPitch = grounded ? 0 : -clamp(ch.verticalVelocity * 0.015, -0.12, 0.12);
        const dashPitch = ch.dashing && ch.dashKind === 1 ? 0.20 : ch.dashing ? 0.10 : 0;
        const launchPitch = -this._launchKick * 0.05;
        const pitchWant =
            0.16 * run
            + 0.012 * clamp(fwdAcc, -9, 22)
            + surf * (0.30 + 0.16 * ch.speed01)
            + airPitch + dashPitch + launchPitch;
        this.pitch = damp(this.pitch, pitchWant, 7, h);

        const rollWant = ch.lean * (0.16 + 0.34 * surf) * (1 + this._cutKick * 0.8);
        this.roll = damp(this.roll, rollWant, 8, h);

        // Vertical bob: the pelvis drops through each stance and rises over the
        // supporting leg, twice per stride. Suppressed while surfing or
        // airborne, where the stance is a static crouch or there is no stance
        // at all.
        const bobWant =
            grounded && surf < 0.5
                ? -0.028 * run * (0.5 - 0.5 * Math.cos(4 * Math.PI * ch.gaitPhase))
                : 0;
        this.bob = damp(this.bob, bobWant, 18, h);

        // Crouch: a little at running speed, a lot on the board, more still
        // for a beat after a hard landing — `_landDip` above — and briefly
        // deeper still right before a jump leaves the ground, springing back
        // up through neutral as the legs finish extending — `_launchKick`
        // above. `-launchKick` is deliberate: the kick is negative during
        // compression (so this term is positive, deepening the crouch) and
        // positive during extension (so this term goes negative, standing
        // the hips up taller than resting height for the pop off the ground).
        const crouch =
            0.035 * run + surf * (0.13 + 0.05 * ch.speed01) + this._landDip * 0.24
            - this._launchKick * 0.05;
        this.hipY = damp(this.hipY, HIP_HEIGHT - crouch, 9, h);

        // The figure settles into the snow it is standing on. Reading the real
        // depth would mean a GPU readback; this is the same number the contact
        // brushes are writing, held on the CPU.
        this.sink = damp(this.sink, 0.045 + surf * 0.055, 4, h);

        // ------------------------------------------------------------- spine
        const gx = ch.position.x;
        const gz = ch.position.z;
        // The actual terrain height under the character, independent of
        // whether they are standing on it right now — exposed for the
        // material shader's procedural weathering (dust accumulation near
        // the boots, sun bleaching up high, both measured as height *above
        // the ground*, which is exactly as meaningful in the air as on it).
        const groundY = this.terrain.heightAt(gx, gz);
        this.groundY = groundY;

        // Phase 7: the root now rides `ch.position.y` itself rather than
        // re-deriving a ground height and assuming the character is on it.
        // `position.y` already *is* the correct number in both regimes — see
        // `controller.js`'s `_integrateVertical` — grounded, it is the
        // terrain height (softly snapped); airborne, it is real integrated
        // flight. Before Phase 7 those were the same value on every frame by
        // construction, since nothing could leave the ground; now they are
        // not, and using the wrong one is the single change that would make
        // every jump, dash-launch and Sand Step invisible.
        const rootY = ch.position.y - this.sink + this.hipY + this.bob;

        composeBasis(ch.facing, this.pitch, this.roll);
        const rX = _axes[0], rY = _axes[1], rZ = _axes[2];
        const uX = _axes[3], uY = _axes[4], uZ = _axes[5];
        const fX = _axes[6], fY = _axes[7], fZ = _axes[8];

        // Pelvis. Its yaw counter-rotates against the shoulders during a stride,
        // which is most of what stops a procedural walk reading as a shop dummy.
        // Raised from 0.13 to 0.18 for a more committed counter-rotation at a
        // full sprint — the chest twists at 1.5x this (below), so the two
        // together read as real hip/shoulder separation rather than a stiff
        // block turning as one piece.
        const twist = (1 - surf) * 0.18 * run * Math.sin(2 * Math.PI * ch.gaitPhase);
        composeBasis(ch.facing + twist, this.pitch, this.roll);
        this._setBone(B_ROOT, gx, rootY, gz, _axes[3], _axes[4], _axes[5], _axes[6], _axes[7], _axes[8]);

        // Spine and chest lift along the pelvis up-axis, with the chest twisting
        // the opposite way and leaning a little further forward.
        const spineY = rootY + uY * 0.11;
        this._setBone(
            B_SPINE, gx + uX * 0.11, spineY, gz + uZ * 0.11,
            uX, uY, uZ, fX, fY, fZ
        );

        const chestTwist = -twist * 1.5;
        const chestPitch = this.pitch + 0.05 * run + surf * 0.10;
        composeBasis(ch.facing + chestTwist, chestPitch, this.roll * 1.15);
        const cUx = _axes[3], cUy = _axes[4], cUz = _axes[5];
        const cFx = _axes[6], cFy = _axes[7], cFz = _axes[8];
        const cRx = _axes[0], cRy = _axes[1], cRz = _axes[2];

        const chestX = gx + uX * 0.31, chestY = rootY + uY * 0.31, chestZ = gz + uZ * 0.31;
        this._setBone(B_CHEST, chestX, chestY, chestZ, cUx, cUy, cUz, cFx, cFy, cFz);

        const neckX = chestX + cUx * 0.20, neckY = chestY + cUy * 0.20, neckZ = chestZ + cUz * 0.20;
        this._setBone(B_NECK, neckX, neckY, neckZ, cUx, cUy, cUz, cFx, cFy, cFz);

        // ------------------------------------------------------------- head
        // Head stabilisation: the head stays much closer to level than the chest
        // it sits on. Real necks do this and it is very obvious when missing.
        this.headPitch = damp(this.headPitch, -chestPitch * 0.62 + surf * 0.10, 9, h);
        this.headYaw = damp(this.headYaw, ch.lean * -0.22, 6, h);
        composeBasis(ch.facing + chestTwist + this.headYaw, chestPitch + this.headPitch, this.roll * 0.5);
        const headX = neckX + cUx * 0.09, headY = neckY + cUy * 0.09, headZ = neckZ + cUz * 0.09;
        this._setBone(B_HEAD, headX, headY, headZ, _axes[3], _axes[4], _axes[5], _axes[6], _axes[7], _axes[8]);

        // The hood is a lagged copy. A hood that tracks the skull exactly reads
        // as a helmet; a few frames of lag reads as fabric.
        this.hoodYaw = damp(this.hoodYaw, ch.facing + chestTwist + this.headYaw, 11, h);
        this.hoodPitch = damp(this.hoodPitch, chestPitch + this.headPitch + 0.05, 9, h);
        composeBasis(this.hoodYaw, this.hoodPitch, this.roll * 0.5);
        this._setBone(B_HOOD, headX, headY, headZ, _axes[3], _axes[4], _axes[5], _axes[6], _axes[7], _axes[8]);

        // -------------------------------------------------------------- arms
        this._poseArms(h, ch, chestX, chestY, chestZ, cRx, cRy, cRz, cUx, cUy, cUz, cFx, cFy, cFz);

        // -------------------------------------------------------------- legs
        this._poseLeg(0, gx, rootY, gz, rX, rY, rZ, uX, uY, uZ, fX, fY, fZ);
        this._poseLeg(1, gx, rootY, gz, rX, rY, rZ, uX, uY, uZ, fX, fY, fZ);

        // ------------------------------------------------------------- skin
        for (let b = 0; b < BONE_COUNT; b++) {
            mul(this.skin, b * 16, this.world, b * 16, this.invBind, b * 16);
            this.joint[b * 3] = this.world[b * 16 + 12];
            this.joint[b * 3 + 1] = this.world[b * 16 + 13];
            this.joint[b * 3 + 2] = this.world[b * 16 + 14];
        }
    }

    _setBone(b, px, py, pz, yx, yy, yz, zx, zy, zz) {
        // X = Y x Z, completing the frame from the bone axis and its front
        // reference. Both are already orthonormal at every call site.
        setFrameFromDir(this.world, b * 16, px, py, pz, yx, yy, yz, zx, zy, zz);
    }

    /**
     * Advance the stance/swing state machine and place both ankles.
     *
     * Stance is the whole point. `plant` is written exactly once, on touchdown,
     * and read unchanged for the rest of the stance — so no amount of body
     * motion, camera motion or frame-rate variation can move a planted foot.
     */
    _updateFeet(h, ch) {
        const surf = ch.surf;
        const speed = ch.speed;
        const run = Math.min(1, speed / RUN_NORM);
        // Duty factor: a walk keeps both feet down for a moment, a run has a
        // flight phase. Interpolating between them is what makes the transition
        // from walk to run read as a gait change and not a speed change.
        const duty = 0.66 - 0.20 * run;

        const fwdX = Math.sin(ch.facing), fwdZ = Math.cos(ch.facing);
        const rgtX = Math.cos(ch.facing), rgtZ = -Math.sin(ch.facing);

        // Half a stride ahead, scaled by speed — this is the step length, and it
        // has to match the controller's stride or the feet skate.
        const half = 0.34 + 0.42 * run;
        // The controller owns this decision — see `stepping` there. Re-deriving
        // it from `surf` here is how the feet and the footprints end up
        // disagreeing about whether the character is walking.
        const moving = speed > 0.2 && ch.stepping;

        for (let f = 0; f < 2; f++) {
            const side = f === 0 ? -0.105 : 0.105;
            // Left foot leads; the right is half a cycle behind.
            const ph = (ch.gaitPhase + (f === 0 ? 0 : 0.5)) % 1;
            const stance = !moving || ph < duty;

            // Where this foot would land if it touched down right now.
            const nx = ch.position.x + fwdX * half + rgtX * side;
            const nz = ch.position.z + fwdZ * half + rgtZ * side;

            if (stance) {
                if (!this._wasStance[f]) {
                    // Touchdown. This is the only line in the file that writes a
                    // plant position.
                    this.plant[f * 3] = nx;
                    this.plant[f * 3 + 1] = this.terrain.heightAt(nx, nz) - this.sink * 0.7;
                    this.plant[f * 3 + 2] = nz;
                    this.touchdown[f] = true;
                } else {
                    this.touchdown[f] = false;
                }
                if (!moving) {
                    // Standing: ease the feet back under the hips rather than
                    // leaving them wherever the last stride dropped them.
                    const sx = ch.position.x + rgtX * side + fwdX * 0.02;
                    const sz = ch.position.z + rgtZ * side + fwdZ * 0.02;
                    this.plant[f * 3] = damp(this.plant[f * 3], sx, 7, h);
                    this.plant[f * 3 + 2] = damp(this.plant[f * 3 + 2], sz, 7, h);
                    this.plant[f * 3 + 1] = damp(
                        this.plant[f * 3 + 1],
                        this.terrain.heightAt(this.plant[f * 3], this.plant[f * 3 + 2]) - this.sink * 0.7,
                        7, h
                    );
                }
                this.footPos[f * 3] = this.plant[f * 3];
                this.footPos[f * 3 + 1] = this.plant[f * 3 + 1];
                this.footPos[f * 3 + 2] = this.plant[f * 3 + 2];
                this.footWeight[f] = damp(this.footWeight[f], 1, 22, h);
            } else {
                this.touchdown[f] = false;
                // Swing: from the plant it is leaving to the plant it is heading
                // for, on an arc. `nx/nz` keeps updating as the body moves, so
                // the foot is always aimed at where the body will actually be.
                const s = (ph - duty) / (1 - duty);
                const e = s * s * (3 - 2 * s);
                const ny = this.terrain.heightAt(nx, nz) - this.sink * 0.7;
                const px = this.plant[f * 3], py = this.plant[f * 3 + 1], pz = this.plant[f * 3 + 2];
                this.footPos[f * 3] = px + (nx - px) * e;
                this.footPos[f * 3 + 2] = pz + (nz - pz) * e;
                // Knee-lift height raised from 0.12 to 0.17x run: a fast
                // sprint wants a genuinely high-knee swing, not the same
                // shallow arc a jog uses just scaled by distance.
                this.footPos[f * 3 + 1] =
                    py + (ny - py) * e + Math.sin(Math.PI * s) * (0.055 + 0.17 * run);
                this.footWeight[f] = damp(this.footWeight[f], 0, 22, h);
            }

            this._wasStance[f] = stance;
        }

        // Surfing: both feet ride the board, offset along the body's long axis
        // and rotated across the direction of travel. Blended in, never
        // snapped. Gated on `grounded` — the surf blend itself deliberately
        // survives a jump (see `controller.js`'s note on why), so without
        // this gate a "surf → jump" would keep pulling the feet down onto a
        // board-shaped position at *ground* height while the body is
        // visibly airborne above it.
        if (ch.grounded && surf > 0.001) {
            for (let f = 0; f < 2; f++) {
                // Wide and staggered: feet apart across the direction of travel
                // for lateral stability, with the leading foot a little ahead.
                const lateral = f === 0 ? -0.17 : 0.17;
                const along = f === 0 ? 0.11 : -0.11;
                const sx = ch.position.x + fwdX * along + rgtX * lateral;
                const sz = ch.position.z + fwdZ * along + rgtZ * lateral;
                const sy = this.terrain.heightAt(sx, sz) - this.sink;
                const o = f * 3;
                this.footPos[o] += (sx - this.footPos[o]) * surf;
                this.footPos[o + 1] += (sy - this.footPos[o + 1]) * surf;
                this.footPos[o + 2] += (sz - this.footPos[o + 2]) * surf;
                this.footWeight[f] = Math.max(this.footWeight[f], surf);
            }
        } else if (!ch.grounded) {
            // Airborne tuck: knees bend and the feet lift toward the hips
            // instead of continuing to chase the last ground plant, which —
            // now that `position.y` actually rises during a jump — would
            // otherwise stretch the legs toward a point increasingly far
            // below the body. Eases in over the first third of a second of
            // air time rather than snapping the moment the ground leaves.
            const tuck = clamp(ch.airTime * 3.0, 0, 1) * 0.55;
            for (let f = 0; f < 2; f++) {
                const lateral = f === 0 ? -0.12 : 0.12;
                const tx = ch.position.x + rgtX * lateral * 1.3 + fwdX * 0.06;
                const tz = ch.position.z + rgtZ * lateral * 1.3 + fwdZ * 0.06;
                const ty = ch.position.y + 0.50 - tuck * 0.30;
                const o = f * 3;
                this.footPos[o] += (tx - this.footPos[o]) * tuck;
                this.footPos[o + 1] += (ty - this.footPos[o + 1]) * tuck;
                this.footPos[o + 2] += (tz - this.footPos[o + 2]) * tuck;
                this.footWeight[f] = damp(this.footWeight[f], 0, 10, h);
            }
        }
    }

    /**
     * Solve one leg. `f` is 0 for left, 1 for right.
     *
     * The knee pole tilts outward as well as forward, because a knee that bends
     * in a perfectly sagittal plane looks mechanical — real legs track slightly
     * wide of the hip.
     */
    _poseLeg(f, rootX, rootY, rootZ, rX, rY, rZ, uX, uY, uZ, fX, fY, fZ) {
        const side = f === 0 ? -0.10 : 0.10;
        const hipB = f === 0 ? B_THIGH_L : B_THIGH_R;
        const shinB = f === 0 ? B_SHIN_L : B_SHIN_R;
        const footB = f === 0 ? B_FOOT_L : B_FOOT_R;

        // Hip joint, carried by the pelvis frame.
        _hip[0] = rootX + rX * side - uX * 0.05;
        _hip[1] = rootY + rY * side - uY * 0.05;
        _hip[2] = rootZ + rZ * side - uZ * 0.05;

        const ax = this.footPos[f * 3];
        const ay = this.footPos[f * 3 + 1] + 0.09; // ankle sits above the sole
        const az = this.footPos[f * 3 + 2];

        const outward = f === 0 ? -0.22 : 0.22;
        solveTwoBone(
            _hip[0], _hip[1], _hip[2], ax, ay, az,
            fX + rX * outward, fY + rY * outward, fZ + rZ * outward,
            THIGH_LEN, SHIN_LEN, _knee
        );

        this._setBone(
            hipB, _hip[0], _hip[1], _hip[2],
            _knee[0] - _hip[0], _knee[1] - _hip[1], _knee[2] - _hip[2],
            fX, fY, fZ
        );
        this._setBone(
            shinB, _knee[0], _knee[1], _knee[2],
            ax - _knee[0], ay - _knee[1], az - _knee[2],
            fX, fY, fZ
        );

        // The foot rolls: flat while loaded, toe-down through the swing. The
        // ground normal is folded in so a foot on a dune face lies along it.
        const w = this.footWeight[f];
        const toeDown = (1 - w) * 0.55;
        const c = Math.cos(toeDown), s = Math.sin(toeDown);
        // Rotate the foot's forward axis down about the body's right axis.
        const dx = fX * c - uX * s, dy = fY * c - uY * s, dz = fZ * c - uZ * s;
        this._setBone(footB, ax, ay, az, dx, dy, dz, uX, uY, uZ);
    }

    /**
     * Arms. Counter-swing against the legs while walking, and a wide, low
     * bending stance while surfing — hands out and forward, which is the
     * Water Tribe pose in the reference and also just what a person does at
     * twenty metres a second.
     */
    _poseArms(h, ch, cx, cy, cz, rX, rY, rZ, uX, uY, uZ, fX, fY, fZ) {
        const surf = ch.surf;
        const run = Math.min(1, ch.speed / RUN_NORM);
        // Raised from 0.42 to 0.54: a full sprint's arm pump was too close to
        // a jog's, which is most of why running still read as mild. The
        // elbow-bend pole vector below is unchanged, so this only pushes the
        // hand target further fore/aft — the bend itself doesn't loosen.
        const swing = Math.sin(2 * Math.PI * ch.gaitPhase) * (0.20 + 0.54 * run) * (1 - surf);
        // Slow idle drift so a standing figure is never perfectly still.
        const idle = Math.sin(this._t * 0.9) * 0.02 + Math.sin(this._t * 1.7 + 1.3) * 0.012;

        for (let a = 0; a < 2; a++) {
            const sgn = a === 0 ? -1 : 1;
            const upperB = a === 0 ? B_UPPER_L : B_UPPER_R;
            const foreB = a === 0 ? B_FORE_L : B_FORE_R;
            const handB = a === 0 ? B_HAND_L : B_HAND_R;

            // Shoulder, on the chest frame.
            _sh[0] = cx + rX * (sgn * 0.185) + uX * 0.14;
            _sh[1] = cy + rY * (sgn * 0.185) + uY * 0.14;
            _sh[2] = cz + rZ * (sgn * 0.185) + uZ * 0.14;

            // ---- walk target: hand swings fore and aft below the hip --------
            //
            // Every offset here is kept comfortably inside the arm's 0.54 m
            // reach. Put the target at or past full extension and the IK solver
            // does exactly what it is told — locks the elbow — and the figure
            // walks around with two straight poles for arms.
            const sw = swing * -sgn;
            let tx = _sh[0] + fX * (sw * 0.38) - uX * 0.43 + rX * (sgn * 0.11);
            let ty = _sh[1] + fY * (sw * 0.38) - uY * 0.43 + rY * (sgn * 0.11);
            let tz = _sh[2] + fZ * (sw * 0.38) - uZ * 0.43 + rZ * (sgn * 0.11);
            ty += idle * sgn;

            // ---- cast target: one gesture per ability -------------------------
            //
            // SANDSTORM Phase 6: SNOWFLOW had one cast pose for all five spells
            // — both hands up and out along the aim. The phase brief asks for a
            // distinct silhouette per ability instead (`ch.castKind`, set by
            // `spellSystem.js` to whichever ability last drove the cast blend),
            // built from the same shoulder/arm-target machinery so nothing about
            // the IK solve below or the walk-swing composition changes.
            //
            // Blended, not switched, and it composes with the walk swing rather
            // than replacing it — a character casting while walking still walks.
            const cast = ch.cast;
            if (cast > 0.001) {
                const ax = ch.castAimX, ay = ch.castAimY, az = ch.castAimZ;
                const lead = a === 1 ? 1 : 0;
                let outward, along, lift, useAim;

                switch (ch.castKind) {
                    case 1:
                        // Dune Surge — strong forward arm sweep: both hands
                        // drive forward together along the character's own
                        // facing rather than the aim, low, the lead hand
                        // further out ahead of the trailing one — a slam, not
                        // a raised stance.
                        outward = lead ? 0.14 : -0.10;
                        along = lead ? 0.60 : 0.26;
                        lift = lead ? -0.06 : -0.14;
                        useAim = false;
                        break;
                    case 3:
                        // Sand Eruption — upward lifting gesture: both hands
                        // rise together, cupped close to the body's own
                        // centreline rather than spread wide, as though
                        // lifting a mass up out of the ground.
                        outward = -0.05;
                        along = 0.10;
                        lift = 0.62;
                        useAim = false;
                        break;
                    case 4:
                        // Fulgurite Garden — focused downward/forward cast:
                        // both hands thrust down and forward together, close
                        // to the body's centreline, along the aim — a single
                        // concentrated point rather than a wide stance.
                        outward = -0.04;
                        along = 0.42;
                        lift = -0.30;
                        useAim = true;
                        break;
                    case 5:
                        // Sand Vortex — wide rotational arm gesture: both arms
                        // spread wide to the sides and slowly counter-rotate,
                        // rather than reaching forward at all.
                        outward = 0.52 + Math.sin(this._t * 1.6 + sgn * 1.7) * 0.06;
                        along = 0.06;
                        lift = 0.10 + Math.cos(this._t * 1.6 + sgn * 1.7) * 0.05;
                        useAim = false;
                        break;
                    default:
                        // Sand Lance (2) and any unset case — one hand
                        // controls the stream: the leading hand reaches out
                        // along the aim, the trailing one sits low and
                        // inboard, cocked back, same shape SNOWFLOW's single
                        // pose used.
                        outward = lead ? 0.30 : -0.16;
                        along = lead ? 0.52 : 0.16;
                        lift = lead ? 0.26 : 0.02;
                        useAim = true;
                        break;
                }

                const dx = useAim ? ax : fX, dy = useAim ? ay : fY, dz = useAim ? az : fZ;
                const cx = _sh[0] + rX * (sgn * 0.30 + outward * sgn) + dx * along + uX * lift;
                const cy = _sh[1] + rY * (sgn * 0.30) + dy * along + uY * lift + lift * 0.6;
                const cz = _sh[2] + rZ * (sgn * 0.30 + outward * sgn) + dz * along + uZ * lift;
                tx += (cx - tx) * cast;
                ty += (cy - ty) * cast;
                tz += (cz - tz) * cast;
            }

            // ---- surf target: out, forward and a little down ----------------
            if (ch.grounded && surf > 0.001) {
                const carve = ch.carve;
                // Trailing arm rises, leading arm drops into the turn — the
                // same asymmetry a snowboarder holds through a carve.
                const rise = 0.02 + carve * sgn * 0.22;
                const sx = _sh[0] + rX * (sgn * 0.33) + fX * 0.24 + uX * rise;
                const sy = _sh[1] + rY * (sgn * 0.33) + fY * 0.24 + uY * rise;
                const sz = _sh[2] + rZ * (sgn * 0.33) + fZ * 0.24 + uZ * rise;
                tx += (sx - tx) * surf;
                ty += (sy - ty) * surf;
                tz += (sz - tz) * surf;
            }

            // ---- air target: out and up for balance --------------------------
            //
            // Airborne, arms spread rather than continuing whatever the walk
            // swing was doing — a figure with no ground under it does not
            // keep pumping its arms. Faded out by `cast` so an ability fired
            // mid-air still reads as the ability, not a balance pose
            // fighting it.
            //
            // Phase 8A: the lateral offset here used to be large enough
            // (0.36 m, almost a straight horizontal reach at this arm's
            // 0.54 m length) that a character caught airborne mid-screenshot
            // read as a rigid T-pose rather than a relaxed balance stance —
            // item 11's explicit complaint. Pulled the sideways reach in,
            // pushed more of it forward and down instead: a real person
            // steadying themselves in the air brings their arms toward their
            // centre and slightly ahead, not straight out to the sides.
            if (!ch.grounded) {
                const air = clamp(ch.airTime * 4.0, 0, 1) * (1 - cast);
                if (air > 0.001) {
                    const rise = ch.verticalVelocity > 0 ? 0.10 : -0.04;
                    const axp = _sh[0] + rX * (sgn * 0.22) + fX * 0.24 + uX * (0.04 + rise);
                    const ayp = _sh[1] + rY * (sgn * 0.22) + fY * 0.24 + uY * (0.04 + rise);
                    const azp = _sh[2] + rZ * (sgn * 0.22) + fZ * 0.24 + uZ * (0.04 + rise);
                    tx += (axp - tx) * air;
                    ty += (ayp - ty) * air;
                    tz += (azp - tz) * air;
                }
            }

            // Elbows point back and out.
            const px = -fX + rX * (sgn * 0.55), py = -fY + rY * (sgn * 0.55) - 0.35, pz = -fZ + rZ * (sgn * 0.55);
            solveTwoBone(
                _sh[0], _sh[1], _sh[2], tx, ty, tz, px, py, pz,
                UPPER_LEN, FORE_LEN, _p
            );

            this._setBone(
                upperB, _sh[0], _sh[1], _sh[2],
                _p[0] - _sh[0], _p[1] - _sh[1], _p[2] - _sh[2],
                fX, fY, fZ
            );
            this._setBone(
                foreB, _p[0], _p[1], _p[2],
                tx - _p[0], ty - _p[1], tz - _p[2],
                fX, fY, fZ
            );
            // The hand continues the forearm, rolled palm-inward.
            let hx = tx - _p[0], hy = ty - _p[1], hz = tz - _p[2];
            const hl = Math.hypot(hx, hy, hz) || 1;
            hx /= hl; hy /= hl; hz /= hl;
            this._setBone(handB, tx, ty, tz, hx, hy, hz, fX, fY, fZ);
        }
    }

    /** World position of a hand, for spell emitters. Writes 3 floats to `out`. */
    handPosition(which, out, od) {
        const b = which === 0 ? B_HAND_L : B_HAND_R;
        xformPoint(this.world, b * 16, 0, 0.09, 0, out, od);
    }
}

export { HIP_HEIGHT };
