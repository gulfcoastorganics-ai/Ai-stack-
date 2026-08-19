// Depth-prepass vertex shader for the skinned body. Same skinning path as
// char.vertex.wgsl and charDepth.vertex.wgsl, from the same include.

#include<snowCharSkin>

attribute position: vec3f;
attribute boneIdx: vec4f;
attribute boneWt: vec4f;

uniform viewProjection: mat4x4f;

var charTex: texture_2d<f32>;
var charTexSampler: sampler;

varying vViewZ: f32;
varying vMask: f32;

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
    let world = skinPoint(charTex, vertexInputs.boneIdx, vertexInputs.boneWt, vertexInputs.position);
    let clip = uniforms.viewProjection * vec4f(world, 1.0);
    vertexOutputs.vViewZ = clip.w;
    vertexOutputs.vMask = 0.0;
    vertexOutputs.position = clip;
}
