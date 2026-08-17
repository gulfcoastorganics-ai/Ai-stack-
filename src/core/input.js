/**
 * Raw input state. Everything lands in one mutable struct that systems poll —
 * no events fired into game code, no per-frame allocation.
 *
 * Mouse look uses pointer lock, which frees the right button for dune-surf.
 */

import { S } from "./settings.js";

export const input = {
    // Movement axes, camera-relative, already normalised to a unit disc.
    moveX: 0,
    moveZ: 0,
    moving: false,

    // Accumulated mouse delta since last `endFrame()`, in radians.
    lookX: 0,
    lookY: 0,

    // Zoom, consumed by the camera rig.
    zoomDelta: 0,

    surf: false, // RMB (or F) held

    /** @type {number} 0 = none, else 1..5 — set on keydown, cleared each frame */
    spellPressed: 0,
    /** @type {boolean} spell 2 (Sand Lance) is a held cast */
    spellHeld2: false,

    // ---------------------------------------------------- Phase 7 traversal
    // Three of these are edge-triggered — true for exactly one `pollInput`
    // cycle — same pattern as `spellPressed`, so the controller sees a press
    // once regardless of how long the key stays down and never has to
    // de-bounce a held key itself.
    /**
     * Phase 8B: rebound from Shift back to Space — "Space is now the
     * canonical jump control", Shift is not bound to jump at all. Space —
     * jump while grounded (or within coyote time), or a Sand Step if already
     * airborne. Edge-triggered on purpose: a discrete action button, not a
     * held movement modifier, and a controller that read `jumpHeld` for this
     * would jump every single frame the key stayed down. See `jumpHeld`
     * below for the (rarely needed) continuous state.
     */
    jumpPressed: false,
    /** @type {boolean} Space currently held — continuous state, for anything
     *  that genuinely needs "is the button down" rather than "was it just
     *  pressed". The controller's own jump/Sand Step logic uses
     *  `jumpPressed`, not this. */
    jumpHeld: false,
    /** @type {boolean} Q — dash, or an air dash if airborne. */
    dashPressed: false,
    /** @type {boolean} Ctrl — evade. */
    evadePressed: false,
    /** @type {boolean} C — camera recenter behind the character. */
    camResetPressed: false,

    locked: false,
};

const keys = Object.create(null);

const LOOK_SCALE = 0.0022;

// Two independent sources for the same `input.surf` flag — RMB held, or the
// alternate `F` toggle — kept as private state so releasing one does not
// clobber the other's contribution.
let _rmbHeld = false;
let _fToggle = false;

/** @type {(() => void)|null} */
let onToggleOverlay = null;

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{ onToggleOverlay?: () => void }} [hooks]
 */
