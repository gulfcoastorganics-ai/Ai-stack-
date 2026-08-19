// Shadow-pass vertex shader for the terrain.
//
// Critically, this uses the *camera* position to place the clipmap, not the
// light — the geometry rendered into the shadow map must be the identical mesh
// the beauty pass draws, or the depths will not correspond and the terrain will
// acne against its own silhouette. Only the view-projection differs.

#include<snowNoise>
#include<snowTerrain>
#include<snowDeform>
#include<snowClipmap>

attribute position: vec3f;

uniform lightViewProjection: mat4x4f;
uniform cameraPos: vec3f;
/// Clipmap ring centre — the character, matching snow.vertex.wgsl exactly.
uniform lodCenter: vec2f;

uniform baseSpacing: f32;
uniform gridHalfN: f32;

uniform worldOrigin: vec2f;
uniform worldSize: f32;
uniform heightRes: f32;

uniform windAngle: f32;
uniform sastrugiAmp: f32;

uniform deformCenter: vec2f;
uniform deformSize: f32;
uniform deformDepthScale: f32;

var heightTex: texture_2d<f32>;
var heightTexSampler: sampler;
var auxTex: texture_2d<f32>;
var auxTexSampler: sampler;
var deformTex: texture_2d<f32>;
var deformTexSampler: sampler;

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
    let grid = vec2f(vertexInputs.position.x, vertexInputs.position.z);
    let level = vertexInputs.position.y;

    let cv = placeClipmapVertex(
        grid, level, uniforms.lodCenter,
        uniforms.baseSpacing, uniforms.gridHalfN
    );

    let worldXZ = cv.worldXZ;
    let hUV = worldToHeightUV(worldXZ, uniforms.worldOrigin, uniforms.worldSize);

    var h = sampleHeightBicubic(heightTex, heightTexSampler, hUV, uniforms.heightRes);

    let exposure = textureSampleLevel(auxTex, auxTexSampler, hUV, 0.0).a;
    if (cv.spacing < 0.42) {
        let fade = 1.0 - smoothstep(0.16, 0.42, cv.spacing);
        h += terrainFine(worldXZ, uniforms.windAngle, exposure, uniforms.sastrugiAmp).x * fade;
    }

    // Carved snow must cast and receive its own shadow, so the depth pass has to
    // see the deformation too. A trail that does not self-shadow reads as a
    // decal painted on flat ground.
    //
    // This gate, the fade and the filter width have to match snow.vertex.wgsl
    // exactly. If this pass displaced on a ring the beauty pass left flat — or
    // band-limited it differently — the terrain would shadow against a surface
    // that is not the one being drawn, and every berm would acne.
    if (cv.spacing < 1.0) {
        let dfade = 1.0 - smoothstep(0.5, 1.0, cv.spacing);
        h += deformHeight(
            deformTex, deformTexSampler, worldXZ,
            uniforms.deformCenter, uniforms.deformSize, uniforms.deformDepthScale,
            cv.spacing
        ) * dfade;
    }

    vertexOutputs.position = uniforms.lightViewProjection * vec4f(worldXZ.x, h, worldXZ.y, 1.0);
}
