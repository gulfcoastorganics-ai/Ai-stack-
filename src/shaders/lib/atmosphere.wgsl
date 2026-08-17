// -----------------------------------------------------------------------------
// snowAtmosphere — sky model and aerial perspective.
//
// The sky is a Nishita single-scattering integration rather than an HDRI. The
// whole look hangs on a sun sitting 5-15 degrees above the horizon, and with an
// analytic model the sun angle is a slider that correctly drags the sky
// gradient, the horizon warmth and the ambient tint along with it. A captured
// HDRI locks all of that to whatever elevation the photographer had.
//
// It is expensive — 16 view steps by 8 light steps — so it is never evaluated
// per pixel per frame. It bakes into a cubemap at load, and again only when the
// sun actually moves.
//
// Aerial perspective at runtime is the cheap analytic half: height-falloff
// extinction plus an inscatter colour looked up from that same cubemap, which
// keeps distant snow tied to the sky it is sitting under.
// -----------------------------------------------------------------------------

const EARTH_R: f32 = 6360000.0;
const ATMOS_R: f32 = 6420000.0;
const H_RAYLEIGH: f32 = 8000.0;
const H_MIE: f32 = 1200.0;

// Sea-level scattering coefficients, per metre.
const BETA_R: vec3f = vec3f(5.8e-6, 13.5e-6, 33.1e-6);
const BETA_M: vec3f = vec3f(21e-6, 21e-6, 21e-6);
const MIE_G: f32 = 0.76;

/// Strength of the isotropic multiple-scattering approximation, relative to
/// single-scattered Rayleigh. Tuned so the diffuse sky irradiance lands near
/// 15% of direct-normal solar, which is where a real clear sky sits.
const MS_BOOST: f32 = 1.5;

/// Distance to the far intersection of a ray with a sphere centred on the
/// origin. Returns -1 when the ray misses.
fn raySphereFar(origin: vec3f, dir: vec3f, radius: f32) -> f32 {
    let b = dot(origin, dir);
    let c = dot(origin, origin) - radius * radius;
    let d = b * b - c;
    if (d < 0.0) { return -1.0; }
    return -b + sqrt(d);
}

fn phaseRayleigh(mu: f32) -> f32 {
    return (3.0 / (16.0 * PI)) * (1.0 + mu * mu);
}

fn phaseMie(mu: f32, g: f32) -> f32 {
    let g2 = g * g;
    let n = (1.0 - g2) * (1.0 + mu * mu);
    let d = (2.0 + g2) * pow(1.0 + g2 - 2.0 * g * mu, 1.5);
    return (3.0 / (8.0 * PI)) * n / d;
}

