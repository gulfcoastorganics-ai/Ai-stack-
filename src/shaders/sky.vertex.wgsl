// Skybox. Drawn as a unit cube pinned to the camera, depth-clamped to the far
// plane so it fills exactly whatever the terrain does not.

attribute position: vec3f;

uniform viewProjection: mat4x4f;
uniform cameraPosition: vec3f;
uniform skyScale: f32;

varying vDir: vec3f;

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
    let world = vertexInputs.position * uniforms.skyScale + uniforms.cameraPosition;
    vertexOutputs.vDir = vertexInputs.position;

    var clip = uniforms.viewProjection * vec4f(world, 1.0);
    // Force to the far plane (reversed-Z would flip this; Babylon is not).
    clip.z = clip.w * 0.999999;
    vertexOutputs.position = clip;
}
