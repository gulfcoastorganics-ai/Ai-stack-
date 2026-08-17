// Shadow-pass vertex shader for the surf wake.
//
// Runs the identical `wakePoint` out of the shared include, so the surface in the
// depth map is the surface being drawn. The erosion has to travel with it — the
// fragment stage below discards the same texels — or the wake would cast the
// shadow of a solid wall it is not actually rendering, which on a crest that is
// half powder is the difference between a shadow and a stripe.

#include<snowNoise>
#include<snowWake>

attribute position: vec3f;   // (column, row, side)

uniform lightViewProjection: mat4x4f;
uniform wakeCount: f32;
uniform wakeCols: f32;
uniform wakeRows: f32;
uniform wakeTime: f32;

var wakeTex: texture_2d<f32>;
var wakeTexSampler: sampler;

varying vQ: f32;
varying vAlong: f32;
varying vAge: f32;
/// Carried through rather than declared again in the fragment stage, so the two
/// halves of the depth pass cannot end up eroding at different moments.
varying vTime: f32;

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
    let side = vertexInputs.position.z;
    let u = vertexInputs.position.x / max(uniforms.wakeCols - 1.0, 1.0);
    let q = vertexInputs.position.y / max(uniforms.wakeRows - 1.0, 1.0);

    let P = wakePoint(wakeTex, uniforms.wakeCount, u, q, side, uniforms.wakeTime);
    let sc = wakeScalars(wakeTex, uniforms.wakeCount, u, side);

    vertexOutputs.vQ = q;
    vertexOutputs.vAlong = sc.z;
    vertexOutputs.vAge = sc.w;
    vertexOutputs.vTime = uniforms.wakeTime;
    vertexOutputs.position = uniforms.lightViewProjection * vec4f(P, 1.0);
}
