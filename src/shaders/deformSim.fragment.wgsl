// -----------------------------------------------------------------------------
// deformSim — the terrain state buffer.
//
// One full-screen pass per frame, ping-ponged between two RGBA16F targets. It
// does four jobs in one dispatch, in this order:
//
//   1. scroll   the window follows the player toroidally; texels that just came
//               into view are zeroed rather than showing whatever was there
//               half a field away.
//   2. relax    diffusion + berm slump + slow decay. This is the "refill": trails
//               soften and eventually heal, but slowly enough that a run is still
//               obviously there a minute later.
//   3. splat    every brush written this frame — footfalls, the surf wake, every
//               spell — accumulated additively.
//   4. clamp    depression bottoms out (you hit packed snow), berms cap.
//
// Channels:
//   R  depression depth, metres, positive = pushed down
//   G  displaced mass,   metres, positive = piled up. This is the channel that
//      separates a trail with berms from a flat footprint decal.
//   B  compression 0..1 — denser, darker, tighter specular, scatters less
//   A  ice 0..1 — refrozen, smooth and reflective
//
// Addressing is toroidal: a texel's UV is fract(worldXZ / size), so the buffer
// never needs copying when the player moves. The seam therefore sits at the far
// edge of the window, ~32 m from the player, where a one-texel bilinear artefact
// is not resolvable.
// -----------------------------------------------------------------------------

#include<snowNoise>

varying vUV: vec2f;

var prevTex: texture_2d<f32>;
var prevTexSampler: sampler;

/// Brush parameters for this frame. Width = max brushes, height = 3 rows:
///   row 0: (worldX, worldZ, radius, elongation)
///   row 1: (cos yaw, sin yaw, depression amount, berm amount)
///   row 2: (compression, ice, edge roughness, seed)
///
/// A texture rather than a uniform array: it sidesteps uniform-array packing
/// entirely, costs one 3 KB upload per frame, and scales past the point where a
/// uniform block would stop fitting.
var brushTex: texture_2d<f32>;
var brushTexSampler: sampler;

uniform center: vec2f;      // window centre this frame, texel-snapped
uniform prevCenter: vec2f;  // window centre last frame
uniform size: f32;          // window coverage in metres
uniform res: f32;           // texels across
/// Seconds of relaxation to apply *this dispatch* — not the frame time.
///
/// Zero on most frames. See the note above the decay block: a half-float target
/// cannot represent a per-frame decay this slow, so the relaxation is banked on
/// the CPU and spent in steps large enough to survive the round-trip. Every term
/// below is an exact no-op at dt = 0, which is what makes that safe.
uniform dt: f32;
uniform brushCount: f32;
uniform refillRate: f32;
uniform maxDepth: f32;
uniform maxBerm: f32;
uniform windAngle: f32;

