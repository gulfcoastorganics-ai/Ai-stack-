/**
 * Readiness helpers.
 *
 * Babylon compiles shaders asynchronously, so a ProceduralTexture or
 * ShaderMaterial constructed on one line is not usable on the next. Rendering
 * early throws "Invalid call to enableEffect" — and, worse, a WGSL compile
 * error surfaces the same way, as a texture that simply never becomes ready.
 *
 * Everything here exists so that compilation happens behind the loading screen:
 * a shader that first compiles when the player casts a spell is a
 * multi-hundred-millisecond freeze.
 */

/**
 * Wait for an object exposing `isReady()`.
 * @param {{isReady: (...a:any[]) => boolean}} obj
 * @param {string} label used in the timeout message
 * @param {any[]} [args] forwarded to isReady (materials want a mesh)
 */
export function whenReady(obj, label, args) {
    return new Promise((resolve, reject) => {
        const t0 = performance.now();
        const a = args || [];
        const tick = () => {
            let ok = false;
            try {
                ok = obj.isReady.apply(obj, a);
            } catch (e) {
                reject(new Error(label + " isReady() threw: " + e.message));
                return;
            }
            if (ok) {
                resolve();
                return;
            }
            if (performance.now() - t0 > 25000) {
                reject(
                    new Error(
                        label + " never became ready after 25s — " +
                        "almost always a WGSL compile error; check the console."
                    )
                );
                return;
            }
            requestAnimationFrame(tick);
        };
        tick();
    });
}

/**
 * Compile a procedural texture's effect, then render it once.
 * @param {import("@babylonjs/core/Materials/Textures/Procedurals/proceduralTexture").ProceduralTexture} pt
 */
export async function bakeOnce(pt, label) {
    await whenReady(pt, label || pt.name);
    pt.render();
}

/**
 * Bind a pre-flattened matrix array to a `ShaderMaterial` without allocating.
 *
 * `ShaderMaterial.setMatrices` builds a fresh `Float32Array` on every call and
 * copies each matrix into it. Six materials upload the three shadow cascades
 * that way every frame, which is about a kilobyte of garbage per frame.
 *
 * Writing the caller's array into the same slot is safe rather than clever:
 * `ShaderMaterial.bind` does `effect.setMatrices(name, this._matrixArrays[name])`,
 * so the array takes the byte-identical path `setMatrices` would have produced.
 * The only thing skipped is the copy. The uniform's declared type, the slot and
 * the effect call are all unchanged.
 *
 * @param {import("@babylonjs/core/Materials/shaderMaterial").ShaderMaterial} material
 * @param {string} name
 * @param {Float32Array} data 16 floats per matrix
 */
export function bindMatrixArray(material, name, data) {
    const arrays = /** @type {any} */ (material)._matrixArrays;
    if (arrays[name] !== data) {
        /** @type {any} */ (material)._checkUniform(name);
        arrays[name] = data;
    }
}
