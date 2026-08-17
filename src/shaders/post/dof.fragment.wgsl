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

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    let uv = input.vUV;
    let centre = textureSampleLevel(sceneTex, sceneTexSampler, uv, 0.0);

    var outCol = centre.rgb;
    if (uniforms.enabled > 0.5) {
        let z = textureSampleLevel(depthTex, depthTexSampler, uv, 0.0).r;
        let r = abs(cocOf(z, uniforms.focusDist)) * uniforms.maxCoc;
        // Under a pixel and a half there is nothing a gather can do that the
        // display transform will not throw away, and this is the branch almost
        // the whole frame takes.
        if (r >= 1.5) { outCol = gather(uv, input.position.xy, r, centre.rgb); }
    }

    fragmentOutputs.color = vec4f(outCol, centre.a);
}
