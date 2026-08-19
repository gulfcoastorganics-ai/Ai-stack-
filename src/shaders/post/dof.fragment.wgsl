// -----------------------------------------------------------------------------
// Depth of field — very restrained.
//
// The focal plane tracks the character, because the character is what the player
// is looking at and the spring arm already knows how far away it is. Everything
// nearer than about half that distance and everything past roughly twice it
// picks up a circle of confusion, capped at a few pixels.
//
// The restraint is not timidity. This scene's depth cue is aerial perspective —
// contrast compression and a hue pull toward the sky — and that is a *physical*
// cue that survives at any focal length. A heavy defocus competes with it and
// wins, which trades a snow field that recedes for a snow field that is out of
// focus. What a light one adds is the last thing missing from the near field:
// the berm the camera is almost sitting on stops being as crisp as the ridge two
// hundred metres away, which is the read that makes a frame look photographed.
//
// Sample weighting is by the *sample's own* circle of confusion, so a blurred
// background cannot bleed onto a sharp foreground — the artefact that makes cheap
// depth of field look like a smeared decal around every silhouette.
//
// SANDSTORM addition: a restrained desert heat-shimmer offset, folded into this
// pass rather than given a pass of its own — see `heatOffset` below. It shares
// this shader's existing depth and full-resolution scene-colour bindings, so
// the added cost is a handful of ALU ops per pixel and nothing else: no new
// render target, no new bound texture, no new entry in the post chain.
// -----------------------------------------------------------------------------

#include<snowPostCommon>

varying vUV: vec2f;

/// The resolved scene at full resolution, bound explicitly — the chain's own
/// input at this point is the bottom of the bloom pyramid.
var sceneTex: texture_2d<f32>;
var sceneTexSampler: sampler;
var depthTex: texture_2d<f32>;
var depthTexSampler: sampler;

uniform invRes: vec2f;
uniform enabled: f32;
/// Distance to the focal plane, metres.
uniform focusDist: f32;
/// Largest circle of confusion, in pixels.
uniform maxCoc: f32;
uniform time: f32;
/// 0 disables heat shimmer entirely (a true no-op — see `heatOffset`), scales
/// linearly above that. Independent of `enabled`: DOF's blur and the shimmer
/// are two different effects that happen to share this pass.
uniform heatStrength: f32;

const TAPS: i32 = 16;
const GOLDEN: f32 = 2.39996323;

/// Where the far defocus starts and where it saturates, in **metres**.
///
/// Absolute, not a multiple of the focal distance, and that distinction is the
/// whole of a bug this pass shipped with. Keying the far ramp to `focus * 14`
/// sounds distant and is not: the focal plane is the spring arm, about six
/// metres, so the ramp saturated at eighty-seven metres — the near-middle of a
/// field that runs to eight hundred and seventy. Every dune past the one the
/// player is standing on sat at the full circle of confusion. The scene does not
/// rescale when the player zooms the camera in, so neither can this.
///
/// The values are also far more conservative than a naive thin-lens model would
/// give, and deliberately. A third-person camera focused at six metres is a wide
/// lens at a small aperture; its hyperfocal distance is a few metres, so
/// physically *nothing* past about twelve metres defocuses at all. What is left
/// here is a cosmetic softening of the last ridge, where aerial perspective has
/// already taken three quarters of the contrast.
const FAR_START: f32 = 130.0;
const FAR_FULL: f32 = 620.0;

/// Signed circle of confusion, -1 (near) .. +1 (far), before the pixel scale.
fn cocOf(z: f32, focus: f32) -> f32 {
    if (isBackground(z)) { return 1.0; }
    let far = smoothstep(FAR_START, FAR_FULL, z);
    // Near side stays keyed to the focal distance, because that *is* the right
    // anchor for it: the near limit is a property of the subject distance, and it
    // is the one place this effect earns its keep — a berm the camera is almost
    // sitting on has no business being as crisp as a ridge two hundred metres
    // away.
    let near = smoothstep(focus * 0.55, focus * 0.16, z);
    return far - near;
}