/// Full single-scattering sky radiance for a view direction.
/// `sunDir` points *toward* the sun. Result is linear, unnormalised radiance.
fn nishitaSky(rayDir: vec3f, sunDir: vec3f, sunIntensity: f32, groundBounce: vec3f) -> vec3f {
    // Stand just above the surface so the horizon resolves cleanly.
    let origin = vec3f(0.0, EARTH_R + 800.0, 0.0);

    let atmosDist = raySphereFar(origin, rayDir, ATMOS_R);
    if (atmosDist < 0.0) { return vec3f(0.0); }

    // Rays heading into the planet are clipped at the surface, which is what
    // produces the dark, dense band right below the horizon.
    let groundDist = raySphereFar(origin, rayDir, EARTH_R);
    let bIn = dot(origin, rayDir);
    let cIn = dot(origin, origin) - EARTH_R * EARTH_R;
    let discr = bIn * bIn - cIn;
    var march = atmosDist;
    if (discr > 0.0) {
        let near = -bIn - sqrt(discr);
        if (near > 0.0) { march = near; }
    }

    const STEPS: i32 = 32;
    const LIGHT_STEPS: i32 = 8;

    // View samples are distributed by a power law, not uniformly, and this is the
    // single most important line in the integral.
    //
    // Density falls off exponentially with height, so almost all of the
    // scattering along any ray happens in the first few kilometres. A uniform
    // march does not know that, and near the horizon it fails outright: a ray at
    // zero elevation travels roughly 450 km before it leaves the atmosphere, so
    // sixteen even steps put the *first* sample 14 km out and 15 km up — past
    // essentially all of the air that matters. The model then under-integrates
    // exactly the direction it is sampled hardest in, and the LUT dives by more
    // than a stop in the last three degrees before the horizon and jumps back up
    // below it, where the snow bounce takes over. A one-stop dark notch, one to
    // two degrees wide, wrapped around the whole horizon.
    //
    // Measured off a readback of the LUT along the anti-sun azimuth: 1.86 at
    // +3.5 degrees, 0.84 at 0, 1.29 at -0.5. Nothing downstream can fix that,
    // because it is a hole in the source data — and it was invisible for as long
    // as nothing sampled it, which stopped being true when the aerial perspective
    // started converging the far field onto the sky in its own direction.
    //
    // `t^2.5` puts the first of thirty-two samples 60 m out on that same grazing
    // ray and still reaches the top of the atmosphere. Steps are integrated over
    // their true width rather than a constant, so the quadrature stays correct.
    const DIST_POWER: f32 = 2.5;

    let mu = dot(rayDir, sunDir);
    let pr = phaseRayleigh(mu);
    let pm = phaseMie(mu, MIE_G);

    var sumR = vec3f(0.0);
    var sumM = vec3f(0.0);
    /// The same two sums, over the samples that have no *direct* view of the sun.
    /// See the note where they are spent, below the loop.
    var shadR = vec3f(0.0);
    var shadM = vec3f(0.0);
    var odR = 0.0; // accumulated optical depth along the view ray
    var odM = 0.0;

    var tPrev = 0.0;
    for (var i = 0; i < STEPS; i++) {
        let tNext = march * pow(f32(i + 1) / f32(STEPS), DIST_POWER);
        let stepLen = tNext - tPrev;
        let p = origin + rayDir * (tPrev + stepLen * 0.5);
        tPrev = tNext;
        let h = length(p) - EARTH_R;

        let dR = exp(-h / H_RAYLEIGH) * stepLen;
        let dM = exp(-h / H_MIE) * stepLen;
        odR += dR;
        odM += dM;

        // Optical depth from this sample toward the sun.
        let lightDist = raySphereFar(p, sunDir, ATMOS_R);
        let lStep = lightDist / f32(LIGHT_STEPS);
        var lR = 0.0;
        var lM = 0.0;
        var occluded = false;

        for (var j = 0; j < LIGHT_STEPS; j++) {
            let lp = p + sunDir * (lStep * (f32(j) + 0.5));
            let lh = length(lp) - EARTH_R;
            if (lh < 0.0) { occluded = true; break; }
            lR += exp(-lh / H_RAYLEIGH) * lStep;
            lM += exp(-lh / H_MIE) * lStep;
        }

        if (occluded) {
            // Not thrown away. This sample sits in the planet's own shadow, so
            // it receives no direct sun — but it is still inside a lit
            // atmosphere, and multiply-scattered light reaches it. Attenuate
            // along the *view* path only and keep it for the isotropic pass.
            let attenV = exp(-(BETA_R * odR + BETA_M * 1.1 * odM));
            shadR += attenV * dR;
            shadM += attenV * dM;
            continue;
        }

        let tau = BETA_R * (odR + lR) + BETA_M * 1.1 * (odM + lM);
        let atten = exp(-tau);
        sumR += atten * dR;
        sumM += atten * dM;
    }

    var col = sunIntensity * (sumR * BETA_R * pr + sumM * BETA_M * pm);

    // --- multiple scattering ------------------------------------------------
    // Single scattering alone underestimates a clear sky by roughly a factor of
    // three, and it underestimates blue the most, because a blue photon is the
    // one most likely to scatter again rather than to be absorbed. Left
    // uncorrected the sky is too dim to fill shadows, the warm ground bounce
    // wins the ambient, and snow shadows come out beige instead of blue — which
    // is the opposite of the whole look.
    //
    // Approximated as an extra isotropic pass over the same optical depths.
    // Cheap, stable, and it puts the sun/sky ratio in the right place.
    //
    // The shadowed samples enter *here* and nowhere else, and leaving them out
    // entirely is what drew a dark band across the sky a degree or two above the
    // horizon on the anti-sun side. At a 13-degree sun most of a grazing path in
    // that direction lies in the planet's own shadow, so most of its samples took
    // the early-out, single scattering had almost nothing left to integrate, and
    // the model produced a stripe — brown once the grazing desaturation had had
    // its say. Real skies do darken there (it is the base of the Earth's shadow)
    // but they darken *smoothly*, because multiple scattering fills the shadow in
    // from the lit air all around it. Half weight: it is scattered light arriving
    // indirectly, not a second sun.
    //
    // It stayed hidden as long as nothing sampled that band. The aerial
    // perspective now converges distant surfaces onto the sky in their own
    // direction — which is the only convergence that lets them dissolve — so the
    // band became the colour the whole far field was dissolving into.
    const SHADOW_FILL: f32 = 0.5;
    let msPhase = 1.0 / (4.0 * PI);
    col += sunIntensity * (
              (sumR + shadR * SHADOW_FILL) * BETA_R * MS_BOOST
            + (sumM + shadM * SHADOW_FILL) * BETA_M * 0.4
          ) * msPhase;

    // Below the horizon the "sky" is snow. `groundBounce` is the radiance
    // leaving that snow, computed on the CPU by iterating the bounce against
    // this very LUT until it converges.
    //
    // This is not a detail. Snow reflects ~85% of what lands on it, so in a
    // snow field the ground is one of the brightest sources in the scene, and
    // it is what fills shadows with bright blue-white light instead of leaving
    // them black. Omitting it — as a naive sky model does — is precisely why
    // untuned snow renders come out with dead, crushed shadows.
    //
    // The handover has to be *fast* — one and a half degrees either side of
    // where the clip actually begins. Run it any wider and the band below the
    // horizon holds mostly the clipped march, which is dark for an artefactual
    // reason: a ray angled into the planet is cut short, accumulates almost no
    // single scattering, and single scattering is all this integral has. That
    // leaves a dark stripe in the LUT exactly where the ground meets the sky,
    // and distant surfaces converge on the sky in their own direction, so they
    // would land on it.
    //
    // Which is also the physically sensible answer for this scene. What is down
    // there is a hundred kilometres of snow: bright, pale, and — at that path
    // length — indistinguishable from the haze above it.
    if (discr > 0.0 && groundDist > 0.0) {
        // Ascending edges: smoothstep is undefined when edge0 > edge1.
        let downT = 1.0 - smoothstep(-0.030, -0.005, rayDir.y);
        col = mix(col, groundBounce, downT);
    }

    // --- the optically thick horizon ---------------------------------------
    // A horizontal path through the atmosphere is hundreds of kilometres long,
    // and single scattering treats that as a coloured filter: blue is
    // extinguished outright, green mostly, and what is left is a saturated olive
    // band sitting between the blue dome and the warm sun. No real sky does that.
    // A path that thick is not a filter, it is fog — high-order scattering inside
    // it drives the result toward the achromatic, which is why a real hazy
    // horizon is pale rather than coloured. The single isotropic pass above is
    // nowhere near enough to model that at grazing angles.
    //
    // So the last dozen degrees are pulled toward their own luminance. It is the
    // cheapest possible stand-in for high-order scattering, and it removes the
    // green band outright — the one artefact of this sky model that reads as
    // wrong rather than as stylised, and the reason the whole far field was
    // inheriting a yellow cast through the aerial perspective.
    //
    // The sun's own warmth is untouched: the solar disc, the aureole and the
    // forward-scatter lobe are all added *after* this LUT, in the sky material
    // and in `applyAerial`.
    //
    // Widened and strengthened from 0.20 / 0.62 once the aerial perspective
    // started converging distant surfaces onto this band rather than onto the
    // cool dome above it. The residual warmth it left was invisible while it was
    // a thin strip mostly hidden behind terrain; with the far field dissolving
    // *into* it, it became a tan wash across a quarter of the frame, on the side
    // of the sky facing away from the sun. Pale, very slightly cool — which is
    // what a real hazy horizon is when you are not looking at the sun, and the
    // warm case is added back afterwards by the forward lobe.
    let grazing = 1.0 - smoothstep(0.0, 0.26, abs(rayDir.y));
    let pale = dot(col, vec3f(0.30, 0.42, 0.28));
    col = mix(col, vec3f(pale) * vec3f(0.97, 1.0, 1.06), grazing * 0.82);

    return col;
}

