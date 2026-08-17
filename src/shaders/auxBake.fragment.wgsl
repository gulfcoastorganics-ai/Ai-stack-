// Derives everything the snow material needs to know about the macro landform
// that isn't the height itself, by differentiating the *baked* height texture
// rather than the analytic function.
//
// Differentiating the bake (instead of re-evaluating terrainMacroD) guarantees
// the normals describe the exact surface the vertex shader displaces to. If the
// two were derived independently, lighting would disagree with silhouette and
// smooth dunes would show phantom shading seams.
//
// Output channels:
//   R,G  dH/dx, dH/dz in metres per metre
//   B    rock mask, 0 = snow, 1 = bare rock
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

    // -lap so crests come out positive. The scale is set against the actual
    // curvature of the dune field: 15 m of relief at a ~58 m wavelength gives a
    // second derivative around 0.18 m^-1, so this has to be near 1/0.18 to
    // produce a usable gradient. Anything larger saturates to a hard 0/1 mask
    // and the sastrugi cross-fade it drives stops being a cross-fade at all.
    let exposure = clamp(0.5 - lap * 2.2, 0.0, 1.0);

    fragmentOutputs.color = vec4f(dHdx, dHdz, hC.y, exposure);
}
