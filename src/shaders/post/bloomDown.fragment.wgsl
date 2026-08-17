// Bloom downsample, with an optional bright-pass on the first level.
//
// The thirteen-tap kernel is the one from Jimenez' Call of Duty presentation: a
// centre box plus four corner boxes, which behaves like a proper low-pass at a
// 2x reduction and does not fall apart at 4x the way a naive bilinear chain does.
//
// The Karis average on the prefilter level is not optional on this content. The
// snow material emits *discrete glints* — single pixels at many times the
// surrounding radiance, by design — and a plain mean of a 2x2 group lets one of
// them dominate the whole group. The result is a bloom that flickers as the glint
// field turns over, which is precisely the "crawling sparkle" the acceptance
// criteria rule out, arriving by the back door after TAA has already stabilised
// the glints themselves. Weighting each group by 1/(1+luma) before averaging
// keeps the energy and drops the flicker.

#include<snowPostCommon>

varying vUV: vec2f;

/// The source. On the prefilter level this is the resolved scene, bound
/// explicitly; on later levels it is the previous bloom level.
var sourceTex: texture_2d<f32>;
var sourceTexSampler: sampler;

/// One texel of the *source*, in UV.
uniform srcTexel: vec2f;
/// 1 on the first level: threshold and Karis-average. 0 on the rest.
uniform prefilter: f32;
/// Knee curve: (threshold, threshold - knee, 2*knee, 0.25/knee).
uniform curve: vec4f;

fn tap(uv: vec2f) -> vec3f {
    return textureSampleLevel(sourceTex, sourceTexSampler, uv, 0.0).rgb;
}

/// Soft-knee threshold. A hard cut puts a visible contour through any smooth
/// gradient that crosses it, and on a snow field almost every gradient does.
fn brightPass(c: vec3f, curve: vec4f) -> vec3f {
    let br = max(c.r, max(c.g, c.b));
    let rq = clamp(br - curve.y, 0.0, curve.z);
    let soft = rq * rq * curve.w;
    return c * max(soft, br - curve.x) / max(br, 1e-5);
}

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    let uv = input.vUV;
    let t = uniforms.srcTexel;

    // Inner 2x2 box (weight 0.5 total) ...
    let a = tap(uv + vec2f(-t.x, -t.y));
    let b = tap(uv + vec2f( t.x, -t.y));
    let c = tap(uv + vec2f(-t.x,  t.y));
    let d = tap(uv + vec2f( t.x,  t.y));

    // ... and the four overlapping outer boxes (weight 0.125 each).
    let e = tap(uv + vec2f(-2.0 * t.x, -2.0 * t.y));
    let f = tap(uv + vec2f( 0.0,       -2.0 * t.y));
    let g = tap(uv + vec2f( 2.0 * t.x, -2.0 * t.y));
    let h = tap(uv + vec2f(-2.0 * t.x,  0.0));
    let i = tap(uv);
    let j = tap(uv + vec2f( 2.0 * t.x,  0.0));
    let k = tap(uv + vec2f(-2.0 * t.x,  2.0 * t.y));
    let l = tap(uv + vec2f( 0.0,        2.0 * t.y));
    let m = tap(uv + vec2f( 2.0 * t.x,  2.0 * t.y));

    var g0 = (a + b + c + d) * 0.25;
    var g1 = (e + f + h + i) * 0.25;
    var g2 = (f + g + i + j) * 0.25;
    var g3 = (h + i + k + l) * 0.25;
    var g4 = (i + j + l + m) * 0.25;

    var outCol: vec3f;
    if (uniforms.prefilter > 0.5) {
        // Weight the five groups by their own luminance before combining, then
        // threshold once. See the note above.
        let w0 = 1.0 / (1.0 + lumaPost(g0));
        let w1 = 1.0 / (1.0 + lumaPost(g1));
        let w2 = 1.0 / (1.0 + lumaPost(g2));
        let w3 = 1.0 / (1.0 + lumaPost(g3));
        let w4 = 1.0 / (1.0 + lumaPost(g4));
        let wsum = w0 * 0.5 + (w1 + w2 + w3 + w4) * 0.125;
        outCol = (g0 * w0 * 0.5 + (g1 * w1 + g2 * w2 + g3 * w3 + g4 * w4) * 0.125)
               / max(wsum, 1e-5);
        outCol = brightPass(outCol, uniforms.curve);
    } else {
        outCol = g0 * 0.5 + (g1 + g2 + g3 + g4) * 0.125;
    }

    fragmentOutputs.color = vec4f(outCol, 1.0);
}
