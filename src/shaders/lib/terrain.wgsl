// -----------------------------------------------------------------------------
// snowTerrain — the landform.
//
// SANDSTORM Phase 4: the macro landform is now a purpose-built desert dune
// generator rather than SNOWFLOW's dune-*shaped* snow field. Phases 1-3 left
// this file's `terrainMacro` numerically close to SNOWFLOW's — this phase is
// the one that actually rewrites it. Everything else about the split below is
// unchanged:
//
//   terrainMacro()  broad dunes + medium drifts. Tens of metres down to about a
//                   metre. Baked once into a texture at load, because the CPU
//                   needs the same data for character grounding and reading back
//                   a bake is the only way to guarantee the two agree exactly.
//                   `terrainMacro`'s *own* gradient is never consumed directly —
//                   `terrainMacroD` below is dead code kept only as a diffing
//                   aid, and the aux bake differentiates the baked texture
//                   itself (see `auxBake.fragment.wgsl`) — so this function is
//                   free to be arbitrarily shaped without maintaining an exact
//                   analytic gradient through it. That bake-time cost is also
//                   the *only* place this phase is allowed to spend more than
//                   SNOWFLOW did: it runs once at load, never per frame.
//
//   terrainFine()   wind ripples and grain, decimetre and below. Evaluated live
//                   in the vertex and fragment shaders with exact analytic
//                   derivatives — far too fine to bake at any sane texture
//                   resolution, and cheap enough not to bother. Untouched this
//                   phase: real-time cost, so it stays exactly as tuned.
//
// Everything is anisotropic about a single prevailing wind direction. Dune
// terrain, unlike a bumpy noise field, is *built* by wind, and asymmetry along
// that one direction is what a heightfield alone can use to say so: broad
// dune bodies run transverse to the wind, their long windward (stoss) faces
// climb gently in the direction the wind blows from, and their short lee
// faces drop steeply — close to the natural angle of repose for dry sand —
// on the far side, in the direction the wind blows toward.
// -----------------------------------------------------------------------------

/// Build the combined rotate-and-anisotropically-scale matrix for a noise layer.
/// `sx` stretches along the wind, `sy` across it; `scale` is the wavelength.
/// A layer's derivative maps back to world space with `dHdq * M`.
fn windMat(angle: f32, sx: f32, sy: f32, scale: f32) -> mat2x2f {
    let c = cos(angle);
    let s = sin(angle);
    let r = mat2x2f(c, -s, s, c);
    let d = mat2x2f(sx / scale, 0.0, 0.0, sy / scale);
    return d * r;
}

// ------------------------------------------------------------------- macro

/// Asymmetric dune cross-section. `t` must already be in [0,1] — this function
/// is undefined outside that range, and callers are responsible for either
/// wrapping it (`fract()`, for a periodic ridge line) or gating it (for a
/// standalone bump like a single barchan) as appropriate.
///
/// Rises as a gentle, concave stoss (windward) slope from t=0 to t=`stossFrac`,
/// then falls in a straight line — constant grade, the angle of repose — from
/// the crest at t=`stossFrac` down to the trough at t=1. There are exactly two
/// slope kinks in that span, at the crest and at the trough, and both are
/// deliberate: a real dune has a genuine crest line and a genuine flat-ish
/// trough floor, not a smoothly rounded sine wave. Both kinks are also
/// perfectly *finite* — nothing here is a discontinuity in value, only in
/// slope, and the lee side's slope is a plain constant with no pow() or
/// division anywhere near a singularity. `stossFrac` is clamped well inside
/// (0,1) so neither branch's denominator can approach zero.
fn duneShape01(t: f32, stossFrac: f32) -> f32 {
    let sf = clamp(stossFrac, 0.15, 0.92);
    if (t < sf) {
        let u = clamp(t / sf, 0.0, 1.0);
        return pow(u, 1.5);
    }
    let u = clamp((t - sf) / (1.0 - sf), 0.0, 1.0);
    return 1.0 - u;
}

