// -----------------------------------------------------------------------------
// Crystallise — ice shading.
//
// What sells this spell is not the geometry. It is that a facet of clear ice
// does three different things depending on where you stand relative to it, all at
// once and all sharply divided by the facet edges:
//
//   near grazing   almost a mirror. Fresnel at 0.02 base reflectance still
//                  returns nearly everything at 80 degrees, and against this
//                  scene's low warm sun that is a hard bright edge.
//   head on        you see through it, bent, and tinted by the path — which on a
//                  30 cm crystal is a real blue, because ice absorbs red about
//                  fifteen times faster than blue.
//   backlit        it glows. Ice scatters internally at every inclusion and
//                  bubble, and a crystal with the sun behind it lights up along
//                  its whole length rather than going to silhouette.
//
// **Blended, but depth-writing.** The usual pair of options is opaque (correct
// depth, no transparency) or alpha-blended with depth write off (transparency,
// no depth). Neither is right for a cluster of forty overlapping prisms: the
// first gives blue spikes, and the second gives a grey smear where every prism
// blends over every other one in index order.
//
// Writing depth while blending gives the third thing. The first surface at a
// pixel blends over whatever the terrain and the character already put there —
// so you genuinely see the snow through the ice — and every surface *behind* it
// is depth-rejected, so no crystal is ever blended over another one. The result
// is order-dependent in principle and completely stable in practice, because the
// only thing the order decides is which face of a solid you see, and any of them
// is a correct answer.
//
// The normal comes from the derivatives of the world position, so every facet is
// exactly flat and the edges between them are exactly hard. That hard edge is
// what makes the material read: adjacent facets of one prism return wildly
// different amounts of sky, and that facet-to-facet jump *is* the look of ice.
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

/// Absorption per metre. Real ice is roughly (1.5, 0.35, 0.10) in the visible;
/// this is a little stronger so a hand-sized crystal shows the colour a
/// glacier-sized one really would — but not so strong that the whole formation
/// saturates to one flat blue, which is what 4.2 in red did.
const ICE_ABSORB: vec3f = vec3f(2.35, 0.60, 0.24);

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

    // ---- frost --------------------------------------------------------------
    // Where the crystal comes out of the drift it is not clear — it is packed
    // with the snow it grew through. That gradient is what attaches it to the
    // ground; without it a crystal looks placed on the surface rather than grown
    // out of it, which is the single failure this effect cannot afford.
    // Confined to the bottom fifth: the frost is there to attach the crystal to
    // the drift, and any more of it than that is a white prism with a clear tip
    // rather than an ice prism standing in snow.
    let grain = noise2(world.xz * 34.0 + input.vSeed * 19.0) * 0.5 + 0.5;
    let frost = clamp(
        (1.0 - smoothstep(0.01, 0.22, input.vHeight01)) * (0.45 + 0.6 * grain),
        0.0, 1.0
    );

    // Optical path through the crystal: long across a facet seen edge-on, short
    // through one seen face-on, and longer near the thick base than at the tip.
    // The constant term carries the colour through the middle of the prism; a
    // path that only opens up at grazing puts all of the blue on the silhouette,
    // where the Fresnel reflection then replaces it with sky.
    let path = clamp(
        (0.16 + 0.42 * (1.0 - input.vHeight01)) * (0.7 + 2.0 * (1.0 - NdotV)),
        0.02, 1.4
    );
    let transmit = exp(-ICE_ABSORB * path);

    // ---- refraction, with dispersion ---------------------------------------
    // Same construction as the spell water: the sky LUT holds both the sky and
    // the solved snow bounce, so one lookup along the refracted ray is a
    // physically-derived estimate of what is behind the crystal in any direction.
    let mirror = reflect(-V, N);
    let rr = refract(-V, N, 1.0 / 1.3050);
    let rg = refract(-V, N, 1.0 / 1.3090);
    let rb = refract(-V, N, 1.0 / 1.3170);
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
    // A crystal with the sun behind it lights along its whole length: the light
    // enters the far facet, scatters off inclusions,
    // and leaves toward the eye, tinted by everything it did not survive.
    // The 1/PI belongs in front of a scattering lobe; see the same note in the
    // water material, where leaving it out clipped the whole body to white.
    let through = backScatter(N, L, V, 0.42, 2.2, 1.0);
    let deepTint = mix(vec3f(0.42, 0.74, 1.0), vec3f(0.86, 0.95, 1.0), exp(-path * 2.5));
    color += sun * INV_PI * deepTint * through * uniforms.sssStrength * 1.6
           * mix(0.25, 1.0, shadow);

    // Sky through the body, which is what keeps a crystal standing in shadow
    // alive rather than black.
    color += shIrradiance(N, uniforms.shR) * uniforms.ambientIntensity * INV_PI
           * deepTint * 0.9;

    // ---- frosted skin -------------------------------------------------------
    if (frost > 0.002) {
        let fa = vec3f(0.88, 0.915, 0.965);
        var fc = fa * INV_PI * sun * wrapDiffuse(NdotL, 0.62) * shadow;
        fc += fa * INV_PI * shIrradiance(N, uniforms.shR) * uniforms.ambientIntensity;
        fc += snowSubsurface(N, L, V, sun, 0.4, uniforms.sssStrength, 1.3)
            * fa * mix(0.4, 1.0, shadow);
        color = mix(color, fc, frost * 0.9);
    }

    // ---- surface ------------------------------------------------------------
    let rough = mix(0.045, 0.42, frost);
    let F = fresnelSchlick(NdotV, vec3f(0.021));
    let skyRefl = textureSampleLevel(skyLUT, skyLUTSampler, dirToLatLong(mirror), rough * 6.0).rgb;
    color = mix(color, skyRefl, F * (1.0 - frost * 0.75));

    if (NdotL > 0.0) {
        let H = normalize(V + L);
        let D = distributionGGX(clamp(dot(N, H), 0.0, 1.0), rough);
        let Vis = visSmithGGXCorrelated(NdotV, NdotL, rough);
        let Fs = fresnelSchlick(clamp(dot(V, H), 0.0, 1.0), vec3f(0.021));
        color += sun * D * Vis * Fs * NdotL * shadow;
    }

    if (uniforms.glintIntensity > 0.001) {
        let g = snowGlints(
            world.xz, N, V, L, max(length(dx.xz) + length(dy.xz), 1e-4),
            uniforms.glintIntensity * (0.4 + 1.2 * frost), uniforms.glintGrazing
        );
        color += sun * g * shadow * 0.6;
    }

    if (uniforms.spellLightCount > 0.5) {
        color += spellLightingSurface(
            world, N, V, mix(vec3f(0.3, 0.6, 0.85), vec3f(0.88), frost),
            vec3f(0.021), rough, 0.5,
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
    // Three things drive it, and they are the three things that decide how much
    // of a real crystal you can see through:
    //
    //   path      a thin tip is nearly clear; the thick base is not.
    //   grazing   a facet seen edge-on presents a long optical path and a strong
    //             reflection, and both make it opaque.
    //   frost     where the prism is packed with the snow it grew through, it is
    //             not transparent at all.
    //
    // The floor is high enough that a crystal never disappears against the field
    // behind it.
    let alpha = clamp(
        0.46 + 0.34 * (1.0 - exp(-path * 2.2)) + 0.26 * (1.0 - NdotV) + frost * 0.55,
        0.0, 1.0
    );
    fragmentOutputs.color = vec4f(color, alpha);
}
