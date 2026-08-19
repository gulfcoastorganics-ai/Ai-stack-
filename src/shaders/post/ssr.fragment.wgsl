// -----------------------------------------------------------------------------
// Screen-space reflections, on ice only.
//
// Reflections on wet and ice surfaces only, and on this content that qualifier
// is doing all the work. A snow field is a rough dielectric with a
// 0.028 F0 — there is nothing to reflect off it that the sky lookup in the
// material does not already give exactly. The one genuinely specular surface here
// is what Crystallise leaves behind: hexagonal prisms at roughness 0.07, and the
// glaze they write into the terrain state buffer's ice channel.
//
// So this pass is gated on the prepass mask, and the mask is non-zero on
// precisely those pixels. On every frame where nobody has cast Crystallise it
// costs one texture fetch and a branch, which is why it can afford to march at
// full resolution when it does fire.
//
// What it buys: the ice already reflects the *sky* correctly and cheaply. What it
// cannot know analytically is that there is a dune, a trench, or the character
// standing in the direction it is reflecting. That is the entire content of this
// pass — replace the sky estimate with what is actually there, where the march
// can find it.
// -----------------------------------------------------------------------------

#include<snowPostCommon>

varying vUV: vec2f;

var textureSampler: texture_2d<f32>;
var textureSamplerSampler: sampler;
var depthTex: texture_2d<f32>;
var depthTexSampler: sampler;

uniform projInfo: vec2f;
uniform invRes: vec2f;
uniform enabled: f32;
uniform strength: f32;

/// Coarse steps along the ray, then a short binary refine on the hit.
const STEPS: i32 = 28;
const REFINE: i32 = 5;
/// Thickness the depth buffer is assumed to have, in metres. A screen-space ray
/// can only see the front surface of anything, so a hit is accepted when it lands
/// behind the buffer by less than this — too small and reflections dropped by
/// grazing rays flicker, too large and the ray "hits" the sky behind a dune.
const THICKNESS: f32 = 0.55;

/// The reflection, or a negative weight when the march found nothing.
///
/// A helper rather than the body of `main` because Babylon rewrites a fragment
/// entry point to return its `FragmentOutputs` struct, so a bare `return` inside
/// one does not compile — and a march like this is all early-outs.
fn reflectionAt(uv: vec2f, pix: vec2f, z: f32, mask: f32) -> vec4f {
    let miss = vec4f(0.0, 0.0, 0.0, -1.0);

    let P = viewFromDepth(uv, z, uniforms.projInfo);

    // Facet normal from the depth buffer. On a hexagonal prism that is exactly
    // right — the facets are flat by construction, and the crystal material
    // builds its own shading normal the same way, from screen-space derivatives.
    let e = uniforms.invRes;
    let zr = textureSampleLevel(depthTex, depthTexSampler, uv + vec2f(e.x, 0.0), 0.0).r;
    let zu = textureSampleLevel(depthTex, depthTexSampler, uv + vec2f(0.0, e.y), 0.0).r;
    if (isBackground(zr) || isBackground(zu)) { return miss; }

    let dx = viewFromDepth(uv + vec2f(e.x, 0.0), zr, uniforms.projInfo) - P;
    let dy = viewFromDepth(uv + vec2f(0.0, e.y), zu, uniforms.projInfo) - P;
    let N = normalize(cross(dx, dy));

    let V = normalize(P);            // the camera sits at the view-space origin
    let R = reflect(V, N);
    // A ray heading back toward the eye has nothing on screen to find.
    if (R.z < 0.02) { return miss; }

    // Step length set so the ray crosses roughly one pixel per step near the
    // surface, jittered to break the banding a fixed step leaves on a flat facet.
    let stride = max(0.06, z * 0.035);
    var t = stride * (0.5 + ignPost(pix));
    var prevT = 0.0;
    var hitT = -1.0;

    for (var i = 0; i < STEPS; i++) {
        let Q = P + R * t;
        let sUV = uvFromView(Q, uniforms.projInfo);
        if (any(sUV < vec2f(0.0)) || any(sUV > vec2f(1.0))) { break; }

        let sz = textureSampleLevel(depthTex, depthTexSampler, sUV, 0.0).r;
        let diff = Q.z - sz;
        if (diff > 0.0 && diff < THICKNESS) {
            // Binary refine between the last miss and this hit.
            var lo = prevT;
            var hi = t;
            for (var k = 0; k < REFINE; k++) {
                let mid = (lo + hi) * 0.5;
                let M = P + R * mid;
                let mz = textureSampleLevel(
                    depthTex, depthTexSampler, uvFromView(M, uniforms.projInfo), 0.0
                ).r;
                if (M.z - mz > 0.0) { hi = mid; } else { lo = mid; }
            }
            hitT = hi;
            break;
        }
        prevT = t;
        // Geometric growth: the near field needs fine steps, and the far field is
        // where the ray runs out of screen anyway.
        t += stride * (1.0 + f32(i) * 0.16);
    }

    if (hitT < 0.0) { return miss; }

    let hitUV = uvFromView(P + R * hitT, uniforms.projInfo);

    // Fade at the screen edge, or the reflection ends in a hard line wherever the
    // ray ran out of buffer.
    let edge = min(min(hitUV.x, 1.0 - hitUV.x), min(hitUV.y, 1.0 - hitUV.y));
    let edgeFade = smoothstep(0.0, 0.10, edge);

    // Schlick against ice's F0. At the grazing angles a low sun and a flat glaze
    // produce, this is most of the surface response — which is why replacing the
    // sky estimate with the real dune behind it is worth a pass at all.
    let f = 0.045 + 0.955 * pow(1.0 - clamp(dot(-V, N), 0.0, 1.0), 5.0);

    let refl = textureSampleLevel(textureSampler, textureSamplerSampler, hitUV, 0.0).rgb;
    return vec4f(refl, clamp(mask * f * edgeFade * uniforms.strength, 0.0, 1.0));
}

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    let uv = input.vUV;
    let src = textureSampleLevel(textureSampler, textureSamplerSampler, uv, 0.0);
    let g = textureSampleLevel(depthTex, depthTexSampler, uv, 0.0);

    var outCol = src.rgb;
    if (uniforms.enabled > 0.5 && g.g >= 0.02 && !isBackground(g.r)) {
        let r = reflectionAt(uv, input.position.xy, g.r, g.g);
        if (r.w > 0.0) { outCol = mix(src.rgb, r.rgb, r.w); }
    }

    fragmentOutputs.color = vec4f(outCol, src.a);
}
