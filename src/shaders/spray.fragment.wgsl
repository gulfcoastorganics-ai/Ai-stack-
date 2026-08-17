// -----------------------------------------------------------------------------
// Snow spray.
//
// Airborne snow is not a fogged sprite. It is a cloud of ice crystals, and the
// two things that make it read are the two things a plain alpha billboard
// leaves out:
//
//   forward scatter   Looking toward the sun through a puff, it is *brighter*
//                     than the snow behind it and it is warm. Looking down-sun
//                     it is a dim blue-grey. That swing is enormous — well over
//                     a stop — and it is the entire difference between "spray
//                     catching the light" and "grey smoke".
//   shadowing         Spray thrown inside the figure's own shadow must go dark,
//                     or every footfall looks self-illuminated. It reads the
//                     same cascades everything else does.
//
// The billboard is shaded as a sphere: the normal is reconstructed from the
// quad's own coordinates, so a puff has a lit side and a dark side instead of
// being a flat disc.
// -----------------------------------------------------------------------------

#include<snowNoise>
#include<snowShading>
#include<snowSpellLights>
#include<snowAtmosphere>

varying vWorld: vec3f;
varying vCorner: vec2f;
varying vState: vec4f;
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
uniform camRight: vec3f;
uniform camUp: vec3f;
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

uniform spellLightPos: array<vec4f, 4>;
uniform spellLightCol: array<vec4f, 4>;
uniform spellLightCount: f32;

#include<snowShadowLookup>

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    let r2 = dot(input.vCorner, input.vCorner);
    if (r2 > 1.0) { discard; }

    let state = input.vState;
    let kind = state.z;

    // Break the disc's edge. A perfectly circular puff is the tell that gives
    // billboards away; a hashed radial wobble costs one noise fetch.
    let ang = atan2(input.vCorner.y, input.vCorner.x);
    let wob = 1.0 + 0.34 * noise2(vec2f(cos(ang), sin(ang)) * 2.4 + state.y * 37.0);
    let r = sqrt(r2) / wob;
    if (r > 1.0) { discard; }

    // Soft-edged for powder, harder for a clod of thrown snow.
    let edge = mix(
        pow(clamp(1.0 - r * r, 0.0, 1.0), 1.6),
        smoothstep(1.0, 0.65, r),
        kind
    );
    // Powder is close to transparent on its own; density has to come from many
    // grains overlapping, or a single one turns into a decal. 0.26 was low enough
    // that even fifteen hundred live grains read as haze rather than as spray.
    var alpha = state.w * edge * mix(0.36, 0.55, kind);
    if (alpha < 0.004) { discard; }

    // Spherical normal from the billboard's own coordinates.
    let world = input.vWorld;
    let V = normalize(uniforms.cameraPos - world);
    let L = uniforms.sunDir;
    let nz = sqrt(max(0.0, 1.0 - r2));
    let N = normalize(
        uniforms.camRight * input.vCorner.x + uniforms.camUp * input.vCorner.y + V * nz
    );

    let noiseRot = ign(input.position.xy) * 6.28318530718;
    let shadow = sunShadow(world, N, input.vViewDist, noiseRot);

    let sun = uniforms.sunRadiance;
    const INV_PI: f32 = 0.31830988618;

    // Snow crystals in air scatter almost isotropically at the surface and very
    // strongly forward through the volume, so both terms are needed.
    let albedo = vec3f(0.92, 0.94, 0.98);
    let diff = wrapDiffuse(dot(N, L), 0.75);
    var color = albedo * INV_PI * sun * diff * shadow;

    // Forward scatter through the puff. `mu` is 1 looking straight into the sun.
    //
    // The coefficient is small and has to be. A phase function is normalised
    // over the sphere, so using it as a direct multiplier on radiance — without
    // the optical depth and scattering albedo that belong in front of it —
    // overstates the peak by more than an order of magnitude: at 4.2 a footfall
    // puff comes out four times brighter than sunlit snow and clips to flat
    // white.
    let mu = dot(-V, L);
    let fwd = phaseMie(mu, 0.55) * 0.85;
    color += sun * albedo * fwd * mix(0.25, 1.0, shadow) * (1.0 - kind * 0.5);

    // Sky, which is what fills the shadowed side and keeps it blue.
    color += albedo * INV_PI * shIrradiance(N, uniforms.shR) * uniforms.ambientIntensity;

    // Spell light. Airborne snow inside a spell is the most legible thing the
    // dynamic lights do — a mist of crystals a metre from a bright emitter picks
    // up far more of it than the ground does, which is why a Bloom's fallout
    // curtain reads as lit from within rather than as grey powder over a glow.
    if (uniforms.spellLightCount > 0.5) {
        color += spellLightingParticle(
            world, N, albedo,
            uniforms.spellLightPos, uniforms.spellLightCol, uniforms.spellLightCount
        );
    }

    color = applyAerial(
        color, uniforms.cameraPos, world, -V, L,
        skyLUT, skyLUTSampler, sun,
        uniforms.fogDensity, uniforms.fogHeightFalloff, uniforms.fogStart,
        uniforms.aerialStrength
    );

    fragmentOutputs.color = vec4f(color, alpha);
}