/// Regional dune-field intensity, 0..1, shared by every consumer that needs to
/// know "how dense is the dune field here" — the ridge amplitude and size
/// below, the barchan placement band, the interdune texture strength, and (via
/// `heightBake.fragment.wgsl`) the rock-placement bias. One function so all of
/// them agree on what "dense dune country" means at a given point.
///
/// Slow, warped noise pushed through a fairly hard smoothstep, so the field
/// resolves into a handful of *zones* — open interdune flats, a transitional
/// band, dense dune country — rather than a smooth gradient scaling everything
/// uniformly everywhere. That zoning is most of what stops the result reading
/// as "noise with a dune material on it": large stretches of the field are
/// deliberately much quieter than others.
///
/// `macroVar` is the art-directed control: at 0 every consumer sees a flat 0.55
/// (one uniform mid-density field, close to SNOWFLOW's original "one noise
/// field everywhere" character); at 1, full regional contrast.
fn terrainRegionMask(p: vec2f, w: f32, macroVar: f32) -> f32 {
    let m = windMat(w, 1.3, 1.0, 640.0);
    let n = fbmd(m * p + vec2f(91.0, -47.0), 3, 2.15, 0.55).x;
    let raw = clamp(smoothstep(-0.30, 0.42, n), 0.0, 1.0);
    return mix(0.55, raw, clamp(macroVar, 0.0, 1.0));
}

/// Broad landscape swell — the 100-500 m+ roll that keeps the horizon from
/// reading as one dune wavelength repeated to the edge of the world. Always
/// present, everywhere, regardless of `terrainRegionMask` — a real desert's
/// underlying terrain rises and falls at this scale independent of where the
/// active dune fields happen to sit on top of it.
fn terrainSwell(p: vec2f, w: f32) -> f32 {
    let m0 = windMat(w, 1.3, 1.0, 260.0);
    return fbmDamped(m0 * p, 3, 2.11, 0.55, 0.28).x;
}

