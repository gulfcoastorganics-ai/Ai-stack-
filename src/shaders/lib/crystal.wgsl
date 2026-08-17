// -----------------------------------------------------------------------------
// snowCrystal — the shape of a grown ice formation.
//
// One crystal is a six-sided tapered prism with a point on it: a base ring
// sitting in the snow, a shoulder ring where the taper starts, and an apex. That
// is the whole model, and it is deliberately the whole model — the read comes
// from the *cluster*, from the light through it, and from the fact that it grows.
// A more elaborate single crystal costs vertices and buys nothing at the range
// this is seen from.
//
// Shared by the beauty pass and the shadow pass, for the same reason everything
// else here is: a formation whose shadow is a different shape from the formation
// is worse than no shadow at all.
//
// Data texture, three rows, one column per crystal:
//
//   row 0   (x, y, z, height m)
//   row 1   (axisX, axisY, axisZ, base radius m)
//   row 2   (growth 0..1, seed, tint, spare)
//
// `growth` is not a uniform scale. A crystal shoots up first and thickens after,
// the way real freezing does along the fastest-growing axis, so height and radius
// run on two different curves off the one parameter.
// -----------------------------------------------------------------------------

/// Vertices per crystal: two rings of six plus an apex.
const CRYSTAL_RING: i32 = 6;
const CRYSTAL_VERTS: i32 = 13;

/// Local position of vertex `v` of a crystal, in the crystal's own frame
/// (+Y along the growth axis).
///
/// The per-crystal `seed` breaks the hexagon: each of the six radial directions
/// gets its own length, so no two crystals in a cluster share a silhouette and
/// none of them is a regular hexagon — which reads as manufactured immediately.
fn crystalLocal(v: i32, height: f32, radius: f32, seed: f32) -> vec3f {
    if (v >= CRYSTAL_VERTS - 1) {
        // Apex, nudged off the axis so the point is not perfectly centred.
        let j = hash22(vec2f(seed, 7.31)) - 0.5;
        return vec3f(j.x * radius * 0.5, height, j.y * radius * 0.5);
    }

    let ring = v / CRYSTAL_RING;          // 0 = base, 1 = shoulder
    let k = v - ring * CRYSTAL_RING;
    let ang = f32(k) * 1.04719755 + seed * 6.2831853;   // 60 degrees apart
    let wob = 0.72 + 0.56 * hash21(vec2f(f32(k) + seed * 31.0, seed * 17.0));

    let r = select(radius * wob, radius * wob * 0.68, ring == 1);
    let y = select(0.0, height * 0.58, ring == 1);
    return vec3f(cos(ang) * r, y, sin(ang) * r);
}

/// World position of vertex `v` of crystal `i`.
fn crystalPoint(tex: texture_2d<f32>, i: i32, v: i32) -> vec3f {
    let a = textureLoad(tex, vec2i(i, 0), 0);
    let b = textureLoad(tex, vec2i(i, 1), 0);
    let c = textureLoad(tex, vec2i(i, 2), 0);

    let g = clamp(c.x, 0.0, 1.0);
    // Height leads, girth follows. A crystal that scales uniformly reads as a
    // model being lerped in; one that spears up and then thickens reads as ice
    // forming, because that is what ice does.
    let gh = g * g * (3.0 - 2.0 * g);
    let gr = smoothstep(0.25, 1.0, g);
    let height = a.w * gh;
    let radius = b.w * (0.22 + 0.78 * gr);

    let local = crystalLocal(v, height, radius, c.y);

    // Frame from the growth axis. Any stable perpendicular will do; the shape is
    // already randomised about the axis by `seed`.
    let axis = normalize(select(b.xyz, vec3f(0.0, 1.0, 0.0), dot(b.xyz, b.xyz) < 1e-6));
    let ref2 = select(vec3f(0.0, 0.0, 1.0), vec3f(1.0, 0.0, 0.0), abs(axis.y) < 0.9);
    let ex = normalize(cross(ref2, axis));
    let ez = cross(axis, ex);

    return a.xyz + ex * local.x + axis * local.y + ez * local.z;
}
