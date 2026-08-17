// -----------------------------------------------------------------------------
// snowClipmap — vertex placement and displacement for the nested-ring terrain.
//
// The whole terrain is one static vertex buffer and one draw call. Vertices
// carry only a grid index and a ring level; where they actually land is decided
// here, every frame, from the camera position. Nothing is rebuilt on the CPU,
// nothing streams.
//
// Two things make this crack-free:
//
//  1. Each ring snaps its origin to twice its own vertex spacing, so the lattice
//     never slides underneath the geometry and the surface does not swim.
//
//  2. Vertices morph toward the *next coarser* lattice across the outer band of
//     their ring (CDLOD). By the ring boundary the morph is complete, so those
//     vertices sit exactly on the coarser ring's lattice and sample exactly the
//     same height. No T-junctions, and no popping when a ring re-snaps.
//
// Included by both the beauty pass and the shadow depth pass. They must produce
// bit-identical positions or the terrain would shadow-acne against itself, which
// is precisely why this is an include and not two copies.
// -----------------------------------------------------------------------------

/// Bicubic B-spline height fetch, via the four-bilinear-tap trick.
///
/// Bilinear alone leaves diamond-shaped creases across every texel of a smooth
/// dune, which reads as visible faceting. B-spline is
/// approximating rather than interpolating, so it also gently low-passes the
/// bake, which on a landform is a bonus.
fn sampleHeightBicubic(tex: texture_2d<f32>, samp: sampler, uv: vec2f, res: f32) -> f32 {
    let coord = uv * res - 0.5;
    let base = floor(coord);
    let f = coord - base;

    let f2 = f * f;
    let f3 = f2 * f;
    let w0 = (1.0 - 3.0 * f + 3.0 * f2 - f3) / 6.0;
    let w1 = (4.0 - 6.0 * f2 + 3.0 * f3) / 6.0;
    let w2 = (1.0 + 3.0 * f + 3.0 * f2 - 3.0 * f3) / 6.0;
    let w3 = f3 / 6.0;

    let s0 = w0 + w1;
    let s1 = w2 + w3;
    let o0 = (base + 0.5 - 1.0 + w1 / s0) / res;
    let o1 = (base + 0.5 + 1.0 + w3 / s1) / res;

    let t00 = textureSampleLevel(tex, samp, vec2f(o0.x, o0.y), 0.0).r;
    let t10 = textureSampleLevel(tex, samp, vec2f(o1.x, o0.y), 0.0).r;
    let t01 = textureSampleLevel(tex, samp, vec2f(o0.x, o1.y), 0.0).r;
    let t11 = textureSampleLevel(tex, samp, vec2f(o1.x, o1.y), 0.0).r;

    return mix(mix(t00, t10, s1.x), mix(t01, t11, s1.x), s1.y);
}

/// World XZ → height-texture UV.
fn worldToHeightUV(p: vec2f, origin: vec2f, size: f32) -> vec2f {
    return (p - origin) / size;
}

struct ClipmapVertex {
    worldXZ: vec2f,
    spacing: f32,   // this vertex's effective sample spacing, post-morph
    morph: f32,
};

/// Place a clipmap vertex in world space.
///
/// `grid` is the vertex's integer position within its ring, in [-N/2, N/2].
/// `level` is the ring index; spacing doubles each level.
fn placeClipmapVertex(
    grid: vec2f,
    level: f32,
    camXZ: vec2f,
    baseSpacing: f32,
    gridHalfN: f32
) -> ClipmapVertex {
    let spacing = baseSpacing * exp2(level);

    // Snap the ring origin to twice this level's spacing. Twice, not once, so
    // that the parity of the lattice is stable — snapping to 1x would let the
    // morph targets flip between frames and the surface would shimmer.
    let snap = spacing * 2.0;
    let origin = floor(camXZ / snap) * snap;

    var local = grid * spacing;

    // ---- morph toward the coarser lattice --------------------------------
    // Chebyshev distance, because the rings are square. Normalised so 1.0 is
    // the ring's outer edge.
    let extent = gridHalfN * spacing;
    let cheb = max(abs(local.x), abs(local.y)) / extent;

    // Completes at 0.86, comfortably before the overlap band where this ring
    // and the next coarser one both draw.
    let morph = clamp((cheb - 0.70) / 0.16, 0.0, 1.0);

    // The coarse lattice is every second vertex of this one.
    let coarseGrid = floor(grid * 0.5) * 2.0;
    let coarseLocal = coarseGrid * spacing;
    local = mix(local, coarseLocal, morph);

    var out: ClipmapVertex;
    out.worldXZ = origin + local;
    out.spacing = spacing * (1.0 + morph);
    out.morph = morph;
    return out;
}
