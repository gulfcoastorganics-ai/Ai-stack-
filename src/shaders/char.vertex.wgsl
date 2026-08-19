// The body: linear blend skinning straight out of the transform texture.

#include<snowCharSkin>

attribute position: vec3f;   // bind-pose world position
attribute normal: vec3f;     // bind-pose world normal
attribute uv: vec2f;         // weave coordinates
attribute aux: vec2f;        // (material id, baked occlusion)
attribute boneIdx: vec4f;
attribute boneWt: vec4f;

uniform viewProjection: mat4x4f;
uniform cameraPos: vec3f;

var charTex: texture_2d<f32>;
var charTexSampler: sampler;

varying vWorld: vec3f;
varying vNormal: vec3f;
varying vUV: vec2f;
varying vAux: vec2f;
varying vViewDist: f32;

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
    let world = skinPoint(charTex, vertexInputs.boneIdx, vertexInputs.boneWt, vertexInputs.position);
    let n = skinNormal(charTex, vertexInputs.boneIdx, vertexInputs.boneWt, vertexInputs.normal);

    vertexOutputs.vWorld = world;
    vertexOutputs.vNormal = n;
    vertexOutputs.vUV = vertexInputs.uv;
    vertexOutputs.vAux = vertexInputs.aux;
    vertexOutputs.vViewDist = distance(world, uniforms.cameraPos);
    vertexOutputs.position = uniforms.viewProjection * vec4f(world, 1.0);
}