/// The dune bodies proper — meso-scale transverse ridges, self-similarly sized
/// so a taller dune is also a wider one, the way real dunes are: the lee slope
/// cannot exceed the angle of repose regardless of how tall the dune is, so
/// amplitude and wavelength are solved together from the *target lee angle*
/// rather than picked independently. This is also what spreads the field's
/// relief across the whole 1-40 m target range from one continuous function
/// instead of needing a separate "small drift" tier: quiet, low-mask regions
/// naturally resolve to short, low ripples and dense, high-mask regions
/// naturally resolve to tall, wide dunes.
///
/// Everything that stops this reading as rotated Perlin noise lives here:
///
///   * the cross-section is `duneShape01`, not a symmetric wave — the stoss
///     run is the majority of the wavelength and the lee drop is short and
///     near-linear, so every ridge has a genuine slip face;
///   * the ridge line is warped across the wind by a slow noise field, so it
///     meanders and locally curves rather than running as a dead-straight
///     corduroy stripe;
///   * wavelength, stoss fraction and local amplitude all vary with slow
///     secondary noise, so no two ridges are quite the same shape;
///   * a `continuity` field lets amplitude sag toward a fraction of itself in
///     patches, so ridge lines read as locally interrupted rather than as one
///     unbroken line running the width of the field;
///   * a second, higher-frequency copy at roughly a third of the wavelength
///     rides on top wherever the field is dense — compound dunes, smaller
///     forms superimposed on larger ones, which is what a real dense dune
///     field looks like rather than one clean wavelength.
///
/// `leeSteep` is the target tangent of the lee slope angle (0.64 ≈ 32.6
/// degrees, close to dry sand's natural angle of repose). The `0.82` factor
/// keeps the realised slope safely under that target rather than exactly at
/// it, so the face reads as steep sand rather than a knife-edge — see
/// `duneShape01`'s own note on why that matters for shading stability too.
fn duneRidges(p: vec2f, w: f32, mask: f32, duneScale: f32, leeSteep: f32) -> f32 {
    let wdir = vec2f(sin(w), cos(w));
    let wperp = vec2f(wdir.y, -wdir.x);
    let along0 = dot(p, wdir);
    let across0 = dot(p, wperp);

    let regionN = noise2(p * 0.0011 + vec2f(14.0, 61.0)) * 0.5 + 0.5;
    let wob = noise2(p * 0.0016 - vec2f(9.0, 33.0));

    // Self-similar sizing: biased toward the dense end of the field by `mask`,
    // with region-to-region variety from `regionN` layered on top so a single
    // zone is not just one dune size either.
    let sizeT = clamp(mix(0.15, 0.95, mask) + (regionN - 0.5) * 0.25, 0.0, 1.0);
    let wavelength = max(duneScale * mix(0.30, 3.0, sizeT), 4.0);

    // Meander: the single biggest difference between "wind-carved ridge" and
    // "sine wave". Scaled to the local wavelength so small dunes meander over
    // small distances and large ones over large distances.
    let meander = noise2(vec2f(across0 * (3.2 / wavelength), regionN * 41.0)) * wavelength * 0.85;

    let sfLocal = clamp(0.60 + (wob - 0.5) * 0.18, 0.45, 0.85);
    let leeRun = wavelength * (1.0 - sfLocal);
    let amp1 = clamp(leeSteep * leeRun * 0.82, 0.0, 55.0);

    let phase = (along0 + meander) / wavelength;
    var h1 = duneShape01(fract(phase), sfLocal);

    // Local ridge-line interruption: amplitude sags toward 35% of itself in
    // patches at a scale a few times the dune wavelength, so a ridge reads as
    // a chain of dune bodies rather than one unbroken wall.
    let continuity = smoothstep(-0.15, 0.35, noise2(vec2f(along0, across0) * (1.0 / (wavelength * 2.6)) + vec2f(7.0, 3.0)));
    h1 *= mix(0.35, 1.0, continuity);

    // Compound dune: a smaller form riding the first, only where the field is
    // dense enough for one to have grown on the flank of another.
    let wavelength2 = max(wavelength * 0.38, 3.0);
    let sf2 = clamp(sfLocal - 0.05, 0.45, 0.85);
    let leeRun2 = wavelength2 * (1.0 - sf2);
    let amp2 = clamp(leeSteep * leeRun2 * 0.82, 0.0, 25.0);
    let phase2 = (along0 + meander * 0.5 + across0 * 0.12) / wavelength2 + 0.31;
    let h2 = duneShape01(fract(phase2), sf2);

    // Both dampened toward the open, quiet end of the field so an interdune
    // flat is genuinely quiet rather than merely a smaller copy of the dunes
    // beside it — this is where "shallow interdune basin" comes from.
    let openDamp = mix(0.22, 1.0, mask);
    return (h1 * amp1 + h2 * amp2 * 0.55 * mask) * openDamp;
}

/// Sparse barchan-like crescent dunes. Real barchans form where sand supply is
/// limited — the margins of a dune field, not its dense core — so instances
/// are weighted into the transitional band of `terrainRegionMask`, tapering
/// off in the open flats (nothing to build a dune from) and deep in dense
/// ridge country (a lone crescent there would just be swallowed by the
/// surrounding ridges).
///
/// Same jittered-cell technique `rockField` below uses, styled the same way
/// deliberately: one candidate per cell, most culled, so instances read as
/// individually placed rather than as a repeating tile. Each instance's shape
/// still comes from `duneShape01` — the crescent is that same asymmetric
/// stoss/lee profile along its own long axis, with the two ends ("horns")
/// swept downwind and tapered by how far off that axis they sit.
fn barchanField(p: vec2f, w: f32, mask: f32) -> f32 {
    let band = clamp(1.0 - abs(mask - 0.42) / 0.30, 0.0, 1.0);
    if (band <= 0.001) { return 0.0; }

    let wdir = vec2f(sin(w), cos(w));
    let wperp = vec2f(wdir.y, -wdir.x);

    let cell = 130.0;
    let gi = floor(p / cell);
    var h = 0.0;

    for (var dy = -1; dy <= 1; dy++) {
        for (var dx = -1; dx <= 1; dx++) {
            let id = gi + vec2f(f32(dx), f32(dy));
            let r = hash22(id);
            let r2 = hash22(id + vec2f(53.1, 17.7));

            // Sparse: most cells carry no barchan at all.
            if (r2.x > 0.20) { continue; }

            let centre = (id + 0.2 + r * 0.6) * cell;
            let rel = p - centre;
            let along = dot(rel, wdir);
            let across = dot(rel, wperp);

            let half = 16.0 + r2.y * 26.0;   // 16-42 m half-length: variety
            let curl = 0.5 + r.y * 1.0;      // horn sweep: variety
            let sf = 0.55 + r.x * 0.22;      // stoss fraction: variety

            let ay = across / max(half * 0.60, 1.0);
            if (abs(ay) > 1.4) { continue; }

            // The horns trail downwind further the closer to the tip — the
            // centre of the crescent leads, the two ends lag behind it, which
            // is the entire visual signature of a barchan in plan view.
            let hornShift = curl * ay * ay * half * 0.6;
            let t = (along - hornShift) / max(half * 1.55, 1.0) + 0.5;
            if (t < 0.0 || t > 1.0) { continue; }

            let taper = 1.0 - smoothstep(0.55, 1.4, abs(ay));
            let height = (3.0 + r2.x * 8.0) * band;
            h += duneShape01(t, sf) * taper * taper * height;
        }
    }
    return h;
}

