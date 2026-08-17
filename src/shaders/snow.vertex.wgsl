#include<snowNoise>
#include<snowTerrain>
#include<snowDeform>
#include<snowClipmap>

// position packs the clipmap addressing: (gridI, ringLevel, gridJ).
attribute position: vec3f;

uniform viewProjection: mat4x4f;
uniform cameraPos: vec3f;

/// Where the clipmap rings are centred — the *character*, not the camera.
///
/// This is the whole reason carved snow holds still while you orbit. Ring 0 is
/// 6.8 m of half-extent and the spring arm sits 3-11 m behind the character, so
/// centring on the camera put the snow directly under the player right on the
/// ring 0 / ring 1 boundary: swinging the camera round re-sampled it between
/// 0.085 m and 0.17 m spacing and the trail visibly changed shape. Centring on
/// the character makes vertex placement a function of world position and player
/// position only, so no camera motion can alter the geometry.
///
/// The cost is that the ground under a fully zoomed-out camera is one ring
/// coarser than it would otherwise be. The camera never leaves ring 1, and it is
/// looking away from that ground anyway.
uniform lodCenter: vec2f;

uniform baseSpacing: f32;
uniform gridHalfN: f32;

uniform worldOrigin: vec2f;
uniform worldSize: f32;
uniform heightRes: f32;

uniform windAngle: f32;
uniform macroAmp: f32;
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

varying vWorld: vec3f;
varying vHeightUV: vec2f;
varying vViewDist: f32;
varying vSpacing: f32;

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
    let grid = vec2f(vertexInputs.position.x, vertexInputs.position.z);
    let level = vertexInputs.position.y;

    let cv = placeClipmapVertex(
        grid,
        level,
        uniforms.lodCenter,
        uniforms.baseSpacing,
        uniforms.gridHalfN
    );

    let worldXZ = cv.worldXZ;
    let hUV = worldToHeightUV(worldXZ, uniforms.worldOrigin, uniforms.worldSize);

    // --- macro height ------------------------------------------------------
    var h = sampleHeightBicubic(heightTex, heightTexSampler, hUV, uniforms.heightRes);

    // --- fine height -------------------------------------------------------
    // Displaced only where the ring is fine enough to resolve it. Past roughly
    // 40 cm spacing the sastrugi is smaller than a triangle, and displacing it
    // there would just alias — the fragment shader keeps carrying it in the
    // normal, which is where it still reads.
    let exposure = textureSampleLevel(auxTex, auxTexSampler, hUV, 0.0).a;
    if (cv.spacing < 0.42) {
        let fade = 1.0 - smoothstep(0.16, 0.42, cv.spacing);
        h += terrainFine(worldXZ, uniforms.windAngle, exposure, uniforms.sastrugiAmp).x * fade;
    }

    // --- deformation -------------------------------------------------------
    // Real displacement, not a normal-map trick: a trench the player can see the
    // far wall of, and berms that break the silhouette against the sky. The
    // fragment shader carries the sub-vertex detail on top.
    //
    // Reaches much further out than the fine layer above, and deliberately so.
    // Sastrugi is a 2 m wavelength at +/-12 cm, so past 0.42 m spacing it is
    // smaller than a triangle and there is nothing to be done but drop it. A
    // trail is the opposite shape of problem — half a metre wide but up to half a
    // metre deep — so it is worth displacing well past the point where the
    // lattice resolves its walls, provided it is band-limited on the way in.
    //
    // `deformHeight` does that filtering from `cv.spacing`, which is what keeps
    // the groove smooth instead of faceted when a ring boundary sweeps across it.
    // The remaining fade only cleans up the tail, where the filter has flattened
    // the trench to nearly nothing anyway.
    //
    // This gate and the filter argument must be mirrored exactly in
    // terrainDepth.vertex.wgsl, or the terrain will shadow against a surface it
    // is not drawing.
    if (cv.spacing < 1.0) {
        let dfade = 1.0 - smoothstep(0.5, 1.0, cv.spacing);
        h += deformHeight(
            deformTex, deformTexSampler, worldXZ,
            uniforms.deformCenter, uniforms.deformSize, uniforms.deformDepthScale,
            cv.spacing
        ) * dfade;
    }

    let world = vec3f(worldXZ.x, h, worldXZ.y);

    vertexOutputs.vWorld = world;
    vertexOutputs.vHeightUV = hUV;
    vertexOutputs.vViewDist = distance(world, uniforms.cameraPos);
    vertexOutputs.vSpacing = cv.spacing;

    vertexOutputs.position = uniforms.viewProjection * vec4f(world, 1.0);
}
