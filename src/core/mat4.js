/**
 * Flat-array 4x4 rigid-transform maths.
 *
 * Babylon's `Matrix` is perfectly good and is used everywhere a matrix crosses
 * into the engine. This exists for the one place it does not fit: the character
 * skeleton keeps twenty bone matrices, their inverse binds and their skinning
 * products in three contiguous `Float32Array`s, because the last of those is
 * uploaded to the GPU verbatim every frame. Wrapping each of those in an object
 * would mean sixty `Matrix` instances and a copy per bone per frame to flatten
 * them again.
 *
 * Layout matches Babylon's, which is also what WGSL wants: read as column-major,
 * elements 0-2 are the X axis, 4-6 the Y axis, 8-10 the Z axis and 12-14 the
 * translation, so `M * vec4(p, 1)` in a shader is the local-to-world transform.
 *
 * Every function takes explicit array + offset. Nothing here allocates.
 */

/**
 * Write a rigid frame: three orthonormal axes and an origin.
 * @param {Float32Array} out @param {number} o element offset (16 per matrix)
 */
export function setFrame(out, o, px, py, pz, xx, xy, xz, yx, yy, yz, zx, zy, zz) {
    out[o] = xx; out[o + 1] = xy; out[o + 2] = xz; out[o + 3] = 0;
    out[o + 4] = yx; out[o + 5] = yy; out[o + 6] = yz; out[o + 7] = 0;
    out[o + 8] = zx; out[o + 9] = zy; out[o + 10] = zz; out[o + 11] = 0;
    out[o + 12] = px; out[o + 13] = py; out[o + 14] = pz; out[o + 15] = 1;
}

/**
 * Build a frame from a bone direction and a reference "front".
 *
 * `dir` becomes the local +Y axis — the convention throughout the rig is that a
 * bone's own axis runs from its joint toward its child, so a hanging arm has
 * +Y pointing at the floor. `ref` only has to be roughly perpendicular; it is
 * re-orthogonalised here, and swapped for a fallback when it is not.
 */
export function setFrameFromDir(out, o, px, py, pz, dx, dy, dz, rx, ry, rz) {
    let l = Math.hypot(dx, dy, dz) || 1;
    const yx = dx / l, yy = dy / l, yz = dz / l;

    // X = Y x ref, which is the axis both are perpendicular to.
    let ax = yy * rz - yz * ry;
    let ay = yz * rx - yx * rz;
    let az = yx * ry - yy * rx;
    l = Math.hypot(ax, ay, az);
    if (l < 1e-5) {
        // `ref` was parallel to the bone. Any perpendicular will do — cross
        // with world +X, which cannot also be parallel unless `ref` was zero.
        ax = 0 * yz - yy * 0;
        ay = yz * 1 - yx * 0;
        az = yx * 0 - yy * 1;
        l = Math.hypot(ax, ay, az) || 1;
    }
    ax /= l; ay /= l; az /= l;

    // Z = X x Y completes the basis. Babylon is left-handed with X right, Y up
    // and Z forward, and the plain cross product is exactly what produces that,
    // so this frame composes correctly with everything else in the engine.
    setFrame(
        out, o, px, py, pz,
        ax, ay, az,
        yx, yy, yz,
        ay * yz - az * yy, az * yx - ax * yz, ax * yy - ay * yx
    );
}

/** `out = a * b`, both rigid. Aliasing `out` with either input is not allowed. */
export function mul(out, oo, a, oa, b, ob) {
    for (let c = 0; c < 4; c++) {
        const bx = b[ob + c * 4], by = b[ob + c * 4 + 1], bz = b[ob + c * 4 + 2], bw = b[ob + c * 4 + 3];
        out[oo + c * 4] = a[oa] * bx + a[oa + 4] * by + a[oa + 8] * bz + a[oa + 12] * bw;
        out[oo + c * 4 + 1] = a[oa + 1] * bx + a[oa + 5] * by + a[oa + 9] * bz + a[oa + 13] * bw;
        out[oo + c * 4 + 2] = a[oa + 2] * bx + a[oa + 6] * by + a[oa + 10] * bz + a[oa + 14] * bw;
        out[oo + c * 4 + 3] = a[oa + 3] * bx + a[oa + 7] * by + a[oa + 11] * bz + a[oa + 15] * bw;
    }
}

/**
 * Inverse of a rigid transform: transpose the rotation, negate the rotated
 * translation. A general inverse would work too and would be slower and less
 * accurate; nothing in the rig ever scales.
 */
export function invertRigid(out, oo, m, om) {
    const xx = m[om], xy = m[om + 1], xz = m[om + 2];
    const yx = m[om + 4], yy = m[om + 5], yz = m[om + 6];
    const zx = m[om + 8], zy = m[om + 9], zz = m[om + 10];
    const tx = m[om + 12], ty = m[om + 13], tz = m[om + 14];

    out[oo] = xx; out[oo + 1] = yx; out[oo + 2] = zx; out[oo + 3] = 0;
    out[oo + 4] = xy; out[oo + 5] = yy; out[oo + 6] = zy; out[oo + 7] = 0;
    out[oo + 8] = xz; out[oo + 9] = yz; out[oo + 10] = zz; out[oo + 11] = 0;
    out[oo + 12] = -(xx * tx + xy * ty + xz * tz);
    out[oo + 13] = -(yx * tx + yy * ty + yz * tz);
    out[oo + 14] = -(zx * tx + zy * ty + zz * tz);
    out[oo + 15] = 1;
}

/** Transform a point. Writes three floats into `dst` at `od`. */
export function xformPoint(m, om, x, y, z, dst, od) {
    dst[od] = m[om] * x + m[om + 4] * y + m[om + 8] * z + m[om + 12];
    dst[od + 1] = m[om + 1] * x + m[om + 5] * y + m[om + 9] * z + m[om + 13];
    dst[od + 2] = m[om + 2] * x + m[om + 6] * y + m[om + 10] * z + m[om + 14];
}

/** Transform a direction (ignores translation). */
export function xformDir(m, om, x, y, z, dst, od) {
    dst[od] = m[om] * x + m[om + 4] * y + m[om + 8] * z;
    dst[od + 1] = m[om + 1] * x + m[om + 5] * y + m[om + 9] * z;
    dst[od + 2] = m[om + 2] * x + m[om + 6] * y + m[om + 10] * z;
}
