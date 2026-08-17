// The garments: surface reconstructed from the simulated node grid.
//
// `position` carries no position at all — it is `(u, v, panelIndex)`. Everything
// spatial comes out of `sampleCloth`, which is why a twenty-by-twelve verlet
// solve can be drawn as a sixty-by-thirty surface with no visible faceting.
//
// Emits the same varyings as char.vertex.wgsl so both share one fragment shader.

#include<snowCharSkin>

attribute position: vec3f;   // (u, v, panel index)
attribute uv: vec2f;         // weave coordinates
attribute aux: vec2f;        // (material id, baked occlusion)

uniform viewProjection: mat4x4f;
uniform cameraPos: vec3f;
/// Per panel: (first row in the transform texture, cols, rows, unused).
uniform panelParams: array<vec4f, 6>;

var charTex: texture_2d<f32>;
var charTexSampler: sampler;

varying vWorld: vec3f;
varying vNormal: vec3f;
varying vUV: vec2f;
varying vAux: vec2f;
varying vViewDist: f32;

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
    let pp = uniforms.panelParams[i32(vertexInputs.position.z)];
    let s = sampleCloth(
        charTex, i32(pp.x), i32(pp.y), i32(pp.z),
        vertexInputs.position.x, vertexInputs.position.y
    );

    vertexOutputs.vWorld = s.pos;
    vertexOutputs.vNormal = s.nrm;
    vertexOutputs.vUV = vertexInputs.uv;
    vertexOutputs.vAux = vertexInputs.aux;
    vertexOutputs.vViewDist = distance(s.pos, uniforms.cameraPos);
    vertexOutputs.position = uniforms.viewProjection * vec4f(s.pos, 1.0);
}
