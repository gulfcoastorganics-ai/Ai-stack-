// -----------------------------------------------------------------------------
// Spell sand mass — shading.
//
// SANDSTORM Phase 6: SNOWFLOW's bent-water material, replaced rather than
// retinted. Four of the five abilities move a coherent body of *displaced sand*
// through this same swept-surface mesh (see `waterBody.js` and `lib/water.wgsl`
// for the geometry, both still named for the system they were built for — the
// geometry itself is substance-agnostic, a swept tube/sheet with a radius and a
// transported frame, and renaming it risks nothing so much as it buys). What
// changed is everything about what that surface *is* once light hits it:
//
//   it is opaque            sand does not transmit light through a decimetre of
//                           itself the way water does. There is no refraction,
//                           no chromatic dispersion, and no sky sampled through
//                           the body — every one of those was a statement about
//                           a transparent medium, and none of them is true here.
//   it is coloured by
//   what it reflects        not by what it absorbs on a path length. The albedo
//                           moves between the terrain's own loose-grain and
//                           packed-sand tones (see the constants below, chosen to
//                           match `snow.fragment.wgsl`'s base/compacted albedo so
//                           a Dune Surge crest and the ground it crests through
//                           read as the same material) rather than deepening with
//                           thickness.
//   it is matte, not wet    Fresnel on water is nearly a mirror at grazing; dry
//                           sand's is a soft, high-roughness sheen. There is no
//                           sky reflection term here at all — a body of thrown
//                           sand does not return a legible image of the sky.
//   it breaks up at
//   the edge                a body of water has a clean tension-held boundary; a
//                           body of granular material does not, and the alpha
//                           carries a stochastic fray at its edges instead of a
//                           smooth taper alone.
//
// `milkiness` — the field is left named for its SNOWFLOW role rather than
// renamed, per the project's "don't rename for aesthetics alone" rule — now
// reads as *compaction*: 0 is loose, freshly disturbed grain, catching full
// sun; 1 is dense, wind-packed mass, darker and tighter. `foam` similarly
// stays named for what it always was structurally — an edge-population weight
// — and now carries the fine dust breaking off the leading edge and the
// grazing scatter that dust catches when backlit.
// -----------------------------------------------------------------------------

#include<snowNoise>
#include<snowShading>
#include<snowSpellLights>
#include<snowAtmosphere>

varying vWorld: vec3f;
varying vNormal: vec3f;
varying vQ: f32;
varying vU: f32;
varying vRadius: f32;
varying vFoam: f32;
varying vMilk: f32;
varying vAlpha: f32;
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
uniform waterTime: f32;
/// Artistic scale on how strongly compaction darkens the mass — the direct
/// replacement for the old absorption-path slider, and left under its old
/// name/uniform slot for the same reason `milkiness` kept its name: nothing
/// downstream (the settings schema, `waterBody.js`'s uniform push) has to
/// change to retarget it. See `settings.js`'s "Sand density" label.
uniform waterDepthTint: f32;

uniform spellLightPos: array<vec4f, 4>;
uniform spellLightCol: array<vec4f, 4>;
uniform spellLightCount: f32;

#include<snowShadowLookup>

