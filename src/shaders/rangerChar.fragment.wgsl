// -----------------------------------------------------------------------------
// Standard glTF metallic-roughness PBR for the authored Ranger meshes, built
// from the SAME shared lighting library every other material in this scene
// uses (snowShading / snowShadowLookup / snowAtmosphere): the same sun
// radiance, the same SH sky ambient, the same cascade shadow lookup, the
// same aerial perspective. This is real shared-lighting integration, not a
// parallel approximation — only the BRDF (a standard metallic/roughness
// dielectric-or-conductor split, not the ground/cloth's bespoke wrapped-
// diffuse-plus-sheen terms) and the texture source (the glTF's own
// baseColor/normal/ORM maps, not the procedural palette) differ from
// char.fragment.wgsl.
//
// Two Ranger glTF materials share this one shader — see rangerCharacter.js:
//
//   MI_Ranger        gear (pauldron, bracer, belts, boots, hood). A real
//                     packed ORM texture: R = baked AO, G = roughness,
//                     B = metalness.
//   MI_Regular_Male   skin/underlayer. Roughness only (no baked AO, no
//                     metalness — this glTF material's own metallicFactor
//                     is 0), so `hasORM` gates those two channels off.
// -----------------------------------------------------------------------------

#include<snowNoise>
#include<snowShading>
#include<snowSpellLights>
#include<snowAtmosphere>

varying vWorld: vec3f;
varying vNormal: vec3f;
varying vUV: vec2f;
varying vViewDist: f32;

var baseColorTex: texture_2d<f32>;
var baseColorTexSampler: sampler;
var normalTex: texture_2d<f32>;
var normalTexSampler: sampler;
var ormTex: texture_2d<f32>;
var ormTexSampler: sampler;
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

/// 1.0 for MI_Ranger's real packed ORM (AO in R, metalness in B); 0.0 for
/// MI_Regular_Male's roughness-only texture (AO forced to 1, metalness
/// forced to 0 — matching that glTF material's own metallicFactor: 0).
uniform hasORM: f32;

#include<snowShadowLookup>

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    let world = input.vWorld;
    let V = normalize(uniforms.cameraPos - world);
    let L = uniforms.sunDir;

    // Every Ranger mesh is a closed authored shell, unlike the procedural
    // garments' open sheets — so, unlike char.fragment.wgsl, the normal is
    // trusted from the mesh winding rather than turned to face the viewer.
    var N = normalize(input.vNormal);
    let geoN = N;

    // Tangent-space normal map via a screen-space cotangent frame — this
    // import carries no authored tangents, the same situation the
    // procedural character's fabric shader is already in.
    let dp1 = dpdx(world);
    let dp2 = dpdy(world);
    let duv1 = dpdx(input.vUV);
    let duv2 = dpdy(input.vUV);
    let dp2perp = cross(dp2, N);
    let dp1perp = cross(N, dp1);
    let T = normalize(dp2perp * duv1.x + dp1perp * duv2.x);
    let B = cross(N, T);

    let nSample = textureSample(normalTex, normalTexSampler, input.vUV).xy * 2.0 - 1.0;
    let nTS = vec3f(nSample, sqrt(max(0.0, 1.0 - dot(nSample, nSample))));
    N = normalize(T * nTS.x + B * nTS.y + N * nTS.z);

    let baseColor = textureSample(baseColorTex, baseColorTexSampler, input.vUV).rgb;
    let orm = textureSample(ormTex, ormTexSampler, input.vUV);
    let roughness = clamp(orm.g, 0.045, 1.0);
    let metalness = orm.b * uniforms.hasORM;
    let ao = mix(1.0, orm.r, uniforms.hasORM);

    // Standard metallic-roughness split: a metal surface tints its own
    // reflectance with the base colour and carries no diffuse lobe; a
    // dielectric keeps a flat, low F0 and diffuses the rest of the base
    // colour untouched.
    let f0 = mix(vec3f(0.04), baseColor, metalness);
    let albedo = baseColor * (1.0 - metalness);

    let NdotL = dot(N, L);
    let NdotV = clamp(dot(N, V), 1e-4, 1.0);
    let noiseRot = ign(input.position.xy) * 6.28318530718;

    var shadow = 1.0;
    if (NdotL > -0.4) {
        shadow = sunShadow(world, geoN, input.vViewDist, noiseRot);
    }

    let sun = uniforms.sunRadiance;
    const INV_PI: f32 = 0.31830988618;

    // A soft wrap, much gentler than the fabric material's 0.18 — this is
    // solid gear and skin, not cloth, so the terminator should read closer
    // to a hard Lambert edge without going fully razor-sharp under a
    // grazing sun.
    let diff = wrapDiffuse(NdotL, 0.06);
    var color = albedo * INV_PI * sun * diff * shadow;

    if (NdotL > 0.0) {
        let H = normalize(V + L);
        let NdotH = clamp(dot(N, H), 0.0, 1.0);
        let VdotH = clamp(dot(V, H), 0.0, 1.0);
        let D = distributionGGX(NdotH, roughness);
        let Vis = visSmithGGXCorrelated(NdotV, NdotL, roughness);
        let F = fresnelSchlick(VdotH, f0);
        color += sun * D * Vis * F * NdotL * shadow;
    }

    // ---- ambient: sky fill + warm sand bounce, off the same SH data every
    // other material in the scene reads -------------------------------------
    var irradiance = shIrradiance(N, uniforms.shR) * uniforms.ambientIntensity;
    let up = clamp(-N.y * 0.5 + 0.5, 0.0, 1.0);
    irradiance += shIrradiance(vec3f(0.0, 1.0, 0.0), uniforms.shR)
                * uniforms.ambientIntensity * 0.40 * up;
    color += albedo * INV_PI * irradiance * ao;

    // Ambient specular from the sky at a roughness-selected mip — the same
    // Karis split-sum approximation the ground/cloth materials use, inlined
    // here rather than shared since it is four lines and this file has no
    // other reason to include the character material's own helpers.
    let R = reflect(-V, N);
    let mip = sqrt(roughness) * 6.0;
    let skyRefl = textureSampleLevel(skyLUT, skyLUTSampler, dirToLatLong(R), mip).rgb;
    let c0 = vec4f(-1.0, -0.0275, -0.572, 0.022);
    let c1 = vec4f(1.0, 0.0425, 1.04, -0.04);
    let r = vec4f(roughness) * c0 + c1;
    let a004 = min(r.x * r.x, exp2(-9.28 * NdotV)) * r.x + r.y;
    let envBRDF = f0 * (-1.04 * a004 + r.z) + (1.04 * a004 + r.w);
    color += skyRefl * envBRDF * uniforms.ambientIntensity * ao;

    // ---- rim light ----------------------------------------------------------
    // A grazing-angle, sky-tinted kicker along the silhouette. Cheap, and it
    // is most of what keeps a hero character reading as lit *by* the scene
    // at its edges rather than only where the sun and shadow map happen to
    // land — the brief's explicit "rim light" ask.
    let rim = pow(1.0 - NdotV, 4.0);
    color += shIrradiance(N, uniforms.shR) * uniforms.ambientIntensity * INV_PI * rim * 0.5 * ao;

    // ------------------------------------------------------- aerial perspective
    color = applyAerial(
        color, uniforms.cameraPos, world, -V, L,
        skyLUT, skyLUTSampler, sun,
        uniforms.fogDensity, uniforms.fogHeightFalloff, uniforms.fogStart,
        uniforms.aerialStrength
    );

    fragmentOutputs.color = vec4f(color, 1.0);
}
