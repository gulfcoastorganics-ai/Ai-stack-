// -----------------------------------------------------------------------------
// snowShadowLookup — the receiving half of the cascaded shadow maps.
//
// Lifted out of the snow material once the character needed the identical
// lookup. Two independent copies of this would be a slow-motion disaster: the
// Y-flip convention, the receiver-plane gradient and the normal offset are all
// things that are invisible to inspection and wrong in ways that only show up
// as "the shadows swim a bit". One include, one convention.
//
// Contract — every material that includes this must declare:
//
//   uniform sunDir: vec3f                    (points *toward* the sun)
//   uniform cascadeMatrices: array<mat4x4f, 3>
//   uniform cascadeSplits: vec4f
//   uniform cascadeParams: array<vec4f, 3>   (depth range m, ortho width m, -, -)
//   uniform shadowTexel: f32
//   uniform shadowSoftness: f32
//   uniform shadowBias: f32
//   var cascade0/1/2: texture_2d<f32> + matching samplers
//
// and must include <snowShading> first, for `pcssShadow`.
// -----------------------------------------------------------------------------

/// Project into one cascade and run PCSS. Returns 1.0 (lit) outside the
/// cascade's extent, so callers can fall through to a coarser one.
fn sampleCascadeTex(
    tex: texture_2d<f32>,
    samp: sampler,
    m: mat4x4f,
    params: vec4f,
    world: vec3f,
    geoN: vec3f,      // the surface the *depth pass* rendered, not the shading normal
    biasWorld: f32,
    softness: f32,
    noiseRot: f32
) -> f32 {
    let depthRange = params.x;
    let orthoWidth = params.y;
    let texelWorld = orthoWidth * uniforms.shadowTexel;

    // ---- the light's own basis -------------------------------------------
    // Reconstructed here rather than passed in, so it cannot drift out of sync
    // with the matrix. This mirrors Matrix.LookAtLHToRef in shadows.js exactly:
    // forward is the direction the light travels, right = up x forward, and the
    // world up is only swapped out for a near-zenith sun, which this scene's
    // 0.5-45 degree elevation range never reaches.
    let lf = -uniforms.sunDir;
    let lr = normalize(cross(vec3f(0.0, 1.0, 0.0), lf));
    let lu = cross(lf, lr);

    // Surface normal in that basis. `nl.z` is the cosine between the normal and
    // the light's direction of travel, so it goes to zero exactly at the
    // terminator — where the plane is edge-on to the light and its depth
    // gradient is genuinely infinite. Clamped to a slope of 6 (about 80 degrees),
    // past which extrapolating further would start detaching real shadows from
    // their casters rather than preventing acne.
    let nl = vec3f(dot(geoN, lr), dot(geoN, lu), dot(geoN, lf));
    let nz = select(min(nl.z, -1e-3), max(nl.z, 1e-3), nl.z >= 0.0);
    let grad = clamp(vec2f(-nl.x / nz, -nl.y / nz), vec2f(-6.0), vec2f(6.0));

    // Metres of light-space travel per unit UV. Y keeps its sign, because the
    // render-target flip below means v runs *with* light-space Y, not against it.
    let planeNdcPerUV = vec2f(grad.x, grad.y) * orthoWidth / depthRange;

    // ---- normal-offset bias ----------------------------------------------
    // Move the receiver off the surface by a texel's worth before projecting,
    // scaled by how obliquely the light meets it. This is what absorbs the
    // depth quantisation of the map itself, and because it is expressed in this
    // cascade's own texels it needs no per-cascade multiplier: 3 cm in cascade 0,
    // where contact shadows must stay attached, and 40 cm out in cascade 2 where
    // a texel covers that much ground anyway.
    let sinL = sqrt(clamp(1.0 - nl.z * nl.z, 0.0, 1.0));
    let biased = world + geoN * (texelWorld * 1.5 * max(sinL, 0.2));

    let clip = m * vec4f(biased, 1.0);
    let ndc = clip.xyz / clip.w;
    if (any(abs(ndc.xy) > vec2f(1.0)) || ndc.z < 0.0 || ndc.z > 1.0) { return 1.0; }

    // NDC → UV, and the sign on Y is not the one you would write from first
    // principles. It is `+` because the map was rendered into a *render target*,
    // and Babylon flips clip-space Y for those — WebGPU's texture origin is
    // top-left where the framebuffer convention is bottom-left, so the engine
    // negates Y in the vertex stage to compensate. The depth map is therefore
    // already stored flipped, and applying the usual top-down flip here as well
    // undoes it, mirroring every lookup about the middle row of the map.
    //
    // Measured, on the CPU, against a readback of cascade 0: sampling with
    // `0.5 - ndc.y*0.5` put the map and the receiver up to 30 m apart, with the
    // error passing through zero exactly at v = 0.5 and growing linearly either
    // side — the mirror axis. With `0.5 + ndc.y*0.5` the same five points agree
    // to within 0.4 m, which is just the CPU height mirror against the GPU's
    // bicubic. That mirror axis sits at the cascade centre, which is fitted to
    // the camera frustum, which is why the shadows appeared to slide around with
    // camera angle, zoom and player position.
    let uv = vec2f(ndc.x * 0.5 + 0.5, 0.5 + ndc.y * 0.5);

    return pcssShadow(
        tex, samp, uv, ndc.z, uniforms.shadowTexel,
        depthRange, orthoWidth, softness, noiseRot, biasWorld, planeNdcPerUV
    );
}

