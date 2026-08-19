// -----------------------------------------------------------------------------
// Fulgurite Garden — vitrified glass shading.
//
// SANDSTORM Phase 6: SNOWFLOW's ice-crystal material, retuned from a cold, blue,
// mirror-bright optic to a hot, amber, smoky one. The *structure* of the
// material — a transparent, path-tinted, facet-hard solid with a Fresnel skin —
// is exactly right for fused glass too, so none of that changed; every colour
// and every physical constant did.
//
//   near grazing   still nearly a mirror — real glass does this too — but the
//                  base reflectance and the highlight roughness both moved: a
//                  fulgurite's surface is not polished the way lake ice is.
//   head on        you see through it, bent, and tinted by the path — amber to
//                  smoky brown rather than blue, because this glass absorbs
//                  blue hardest rather than red.
//   backlit        it glows, hot amber rather than cool blue-white — the same
//                  internal-scatter mechanism ice used, wearing this ability's
//                  colour instead.
//   just formed    an extra term ice never had: a fast-fading hot white/amber
//                  flash right after each facet fuses (`vHeat`, from
//                  `crystals.js`), which is most of what sells "this just got
//                  blasted into being" rather than "this was always here."
//
// **Blended, but depth-writing.** Unchanged from SNOWFLOW — see the original
// reasoning: opaque loses the transparency, blended-without-depth smears forty
// overlapping formations into each other. Writing depth while blending is the
// only combination where a cluster this dense stays legible.
//
// The normal still comes from the derivatives of the world position, so every
// facet is exactly flat. That hard edge is what makes glass read as glass:
// adjacent facets return wildly different amounts of transmitted light, and that
// facet-to-facet jump is the material, independent of its colour.
// -----------------------------------------------------------------------------

#include<snowNoise>
#include<snowShading>
#include<snowSpellLights>
#include<snowAtmosphere>

varying vWorld: vec3f;
varying vBase: vec3f;
varying vHeight01: f32;
varying vSeed: f32;
varying vGrowth: f32;
varying vHeat: f32;
varying vViewDist: f32;

var skyLUT: texture_2d<f32>;
var skyLUTSampler: sampler;
var cascade0: texture_2d<f32>;
var cascade0Sampler: sampler;
var cascade1: texture_2d<f32>;
var cascade1Sampler: sampler;
var cascade2: texture_2d<f32>;
var cascade2Sampler: sampler;

uniform cameraPos: vec3f;
uniform sunDir: vec3f;
uniform sunRadiance: vec3f;
uniform shR: array<vec4f, 9>;

uniform cascadeMatrices: array<mat4x4f, 3>;
uniform cascadeSplits: vec4f;
uniform cascadeParams: array<vec4f, 3>;
uniform shadowTexel: f32;
uniform shadowSoftness: f32;
uniform shadowBias: f32;

uniform fogDensity: f32;
uniform fogHeightFalloff: f32;
uniform fogStart: f32;
uniform aerialStrength: f32;
uniform ambientIntensity: f32;
uniform sssStrength: f32;
uniform glintIntensity: f32;
uniform glintGrazing: f32;

uniform spellLightPos: array<vec4f, 4>;
uniform spellLightCol: array<vec4f, 4>;
uniform spellLightCount: f32;

#include<snowShadowLookup>

