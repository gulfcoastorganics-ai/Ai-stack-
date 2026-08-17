// Depth-prepass vertex shader for the garments. Same Catmull-Rom reconstruction
// over the simulated node grid as cloth.vertex.wgsl, from the same include.

#include<snowCharSkin>

attribute position: vec3f;   // (u, v, panel index)

uniform viewProjection: mat4x4f;
uniform panelParams: array<vec4f, 6>;

var charTex: texture_2d<f32>;
var charTexSampler: sampler;

varying vViewZ: f32;
varying vMask: f32;

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
    let pp = uniforms.panelParams[i32(vertexInputs.position.z)];
    let s = sampleCloth(
        charTex, i32(pp.x), i32(pp.y), i32(pp.z),
        vertexInputs.position.x, vertexInputs.position.y
    );
    let clip = uniforms.viewProjection * vec4f(s.pos, 1.0);
    vertexOutputs.vViewZ = clip.w;
    vertexOutputs.vMask = 0.0;
    vertexOutputs.position = clip;
}
