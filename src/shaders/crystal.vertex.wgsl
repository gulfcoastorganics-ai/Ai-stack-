// Crystallise — ice formation, vertex placement.
//
// `position` is (crystalIndex, vertexIndex, 0) and carries no geometry, exactly
// as every other data-driven mesh here. Ninety-six crystals are one draw and a
// 3 x 96 upload.
//
// No normal is emitted. The fragment shader takes it from the derivatives of the
// world position, which gives exact flat facets for free — and a facet is what an
// ice crystal is. Interpolated vertex normals would round the edges off and turn
// a crystal into a lumpy cone, which is the one thing it must not look like.

#include<snowNoise>
#include<snowCrystal>

attribute position: vec3f;   // (crystal, vertex, unused)

uniform viewProjection: mat4x4f;
uniform cameraPos: vec3f;

var crystalTex: texture_2d<f32>;
var crystalTexSampler: sampler;

varying vWorld: vec3f;
varying vBase: vec3f;
varying vHeight01: f32;
varying vSeed: f32;
varying vGrowth: f32;
varying vViewDist: f32;

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
    let i = i32(vertexInputs.position.x);
    let v = i32(vertexInputs.position.y);

    let a = textureLoad(crystalTex, vec2i(i, 0), 0);
    let c = textureLoad(crystalTex, vec2i(i, 2), 0);

    let P = crystalPoint(crystalTex, i, v);

    vertexOutputs.vWorld = P;
    vertexOutputs.vBase = a.xyz;
    // Fraction of the way up the crystal, which is what the frost and the
    // absorption path are both keyed to: the base is buried in the drift and
    // milky, the tip is clear and lit through.
    vertexOutputs.vHeight01 = clamp((P.y - a.y) / max(a.w, 1e-3), 0.0, 1.0);
    vertexOutputs.vSeed = c.y;
    vertexOutputs.vGrowth = c.x;
    vertexOutputs.vViewDist = distance(P, uniforms.cameraPos);
    vertexOutputs.position = uniforms.viewProjection * vec4f(P, 1.0);
}
