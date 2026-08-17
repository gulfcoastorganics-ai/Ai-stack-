// -----------------------------------------------------------------------------
// snowCrystal — the shape of a grown fulgurite formation.
//
// SANDSTORM Phase 6: SNOWFLOW's ice-prism geometry, redesigned rather than
// retinted, for Fulgurite Garden. One formation is still a six-sided tapered
// prism with a point on it — a base ring, a shoulder ring where the taper
// starts, and an apex — the same thirteen-vertex, six-sided budget, because
// the read comes from the *cluster* and from the light through it rather than
// from any one prism's vertex count. What changed is that the shoulder ring no
// longer sits directly above the base: it steps sideways and rotates against
// it, so the form reads as a bent, twisted, irregular glass tube fused by heat
// rather than a crystal that grew straight up along one axis. "Branch and
// twist modestly," not literally fork — a true branching mesh would cost a
// second ring budget per formation, which forty live prisms cannot afford.
//
// Shared by the beauty pass and the shadow pass, for the same reason everything
// else here is: a formation whose shadow is a different shape from the formation
// is worse than no shadow at all.
//
// Data texture, three rows, one column per crystal:
//
//   row 0   (x, y, z, height m)
//   row 1   (axisX, axisY, axisZ, base radius m)
//   row 2   (growth 0..1, seed, tint, formation heat 0..1)
//
// `growth` is not a uniform scale. A formation shoots up first and thickens
// after, the way a real fulgurite's fusion front races ahead of the melt, so
// height and radius run on two different curves off the one parameter.
// `tint` (row 2, channel 2) is currently unused, same as in SNOWFLOW.
// -----------------------------------------------------------------------------

/// Vertices per crystal: two rings of six plus an apex.
const CRYSTAL_RING: i32 = 6;
const CRYSTAL_VERTS: i32 = 13;

/// Local position of vertex `v` of a crystal, in the crystal's own frame
/// (+Y along the growth axis).
///
/// The per-crystal `seed` breaks the hexagon the same way SNOWFLOW's did —
/// each of the six radial directions gets its own length — and adds two things
/// SNOWFLOW's straight ice prism had no reason to have: the shoulder ring is
/// rotated against the base rather than stacked directly above it, and its
/// centre steps sideways off the base-to-apex axis. Together those read as a
/// form that bent and twisted while it fused, which is what irregular vitrified
/// glass actually looks like — a straight hexagonal prism is precisely the ice
/// silhouette this ability must not have.
fn crystalLocal(v: i32, height: f32, radius: f32, seed: f32) -> vec3f {
    if (v >= CRYSTAL_VERTS - 1) {
        // Apex, on an independent seeded offset from the shoulder's kink so the
        // spire's very tip can lean a different way than its waist — a small
        // extra irregularity that keeps the silhouette from reading as one
        // clean bend.
        let j = hash22(vec2f(seed * 2.1 + 4.0, 9.7)) - 0.5;
        return vec3f(j.x * radius * 1.1, height, j.y * radius * 1.1);
    }

    let ring = v / CRYSTAL_RING;          // 0 = base, 1 = shoulder
    let k = v - ring * CRYSTAL_RING;
    // The shoulder hexagon is rotated against the base's — a fulgurite twists
    // as it fuses, a straight ice prism never did.
    let twist = select(0.0, 0.55 + seed * 1.35, ring == 1);
    let ang = f32(k) * 1.04719755 + seed * 6.2831853 + twist;
    let wob = 0.62 + 0.72 * hash21(vec2f(f32(k) + seed * 31.0, seed * 17.0));

    let r = select(radius * wob, radius * wob * 0.60, ring == 1);
    let y = select(0.0, height * 0.58, ring == 1);

    // Lateral kink: the shoulder ring's centre steps off the base-to-apex line,
    // bending the whole form rather than tapering it straight.
    let kink = select(
        vec2f(0.0),
        (hash22(vec2f(seed * 3.7, seed * 5.3 + 1.0)) - 0.5) * radius * 1.4,
        ring == 1
    );

    return vec3f(cos(ang) * r + kink.x, y, sin(ang) * r + kink.y);
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
