// Shell fur.
//
// The shell offset is already baked into the vertex position at build time, so
// all this adds is droop: gravity, wind and the character's own acceleration,
// applied in world space and scaled by the square of the shell parameter. The
// square is what curves a strand instead of shearing it — the tip moves four
// times as far as the midpoint.

#include<snowCharSkin>

attribute position: vec3f;   // bind-pose world position, shell offset included
attribute normal: vec3f;     // shell direction, unit
attribute uv: vec2f;         // strand field coordinates, in metres of surface
attribute aux: vec2f;        // (shell parameter 0..1, baked occlusion)
attribute boneIdx: vec4f;
attribute boneWt: vec4f;

uniform viewProjection: mat4x4f;
uniform cameraPos: vec3f;
/// World-space displacement applied to a strand tip.
uniform furDroop: vec3f;

var charTex: texture_2d<f32>;
var charTexSampler: sampler;

varying vWorld: vec3f;
varying vNormal: vec3f;
varying vUV: vec2f;
varying vAux: vec2f;
varying vViewDist: f32;

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
    let b = i32(vertexInputs.boneIdx.x);
    var world = skinPoint1(charTex, b, vertexInputs.position);
    let n = normalize(skinDir1(charTex, b, vertexInputs.normal));

    let t = vertexInputs.aux.x;
    world += uniforms.furDroop * (t * t);

    vertexOutputs.vWorld = world;
    vertexOutputs.vNormal = n;
    vertexOutputs.vUV = vertexInputs.uv;
    vertexOutputs.vAux = vertexInputs.aux;
    vertexOutputs.vViewDist = distance(world, uniforms.cameraPos);
    vertexOutputs.position = uniforms.viewProjection * vec4f(world, 1.0);
}
