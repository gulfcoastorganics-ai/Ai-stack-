/**
 * Smoke tests for the jump/input state machine in `src/core/input.js`.
 *
 * Uses Node's built-in test runner (`node --test`) rather than adding a
 * framework dependency — there was no test infrastructure in this repo
 * before this file, and one file's worth of DOM-event plumbing doesn't
 * justify introducing one. `document`/`window`/the canvas are all just
 * `EventTarget`s here: `input.js` only ever calls `addEventListener`/
 * `dispatchEvent`-compatible methods on them, never anything DOM-specific,
 * so a real browser or jsdom is not needed to exercise the state machine.
 *
 * Each test gets its own fresh `window`/`document`/canvas and calls
 * `initInput()` itself, so listeners never accumulate across tests and one
 * test's key state can't leak into the next.
 *
 * Run with: node --test test/input.jump.test.js
 */

import { test } from "node:test";
import assert from "node:assert/strict";

const { initInput, input, endFrame } = await import("../src/core/input.js");

/** A synthetic KeyboardEvent-shaped object. Node's `Event` doesn't carry
 *  `code`/`repeat` itself, but nothing stops assigning them — `input.js`
 *  only ever reads those two properties plus calls `preventDefault()`,
 *  which `Event` instances already implement. */
function key(type, code, repeat = false) {
    const e = new Event(type);
    e.code = code;
    e.repeat = repeat;
    return e;
}

/** Fresh `window`/`document`/canvas per test, with `initInput()` wired up. */
function freshInput() {
    globalThis.window = new EventTarget();
    globalThis.document = new EventTarget();
    globalThis.document.pointerLockElement = null;

    const canvas = new EventTarget();
    canvas.requestPointerLock = () => {
        globalThis.document.pointerLockElement = canvas;
        globalThis.document.dispatchEvent(new Event("pointerlockchange"));
    };

    initInput(canvas);
    // `input` is a module-level singleton reused across every test in this
    // file — reset the fields under test explicitly rather than relying on
    // whatever the previous test happened to leave behind.
    input.locked = false;
    input.jumpPressed = false;
    input.jumpHeld = false;
    return canvas;
}

function lock(canvas) {
    globalThis.document.pointerLockElement = canvas;
    globalThis.document.dispatchEvent(new Event("pointerlockchange"));
}

function unlock() {
    globalThis.document.pointerLockElement = null;
    globalThis.document.dispatchEvent(new Event("pointerlockchange"));
}

test("first Space keydown sets jumpPressed and jumpHeld", () => {
    freshInput();
    assert.equal(input.jumpPressed, false);
    assert.equal(input.jumpHeld, false);
    globalThis.window.dispatchEvent(key("keydown", "Space", false));
    assert.equal(input.jumpPressed, true);
    assert.equal(input.jumpHeld, true);
});

test("held Space (repeat=true) does not re-set jumpPressed after it clears", () => {
    freshInput();
    globalThis.window.dispatchEvent(key("keydown", "Space", false));
    endFrame();
    assert.equal(input.jumpPressed, false, "endFrame must clear jumpPressed");
    // OS key-repeat events carry repeat: true — must not retrigger.
    globalThis.window.dispatchEvent(key("keydown", "Space", true));
    assert.equal(input.jumpPressed, false, "a repeat keydown must not set jumpPressed");
    assert.equal(input.jumpHeld, true, "jumpHeld should still read as held");
});

test("Space keyup clears jumpHeld", () => {
    freshInput();
    globalThis.window.dispatchEvent(key("keydown", "Space", false));
    globalThis.window.dispatchEvent(key("keyup", "Space"));
    assert.equal(input.jumpHeld, false);
});

test("endFrame clears jumpPressed every frame", () => {
    freshInput();
    globalThis.window.dispatchEvent(key("keydown", "Space", false));
    assert.equal(input.jumpPressed, true);
    endFrame();
    assert.equal(input.jumpPressed, false);
});

test("losing pointer lock clears jumpPressed and jumpHeld", () => {
    const canvas = freshInput();
    lock(canvas);
    globalThis.window.dispatchEvent(key("keydown", "Space", false));
    assert.equal(input.jumpHeld, true);
    unlock();
    assert.equal(input.jumpHeld, false);
    assert.equal(input.jumpPressed, false);
});

test("window blur clears jumpPressed and jumpHeld", () => {
    freshInput();
    globalThis.window.dispatchEvent(key("keydown", "Space", false));
    assert.equal(input.jumpHeld, true);
    globalThis.window.dispatchEvent(new Event("blur"));
    assert.equal(input.jumpHeld, false);
    assert.equal(input.jumpPressed, false);
});

test("Shift is not bound to jump", () => {
    freshInput();
    globalThis.window.dispatchEvent(key("keydown", "ShiftLeft", false));
    assert.equal(input.jumpPressed, false);
    assert.equal(input.jumpHeld, false);
});

test("jump registers even without pointer lock (regression: jump used to require input.locked, which movement never did — this was the actual cause of the reported 'Space doesn't jump' bug)", () => {
    freshInput();
    assert.equal(input.locked, false, "lock was never acquired in this test");
    globalThis.window.dispatchEvent(key("keydown", "Space", false));
    assert.equal(input.jumpPressed, true, "jump must not silently require pointer lock");
});

test("jumpPressCount increments once per physical press, not per repeat", () => {
    freshInput();
    const before = input.jumpPressCount;
    globalThis.window.dispatchEvent(key("keydown", "Space", false));
    globalThis.window.dispatchEvent(key("keydown", "Space", true));
    globalThis.window.dispatchEvent(key("keydown", "Space", true));
    assert.equal(input.jumpPressCount, before + 1);
    globalThis.window.dispatchEvent(key("keyup", "Space"));
    globalThis.window.dispatchEvent(key("keydown", "Space", false));
    assert.equal(input.jumpPressCount, before + 2);
});