/// Subtle relief in the quiet ground between dune systems — believable
/// "flatter" rather than literally flat: shallow wind ripples and small
/// accumulated drifts that never organise into a ridge because there is not
/// enough sand supply here for one. Strongest where `terrainRegionMask` is
/// low; nearly absent under the dune bodies themselves, where the ridge
/// relief already dominates and this would just add noise on top of it.
fn interduneTexture(p: vec2f, w: f32, mask: f32) -> f32 {
    let m = windMat(w, 1.6, 1.0, 9.0);
    let n = fbmDamped(m * p, 3, 2.06, 0.5, 1.4).x;
    return n * mix(1.0, 0.25, mask);
}

/// The full macro landform, metres. `w` is the wind bearing in radians, `amp`
/// a global height multiplier (SNOWFLOW's original `macroHeightScale`
/// control, unchanged in meaning). `duneScale`, `leeSteep` and `macroVar` are
/// the new SANDSTORM art controls — see `settings.js` for their defaults and
/// ranges.
fn terrainMacro(p: vec2f, w: f32, amp: f32, duneScale: f32, leeSteep: f32, macroVar: f32) -> f32 {
    let mask = terrainRegionMask(p, w, macroVar);

    var h = terrainSwell(p, w) * 22.0;
    h += duneRidges(p, w, mask, max(duneScale, 4.0), leeSteep);
    h += barchanField(p, w, mask) * mix(0.3, 1.0, clamp(macroVar, 0.0, 1.0));
    h += interduneTexture(p, w, mask) * 1.6;

    return h * amp;
}

/// Finite-difference macro gradient. Dead code on the render path — the aux
/// bake differentiates the *baked* height texture instead, exactly as
/// SNOWFLOW's did (see `auxBake.fragment.wgsl`) — kept only as a diffing aid
/// for comparing against that bake by hand. Updated to the new signature so it
/// still compiles; not otherwise exercised.
fn terrainMacroD(p: vec2f, w: f32, amp: f32, duneScale: f32, leeSteep: f32, macroVar: f32) -> vec2f {
    let e = 0.35;
    let hx = terrainMacro(p + vec2f(e, 0.0), w, amp, duneScale, leeSteep, macroVar)
           - terrainMacro(p - vec2f(e, 0.0), w, amp, duneScale, leeSteep, macroVar);
    let hz = terrainMacro(p + vec2f(0.0, e), w, amp, duneScale, leeSteep, macroVar)
           - terrainMacro(p - vec2f(0.0, e), w, amp, duneScale, leeSteep, macroVar);
    return vec2f(hx, hz) / (2.0 * e);
}

// -------------------------------------------------------------------- rocks

