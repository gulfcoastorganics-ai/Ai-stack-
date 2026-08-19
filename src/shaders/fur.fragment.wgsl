// -----------------------------------------------------------------------------
// Shell fur.
//
// Each shell is a copy of the trim's surface, pushed further out. This shader
// decides, per pixel per shell, whether a strand is still present there. Two
// hashed quantities per strand cell do all the work:
//
//   length   how far up the shell stack this strand survives. Uniform-length
//            fur reads as a sponge; the variation is what makes it fur.
//   radius   the strand's cross-section, tapering to nothing at its own tip, so
//            the silhouette is pointed rather than cut off flat.
//
// Lighting is deliberately not a surface BRDF. A strand is a fibre: it scatters
// forward strongly, wraps light most of the way round, and its roots are buried
// in shadow. Wrapped diffuse plus a strong transmission lobe plus depth-based
// occlusion gets all three, and white fur against a low sun then does the thing
// white fur does, which is glow around its edges.
// -----------------------------------------------------------------------------

#include<snowNoise>
#include<snowShading>
#include<snowAtmosphere>

varying vWorld: vec3f;
varying vNormal: vec3f;
varying vUV: vec2f;
varying vAux: vec2f;
varying vViewDist: f32;

var skyLUT: texture_2d<f32>;
var skyLUTSampler: sampler;
var cascade0: texture_2d<f32>;
var cascade0Sampler: sampler;
var cascade1: texture_2d<f32>;
var cascade1Sampler: sampler;
var cascade2: texture_2d<f32>;
var cascade2Sampler: sampler;

uniform cameraPos: vec3f;
uniform sunDir: vec3f;
uniform sunRadiance: vec3f;
uniform shR: array<vec4f, 9>;

uniform cascadeMatrices: array<mat4x4f, 3>;
uniform cascadeSplits: vec4f;
uniform cascadeParams: array<vec4f, 3>;
uniform shadowTexel: f32;
uniform shadowSoftness: f32;
uniform shadowBias: f32;

uniform fogDensity: f32;
uniform fogHeightFalloff: f32;
uniform fogStart: f32;
uniform aerialStrength: f32;
uniform ambientIntensity: f32;

/// Strand cells per metre of surface. 260 is a 3.8 mm pitch.
uniform furDensity: f32;
uniform furColor: vec3f;

#include<snowShadowLookup>

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    let t = input.vAux.x;

    // ---------------------------------------------------------- strand field
    let g = input.vUV * uniforms.furDensity;
    let cell = floor(g);
    let h = hash21(cell);
    let jitter = hash22(cell + vec2f(11.3, 5.7)) - 0.5;

    // How far up this strand reaches. Cut early and often: a shell stack where
    // most strands survive to the top is a solid shell with holes in it.
    let strandLen = 0.30 + 0.70 * h;
    if (t > strandLen) { discard; }

    // Distance to the strand's own axis, in cell units.
    let d = length(fract(g) - 0.5 - jitter * 0.55);
    // Taper: full width at the root, a point at the tip.
    let taper = 1.0 - (t / strandLen);
    let radius = 0.46 * (0.55 + 0.45 * hash21(cell + vec2f(3.1, 9.4))) * sqrt(max(taper, 0.0));
    if (d > radius) { discard; }

    // ------------------------------------------------------------- shading
    let world = input.vWorld;
    let V = normalize(uniforms.cameraPos - world);
    let L = uniforms.sunDir;
    var N = normalize(input.vNormal);
    if (dot(N, V) < 0.0) { N = -N; }

    let noiseRot = ign(input.position.xy) * 6.28318530718;
    var shadow = sunShadow(world, N, input.vViewDist, noiseRot);

    // Self-occlusion down the stack. Roots see almost no sky, tips see all of
    // it — this gradient is what gives shell fur its depth, and without it the
    // trim reads as a flat white band.
    let depth = t / max(strandLen, 1e-3);
    let selfAO = 0.16 + 0.84 * depth * depth;

    const INV_PI: f32 = 0.31830988618;
    let sun = uniforms.sunRadiance;
    let NdotL = dot(N, L);

    // Fibres wrap light almost all the way round.
    let diff = wrapDiffuse(NdotL, 0.65);
    var color = uniforms.furColor * INV_PI * sun * diff * shadow * selfAO;

    // Transmission — the term that makes a fur rim light up against a low sun.
    let back = backScatter(N, L, V, 0.5, 3.0, 1.0);
    color += sun * uniforms.furColor * back * 0.85 * mix(0.4, 1.0, shadow) * selfAO;

    // A dim, wide specular. Fur is not glossy, but a completely matte white
    // reads as paper.
    if (NdotL > 0.0) {
        let H = normalize(V + L);
        let ds = distributionGGX(clamp(dot(N, H), 0.0, 1.0), 0.75);
        color += sun * ds * 0.05 * NdotL * shadow * selfAO;
    }

    let irradiance = shIrradiance(N, uniforms.shR) * uniforms.ambientIntensity;
    color += uniforms.furColor * INV_PI * irradiance * selfAO * input.vAux.y * 1.4;

    color = applyAerial(
        color, uniforms.cameraPos, world, -V, L,
        skyLUT, skyLUTSampler, sun,
        uniforms.fogDensity, uniforms.fogHeightFalloff, uniforms.fogStart,
        uniforms.aerialStrength
    );

    fragmentOutputs.color = vec4f(color, 1.0);
}
