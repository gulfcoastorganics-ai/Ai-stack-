// Bakes the macro landform (dune fields + barchans + rock outcrops) into a
// single-channel float texture covering the whole playable field.
//
// Baked rather than evaluated live for one reason: the CPU needs the same
// heights for character grounding, footfall placement and spell hit points, and
// reading back a GPU bake is the only way to guarantee the two never disagree.
// Re-implementing the noise in JS would drift the moment f32 and f64 rounding
// diverged, and the character would float or sink by centimetres.
//
// This is also the one place SANDSTORM's Phase 4 terrain rewrite is allowed to
// cost more than SNOWFLOW's did: it runs once at load (and again only if the
// art controls below change), never per frame.

#include<snowNoise>
#include<snowTerrain>

varying vUV: vec2f;

uniform worldOrigin: vec2f;
uniform worldSize: f32;
uniform windAngle: f32;
uniform heightAmp: f32;
/// SANDSTORM art controls — see `settings.js` (`duneScale`, `leeSteepness`,
/// `macroVariation`) for defaults, ranges and what each one means.
uniform duneScale: f32;
uniform leeSteepness: f32;
uniform macroVariation: f32;

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    let p = uniforms.worldOrigin + input.vUV * uniforms.worldSize;

    var h = terrainMacro(
        p, uniforms.windAngle, uniforms.heightAmp,
        uniforms.duneScale, uniforms.leeSteepness, uniforms.macroVariation
    );

    // Rock displaces sand upward; sand then re-accumulates on the flatter
    // faces, which the ground material resolves from the mask in the aux
    // bake. Placement reads the same regional mask the dune bodies do, so
    // rock and dune density agree about where the "open ground" is.
    let mask = terrainRegionMask(p, uniforms.windAngle, uniforms.macroVariation);
    let rock = rockField(p, uniforms.windAngle, mask);
    h += rock.x;

    fragmentOutputs.color = vec4f(h, rock.y, 0.0, 1.0);
}
