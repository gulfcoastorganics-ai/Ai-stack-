// Bakes the atmospheric scattering integral into an equirectangular LUT.
// Re-run only when the sun moves, never per frame.

#include<snowNoise>
#include<snowAtmosphere>

varying vUV: vec2f;

uniform sunDir: vec3f;
uniform sunIntensity: f32;
uniform groundBounce: vec3f;

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    let dir = latLongToDir(input.vUV);
    var col = nishitaSky(dir, uniforms.sunDir, uniforms.sunIntensity, uniforms.groundBounce);

    // The solar disc itself. Kept out of nishitaSky so the IBL projection can
    // use the same LUT without a 100,000x spike blowing out the SH fit.
    fragmentOutputs.color = vec4f(col, 1.0);
}