/// Absorption per metre. Amber/smoky glass absorbs blue hardest and red
/// least — the inverse emphasis from ice, which is most of what turns the
/// same optical construction into a completely different-reading material.
/// Strong enough that a hand-sized formation shows real colour without
/// needing glacier-scale thickness, tuned back from the point where the whole
/// cluster saturated to one flat brown.
const GLASS_ABSORB: vec3f = vec3f(0.55, 1.55, 3.35);

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    let world = input.vWorld;
    let V = normalize(uniforms.cameraPos - world);
    let L = uniforms.sunDir;

    // Flat facet normal, from the geometry itself.
    let dx = dpdx(world);
    let dy = dpdy(world);
    var N = normalize(cross(dx, dy));
    if (dot(N, V) < 0.0) { N = -N; }
    let geoN = N;

    let NdotV = clamp(dot(N, V), 1e-4, 1.0);
    let NdotL = dot(N, L);
    let noiseRot = ign(input.position.xy) * 6.28318530718;
    let shadow = sunShadow(world, geoN, input.vViewDist, noiseRot);

    let sun = uniforms.sunRadiance;
    const INV_PI: f32 = 0.31830988618;

    // ---- fused base -----------------------------------------------------------
    // Where the formation meets the ground it is not clear glass — it is fused
    // with the sand it melted out of, dark and opaque rather than frosted white.
    // That gradient is what attaches it to the ground; without it a formation
    // looks placed on the surface rather than grown out of it, which is the
    // single failure this effect cannot afford. Confined to the bottom fifth,
    // same as SNOWFLOW's frost — any more and it is a dark tube with a clear
    // tip rather than a spire fused into a dune.
    let grain = noise2(world.xz * 34.0 + input.vSeed * 19.0) * 0.5 + 0.5;
    let fused = clamp(
        (1.0 - smoothstep(0.01, 0.22, input.vHeight01)) * (0.45 + 0.6 * grain),
        0.0, 1.0
    );

    // Optical path through the glass: long across a facet seen edge-on, short
    // through one seen face-on, and longer near the thick base than at the tip.
    // The constant term carries the colour through the middle of the spire; a
    // path that only opens up at grazing puts all of the tint on the
    // silhouette, where the Fresnel reflection then replaces it with sky.
    let path = clamp(
        (0.16 + 0.42 * (1.0 - input.vHeight01)) * (0.7 + 2.0 * (1.0 - NdotV)),
        0.02, 1.4
    );
    let transmit = exp(-GLASS_ABSORB * path);

    // ---- refraction, with dispersion ---------------------------------------
    // Same construction as the spell sand mass: the sky LUT holds both the sky
    // and the solved ground bounce, so one lookup along the refracted ray is a
    // physically-derived estimate of what is behind the glass in any direction.
    // Real glass IOR (~1.5) rather than ice's (~1.31) — a faint dispersion
    // fringe on the rim, same as before, just at the right refractive index.
    let mirror = reflect(-V, N);
    let rr = refract(-V, N, 1.0 / 1.490);
    let rg = refract(-V, N, 1.0 / 1.500);
    let rb = refract(-V, N, 1.0 / 1.516);
    let dr = select(mirror, rr, dot(rr, rr) > 0.5);
    let dg = select(mirror, rg, dot(rg, rg) > 0.5);
    let db = select(mirror, rb, dot(rb, rb) > 0.5);

    let behind = vec3f(
        textureSampleLevel(skyLUT, skyLUTSampler, dirToLatLong(dr), 0.9).r,
        textureSampleLevel(skyLUT, skyLUTSampler, dirToLatLong(dg), 0.9).g,
        textureSampleLevel(skyLUT, skyLUTSampler, dirToLatLong(db), 0.9).b
    );
    var color = behind * transmit;

    // ---- internal transport -------------------------------------------------
    // A formation with the sun behind it lights along its whole length: light
    // enters the far facet, scatters off inclusions and bubbles frozen into the
    // fusion, and leaves toward the eye tinted by everything it did not absorb.
    // Hot amber rather than ice's cool blue-white — this is the same mechanism
    // wearing the ability's own colour. The 1/PI belongs in front of a
    // scattering lobe; leaving it out clips the whole body to white, the same
    // failure the water material had for the identical reason.
    let through = backScatter(N, L, V, 0.42, 2.2, 1.0);
    let deepTint = mix(vec3f(1.0, 0.55, 0.16), vec3f(1.0, 0.86, 0.58), exp(-path * 2.5));
    color += sun * INV_PI * deepTint * through * uniforms.sssStrength * 1.6
           * mix(0.25, 1.0, shadow);

    // Sky through the body, which is what keeps a formation standing in shadow
    // alive rather than black.
    color += shIrradiance(N, uniforms.shR) * uniforms.ambientIntensity * INV_PI
           * deepTint * 0.9;

    // ---- fused-base skin ------------------------------------------------------
    if (fused > 0.002) {
        // Dark, smoky, scorched sand-glass — not the pale frost ice had. This is
        // the vitrified skin where the melt met ungrown sand and cooled fast.
        let fa = vec3f(0.085, 0.062, 0.042);
        var fc = fa * INV_PI * sun * wrapDiffuse(NdotL, 0.5) * shadow;
        fc += fa * INV_PI * shIrradiance(N, uniforms.shR) * uniforms.ambientIntensity;
        color = mix(color, fc, fused * 0.9);
    }

    // ---- surface ------------------------------------------------------------
    // Sharper than the fused base, duller than polished ice — a strong, hard
    // specular that reads as "glass" without reading as "mirror-wet".
    let rough = mix(0.07, 0.46, fused);
    let F = fresnelSchlick(NdotV, vec3f(0.038));
    let skyRefl = textureSampleLevel(skyLUT, skyLUTSampler, dirToLatLong(mirror), rough * 6.0).rgb;
    color = mix(color, skyRefl, F * (1.0 - fused * 0.78));

    if (NdotL > 0.0) {
        let H = normalize(V + L);
        let D = distributionGGX(clamp(dot(N, H), 0.0, 1.0), rough);
        let Vis = visSmithGGXCorrelated(NdotV, NdotL, rough);
        let Fs = fresnelSchlick(clamp(dot(V, H), 0.0, 1.0), vec3f(0.038));
        color += sun * D * Vis * Fs * NdotL * shadow;
    }

    if (uniforms.glintIntensity > 0.001) {
        let g = snowGlints(
            world.xz, N, V, L, max(length(dx.xz) + length(dy.xz), 1e-4),
            uniforms.glintIntensity * (0.4 + 1.2 * fused), uniforms.glintGrazing
        );
        color += sun * g * shadow * 0.6;
    }

    // ---- formation heat ------------------------------------------------------
    // A fast-fading hot flash right after each facet fuses — see `vHeat`'s
    // header note. Additive, not mixed: this is meant to read as light coming
    // *out* of freshly superheated glass, not as a tint on its surface. Gated
    // hard by `vHeat^2` so it is essentially gone within the first second and
    // never lingers as a permanent glow — sand should not glow merely because a
    // spell exists, and this ability's whole "just formed" identity depends on
    // that glow being brief.
    if (input.vHeat > 0.002) {
        let heatColor = vec3f(1.5, 0.68, 0.20);
        color += heatColor * input.vHeat * input.vHeat * 2.2;
    }

    if (uniforms.spellLightCount > 0.5) {
        color += spellLightingSurface(
            world, N, V, mix(vec3f(1.0, 0.6, 0.28), vec3f(0.15, 0.1, 0.07), fused),
            vec3f(0.038), rough, 0.5,
            uniforms.spellLightPos, uniforms.spellLightCol, uniforms.spellLightCount
        );
    }

    color = applyAerial(
        color, uniforms.cameraPos, world, -V, L,
        skyLUT, skyLUTSampler, sun,
        uniforms.fogDensity, uniforms.fogHeightFalloff, uniforms.fogStart,
        uniforms.aerialStrength
    );

    // ---- opacity ------------------------------------------------------------
    //
    // Three things drive it, unchanged from SNOWFLOW's reasoning:
    //
    //   path    a thin tip is nearly clear; the thick base is not.
    //   grazing a facet seen edge-on presents a long optical path and a strong
    //           reflection, and both make it opaque.
    //   fused   where the spire is fused with the sand it grew through, it is
    //           not transparent at all.
    //
    // The floor is high enough that a formation never disappears against the
    // field behind it.
    let alpha = clamp(
        0.46 + 0.34 * (1.0 - exp(-path * 2.2)) + 0.26 * (1.0 - NdotV) + fused * 0.55,
        0.0, 1.0
    );
    fragmentOutputs.color = vec4f(color, alpha);
}