// ------------------------------------------------------- lat-long projection

// The sky is stored as an equirectangular 2D LUT rather than a cubemap. A cube
// would be six render targets, six readbacks and seam handling, to buy accuracy
// at the poles that a sky gradient does not have and cannot use.

fn dirToLatLong(d: vec3f) -> vec2f {
    let u = atan2(d.x, d.z) / (2.0 * PI) + 0.5;
    let v = acos(clamp(d.y, -1.0, 1.0)) / PI;
    return vec2f(u, v);
}

fn latLongToDir(uv: vec2f) -> vec3f {
    let phi = (uv.x - 0.5) * 2.0 * PI;
    let theta = uv.y * PI;
    let st = sin(theta);
    return vec3f(st * sin(phi), cos(theta), st * cos(phi));
}

// ------------------------------------------------------------------- runtime

/// Height-falloff extinction. Returns transmittance 0..1.
/// Integrates exp(-k*y) analytically along the segment, so fog thins with
/// altitude the way real haze does instead of sitting in a flat slab.
fn aerialTransmittance(
    camPos: vec3f,
    worldPos: vec3f,
    density: f32,
    heightFalloff: f32,
    fogStart: f32
) -> f32 {
    let d = worldPos - camPos;
    let dist = max(0.0, length(d) - fogStart);
    if (dist <= 0.0) { return 1.0; }

    let dy = d.y;
    var integral: f32;
    if (abs(dy) < 0.01) {
        integral = exp(-heightFalloff * camPos.y) * dist;
    } else {
        // ∫ exp(-k*y(t)) dt along the ray, closed form.
        let k = heightFalloff;
        integral = (exp(-k * camPos.y) - exp(-k * worldPos.y)) / (k * dy) * length(d);
        integral = integral * (dist / max(1e-4, length(d)));
    }

    return exp(-density * max(0.0, integral));
}