/// Pick a cascade and evaluate PCSS, cross-fading over the last 12% of each
/// slice so the filter width never visibly steps.
///
/// The cascades are separate bindings rather than one atlas because WGSL cannot
/// index a texture by a runtime value without binding arrays. The branch costs
/// almost nothing: cascade choice is a function of view distance, so it is
/// coherent across essentially every wavefront.
fn sunShadow(world: vec3f, geoN: vec3f, viewDist: f32, noiseRot: f32) -> f32 {
    // A small constant bias, and nothing else. Slope scaling and per-cascade
    // texel-footprint multipliers are both handled inside `sampleCascadeTex`,
    // exactly and in world units, by the receiver-plane gradient and the
    // texel-sized normal offset. Stacking more on top only peter-pans the
    // shadows off their casters.
    let biasWorld = uniforms.shadowBias;

    let sp = uniforms.cascadeSplits;
    let soft = uniforms.shadowSoftness;

    if (viewDist >= sp.z) { return 1.0; }

    if (viewDist < sp.x) {
        let s = sampleCascadeTex(cascade0, cascade0Sampler, uniforms.cascadeMatrices[0],
                                 uniforms.cascadeParams[0], world, geoN, biasWorld, soft, noiseRot);
        let blendStart = sp.x * 0.88;
        if (viewDist <= blendStart) { return s; }
        let s2 = sampleCascadeTex(cascade1, cascade1Sampler, uniforms.cascadeMatrices[1],
                                  uniforms.cascadeParams[1], world, geoN, biasWorld, soft, noiseRot);
        return mix(s, s2, clamp((viewDist - blendStart) / (sp.x - blendStart), 0.0, 1.0));
    }

    if (viewDist < sp.y) {
        let s = sampleCascadeTex(cascade1, cascade1Sampler, uniforms.cascadeMatrices[1],
                                 uniforms.cascadeParams[1], world, geoN, biasWorld, soft, noiseRot);
        let blendStart = sp.y * 0.88;
        if (viewDist <= blendStart) { return s; }
        let s2 = sampleCascadeTex(cascade2, cascade2Sampler, uniforms.cascadeMatrices[2],
                                  uniforms.cascadeParams[2], world, geoN, biasWorld, soft, noiseRot);
        return mix(s, s2, clamp((viewDist - blendStart) / (sp.y - blendStart), 0.0, 1.0));
    }

    let s = sampleCascadeTex(cascade2, cascade2Sampler, uniforms.cascadeMatrices[2],
                             uniforms.cascadeParams[2], world, geoN, biasWorld, soft, noiseRot);
    // Fade the last cascade out at its far edge rather than cutting to lit.
    return mix(s, 1.0, smoothstep(sp.z * 0.85, sp.z, viewDist));
}
