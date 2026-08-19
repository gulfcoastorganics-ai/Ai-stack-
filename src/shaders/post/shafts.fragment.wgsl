// -----------------------------------------------------------------------------
// Volumetric light shafts.
//
// At a thirteen-degree sun these earn their cost: every dune crest in the frame
// is a horizon-line occluder with the sun sitting just above it, which is the
// geometry that produces shafts. The same effect at a midday sun would be
// invisible, and this is written so that it simply switches itself off there —
// the weight falls with the sun's screen distance and vanishes once the sun
// leaves the frustum.
//
// Occlusion comes from the depth prepass rather than a separate occlusion render:
// a pixel where the prepass wrote nothing is sky, and sky is where the beam gets
// through. That makes this a radial integral of sky visibility, and it costs one
// texture fetch per step with no extra geometry pass behind it.
//
// Runs at quarter resolution. Shafts are the lowest-frequency thing in the frame
// by an order of magnitude, and the composite reads this back bilinearly.
// -----------------------------------------------------------------------------

#include<snowPostCommon>

varying vUV: vec2f;

var textureSampler: texture_2d<f32>;
var textureSamplerSampler: sampler;
var depthTex: texture_2d<f32>;
var depthTexSampler: sampler;

/// Where the sun projects on screen, in the same UV space as everything else.
uniform sunUV: vec2f;
/// 1 when the sun is in front of the camera, 0 behind. No smoothing — the radial
/// weight has already faded to nothing long before the sun reaches the frustum
/// edge, so there is nothing to pop.
uniform sunOnScreen: f32;
uniform sunColor: vec3f;
uniform enabled: f32;
uniform strength: f32;
/// Aspect ratio, so the angular falloff is round on screen rather than elliptical.
uniform aspect: f32;

const STEPS: i32 = 24;
/// How far along the ray to the sun the march reaches. Short of 1.0 on purpose:
/// the shaft should read as light spilling *past* a crest, not as a star filter.
const REACH: f32 = 0.82;
/// Per-step attenuation. Sets how far a shaft runs before it dies out.
const DECAY: f32 = 0.955;

/// Sky visibility integrated along the ray toward the sun.
fn marchShaft(uv: vec2f, pix: vec2f, radial: f32) -> f32 {
    let delta = (uniforms.sunUV - uv) * (REACH / f32(STEPS));

    // Dither the start, or twenty-four steps quantise into visible rings around
    // the sun. The temporal resolve has already run by this point, so the noise
    // has to be broken up spatially rather than accumulated away — hence a fixed
    // hash rather than a per-frame one.
    var p = uv + delta * ignPost(pix);

    var illum = 1.0;
    var acc = 0.0;
    for (var i = 0; i < STEPS; i++) {
        let z = textureSampleLevel(depthTex, depthTexSampler, p, 0.0).r;
        acc += select(0.0, illum, isBackground(z));
        illum *= DECAY;
        p += delta;
    }
    acc /= f32(STEPS);

    // Squared, so a beam that is half occluded reads as clearly dimmer than one
    // that is not. Linear accumulation makes every crest emit the same haze and
    // the shafts lose their shape.
    return acc * acc * radial * uniforms.strength;
}

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    let uv = input.vUV;

    // Angular weight. Shafts belong near the sun; letting them reach the far
    // corner turns the whole frame into a radial blur, which is the failure mode
    // that makes this effect look cheap.
    let d = (uv - uniforms.sunUV) * vec2f(uniforms.aspect, 1.0);
    let radial = 1.0 - smoothstep(0.03, 0.68, length(d));

    var v = 0.0;
    if (uniforms.enabled > 0.5 && uniforms.sunOnScreen > 0.5 && radial > 0.001) {
        v = marchShaft(uv, input.position.xy, radial);
    }

    fragmentOutputs.color = vec4f(uniforms.sunColor * v, 1.0);
}
