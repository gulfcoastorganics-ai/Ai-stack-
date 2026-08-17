// Derives everything the ground material needs to know about the macro
// landform that isn't the height itself, by differentiating the *baked*
// height texture rather than the analytic function.
//
// Differentiating the bake (instead of re-evaluating terrainMacroD) guarantees
// the normals describe the exact surface the vertex shader displaces to. If the
// two were derived independently, lighting would disagree with silhouette and
// smooth dunes would show phantom shading seams.
//
// Output channels:
//   R,G  dH/dx, dH/dz in metres per metre
//   B    rock mask, 0 = sand, 1 = bare rock
//   A    exposure: 1 on scoured crests, 0 in sheltered hollows

varying vUV: vec2f;

var heightTex: texture_2d<f32>;
var heightTexSampler: sampler;

uniform texelWorld: f32; // world metres per height texel
uniform invHeightRes: f32;

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    let uv = input.vUV;
    let t = uniforms.invHeightRes;
    let d = uniforms.texelWorld;

    let hL = textureSample(heightTex, heightTexSampler, uv - vec2f(t, 0.0));
    let hR = textureSample(heightTex, heightTexSampler, uv + vec2f(t, 0.0));
    let hD = textureSample(heightTex, heightTexSampler, uv - vec2f(0.0, t));
    let hU = textureSample(heightTex, heightTexSampler, uv + vec2f(0.0, t));
    let hC = textureSample(heightTex, heightTexSampler, uv);

    // Central difference — second-order accurate, and symmetric so flat ground
    // produces exactly zero slope instead of a bias.
    let dHdx = (hR.x - hL.x) / (2.0 * d);
    let dHdz = (hU.x - hD.x) / (2.0 * d);

    // --- exposure ----------------------------------------------------------
    // Wide-stencil Laplacian: positive on convex crests (which the wind scours
    // and packs into sastrugi), negative in concave hollows (where loose drift
    // collects). Sampling wide deliberately ignores the fine corrugation and
    // answers only "is this a crest or a pocket".
    let w = t * 6.0;
    let wd = d * 6.0;
    let lL = textureSample(heightTex, heightTexSampler, uv - vec2f(w, 0.0)).x;
    let lR = textureSample(heightTex, heightTexSampler, uv + vec2f(w, 0.0)).x;
    let lD = textureSample(heightTex, heightTexSampler, uv - vec2f(0.0, w)).x;
    let lU = textureSample(heightTex, heightTexSampler, uv + vec2f(0.0, w)).x;
    let lap = (lL + lR + lD + lU - 4.0 * hC.x) / (wd * wd);

    // -lap so crests come out positive.
    //
    // SANDSTORM Phase 4: the macro landform's crests are now genuine slope
    // kinks (see `duneShape01` in `lib/terrain.wgsl`) rather than smoothly
    // rounded fBm peaks, so the same wide stencil now measures noticeably
    // higher curvature at a crest than SNOWFLOW's snow field did. The scale
    // below is retuned down from SNOWFLOW's 2.2 accordingly, so a typical
    // dune crest still lands short of hard saturation and the exposure field
    // stays a genuine 0..1 gradient — every consumer of it (the ground
    // material's sastrugi cross-fade, the Phase 2 downhill-migration term,
    // the Phase 2 ambient wind-drift particle gate) needs graded values, not
    // a binary mask. This is an estimate consistent with the new terrain's
    // amplitude/wavelength targets, not a measured constant — see the browser
    // checklist for confirming crests read as scoured/bright without washing
    // out mid-slope shading.
    let exposure = clamp(0.5 - lap * 1.3, 0.0, 1.0);

    fragmentOutputs.color = vec4f(dHdx, dHdz, hC.y, exposure);
}