/// Sparse exposed rock. Jittered grid, one outcrop per cell, most of them
/// culled so the field stays mostly open sand.
///
/// SANDSTORM: placement is now biased by `mask` (the same `terrainRegionMask`
/// the dune bodies read) rather than uniformly random — real desert rock
/// exposure is a margin phenomenon: common on the open, wind-scoured flats
/// between dune systems and on the shallow edges of a dune field where
/// bedrock shows through, rare once the dune field is dense enough to bury
/// everything under actively moving sand. `hgt` is reduced the same way, so
/// what little rock survives inside dense dune country reads as a low,
/// half-buried remnant rather than a full outcrop.
/// Returns vec2f(height contribution, rock mask 0..1).
fn rockField(p: vec2f, w: f32, mask: f32) -> vec2f {
    let cell = 165.0;
    let gi = floor(p / cell);

    var hSum = 0.0;
    var rmask = 0.0;

    let cullT = mix(0.30, 0.07, mask);

    // 3x3 neighbourhood so blobs straddle cell borders cleanly.
    for (var dy = -1; dy <= 1; dy++) {
        for (var dx = -1; dx <= 1; dx++) {
            let id = gi + vec2f(f32(dx), f32(dy));
            let r = hash22(id);
            let r2 = hash22(id + 71.3);

            // Cull most cells: outcrops are meant to be sparse.
            if (r2.x > cullT) { continue; }

            let centre = (id + 0.15 + r * 0.7) * cell;
            let radius = 7.0 + r2.y * 11.0;
            let d = length(p - centre);
            if (d > radius * 1.6) { continue; }

            // Smooth dome, then broken up by ridged noise so it reads as rock
            // rather than as a lump. The noise rides the dome so it never
            // detaches from the silhouette.
            let t = clamp(1.0 - d / radius, 0.0, 1.0);
            let dome = t * t * (3.0 - 2.0 * t);
            let mr = windMat(w, 1.0, 1.0, 5.5);
            let rough = ridgedd(mr * (p - centre), 3, 2.17, 0.55).x;
            let hgt = (3.5 + r2.y * 6.0) * mix(1.0, 0.4, mask);

            hSum += dome * hgt * (0.62 + 0.55 * rough);
            rmask = max(rmask, dome * dome);
        }
    }
    return vec2f(hSum, rmask);
}

// --------------------------------------------------------------------- fine

/// Local departure of the wind from its prevailing bearing, in radians, and the
/// local anisotropy of the sastrugi.
///
/// One global bearing gives every ridge in the field the same direction and the
/// same aspect ratio, and the result reads as corduroy — a woven texture laid
/// over the landform rather than snow carved by weather. Real sastrugi does not
/// do that: the wind veers as it crosses a dune, so the field breaks into patches
/// that run at slightly different angles and are streakier in some places than
/// others. Two slow noise fields, at ~120 m and ~80 m, are enough to destroy the
/// uniformity completely while leaving the prevailing direction obvious.
///
/// Both fine layers below read this, and so does the *filtered* twin further
/// down, which must produce the same surface — one is the vertex displacement and
/// the other is the fragment normal.
///
/// The layer derivatives ignore the chain-rule term from the veer varying with
/// position. The veer field's wavelength is fifty times the sastrugi's, so that
/// term is a couple of percent of a normal — well under what the detail maps
/// perturb it by anyway.
fn windLocal(p: vec2f) -> vec2f {
    let veer = noise2(p * 0.0083 + vec2f(31.7, 12.3)) * 0.42;
    let stretch = 2.3 + 2.4 * (noise2(p * 0.0126 + vec2f(7.1, 41.9)) * 0.5 + 0.5);
    return vec2f(veer, stretch);
}

