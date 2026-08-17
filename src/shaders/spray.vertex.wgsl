// Snow spray billboards.
//
// The mesh carries no geometry: `position` is (particle index, cornerX, cornerY)
// and every corner is placed here from the particle data texture. That keeps the
// vertex buffer static and the per-frame traffic down to eight floats per live
// grain.

attribute position: vec3f;

uniform viewProjection: mat4x4f;
uniform cameraPos: vec3f;
uniform camRight: vec3f;
uniform camUp: vec3f;

var sprayTex: texture_2d<f32>;
var sprayTexSampler: sampler;

varying vWorld: vec3f;
varying vCorner: vec2f;
varying vState: vec4f;   // (age01, seed, kind, alpha)
varying vViewDist: f32;

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
    let i = i32(vertexInputs.position.x);
    let corner = vertexInputs.position.yz;

    let a = textureLoad(sprayTex, vec2i(i, 0), 0);
    let b = textureLoad(sprayTex, vec2i(i, 1), 0);

    // A dead grain has size zero, which collapses all four corners onto one
    // point. The rasteriser then produces no fragments at all, which is a
    // cheaper way to skip a particle than any branch would be.
    let radius = a.w;

    // Spin, hashed off the seed, so a burst is not four hundred identical
    // discs. Rotating the *corner* rather than the texture keeps the billboard
    // square-free.
    let ang = b.y * 6.28318530718 + b.x * (b.y - 0.5) * 3.0;
    let cs = cos(ang);
    let sn = sin(ang);
    let rc = vec2f(corner.x * cs - corner.y * sn, corner.x * sn + corner.y * cs);

    let world = a.xyz + (uniforms.camRight * rc.x + uniforms.camUp * rc.y) * radius;

    vertexOutputs.vWorld = world;
    vertexOutputs.vCorner = corner;
    vertexOutputs.vState = b;
    vertexOutputs.vViewDist = distance(world, uniforms.cameraPos);
    vertexOutputs.position = uniforms.viewProjection * vec4f(world, 1.0);
}
