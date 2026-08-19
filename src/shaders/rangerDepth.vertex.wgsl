// Shadow-cascade vertex shader for the Ranger meshes.
//
// Rigid transform, same reasoning as rangerChar.vertex.wgsl: no active
// animation yet, so `world` alone is the correct transform, and there is no
// bone skinning to run. Shares `terrainDepth.fragment.wgsl` — the plain
// "write NDC depth" fragment every other rigid/skinned caster in this scene
// already reuses.

attribute position: vec3f;

uniform world: mat4x4f;
uniform lightViewProjection: mat4x4f;

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
    let world = uniforms.world * vec4f(vertexInputs.position, 1.0);
    vertexOutputs.position = uniforms.lightViewProjection * world;
}
