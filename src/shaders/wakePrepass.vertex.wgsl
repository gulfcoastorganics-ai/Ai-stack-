// Depth-prepass vertex shader for the surf wake. Same `wakePoint` as the beauty
// pass and the shadow pass, and the fragment stage discards the same eroded
// texels — a wall that is half powder must not occlude as if it were solid.

#include<snowNoise>
#include<snowWake>

attribute position: vec3f;   // (column, row, side)

uniform viewProjection: mat4x4f;
uniform wakeCount: f32;
uniform wakeCols: f32;
uniform wakeRows: f32;
uniform wakeTime: f32;

var wakeTex: texture_2d<f32>;
var wakeTexSampler: sampler;

varying vQ: f32;
varying vAlong: f32;
varying vAge: f32;
varying vTime: f32;
varying vViewZ: f32;

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
    let side = vertexInputs.position.z;
    let u = vertexInputs.position.x / max(uniforms.wakeCols - 1.0, 1.0);
    let q = vertexInputs.position.y / max(uniforms.wakeRows - 1.0, 1.0);

    let P = wakePoint(wakeTex, uniforms.wakeCount, u, q, side, uniforms.wakeTime);
    let sc = wakeScalars(wakeTex, uniforms.wakeCount, u, side);

    let clip = uniforms.viewProjection * vec4f(P, 1.0);

    vertexOutputs.vQ = q;
    vertexOutputs.vAlong = sc.z;
    vertexOutputs.vAge = sc.w;
    vertexOutputs.vTime = uniforms.wakeTime;
    vertexOutputs.vViewZ = clip.w;
    vertexOutputs.position = clip;
}