/// Loose, sunlit grain and dense, wind-packed grain — the same two states the
/// terrain's own base/compacted albedo describe in `snow.fragment.wgsl`,
/// repeated here rather than shared through an include because the two
/// materials read completely different varyings and the values are what needs
/// to agree, not the code path.
const SAND_LOOSE: vec3f = vec3f(0.80, 0.63, 0.40);
const SAND_PACKED: vec3f = vec3f(0.46, 0.36, 0.23);

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    if (input.vAlpha <= 0.003 || input.vRadius <= 0.0005) { discard; }

    let world = input.vWorld;
    let V = normalize(uniforms.cameraPos - world);
    let L = uniforms.sunDir;

    // Both faces of the body are visible — the sheet profile is genuinely
    // open — so winding says nothing. Turn the normal toward the eye, exactly
    // as the wake and the garments do.
    let Ng = normalize(input.vNormal);
    var N = select(-Ng, Ng, dot(Ng, V) >= 0.0);
    let geoN = N;

    // Grain relief. Two octaves of gradient noise sliced along two oblique
    // world directions rather than the XZ plane, so a mass that is as often
    // vertical as horizontal (a rising crest, a falling column) does not band
    // into horizontal stripes on its vertical parts.
    //
    // Slower and finer than the water ripple this replaces: sand does not
    // flow into ripples on a surface this size in real time, it just has a
    // grainy, granular micro-surface that drifts gently with the mass's own
    // motion. See `lib/water.wgsl`'s `waterRelief` for the *macro* lumps this
    // sits on top of — that is vertex-resolution displacement, this is
    // per-pixel normal detail one order finer.
    let ddxW = dpdx(world);
    let ddyW = dpdy(world);
    let footprint = max(length(vec2f(length(ddxW.xz), length(ddyW.xz))), 1e-4);
    let fp = vec2f(
        dot(world, vec3f(0.88, 0.31, -0.36)),
        dot(world, vec3f(0.24, 0.79, 0.56))
    );

    let up = select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), abs(N.y) > 0.99);
    let T = normalize(cross(up, N));
    let B = cross(N, T);

    let t = uniforms.waterTime;
    let grainFade = 1.0 - smoothstep(0.03, 0.22, footprint);
    if (grainFade > 0.002) {
        let g1 = noised(fp * 11.0 + vec2f(t * 0.22, -t * 0.14));
        let g2 = noised(fp * 27.0 + vec2f(-t * 0.4, t * 0.28));
        N = normalize(N + (T * (g1.y * 0.075 + g2.y * 0.05)
                         + B * (g1.z * 0.075 + g2.z * 0.05)) * grainFade);
    }
    let fineFade = 1.0 - smoothstep(0.006, 0.045, footprint);
    if (fineFade > 0.002) {
        let g3 = noised(fp * 78.0 + vec2f(t * 0.7, t * 0.5));
        N = normalize(N + (T * g3.y + B * g3.z) * 0.026 * fineFade);
    }

    let NdotV = clamp(dot(N, V), 1e-4, 1.0);
    let NdotL = dot(N, L);
    let noiseRot = ign(input.position.xy) * 6.28318530718;
    let shadow = sunShadow(world, geoN, input.vViewDist, noiseRot);

    let sun = uniforms.sunRadiance;
    const INV_PI: f32 = 0.31830988618;

    // ---- albedo --------------------------------------------------------------
    // Loose grain toward compacted mass, darkened further where the material is
    // actually dense (`waterDepthTint` — see the note on the uniform above).
    // Streaked by the grain-relief normal's own deviation from flat, so the
    // facets the light rakes across read slightly lighter than the ones it
    // grazes past, the way a pile of dry sand actually catches raking light.
    let compaction = clamp(input.vMilk * uniforms.waterDepthTint, 0.0, 1.0);
    var albedo = mix(SAND_LOOSE, SAND_PACKED, compaction);
    albedo *= mix(0.92, 1.08, clamp(dot(N, geoN) * 1.4 - 0.4, 0.0, 1.0));

    // ---- diffuse ---------------------------------------------------------------
    var color = albedo * INV_PI * sun * wrapDiffuse(NdotL, 0.28) * shadow;
    color += albedo * INV_PI * shIrradiance(N, uniforms.shR) * uniforms.ambientIntensity;

    // ---- dust scatter -----------------------------------------------------
    // Fine, airborne dust breaking off the leading edge (`foam` — see the file
    // header) catches a backlit sun the way any suspended particulate does: a
    // soft glow along the rim when the sun sits behind the mass. Weighted by
    // `foam` alone so the coherent, compacted core of the body never picks up
    // this term — only the fraying edge does.
    if (input.vFoam > 0.002) {
        let dust = backScatter(N, L, V, 0.62, 2.1, 1.0);
        let dustTint = mix(vec3f(0.94, 0.78, 0.55), vec3f(1.0, 0.92, 0.78), input.vFoam);
        color += sun * INV_PI * dustTint * dust * input.vFoam
               * (0.5 + 0.6 * uniforms.sssStrength) * mix(0.4, 1.0, shadow);
    }

    // ---- dry specular -------------------------------------------------------
    // A soft, high-roughness sheen rather than a wet mirror highlight — the
    // single biggest change from the water material this replaces, and the
    // one thing that stops a moving sand mass from reading as glazed. No sky
    // reflection term at all: a body of thrown sand does not return a
    // legible image of the sky the way a wet surface does.
    if (NdotL > 0.0) {
        // Streaked toward the tangent so the highlight breaks up directionally
        // along the flow rather than sitting as one clean isotropic lobe — a
        // cheap stand-in for true anisotropic breakup that costs one more
        // noise tap rather than a second BRDF term.
        let streak = noise2(fp * 5.5 + vec2f(input.vU * 3.0, 0.0)) * 0.5 + 0.5;
        let rough = clamp(0.62 + 0.22 * compaction - 0.12 * streak, 0.35, 0.92);
        let H = normalize(V + L);
        let D = distributionGGX(clamp(dot(N, H), 0.0, 1.0), rough);
        let Vis = visSmithGGXCorrelated(NdotV, NdotL, rough);
        let F = fresnelSchlick(clamp(dot(V, H), 0.0, 1.0), vec3f(0.035));
        color += sun * D * Vis * F * NdotL * shadow * 0.6;
    }

    // Mineral sparkle in the mass itself — the snow field's own glint term,
    // at a fraction of its ground intensity, so a crest or a lance catches
    // the same kind of flecked highlight the dune surface does rather than
    // reading as a differently-lit object standing on it.
    if (uniforms.glintIntensity > 0.001) {
        let g = snowGlints(
            fp, N, V, L, footprint,
            uniforms.glintIntensity * (0.35 + 0.5 * max(input.vFoam, compaction)),
            uniforms.glintGrazing
        );
        color += sun * g * shadow * 0.45;
    }

    // ---- spell light -------------------------------------------------------
    // A spell body lit by its own emitter — see the per-ability notes in
    // `spellSystem.js`'s dispatch for which of the five actually declare one
    // here; most do not, on purpose (sand does not glow merely because a
    // spell exists).
    if (uniforms.spellLightCount > 0.5) {
        color += spellLightingSurface(
            world, N, V, albedo,
            vec3f(0.035), 0.7, 0.4,
            uniforms.spellLightPos, uniforms.spellLightCol, uniforms.spellLightCount
        );
    }

    // ---- opacity -----------------------------------------------------------
    // Opaque at the core, the same reasoning SNOWFLOW's water used — a high
    // alpha keeps the background from being counted twice — but with a
    // stochastic fray at the edge instead of a Fresnel-driven glass edge: a
    // granular mass does not thin to a clear film at its boundary, it breaks
    // apart into separated grains, so the alpha itself gets a noise dither
    // wherever `foam` says the edge is fraying.
    let taper = clamp(input.vRadius / 0.055, 0.0, 1.0);
    var alpha = taper * input.vAlpha;
    if (input.vFoam > 0.05) {
        let fray = noise2(fp * 34.0 + vec2f(t * 0.9, -t * 0.6)) * 0.5 + 0.5;
        alpha *= mix(1.0, 0.45 + 0.55 * fray, input.vFoam);
    }
    if (alpha < 0.004) { discard; }

    color = applyAerial(
        color, uniforms.cameraPos, world, -V, L,
        skyLUT, skyLUTSampler, sun,
        uniforms.fogDensity, uniforms.fogHeightFalloff, uniforms.fogStart,
        uniforms.aerialStrength
    );

    fragmentOutputs.color = vec4f(color, alpha);
}
