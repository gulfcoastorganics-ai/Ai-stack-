// Beauty-pass vertex shader for the authored Quaternius Ranger meshes.
//
// Rigid transform only — deliberately, not an oversight. The Ranger's
// glTF carries 0 animation clips (see rangerCharacter.js's own audit note),
// so every vertex sits at its bind-pose position for as long as animation
// retargeting hasn't landed. A rigid `world` transform is therefore exactly
// correct for the mesh's current state, and it is what lets the shadow/
// depth casters below skip hand-rolled bone-texture skinning entirely.
// Revisit this file once retargeting adds real skeletal animation.

attribute position: vec3f;
attribute normal: vec3f;
attribute uv: vec2f;

uniform world: mat4x4f;
uniform viewProjection: mat4x4f;
uniform cameraPos: vec3f;

varying vWorld: vec3f;
varying vNormal: vec3f;
varying vUV: vec2f;
varying vViewDist: f32;

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
    let worldPos = uniforms.world * vec4f(vertexInputs.position, 1.0);
    let world = worldPos.xyz;

    // `world`'s upper-left 3x3 is translation-free rotation times a single
    // uniform scale factor (RANGER_SCALE, applied equally on every axis —
    // see rangerCharacter.js) — no shear, so it carries normals directly
    // without the usual inverse-transpose a non-uniform scale would need.
    let n = normalize((uniforms.world * vec4f(vertexInputs.normal, 0.0)).xyz);

    vertexOutputs.vWorld = world;
    vertexOutputs.vNormal = n;
    vertexOutputs.vUV = vertexInputs.uv;
    vertexOutputs.vViewDist = distance(world, uniforms.cameraPos);
    vertexOutputs.position = uniforms.viewProjection * vec4f(world, 1.0);
}
