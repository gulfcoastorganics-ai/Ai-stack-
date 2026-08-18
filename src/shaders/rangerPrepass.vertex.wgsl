// Scene depth-prepass vertex shader for the Ranger meshes — same rigid
// transform as rangerChar.vertex.wgsl/rangerDepth.vertex.wgsl. Shares the
// generic `prepass` fragment every other caster with nothing to discard
// already reuses (writes linear view depth + a specular mask).

attribute position: vec3f;

uniform world: mat4x4f;
uniform viewProjection: mat4x4f;

varying vViewZ: f32;
varying vMask: f32;

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
    let world = uniforms.world * vec4f(vertexInputs.position, 1.0);
    let clip = uniforms.viewProjection * world;
    vertexOutputs.vViewZ = clip.w;
    vertexOutputs.vMask = 0.0;
    vertexOutputs.position = clip;
}