/// The gather. Weighted by each tap's *own* circle of confusion, so a blurred
/// background cannot bleed onto a sharp foreground.
fn gather(uv: vec2f, pix: vec2f, r: f32, centre: vec3f) -> vec3f {
    let rot = ignPost(pix) * 6.28318530718;

    var acc = centre;
    var wsum = 1.0;
    for (var i = 0; i < TAPS; i++) {
        let fi = f32(i) + 0.5;
        let a = rot + fi * GOLDEN;
        let rr = r * sqrt(fi / f32(TAPS));
        let sUV = uv + vec2f(cos(a), sin(a)) * rr * uniforms.invRes;

        let sz = textureSampleLevel(depthTex, depthTexSampler, sUV, 0.0).r;
        let sCoc = cocOf(sz, uniforms.focusDist);
        // A tap only contributes if its own blur circle is wide enough to reach
        // this pixel. That is the whole foreground-bleed fix, in one line.
        let w = clamp(abs(sCoc) * uniforms.maxCoc - rr + 1.0, 0.0, 1.0);
        acc += textureSampleLevel(sceneTex, sceneTexSampler, sUV, 0.0).rgb * w;
        wsum += w;
    }
    return acc / wsum;
}

/// Restrained desert heat-shimmer sampling offset.
///
/// Gated purely on distance — `z` is the linear view depth this pass already
/// has bound, so no new texture or uniform is needed to know "how far away is
/// this pixel". It fades in well past the DOF far ramp (140-700 m here against
/// DOF's own 130-620 m) so the two effects agree on what counts as "distant"
/// without literally sharing a constant, and it goes to exactly zero below
/// that band, over the sky (`isBackground`), and whenever `heatStrength` is 0
/// — the last of which is the toggle's true no-op path.
///
/// This pass has depth but not shading, so it cannot know which distant
/// pixels are in shadow the way the ground material can; the item asking for
/// this effect accepts that this pass lacks that information, so the offset
/// here is not shadow-gated. Kept weak enough in practice (a few tenths of a
/// pixel at `heatShimmerStrength`'s default) that the omission should not
/// read as wrong — the ground material's own shading still darkens shadowed
/// terrain normally, the shimmer just does not additionally back off there.
///
/// Only the vertical component wobbles — real heat haze rises and wavers, it
/// does not swim sideways — so this never reads as the frame sliding around
/// under camera motion, only as air shimmering in place.
fn heatOffset(z: f32, uv: vec2f, t: f32) -> vec2f {
    if (uniforms.heatStrength <= 0.0 || isBackground(z)) { return vec2f(0.0); }

    let far01 = smoothstep(140.0, 700.0, z);
    if (far01 <= 0.0) { return vec2f(0.0); }

    // Two incommensurate frequencies so the wobble does not read as a single
    // repeating wave — the same reasoning the wake's erosion noise uses.
    let wob = sin(uv.x * 38.0 + t * 0.9) * 0.6
            + sin(uv.y * 61.0 - t * 1.35 + uv.x * 11.0) * 0.4;

    // In UV space: 0.0016 is a little over two pixels at 1440p and full
    // strength, at the far edge of the ramp only — restrained by construction,
    // not just by the default slider value.
    return vec2f(0.0, wob * far01 * uniforms.heatStrength * 0.0016);
}

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    let uv = input.vUV;
    // True depth at the true pixel — used for both the shimmer gate and the
    // circle-of-confusion below, so the two effects never disagree about how
    // far away this pixel actually is.
    let z = textureSampleLevel(depthTex, depthTexSampler, uv, 0.0).r;

    let hUV = uv + heatOffset(z, uv, uniforms.time);
    let centre = textureSampleLevel(sceneTex, sceneTexSampler, hUV, 0.0);

    var outCol = centre.rgb;
    if (uniforms.enabled > 0.5) {
        let r = abs(cocOf(z, uniforms.focusDist)) * uniforms.maxCoc;
        // Under a pixel and a half there is nothing a gather can do that the
        // display transform will not throw away, and this is the branch almost
        // the whole frame takes.
        if (r >= 1.5) { outCol = gather(hUV, input.position.xy, r, centre.rgb); }
    }

    fragmentOutputs.color = vec4f(outCol, centre.a);
}