/// The colour that fills a *short*, ground-level path.
///
/// Not the sky's radiance in the view direction. The horizon band of this sky is
/// the colour of a hundred-kilometre path — by the time light has travelled that
/// far the blue end is gone entirely. Borrowing it as the inscatter colour for
/// three hundred metres of haze paints the middle distance with a sunset it is
/// three orders of magnitude too short to have earned, and the whole far field
/// goes yellow.
///
/// What actually fills a short path is the whole sky hemisphere, and that is
/// dominated by the bright cool dome overhead rather than by the band at eye
/// level. So the lookup is tilted upward and read from a blurred mip. The sun's
/// forward lobe is added separately by `applyAerial`, which is what keeps haze
/// warm where you are looking toward the sun — the one place it should be.
fn aerialNearSky(tex: texture_2d<f32>, samp: sampler, viewDir: vec3f) -> vec3f {
    let d = normalize(viewDir + vec3f(0.0, 0.42, 0.0));
    return textureSampleLevel(tex, samp, dirToLatLong(d), 3.0).rgb;
}

/// The inscatter colour for a path of a given total extinction.
///
/// This is the whole of the horizon, and both halves of it were wrong in turn.
///
/// The short-path answer above is right up close and wrong in the limit. A
/// surface at total extinction is *invisible*: by definition what reaches the eye
/// from it is the sky in that exact direction — the sky that would be there if
/// the surface were not. Converge on anything else and the ground never dissolves
/// however much haze is piled on it; it bottoms out at a colour the sky above it
/// does not share, and the far edge of the clipmap draws as a hard silhouette at
/// a fixed radius from the player, with the mountain range apparently standing on
/// it. No fog density removes that, because the two ends of the ramp are
/// different colours.
///
/// The first attempt at this crossfaded the two *lookups* and left the
/// forward-scatter lobe added on top at full strength, and that turned the shelf
/// into a wall: a saturated bank of haze, hard-topped, brighter and warmer than
/// the sky above it and the ground below it, with the mountains sticking out of
/// it like rocks out of surf. The lobe is the reason. It is a short-path
/// correction — it stands in for sunlight scattered into the first few hundred
/// metres, which the LUT's directional radiance cannot describe at that range —
/// but over kilometres the LUT *is* that integral, aureole and all, so adding the
/// lobe as well double-counts it. Away from the sun that is worth a fifth of the
/// sky's own radiance; toward it, at a Mie `g` of 0.62, the phase function is
/// nearly two orders of magnitude larger and the band goes to flat white.
///
/// So the whole inscatter — lobe included — is crossfaded onto the exact sky
/// sample, at the exact mip the sky material itself draws with. At full
/// extinction a hazed surface and the sky pixel beside it are then the same
/// number, and there is nothing left to draw an edge.
fn aerialInscatterSky(
    tex: texture_2d<f32>, samp: sampler, viewDir: vec3f,
    sunDir: vec3f, sunColor: vec3f, ext: f32
) -> vec3f {
    // Mip 0 and no tilt: this has to match `sky.fragment.wgsl`'s own lookup
    // exactly, or "fully hazed" and "sky" are two different colours again.
    let exact = textureSampleLevel(tex, samp, dirToLatLong(normalize(viewDir)), 0.0).rgb;

    let mu = dot(viewDir, sunDir);
    let fwd = phaseMie(mu, 0.62) * 5.5;
    let near = aerialNearSky(tex, samp, viewDir) + sunColor * fwd * 0.16;

    // Ramps across roughly 100 m to 700 m on the current fog settings: the near
    // field keeps the cool dome and the warm sun-facing haze it is tuned for, and
    // everything past the middle distance is already on its way to the sky.
    return mix(near, exact, smoothstep(0.55, 0.995, ext));
}

/// Fold aerial perspective into a shaded colour.
///
/// Distance does three things at once in the references, and all three matter:
/// contrast compresses, hue pulls toward the sky, and the sun direction picks up
/// a forward-scatter bloom. Extinction alone only does the first.
///
/// The sky LUT is passed in rather than a pre-sampled colour, because the right
/// inscatter colour depends on the extinction this function computes — see
/// `aerialInscatterSky`. Seven materials call this, and the previous signature
/// let every one of them decide for itself what "the sky here" meant.
fn applyAerial(
    color: vec3f,
    camPos: vec3f,
    worldPos: vec3f,
    viewDir: vec3f,
    sunDir: vec3f,
    skyTex: texture_2d<f32>,
    skySamp: sampler,
    sunColor: vec3f,
    density: f32,
    heightFalloff: f32,
    fogStart: f32,
    strength: f32
) -> vec3f {
    let t = aerialTransmittance(camPos, worldPos, density, heightFalloff, fogStart);
    let ext = clamp(1.0 - pow(t, strength), 0.0, 1.0);
    let inscatter = aerialInscatterSky(skyTex, skySamp, viewDir, sunDir, sunColor, ext);
    return mix(color, inscatter, ext);
}
