// -----------------------------------------------------------------------------
// snowPostCommon — the conventions every screen-space pass shares.
//
// One place for the coordinate agreement, because getting it wrong is silent:
// a vertically mirrored depth lookup still produces plausible-looking occlusion,
// it is just occlusion belonging to a different part of the frame, and that is
// exactly the class of bug that costs a day.
//
// The agreement, derived once:
//
//   Babylon's WGSL processor multiplies `position.y` by an internal `yFactor` of
//   -1 when the destination is a render target, and compensates in the fragment
//   stage when it is not. The net effect is that `vUV` and
//   `fragmentInputs.position.xy / renderSize` are the *same* number in every
//   pass, and both run bottom-up: vUV.y = 1 is the top of the image. So NDC y in
//   the ordinary, unflipped sense is `vUV.y * 2 - 1`, and a world point projected
//   with `scene.getTransformMatrix()` lands at `ndc * 0.5 + 0.5` — no flip
//   anywhere, as long as nothing in this file invents one.
//
// View space is left-handed with +z forward, matching the camera.
// -----------------------------------------------------------------------------

/// Cleared value of the depth prepass. Must match `DEPTH_FAR` in depthPass.js.
const POST_FAR: f32 = 9000.0;

/// True where the prepass wrote nothing — sky, or a discarded fragment.
fn isBackground(z: f32) -> bool {
    return z > POST_FAR * 0.5;
}

/// View-space position of a pixel.
///
/// `projInfo` is `(tan(fovY/2) * aspect, tan(fovY/2))`, so the reconstruction is
/// one multiply and needs no matrix. `z` is the linear view depth the prepass
/// stored, which for a perspective projection is the clip-space w.
fn viewFromDepth(uv: vec2f, z: f32, projInfo: vec2f) -> vec3f {
    let ndc = uv * 2.0 - 1.0;
    return vec3f(ndc.x * projInfo.x, ndc.y * projInfo.y, 1.0) * z;
}

/// Screen UV of a view-space position. The inverse of `viewFromDepth`.
fn uvFromView(p: vec3f, projInfo: vec2f) -> vec2f {
    let ndc = vec2f(p.x / (projInfo.x * p.z), p.y / (projInfo.y * p.z));
    return ndc * 0.5 + 0.5;
}

/// Interleaved gradient noise — the cheapest per-pixel dither that TAA resolves
/// cleanly, because its spectrum is close to blue over a 3x3 neighbourhood.
fn ignPost(p: vec2f) -> f32 {
    return fract(52.9829189 * fract(dot(p, vec2f(0.06711056, 0.00583715))));
}

/// Rec.709 luminance.
fn lumaPost(c: vec3f) -> f32 {
    return dot(c, vec3f(0.2126, 0.7152, 0.0722));
}

/// Karis' tonemap/inverse pair. Averaging HDR samples with a linear weight lets
/// one 200-nit firefly dominate sixteen taps of ordinary snow; averaging in this
/// compressed space and expanding afterwards keeps the mean where the eye expects
/// it. Used by the temporal resolve and the bloom prefilter.
fn tonemapWeight(c: vec3f) -> vec3f {
    return c / (1.0 + lumaPost(c));
}

fn tonemapUnweight(c: vec3f) -> vec3f {
    return c / max(1e-4, 1.0 - lumaPost(c));
}