export function initInput(canvas, hooks) {
    onToggleOverlay = hooks?.onToggleOverlay ?? null;

    canvas.addEventListener("click", () => {
        if (!input.locked) canvas.requestPointerLock();
    });

    document.addEventListener("pointerlockchange", () => {
        input.locked = document.pointerLockElement === canvas;
        if (!input.locked) {
            // Drop held state so the character doesn't run off while unfocused,
            // and — Phase 7 — never leave a traversal action stuck mid-flight
            // because the lock dropped under it (alt-tab, an OS dialog, the
            // browser stealing focus). A lost lock cancels the same way a
            // controller-driven `cancel()` would.
            for (const k in keys) keys[k] = false;
            _rmbHeld = false;
            _fToggle = false;
            input.surf = false;
            input.spellHeld2 = false;
            input.jumpHeld = false;
        }
    });

    document.addEventListener("mousemove", (e) => {
        if (!input.locked) return;
        // Raw delta, scaled and summed — no smoothing here. Smoothing the
        // player's own mouse intent is exactly what Phase 7's camera-response
        // requirement rules out; see `camera.js`'s note on where smoothing
        // does and does not belong.
        const s = LOOK_SCALE * S.mouseSensitivity;
        input.lookX += e.movementX * s;
        input.lookY += e.movementY * s;
    });

    canvas.addEventListener("contextmenu", (e) => e.preventDefault());

    document.addEventListener("mousedown", (e) => {
        if (!input.locked) return;
        if (e.button === 2) { _rmbHeld = true; input.surf = _rmbHeld || _fToggle; }
    });

    document.addEventListener("mouseup", (e) => {
        if (e.button === 2) { _rmbHeld = false; input.surf = _rmbHeld || _fToggle; }
    });

    document.addEventListener(
        "wheel",
        (e) => {
            if (!input.locked) return;
            e.preventDefault();
            input.zoomDelta += e.deltaY * 0.0016;
        },
        { passive: false }
    );

    window.addEventListener("keydown", (e) => {
        // Overlay toggle works whether or not the pointer is locked.
        if (e.code === "F1" || e.code === "Backquote") {
            e.preventDefault();
            onToggleOverlay?.();
            return;
        }

        const isJumpKey = e.code === "Space";
        // Space is the discrete action button (jump / Sand Step), not a held
        // movement modifier — `jumpPressed` fires once per physical press
        // regardless of how long the key stays down afterward, the same
        // edge-triggered shape as the spell keys below. `jumpHeld` tracks the
        // continuous state alongside it for anything that genuinely wants
        // "is it down", but the controller's own jump logic deliberately
        // does not read it — see the field's own doc comment on why a naive
        // `if (spaceHeld) jump()` would fire every frame. Shift is not bound
        // to jump at all — Phase 8B reverted the earlier control revision.
        if (isJumpKey) {
            if (!e.repeat && input.locked) input.jumpPressed = true;
            input.jumpHeld = true;
            if (input.locked) e.preventDefault(); // stop the page from scrolling
        }

        if (e.repeat) return;
        keys[e.code] = true;

        const n = SPELL_KEYS[e.code];
        if (n) {
            input.spellPressed = n;
            if (n === 2) input.spellHeld2 = true;
        }

        if (!input.locked) return;
        if (e.code === "KeyQ") input.dashPressed = true;
        else if (e.code === "ControlLeft" || e.code === "ControlRight") input.evadePressed = true;
        else if (e.code === "KeyC") input.camResetPressed = true;
        // Alternate surf toggle — see the note on `input.surf` above.
        else if (e.code === "KeyF") { _fToggle = !_fToggle; input.surf = _rmbHeld || _fToggle; }
    });

    window.addEventListener("keyup", (e) => {
        keys[e.code] = false;
        if (SPELL_KEYS[e.code] === 2) input.spellHeld2 = false;
        if (e.code === "Space") input.jumpHeld = false;
    });

    window.addEventListener("blur", () => {
        for (const k in keys) keys[k] = false;
        _rmbHeld = false;
        _fToggle = false;
        input.surf = false;
        input.spellHeld2 = false;
        input.jumpHeld = false;
    });
}

const SPELL_KEYS = {
    Digit1: 1,
    Digit2: 2,
    Digit3: 3,
    Digit4: 4,
    Digit5: 5,
};

/** Resolve held keys into movement axes. Called once per frame before update. */
export function pollInput() {
    let x = 0;
    let z = 0;
    if (keys.KeyW || keys.ArrowUp) z += 1;
    if (keys.KeyS || keys.ArrowDown) z -= 1;
    if (keys.KeyD || keys.ArrowRight) x += 1;
    if (keys.KeyA || keys.ArrowLeft) x -= 1;

    // Clamp to a unit disc so diagonals aren't faster.
    const len = Math.sqrt(x * x + z * z);
    if (len > 1) {
        x /= len;
        z /= len;
    }
    input.moveX = x;
    input.moveZ = z;
    input.moving = len > 0.001;
}

/** Clear per-frame accumulators. Called at the very end of the frame. */
export function endFrame() {
    input.lookX = 0;
    input.lookY = 0;
    input.zoomDelta = 0;
    input.spellPressed = 0;
    input.jumpPressed = false;
    input.dashPressed = false;
    input.evadePressed = false;
    input.camResetPressed = false;
}

export function isDown(code) {
    return !!keys[code];
}
