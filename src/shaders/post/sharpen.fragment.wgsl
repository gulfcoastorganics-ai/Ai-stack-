// Contrast-adaptive sharpen, after the display transform.
//
// TAA costs sharpness — it is a weighted average over eight subpixel positions,
// and however good the neighbourhood clip is, the result is softer than the
// jittered frame that went in. This is the pass that buys it back, and it belongs
// at the very end for two reasons: sharpening in linear HDR puts a dark ring
// around every specular highlight, because the overshoot there is measured in
// stops rather than in code values; and the eye judges acutance after the tone
// curve, not before it.
//
// The local min/max clamp is what makes it "adaptive": the correction is limited
// to the range already present in the 3x3 neighbourhood, so a sharp edge is
// steepened and a flat expanse of snow does not gain a halo it has no gradient to
// justify.

varying vUV: vec2f;

var textureSampler: texture_2d<f32>;
var textureSamplerSampler: sampler;

uniform invRes: vec2f;
uniform amount: f32;

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    let uv = input.vUV;
    let c = textureSampleLevel(textureSampler, textureSamplerSampler, uv, 0.0);

    var outCol = c.rgb;
    if (uniforms.amount >= 0.001) {
        let t = uniforms.invRes;
        let l = textureSampleLevel(textureSampler, textureSamplerSampler, uv - vec2f(t.x, 0.0), 0.0).rgb;
        let r = textureSampleLevel(textureSampler, textureSamplerSampler, uv + vec2f(t.x, 0.0), 0.0).rgb;
        let d = textureSampleLevel(textureSampler, textureSamplerSampler, uv - vec2f(0.0, t.y), 0.0).rgb;
        let u = textureSampleLevel(textureSampler, textureSamplerSampler, uv + vec2f(0.0, t.y), 0.0).rgb;

        let lo = min(c.rgb, min(min(l, r), min(d, u)));
        let hi = max(c.rgb, max(max(l, r), max(d, u)));

        let k = uniforms.amount * 0.32;
        outCol = clamp(c.rgb * (1.0 + 4.0 * k) - (l + r + d + u) * k, lo, hi);
    }

    fragmentOutputs.color = vec4f(outCol, c.a);
}