/// Recover the world position a texel stands for.
///
/// `uv * size` only pins the position modulo the window, so the correct branch is
/// the one nearest the window centre — which, by construction, is the only one
/// inside the window at all.
fn texelWorld(uv: vec2f, centre: vec2f, size: f32) -> vec2f {
    let base = uv * size;
    return base + size * round((centre - base) / size);
}

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    let uv = input.vUV;
    let size = uniforms.size;
    let dt = uniforms.dt;
    let world = texelWorld(uv, uniforms.center, size);

    var dep = 0.0;
    var berm = 0.0;
    var comp = 0.0;
    var ice = 0.0;

    // ---------------------------------------------------------------- scroll
    // Inside last frame's window? If not this texel just wrapped in from the
    // trailing edge and holds state from the far side of the field.
    let wasInside = all(abs(world - uniforms.prevCenter) <= vec2f(size * 0.5));

    if (wasInside) {
        let t = 1.0 / uniforms.res;
        let c = textureSampleLevel(prevTex, prevTexSampler, uv, 0.0);
        let xl = textureSampleLevel(prevTex, prevTexSampler, uv - vec2f(t, 0.0), 0.0);
        let xr = textureSampleLevel(prevTex, prevTexSampler, uv + vec2f(t, 0.0), 0.0);
        let zd = textureSampleLevel(prevTex, prevTexSampler, uv - vec2f(0.0, t), 0.0);
        let zu = textureSampleLevel(prevTex, prevTexSampler, uv + vec2f(0.0, t), 0.0);

        dep = c.r;
        berm = c.g;
        comp = c.b;
        ice = c.a;

        // --- diffusion -----------------------------------------------------
        // Explicit five-point Laplacian, so the coefficient has to stay under
        // 0.25 or it goes unstable and the buffer rings.
        //
        // These coefficients are *per second* and tiny on purpose. This pass runs
        // every frame, so at 140 FPS a rate that looks conservative per frame has
        // been applied 8,400 times a minute later. Diffusion spreads as
        // sqrt(2*D*t): at D = 0.05/s a footprint's rim softens by about 2.5
        // texels (8 cm) over a minute, which is the whole budget.
        //
        // Loose piled snow slumps faster than a compacted trench floor, so the
        // berm channel gets three times the depression's rate. That difference is
        // what makes a trail soften from its edges inward.
        let k = clamp(uniforms.refillRate * dt, 0.0, 1.0);
        let kDep = min(0.22, 0.004 * k);
        let kBerm = min(0.22, 0.012 * k);

        let lapDep = (xl.r + xr.r + zd.r + zu.r) - 4.0 * dep;
        let lapBerm = (xl.g + xr.g + zd.g + zu.g) - 4.0 * berm;
        dep += lapDep * kDep;
        berm += lapBerm * kBerm;

        // --- wind infill ----------------------------------------------------
        // Drift blows into the trench from upwind, so pull a little of the
        // upwind neighbour's state across. Asymmetric on purpose: a trail
        // filling evenly from both sides looks like a blur, filling from one
        // side looks like weather.
        let wdir = vec2f(sin(uniforms.windAngle), cos(uniforms.windAngle));
        let upwind = uv - wdir * (t * 1.6);
        let uw = textureSampleLevel(prevTex, prevTexSampler, upwind, 0.0);
        let kAdv = min(0.2, 0.002 * k);
        dep = mix(dep, uw.r, kAdv * 0.6);
        berm = mix(berm, uw.g, kAdv);

        // --- slump ----------------------------------------------------------
        // Piled mass falls back into the hole it came out of. Taking the min
        // keeps it mass-conserving and means an isolated berm with no adjacent
        // depression does not evaporate — it has to diffuse away instead.
        //
        // Per second, like the diffusion above.
        let slump = min(berm, dep) * min(0.6, 0.002 * uniforms.refillRate * dt);
        dep -= slump;
        berm -= slump;

        // --- decay ----------------------------------------------------------
        // Time constants, seconds, at refillRate = 1.
        //
        // The reason `dt` is banked rather than per-frame lives here.
        //
        // A 400-second time constant is a per-frame multiply by 0.999985 at
        // 165 FPS. Half float carries an 11-bit significand, so one ULP near 0.5
        // is a relative 4.9e-4 — thirty times *larger* than the 1.5e-5 the decay
        // is trying to subtract. Every store therefore lands between two
        // representable values, and because the product is always slightly below
        // the input it consistently resolves to the lower one: the buffer loses a
        // full ULP per frame instead of the sliver it asked for.
        //
        // That is a decay of 2^-11 per frame — about 8% per second, a ten-second
        // half-life, entirely independent of the constant written here and
        // proportional to frame rate. It is why three rounds of retuning these
        // numbers changed the measured decay by nothing at all, and why setting
        // refillRate to 0 (which makes exp() return exactly 1) froze the buffer
        // solid. Banking the time and spending it in steps of ~0.4 s puts each
        // multiply two ULPs clear of the noise floor, and the constants below now
        // mean what they say.
        let r = uniforms.refillRate;
        dep *= exp(-dt * r / 400.0);
        berm *= exp(-dt * r / 250.0);
        comp *= exp(-dt * r / 300.0);
        // Ice is the one thing here that is meant to feel permanent within a
        // session — a spell that "permanently alters the surface" should not
        // visibly melt while the player watches it.
        ice *= exp(-dt * r / 900.0);
    }

    // ----------------------------------------------------------------- splat
    let n = i32(uniforms.brushCount);
    for (var i = 0; i < n; i++) {
        let a = textureLoad(brushTex, vec2i(i, 0), 0);
        let b = textureLoad(brushTex, vec2i(i, 1), 0);
        let c = textureLoad(brushTex, vec2i(i, 2), 0);

        let radius = a.z;
        if (radius <= 0.0) { continue; }

        // Wrap the offset too, so a brush written near the seam still reaches
        // the texels on the far side of it.
        var p = world - a.xy;
        p -= size * round(p / size);

        // Cheap reject before the trig. The berm ring lives out to ~1.35, and
        // the edge wobble can push it a little past that.
        let reach = radius * max(a.w, 1.0) * 1.6;
        if (abs(p.x) > reach || abs(p.y) > reach) { continue; }

        // Into brush space: rotate by the brush yaw, then squash the long axis.
        let q = vec2f(
            (p.x * b.x + p.y * b.y) / (radius * a.w),
            (-p.x * b.y + p.y * b.x) / radius
        );
        let d = length(q);
        if (d > 1.55) { continue; }

        // Contact detail. A clean analytic bevel at the trail edge is the tell
        // that reads as "decal"; breaking the rim radius with angular noise and
        // granulating the berm is what gives it the chunky displaced look of the
        // God of War reference.
        let ang = atan2(q.y, q.x);
        let wob = 1.0 + c.z * 0.22 * noise2(vec2f(cos(ang), sin(ang)) * 2.7 + c.w);
        let dn = d / wob;

        // Depression: flat-ish floor, then a fast shoulder. Not a Gaussian —
        // a boot compresses a floor, it does not dimple.
        let core = 1.0 - smoothstep(0.42, 1.0, dn);

        // Berm: a ring sitting just outside the depression rim, where the
        // displaced mass actually ends up.
        let ringD = (dn - 1.04) * 3.4;
        let ring = exp(-ringD * ringD);
        let grain = 0.72 + 0.56 * (noise2(q * 7.5 + c.w * 3.1) * 0.5 + 0.5);

        dep += b.z * core;
        berm += b.w * ring * grain;
        comp += c.x * core;
        ice = max(ice, c.y * core);
    }

    // ----------------------------------------------------------------- clamp
    // Depression bottoms out: below about half a metre you are on packed snow
    // and nothing more moves. Without this, standing still while surfing would
    // dig an unbounded pit.
    dep = clamp(dep, 0.0, uniforms.maxDepth);
    berm = clamp(berm, 0.0, uniforms.maxBerm);
    comp = clamp(comp, 0.0, 1.0);
    ice = clamp(ice, 0.0, 1.0);

    fragmentOutputs.color = vec4f(dep, berm, comp, ice);
}
