// Nine-tap tent blur, at the bottom of the bloom chain.
//
// Widens the coarsest level into the broad halo that reads as atmosphere around
// the sun rather than as a ring around it. A tent rather than a box because the
// composite samples this bilinearly at sixteen times the resolution, and a box's
// flat top makes the upsample's own linear interpolation visible as facets.

varying vUV: vec2f;

var textureSampler: texture_2d<f32>;
var textureSamplerSampler: sampler;

/// One texel of the source, in UV, times the desired spread.
uniform srcTexel: vec2f;

fn tap(uv: vec2f) -> vec3f {
    return textureSampleLevel(textureSampler, textureSamplerSampler, uv, 0.0).rgb;
}

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    let uv = input.vUV;
    let t = uniforms.srcTexel;

    var c = tap(uv + vec2f(-t.x,  t.y)) * 1.0;
    c += tap(uv + vec2f( 0.0,   t.y)) * 2.0;
    c += tap(uv + vec2f( t.x,   t.y)) * 1.0;
    c += tap(uv + vec2f(-t.x,   0.0)) * 2.0;
    c += tap(uv)                      * 4.0;
    c += tap(uv + vec2f( t.x,   0.0)) * 2.0;
    c += tap(uv + vec2f(-t.x,  -t.y)) * 1.0;
    c += tap(uv + vec2f( 0.0,  -t.y)) * 2.0;
    c += tap(uv + vec2f( t.x,  -t.y)) * 1.0;

    fragmentOutputs.color = vec4f(c * (1.0 / 16.0), 1.0);
}
