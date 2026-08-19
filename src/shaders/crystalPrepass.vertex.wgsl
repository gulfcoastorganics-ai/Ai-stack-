// Depth-prepass vertex shader for the ice formations. Same `crystalPoint` and
// the same growth curve as the beauty pass.
//
// This is the one caster that writes a non-zero specular mask, and it is the
// reason the mask exists: ice is the only mirror in a field of matte snow, so
// the reflection pass can early-out on the mask and cost nothing at all on every
// frame where nobody has cast Crystallise.

#include<snowNoise>
#include<snowCrystal>

attribute position: vec3f;   // (crystal, vertex, unused)

uniform viewProjection: mat4x4f;

var crystalTex: texture_2d<f32>;
var crystalTexSampler: sampler;

varying vViewZ: f32;
varying vMask: f32;

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
    let i = i32(vertexInputs.position.x);
    let v = i32(vertexInputs.position.y);
    let P = crystalPoint(crystalTex, i, v);
    let clip = uniforms.viewProjection * vec4f(P, 1.0);
    vertexOutputs.vViewZ = clip.w;
    vertexOutputs.vMask = 1.0;
    vertexOutputs.position = clip;
}
