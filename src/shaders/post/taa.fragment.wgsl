// -----------------------------------------------------------------------------
// Temporal anti-aliasing.
//
// The one post-process this content genuinely cannot do without. The snow
// material's whole detail budget is spent on
// things that live at or below the pixel: two octaves of discrete crystal glints,
// three tiled grain scales, sastrugi at a decimetre, a rotated Poisson shadow
// filter dithered per pixel, and a plume of two-centimetre grains. Every one of
// those is built to be *resolved* by an accumulation rather than to survive on
// its own — the glint hash is nailed to world space and the shadow rotation is
// interleaved-gradient noise precisely so that a temporal filter can integrate
// them. Without one, the field crawls.
//
// The reprojection is depth-based rather than motion-vector based, which is a
// deliberate trade. Almost everything on screen is static world geometry, so the
// camera's own motion accounts for essentially all the parallax; the character,
// the wake and the spray are small, fast and high-contrast, which is exactly the
// case the neighbourhood clip rejects history for anyway. A motion-vector buffer
// would be a second full-screen target and a velocity output in five vertex
// programs, to improve the one part of the frame that already refuses history.
// -----------------------------------------------------------------------------

#include<snowPostCommon>

varying vUV: vec2f;

var textureSampler: texture_2d<f32>;
var textureSamplerSampler: sampler;
var historyTex: texture_2d<f32>;
var historyTexSampler: sampler;
var depthTex: texture_2d<f32>;
var depthTexSampler: sampler;

/// Last frame's view-projection, unjittered.
uniform prevViewProj: mat4x4f;
/// This frame's view -> world.
uniform invView: mat4x4f;
uniform projInfo: vec2f;
uniform invRes: vec2f;
/// Subpixel offset baked into this frame's projection, in NDC.
uniform jitterNdc: vec2f;
/// 0 on the first frame and after a resize — the history is uninitialised VRAM
/// there, and a single NaN in it would propagate for the rest of the session.
uniform historyValid: f32;
uniform enabled: f32;
/// How much history to keep at rest, 0..1.
uniform feedback: f32;

/// Five-tap Catmull-Rom fetch of the history.
///
/// The single largest quality decision in this file, and it is not about
/// aliasing at all — it is about accumulated blur. History is resampled at a
/// fractional offset *every frame*, and each resample is fed back into the next,
/// so a bilinear tap does not soften the image once, it convolves it with a tent
/// kernel again and again. Standing still with a 0.9 feedback that is roughly ten
/// applications of it, and the result is a frame visibly softer than the one the
/// renderer produced — which on a field whose entire detail budget is
/// subpixel-scale is the difference between snow and a grey slope.
///
/// A bicubic B-spline fetch has negative lobes that undo most of that. Five
/// bilinear taps rather than sixteen point fetches, by folding each pair of
/// weights into one offset tap.
fn historyCatmullRom(uv: vec2f, texSize: vec2f) -> vec3f {
    let samplePos = uv * texSize;
    let texPos1 = floor(samplePos - 0.5) + 0.5;
    let f = samplePos - texPos1;

    let w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
    let w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
    let w2 = f * (0.5 + f * (2.0 - 1.5 * f));
    let w3 = f * f * (-0.5 + 0.5 * f);

    let w12 = w1 + w2;
    let off12 = w2 / w12;

    let p0 = (texPos1 - 1.0) / texSize;
    let p3 = (texPos1 + 2.0) / texSize;
    let p12 = (texPos1 + off12) / texSize;

    var acc = vec3f(0.0);
    acc += textureSampleLevel(historyTex, historyTexSampler, vec2f(p12.x, p0.y), 0.0).rgb
         * (w12.x * w0.y);
    acc += textureSampleLevel(historyTex, historyTexSampler, vec2f(p0.x, p12.y), 0.0).rgb
         * (w0.x * w12.y);
    acc += textureSampleLevel(historyTex, historyTexSampler, vec2f(p12.x, p12.y), 0.0).rgb
         * (w12.x * w12.y);
    acc += textureSampleLevel(historyTex, historyTexSampler, vec2f(p3.x, p12.y), 0.0).rgb
         * (w3.x * w12.y);
    acc += textureSampleLevel(historyTex, historyTexSampler, vec2f(p12.x, p3.y), 0.0).rgb
         * (w12.x * w3.y);

    // The negative lobes can undershoot past zero on a hard edge, and a negative
    // radiance survives the clip below as a black fringe.
    return max(acc, vec3f(0.0));
}

