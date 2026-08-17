// Shadow-pass vertex shader for the ice formations.
//
// Runs the identical `crystalPoint` out of the shared include, so the shape in
// the depth map is the shape being drawn — including the growth curve, which
// matters because the shadow has to grow with the crystal rather than snapping
// to full size on the frame it is planted.

#include<snowNoise>
#include<snowCrystal>

attribute position: vec3f;   // (crystal, vertex, unused)

uniform lightViewProjection: mat4x4f;

var crystalTex: texture_2d<f32>;
var crystalTexSampler: sampler;

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
    let i = i32(vertexInputs.position.x);
    let v = i32(vertexInputs.position.y);
    let P = crystalPoint(crystalTex, i, v);
    vertexOutputs.position = uniforms.lightViewProjection * vec4f(P, 1.0);
}
