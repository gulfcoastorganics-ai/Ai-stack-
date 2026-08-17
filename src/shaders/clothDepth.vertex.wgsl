// Shadow-pass vertex shader for the garments.
//
// Same Catmull-Rom reconstruction as cloth.vertex.wgsl, from the same include.
// A robe that casts the shape of its bind pose while drawing the shape of its
// simulation is worse than no shadow at all.

#include<snowCharSkin>

attribute position: vec3f;   // (u, v, panel index)

uniform lightViewProjection: mat4x4f;
uniform panelParams: array<vec4f, 6>;

var charTex: texture_2d<f32>;
var charTexSampler: sampler;

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
    let pp = uniforms.panelParams[i32(vertexInputs.position.z)];
    let s = sampleCloth(
        charTex, i32(pp.x), i32(pp.y), i32(pp.z),
        vertexInputs.position.x, vertexInputs.position.y
    );
    vertexOutputs.position = uniforms.lightViewProjection * vec4f(s.pos, 1.0);
}