/// The resolve, as a helper so it can return early.
///
/// Babylon rewrites a fragment `main` to return its `FragmentOutputs` struct, so
/// a bare `return` inside one does not compile. Every early-out in this chain
/// therefore lives in a function that returns a value — which reads better
/// anyway.
fn resolve(uv: vec2f) -> vec3f {
    let cur = textureSampleLevel(textureSampler, textureSamplerSampler, uv, 0.0).rgb;

    if (uniforms.enabled < 0.5 || uniforms.historyValid < 0.5) { return cur; }

    // ---- reprojection -----------------------------------------------------
    // The depth stored here was rasterised through the jittered projection, so
    // the ray this pixel actually looked along is the jittered one. Removing the
    // offset before reconstructing is worth the one subtraction: at 0.5 px it is
    // the difference between history that lands on the same surface and history
    // that lands on the far side of a berm crest.
    let z = textureSampleLevel(depthTex, depthTexSampler, uv, 0.0).r;
    let ndc = uv * 2.0 - 1.0 - uniforms.jitterNdc;
    let view = vec3f(ndc.x * uniforms.projInfo.x, ndc.y * uniforms.projInfo.y, 1.0)
             * min(z, POST_FAR);
    let world = uniforms.invView * vec4f(view, 1.0);

    let prevClip = uniforms.prevViewProj * vec4f(world.xyz, 1.0);
    if (prevClip.w <= 1e-4) { return cur; }

    let prevUV = (prevClip.xy / prevClip.w) * 0.5 + 0.5;

    // Off the edge of last frame is a disocclusion by definition.
    if (any(prevUV < vec2f(0.0)) || any(prevUV > vec2f(1.0))) { return cur; }

    // ---- neighbourhood statistics -----------------------------------------
    // Variance clipping rather than a min/max box. A box built from nine taps of
    // a field that *contains* discrete glints is enormous — one lit crystal in
    // the corner of the neighbourhood opens the box wide enough to admit any
    // ghost at all, which is the failure that makes naive TAA smear moving
    // objects across the frame. Clipping to the local distribution instead
    // tracks the surface and ignores the outlier.
    var m1 = vec3f(0.0);
    var m2 = vec3f(0.0);
    for (var j = -1; j <= 1; j++) {
        for (var i = -1; i <= 1; i++) {
            let s = tonemapWeight(textureSampleLevel(
                textureSampler, textureSamplerSampler,
                uv + vec2f(f32(i), f32(j)) * uniforms.invRes, 0.0
            ).rgb);
            m1 += s;
            m2 += s * s;
        }
    }
    let mu = m1 / 9.0;
    let sigma = sqrt(max(vec3f(0.0), m2 / 9.0 - mu * mu));
    let lo = mu - sigma * 1.35;
    let hi = mu + sigma * 1.35;

    var raw = tonemapWeight(historyCatmullRom(prevUV, 1.0 / uniforms.invRes));
    // Guard the uninitialised-history case a second time. A NaN survives a clamp.
    if (any(raw != raw)) { raw = mu; }
    let hist = clamp(raw, lo, hi);

    let curW = tonemapWeight(cur);

    // ---- feedback ---------------------------------------------------------
    // Two things pull it down. Fast screen-space motion, because a long
    // reprojection is a poor prediction and the resampling blur compounds every
    // frame it is kept. And a history that had to be clipped hard, because that
    // is the signal that this pixel is not the same surface it was.
    let motion = length((prevUV - uv) / uniforms.invRes); // pixels travelled
    let motionFade = 1.0 - clamp(motion / 64.0, 0.0, 1.0) * 0.35;
    let clipFade = 1.0 - clamp(length(hist - raw) * 4.0, 0.0, 1.0) * 0.45;

    let k = clamp(uniforms.feedback * motionFade * clipFade, 0.0, 0.97);
    return tonemapUnweight(mix(curW, hist, k));
}

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    fragmentOutputs.color = vec4f(resolve(input.vUV), 1.0);
}