/// Sastrugi + ripples. Returns vec3f(height in metres, dH/dx, dH/dz).
///
/// `exposure` (0..1) comes from the baked curvature channel: wind scours crests
/// into hard sastrugi and leaves hollows smooth, so the two fine layers are
/// cross-faded by it rather than applied uniformly.
fn terrainFine(p: vec2f, w: f32, exposure: f32, amp: f32) -> vec3f {
    var h = 0.0;
    var d = vec2f(0.0);

    let wl = windLocal(p);

    // --- sastrugi ----------------------------------------------------------
    // Compressed *across* the wind, so the ridges streak along it. Ridged noise
    // gives the hard scalloped crest and soft trough that sastrugi actually has.
    let m3 = windMat(w + wl.x, 1.0, wl.y, 2.3);
    let sas = ridgedd(m3 * p, 3, 2.11, 0.52);
    let scour = 0.45 + 0.55 * smoothstep(-0.25, 0.35, noise2(p * 0.021));
    let sasAmp = 0.125 * amp * mix(0.45, 1.0, exposure) * scour;
    h += (sas.x - 0.35) * sasAmp;
    d += (sas.yz * m3) * sasAmp;

    // --- wind ripples ------------------------------------------------------
    // Fine transverse corrugation, strongest in the sheltered flats where
    // sastrugi is weak. Half a wavelength of asymmetry via a soft abs.
    //
    // Veered by half of what the sastrugi is: ripples form in the boundary layer
    // and follow the local flow more closely than the metre-scale forms do, but
    // giving them the same veer makes the two layers move together and the field
    // goes back to reading as one woven sheet.
    let m4 = windMat(w + wl.x * 0.5, 2.9, 1.0, 0.42);
    let rip = noised(m4 * p);
    let ripAmp = 0.024 * amp * mix(1.0, 0.45, exposure);
    h += rip.x * ripAmp;
    d += (rip.yz * m4) * ripAmp;

    // --- grain -------------------------------------------------------------
    // Sub-centimetre. Too small to displace geometry usefully, but it keeps the
    // normal field alive right under the camera.
    let m5 = windMat(w, 1.0, 1.0, 0.115);
    let gr = noised(m5 * p);
    let grAmp = 0.0075 * amp;
    h += gr.x * grAmp;
    d += (gr.yz * m5) * grAmp;

    return vec3f(h, d);
}

/// Footprint-filtered fine layer, for the fragment shader.
///
/// Each layer fades out once its wavelength drops near the size of a pixel.
/// Without this the sastrugi turns into a crawling moiré carpet across the
/// mid-distance the moment the camera moves — and unlike geometry aliasing, TAA
/// cannot rescue normal-map aliasing, because the signal is already wrong before
/// it is sampled. Fading is not a quality compromise here; it *is* the filter.
///
/// `fp` is the world-space size of one pixel, from fwidth() on world position.
fn terrainFineFiltered(p: vec2f, w: f32, exposure: f32, amp: f32, fp: f32) -> vec3f {
    var h = 0.0;
    var d = vec2f(0.0);

    // Sastrugi: wavelength ~2.3 m. Real sastrugi stands 10-30 cm proud with a
    // hard scalloped crest — it is a landform in its own right, not a texture,
    // and underscaling it is what leaves a snow field looking like poured icing.
    // Same local veer and anisotropy the vertex stage used. See `windLocal`.
    let wl = windLocal(p);

    let fadeS = 1.0 - smoothstep(0.35, 1.6, fp);
    if (fadeS > 0.001) {
        let m3 = windMat(w + wl.x, 1.0, wl.y, 2.3);
        let sas = ridgedd(m3 * p, 3, 2.11, 0.52);
        // Modulated by a slow field so the field has scoured patches and smooth
        // patches rather than one uniform corduroy everywhere — which is what
        // makes it read as woven fabric instead of as snow.
        // `scour`, not `patch` — the latter is a reserved keyword in WGSL.
        let scour = 0.45 + 0.55 * smoothstep(-0.25, 0.35, noise2(p * 0.021));
        let a = 0.125 * amp * mix(0.45, 1.0, exposure) * scour * fadeS;
        h += (sas.x - 0.35) * a;
        d += (sas.yz * m3) * a;
    }

    // Ripples: wavelength ~0.42 m.
    let fadeR = 1.0 - smoothstep(0.06, 0.3, fp);
    if (fadeR > 0.001) {
        let m4 = windMat(w + wl.x * 0.5, 2.9, 1.0, 0.42);
        let rip = noised(m4 * p);
        let a = 0.024 * amp * mix(1.0, 0.45, exposure) * fadeR;
        h += rip.x * a;
        d += (rip.yz * m4) * a;
    }

    // Grain: wavelength ~0.115 m.
    let fadeG = 1.0 - smoothstep(0.016, 0.08, fp);
    if (fadeG > 0.001) {
        let m5 = windMat(w, 1.0, 1.0, 0.115);
        let gr = noised(m5 * p);
        let a = 0.0075 * amp * fadeG;
        h += gr.x * a;
        d += (gr.yz * m5) * a;
    }

    return vec3f(h, d);
}
