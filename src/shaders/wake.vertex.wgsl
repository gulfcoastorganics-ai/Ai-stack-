// The snow-surf wake.
//
// The mesh carries no geometry: `position` is (column, row, side) and every
// vertex is placed here from the spine data texture, exactly as the spray
// billboards are. So a wake that is 19 m long one frame and 2 m long the next
// costs the same static vertex buffer and one 3 x 96 texture upload.
//
// Normals come from differencing the surface rather than from an analytic
// tangent frame. The surface is a sweep with a per-sample amplitude envelope, a
// backward shear and a lump field on top, and the analytic normal for all of
// that together is both long and easy to get subtly wrong. Three evaluations of
// `wakePoint` cost less than the vertex shader spends on the spine fetch, and
// they cannot disagree with the geometry because they *are* the geometry.

#include<snowNoise>
#include<snowWake>

attribute position: vec3f;   // (column, row, side)

uniform viewProjection: mat4x4f;
uniform cameraPos: vec3f;
uniform wakeCount: f32;
uniform wakeCols: f32;
uniform wakeRows: f32;
uniform wakeTime: f32;

var wakeTex: texture_2d<f32>;
var wakeTexSampler: sampler;

varying vWorld: vec3f;
varying vNormal: vec3f;
varying vQ: f32;
varying vAlong: f32;
varying vAge: f32;
varying vAmp: f32;
varying vCurl: f32;
varying vViewDist: f32;

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
    let side = vertexInputs.position.z;
    let u = vertexInputs.position.x / max(uniforms.wakeCols - 1.0, 1.0);
    let q = vertexInputs.position.y / max(uniforms.wakeRows - 1.0, 1.0);

    let tm = uniforms.wakeTime;
    let P = wakePoint(wakeTex, uniforms.wakeCount, u, q, side, tm);

    // Central-ish differences. The offset flips sign near either edge of the
    // patch so the pair never straddles a clamp, which would silently return a
    // zero-length tangent and a NaN normal on the boundary column.
    let du = 0.65 / max(uniforms.wakeCols - 1.0, 1.0);
    let dq = 0.65 / max(uniforms.wakeRows - 1.0, 1.0);
    let su = select(1.0, -1.0, u > 0.5);
    let sq = select(1.0, -1.0, q > 0.5);

    let Pu = (wakePoint(wakeTex, uniforms.wakeCount, u + du * su, q, side, tm) - P) * su;
    let Pq = (wakePoint(wakeTex, uniforms.wakeCount, u, q + dq * sq, side, tm) - P) * sq;

    // The `* side` is not cosmetic, and leaving it out is a bug that hides.
    //
    // The two walls are mirror images, and mirroring a parametric surface
    // reverses the handedness of its tangent pair — so `cross(Pq, Pu)` points to
    // the concave side of the right-hand wall and to the *convex* side of the
    // left-hand one. The fragment shader turns the normal toward the eye before
    // shading, so the lit result looked fine and the error was invisible in the
    // BRDF. What it was not invisible in was the one thing that asks the normal
    // which side of the sheet it is on: the barrel occlusion landed on the open
    // outer face of the left wall and left the inside of the curl unshaded. One
    // wall dark on the wrong side, the other correct — which is exactly how it
    // presented.
    var N = cross(Pq, Pu) * side;
    let nl = length(N);
    // Degenerate where the amplitude envelope has collapsed the strip onto its
    // own spine — the tail, and the frames just after the player lets go.
    N = select(vec3f(0.0, 1.0, 0.0), N / max(nl, 1e-8), nl > 1e-7);

    let sc = wakeScalars(wakeTex, uniforms.wakeCount, u, side);

    vertexOutputs.vWorld = P;
    vertexOutputs.vNormal = N;
    vertexOutputs.vQ = q;
    vertexOutputs.vAlong = sc.z;
    vertexOutputs.vAge = sc.w;
    vertexOutputs.vAmp = sc.x;
    vertexOutputs.vCurl = sc.y;
    vertexOutputs.vViewDist = distance(P, uniforms.cameraPos);
    vertexOutputs.position = uniforms.viewProjection * vec4f(P, 1.0);
}
