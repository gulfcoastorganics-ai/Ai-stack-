/**
 * Loading-screen driver.
 *
 * A phase-weighted progress model: each phase declares how much of the bar it
 * owns, and the bar only ever moves forward. `phase()` also yields to the
 * browser so the DOM actually repaints between heavy synchronous steps.
 */

const bar = /** @type {HTMLElement} */ (document.getElementById("boot-bar"));
const label = /** @type {HTMLElement} */ (document.getElementById("boot-phase"));
const root = /** @type {HTMLElement} */ (document.getElementById("boot"));
const hint = /** @type {HTMLElement} */ (document.getElementById("hint"));

let progress = 0;

/** Yield to the compositor so the loading screen repaints. */
export function nextFrame() {
    return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
}

/**
 * @param {string} text shown under the bar
 * @param {number} to target progress, 0..1
 */
export async function phase(text, to) {
    if (label) label.textContent = text;
    progress = Math.max(progress, to);
    if (bar) bar.style.width = (progress * 100).toFixed(1) + "%";
    await nextFrame();
}

export async function done() {
    await phase("ready", 1);
    // Let the bar visibly land before the fade starts.
    await new Promise((r) => setTimeout(r, 360));
    root?.classList.add("gone");
    hint?.classList.add("show");
    setTimeout(() => {
        root?.remove();
        hint?.classList.remove("show");
    }, 6000);
}

export function fail(message) {
    root?.remove();
    const el = document.getElementById("nogpu");
    if (el) {
        el.classList.add("show");
        const b = el.querySelector("b");
        if (b && message) b.textContent = message;
    }
}
