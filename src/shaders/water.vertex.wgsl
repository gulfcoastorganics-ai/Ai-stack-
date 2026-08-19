// Spell water — vertex placement.
//
// The mesh carries no geometry. `position` is (column, ring, strand) and every
// vertex is placed here from the strand table, exactly as the wake and the spray
// billboards are. Eight strands share one static buffer and one draw.
//
// Normals are differenced out of `waterPoint` rather than derived analytically.
// The surface is a sweep with a per-sample radius, a transported frame, a
// vertical squash and three octaves of relief on top; the analytic normal for
// all of that is long and easy to get subtly wrong, and three extra evaluations
// cannot disagree with the geometry because they *are* the geometry.
//
// A strand that is not in use is switched off by having its table zeroed rather
// than by a branch: radius 0 puts every vertex of it on one point, every triangle
// then has zero area, and the rasteriser produces no fragments. That is cheaper
// than any test, and — more usefully — it means "how many spells are up" never
// changes which pipeline runs or how many draws there are.

#include<snowNoise>
#include<snowWake>
#include<snowWater>

attribute position: vec3f;   // (column, ring, strand)

uniform viewProjection: mat4x4f;
uniform cameraPos: vec3f;
uniform waterCols: f32;
uniform waterRings: f32;
uniform waterTime: f32;
/// Per strand: (profile, milkiness, alpha, column count).
uniform strandParams: array<vec4f, 8>;

var waterTex: texture_2d<f32>;
var waterTexSampler: sampler;

varying vWorld: vec3f;
varying vNormal: vec3f;
varying vQ: f32;
varying vU: f32;
varying vRadius: f32;
varying vFoam: f32;
varying vMilk: f32;
varying vAlpha: f32;
varying vViewDist: f32;

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
    let strand = i32(vertexInputs.position.z);
    let sp = uniforms.strandParams[strand];
    let count = max(sp.w, 2.0);
    let base = strand * 3;

    let u = vertexInputs.position.x / max(uniforms.waterCols - 1.0, 1.0);
    let q = vertexInputs.position.y / max(uniforms.waterRings - 1.0, 1.0);

    let tm = uniforms.waterTime;

    // A dead strand does none of the work below.
    //
    // Every vertex of the lattice runs this shader whether or not its strand is
    // in use, and the eight strands together are thirty-four thousand vertices
    // each evaluating a swept surface four times. Leaving the dead ones to fall
    // out of the maths — radius zero collapses them anyway — cost 1.4 ms a frame
    // for eight strands' worth of spline fetches to produce nothing. The branch
    // is perfectly wavefront-coherent, since a strand is thousands of contiguous
    // vertices, and the common case in this demo is one strand live out of eight.
    let alive = sp.z > 0.001 && sp.w >= 2.0;

    var P = vec3f(0.0);
    var N = vec3f(0.0, 1.0, 0.0);
    var radius = 0.0;
    var foam = 0.0;

    if (alive) {
        P = waterPoint(waterTex, base, count, sp.x, u, q, tm);

        // Central-ish differences, with the offset flipped near either edge of
        // the patch so the pair never straddles a clamp — which would silently
        // return a zero-length tangent and a NaN normal on the boundary column.
        let du = 0.65 / max(uniforms.waterCols - 1.0, 1.0);
        let dq = 0.65 / max(uniforms.waterRings - 1.0, 1.0);
        let su = select(1.0, -1.0, u > 0.5);
        let sq = select(1.0, -1.0, q > 0.5);

        let Pu = (waterPoint(waterTex, base, count, sp.x, u + du * su, q, tm) - P) * su;
        let Pq = (waterPoint(waterTex, base, count, sp.x, u, q + dq * sq, tm) - P) * sq;

        var Nn = cross(Pq, Pu);
        let nl = length(Nn);
        Nn = select(vec3f(0.0, 1.0, 0.0), Nn / max(nl, 1e-8), nl > 1e-7);

        // Orient outward. The tube is a closed surface, and the sign of a
        // differenced cross product on it depends on which way the transported
        // frame happens to wind — so it is resolved against the one thing that
        // cannot be ambiguous: the vector from the spine to the surface. The same
        // test on a sheet is meaningless, and the fragment shader turns that
        // normal toward the eye instead, exactly as the wake does.
        let axis = P - waterSpine(waterTex, base, count, u);
        let outward = select(Nn, -Nn, dot(Nn, axis) < 0.0);
        N = select(Nn, outward, sp.x < 0.5);

        radius = waterRow(waterTex, base, count, u).w;
        foam = waterRow(waterTex, base + 2, count, u).z;
    }

    vertexOutputs.vWorld = P;
    vertexOutputs.vNormal = N;
    vertexOutputs.vQ = q;
    vertexOutputs.vU = u;
    vertexOutputs.vRadius = radius;
    vertexOutputs.vFoam = foam;
    vertexOutputs.vMilk = sp.y;
    vertexOutputs.vAlpha = select(0.0, sp.z, alive);
    vertexOutputs.vViewDist = distance(P, uniforms.cameraPos);
    vertexOutputs.position = uniforms.viewProjection * vec4f(P, 1.0);
}
