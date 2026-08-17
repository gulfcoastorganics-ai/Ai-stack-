// -----------------------------------------------------------------------------
// deformSim — the terrain state buffer.
//
// SANDSTORM: reinterpreted from SNOWFLOW's snow deformation for granular sand.
// The pass architecture, the ping-pong pair, the channel count and the
// toroidal addressing are all unchanged — only the relaxation constants below
// and the channel semantics have moved from "packed snow that slowly refills"
// to "dry granular sand that slumps toward its angle of repose and is reworked
// by wind." One full-screen pass per frame, ping-ponged between two RGBA16F
// targets. It does four jobs in one dispatch, in this order:
//
//   1. scroll   the window follows the player toroidally; texels that just came
//               into view are zeroed rather than showing whatever was there
//               half a field away.
//   2. relax    diffusion + downhill slump + wind infill + slow decay. This is
//               sand's answer to "refill": excavated hollows and thrown berms
//               soften and eventually erode away, faster and more readily than
//               snow ever did, because loose sand has essentially no cohesion.
//   3. splat    every brush written this frame — footfalls, the surf wake, every
//               spell — accumulated additively.
//   4. clamp    depression bottoms out (you hit packed sand), berms cap.
//
// Channels:
//   R  depression / excavation depth, metres, positive = pushed down
//   G  displaced loose sand mass, metres, positive = piled up. This is the
//      channel that separates a trail with berms from a flat footprint decal.
//   B  compaction 0..1 — denser, darker, tighter specular, scatters less
//   A  sun-baked crust / stabilised surface 0..1 — cemented sand (caliche),
//      smoother and more weather-resistant than loose grain
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

/// Macro landform slope (dH/dx, dH/dz in R,G), the same baked aux texture the
/// ground material reads. Sampled here so loose sand can slump downhill toward
/// its angle of repose — a behaviour snow's cohesive pack never needed and dry
/// granular sand cannot do without. One extra texture read on an already
/// resident, already-baked texture; no new resource category.
var auxTex: texture_2d<f32>;
var auxTexSampler: sampler;
uniform worldOrigin: vec2f;
uniform worldSize: f32;

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
        // sqrt(2*D*t).
        //
        // Loose piled sand slumps far more readily than a compacted trench
        // floor — dry granular material has essentially no cohesion, unlike
        // snow's sintered pack — so the berm channel's rate is raised well
        // above the depression's. That gap is what makes a trail soften from
        // its edges inward, faster than SNOWFLOW's snow ever did.
        let k = clamp(uniforms.refillRate * dt, 0.0, 1.0);
        let kDep = min(0.22, 0.005 * k);
        let kBerm = min(0.22, 0.030 * k);

        let lapDep = (xl.r + xr.r + zd.r + zu.r) - 4.0 * dep;
        let lapBerm = (xl.g + xr.g + zd.g + zu.g) - 4.0 * berm;
        dep += lapDep * kDep;
        berm += lapBerm * kBerm;

        // --- downhill migration ---------------------------------------------
        // Loose sand relaxes toward its angle of repose (~30-34 degrees for dry
        // grain) far faster than it diffuses isotropically — a berm sitting on
        // a steep dune face avalanches downhill rather than spreading evenly in
        // every direction. `auxTex` already carries the macro slope baked for
        // the ground material, so this reads an existing resident texture
        // rather than re-evaluating the landform noise.
        //
        // Implemented as a biased pull from the *uphill* neighbour rather than a
        // push downhill, so it composes with the isotropic diffusion above using
        // the same "sample and mix" shape instead of a separate advection kernel.
        let auxUV = (world - uniforms.worldOrigin) / uniforms.worldSize;
        let slope = textureSampleLevel(auxTex, auxTexSampler, auxUV, 0.0).xy;
        let slopeMag = length(slope);
        if (slopeMag > 0.12) {
            let uphill = slope / slopeMag;
            // Angle-of-repose gate: only steep faces avalanche, so a berm on
            // near-flat ground stays put and is not silently erased by this term.
            let steep = clamp((slopeMag - 0.12) * 2.2, 0.0, 1.0);
            let src = textureSampleLevel(prevTex, prevTexSampler, uv + uphill * (t * 2.0), 0.0);
            let kSlide = steep * min(0.5, 0.05 * k);
            berm = mix(berm, src.g, kSlide);
            dep = mix(dep, src.r, kSlide * 0.3);
        }

        // --- wind infill ----------------------------------------------------
        // Blowing sand fills the trench in from upwind, so pull a little of the
        // upwind neighbour's state across. Asymmetric on purpose: a trail
        // filling evenly from both sides looks like a blur, filling from one
        // side looks like weather. Wind-driven infill is a bigger part of dry
        // sand's identity than it was for snow's slower settling, so the rate
        // here runs well above SNOWFLOW's.
        let wdir = vec2f(sin(uniforms.windAngle), cos(uniforms.windAngle));
        let upwind = uv - wdir * (t * 1.6);
        let uw = textureSampleLevel(prevTex, prevTexSampler, upwind, 0.0);
        let kAdv = min(0.2, 0.006 * k);
        dep = mix(dep, uw.r, kAdv * 0.6);
        berm = mix(berm, uw.g, kAdv);

        // --- slump ----------------------------------------------------------
        // Piled mass falls back into the hole it came out of. Taking the min
        // keeps it mass-conserving and means an isolated berm with no adjacent
        // depression does not evaporate — it has to diffuse or avalanche away
        // instead. Granular sand has no cohesion to hold a berm at the lip of
        // its own pit, so this runs several times faster than snow's slump did.
        //
        // Per second, like the diffusion above.
        let slump = min(berm, dep) * min(0.6, 0.006 * uniforms.refillRate * dt);
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
        //
        // Sand's exponential decay here stands in for slow wind erosion and
        // reburial rather than snow settling, and gradual softening rather than
        // a "fresh snowfall" refill — there is no accumulation term, only decay,
        // diffusion, slump and advection, which together read as sand grains
        // being carried off and redistributed rather than a surface healing
        // itself. Depression and berm both erode faster than SNOWFLOW's snow
        // did; compaction — a packed trench floor or a footpath — persists
        // noticeably longer, matching how a compacted sand track actually
        // outlasts the loose grain thrown up around it.
        let r = uniforms.refillRate;
        dep *= exp(-dt * r / 260.0);
        berm *= exp(-dt * r / 150.0);
        comp *= exp(-dt * r / 480.0);
        // The sun-baked crust channel is meant to feel permanent within a
        // session — a spell (or feature) that cements the surface should not
        // visibly soften back to loose grain while the player watches it.
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
    // Depression bottoms out: below about half a metre you are on packed sand
    // and nothing more moves. Without this, standing still while surfing would
    // dig an unbounded pit.
    dep = clamp(dep, 0.0, uniforms.maxDepth);
    berm = clamp(berm, 0.0, uniforms.maxBerm);
    comp = clamp(comp, 0.0, 1.0);
    ice = clamp(ice, 0.0, 1.0);

    fragmentOutputs.color = vec4f(dep, berm, comp, ice);
}
