// Shadow-pass vertex shader for the skinned body.
//
// Runs the identical skinning path as char.vertex.wgsl through the shared
// include, so the surface in the depth map is the surface being drawn. The only
// difference is which matrix it is projected by.

#include<snowCharSkin>

attribute position: vec3f;
attribute boneIdx: vec4f;
attribute boneWt: vec4f;

uniform lightViewProjection: mat4x4f;

var charTex: texture_2d<f32>;
var charTexSampler: sampler;

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
    let world = skinPoint(charTex, vertexInputs.boneIdx, vertexInputs.boneWt, vertexInputs.position);
    vertexOutputs.position = uniforms.lightViewProjection * vec4f(world, 1.0);
}
