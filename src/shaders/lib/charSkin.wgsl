// -----------------------------------------------------------------------------
// charSkin — the character's shared vertex-side transform library.
//
// Everything the character needs to place a vertex comes out of one small
// RGBA32F texture, uploaded once per frame:
//
//   rows 0-3   bone skinning matrices. Column = bone index, row = matrix column,
//              so texel (b, c) is column c of bone b's `world * inverseBind`.
//   rows 4+    simulated cloth node positions, one rectangle per garment panel.
//
// A texture rather than uniform arrays, for the same reason the deformation
// brushes are a texture: it sidesteps uniform-array packing entirely, it has no
// awkward size ceiling, and it is one small upload per frame either way.
//
// The beauty pass and both shadow cascades include this file, so the surface
// they place is the same surface by construction — the mistake the terrain
// already paid for once.
// -----------------------------------------------------------------------------

/// Skin a point by one bone.
fn skinPoint1(tex: texture_2d<f32>, b: i32, p: vec3f) -> vec3f {
    let c0 = textureLoad(tex, vec2i(b, 0), 0);
    let c1 = textureLoad(tex, vec2i(b, 1), 0);
    let c2 = textureLoad(tex, vec2i(b, 2), 0);
    let c3 = textureLoad(tex, vec2i(b, 3), 0);
    return c0.xyz * p.x + c1.xyz * p.y + c2.xyz * p.z + c3.xyz;
}

/// Skin a direction by one bone (no translation).
fn skinDir1(tex: texture_2d<f32>, b: i32, d: vec3f) -> vec3f {
    let c0 = textureLoad(tex, vec2i(b, 0), 0);
    let c1 = textureLoad(tex, vec2i(b, 1), 0);
    let c2 = textureLoad(tex, vec2i(b, 2), 0);
    return c0.xyz * d.x + c1.xyz * d.y + c2.xyz * d.z;
}

/// Two-influence linear blend skinning. Two is enough for a figure whose only
/// hard joints are elbows and knees; the garments that need more are simulated.
fn skinPoint(tex: texture_2d<f32>, idx: vec4f, wt: vec4f, p: vec3f) -> vec3f {
    var r = skinPoint1(tex, i32(idx.x), p) * wt.x;
    if (wt.y > 0.0001) { r += skinPoint1(tex, i32(idx.y), p) * wt.y; }
    return r / max(1e-4, wt.x + wt.y);
}

fn skinNormal(tex: texture_2d<f32>, idx: vec4f, wt: vec4f, n: vec3f) -> vec3f {
    var r = skinDir1(tex, i32(idx.x), n) * wt.x;
    if (wt.y > 0.0001) { r += skinDir1(tex, i32(idx.y), n) * wt.y; }
    return normalize(r);
}

// ------------------------------------------------------------- cloth sampling

/// One simulated node. `u` wraps — every garment is a closed tube — and `v`
/// clamps, because the top and bottom edges are real boundaries.
fn clothNode(tex: texture_2d<f32>, rowBase: i32, cols: i32, rows: i32, i: i32, j: i32) -> vec3f {
    let ii = (i % cols + cols) % cols;
    let jj = clamp(j, 0, rows - 1);
    return textureLoad(tex, vec2i(ii, rowBase + jj), 0).xyz;
}

/// Catmull-Rom basis and its derivative.
fn crBasis(t: f32) -> vec4f {
    let t2 = t * t;
    let t3 = t2 * t;
    return vec4f(
        0.5 * (-t3 + 2.0 * t2 - t),
        0.5 * (3.0 * t3 - 5.0 * t2 + 2.0),
        0.5 * (-3.0 * t3 + 4.0 * t2 + t),
        0.5 * (t3 - t2)
    );
}

fn crDeriv(t: f32) -> vec4f {
    let t2 = t * t;
    return vec4f(
        0.5 * (-3.0 * t2 + 4.0 * t - 1.0),
        0.5 * (9.0 * t2 - 10.0 * t),
        0.5 * (-9.0 * t2 + 8.0 * t + 1.0),
        0.5 * (3.0 * t2 - 2.0 * t)
    );
}

struct ClothSample {
    pos: vec3f,
    nrm: vec3f,
    tanU: vec3f,
};

/// Reconstruct a smooth garment surface from its simulated grid.
///
/// This is the whole reason the solver can afford to be twenty by twelve: the
/// interpolant is C1, so a coarse grid renders without a single visible facet,
/// and the tangents fall out of the same sixteen taps as the position — no
/// finite differences, no second sampling pass, and normals that are exactly
/// consistent with the surface being drawn.
fn sampleCloth(
    tex: texture_2d<f32>,
    rowBase: i32, cols: i32, rows: i32,
    u: f32, v: f32
) -> ClothSample {
    let gu = u * f32(cols);
    let gv = v * f32(rows - 1);
    let fu = floor(gu);
    let fv = floor(gv);
    let i0 = i32(fu) - 1;
    let j0 = i32(fv) - 1;

    let wu = crBasis(gu - fu);
    let du = crDeriv(gu - fu);
    let wv = crBasis(gv - fv);
    let dv = crDeriv(gv - fv);

    var p = vec3f(0.0);
    var pu = vec3f(0.0);
    var pv = vec3f(0.0);

    for (var j = 0; j < 4; j++) {
        var rowP = vec3f(0.0);
        var rowD = vec3f(0.0);
        for (var i = 0; i < 4; i++) {
            let q = clothNode(tex, rowBase, cols, rows, i0 + i, j0 + j);
            rowP += q * wu[i];
            rowD += q * du[i];
        }
        p += rowP * wv[j];
        pu += rowD * wv[j];
        pv += rowP * dv[j];
    }

    var out: ClothSample;
    out.pos = p;
    // Ordered so the result points away from the body: u runs anticlockwise
    // around the tube and v runs down it.
    out.nrm = normalize(cross(pv, pu));
    out.tanU = normalize(pu);
    return out;
}
