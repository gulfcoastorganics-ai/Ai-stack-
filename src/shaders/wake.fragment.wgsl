// -----------------------------------------------------------------------------
// The snow-surf wake — shading.
//
// This is snow that has just left the ground, and it is a different material from
// the field it came out of even though it is the same substance. Freshly broken
// snow is looser, brighter and rougher than the pack, and — the part that matters
// most here — it is *thin*. A wave crest is centimetres of powder held up in the
// air, so it transmits: with the sun low and behind it, the lip should light up
// from the inside rather than going to silhouette.
//
// So the subsurface term is driven off the section parameter rather than off a
// constant: thick and opaque at the base where the wall meets the trench, thin
// and glowing at the lip. That single gradient is most of what separates this
// from a white ribbon.
//
// Everything else — the cascades, the SH ambient, the glints, the aerial
// perspective — is the same code the snow field runs, out of the same includes.
// The wake has to sit in the frame as part of the same world.
// -----------------------------------------------------------------------------

#include<snowNoise>
#include<snowShading>
#include<snowSpellLights>
#include<snowAtmosphere>
#include<snowWake>

varying vWorld: vec3f;
varying vNormal: vec3f;
varying vQ: f32;
varying vAlong: f32;
varying vAge: f32;
varying vAmp: f32;
varying vCurl: f32;
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
uniform sssStrength: f32;
uniform glintIntensity: f32;
uniform glintGrazing: f32;
uniform wakeTime: f32;
/// Per-term diagnostic. See the switch at the bottom; `SNOWFLOW.wake.debug`.
uniform wakeDebug: f32;

uniform spellLightPos: array<vec4f, 4>;
uniform spellLightCol: array<vec4f, 4>;
uniform spellLightCount: f32;

#include<snowShadowLookup>

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    let q = input.vQ;

    if (wakeEroded(input.vAlong, q, input.vAge, uniforms.wakeTime)) { discard; }

    let world = input.vWorld;
    let V = normalize(uniforms.cameraPos - world);
    let L = uniforms.sunDir;

    // The wake is an open sheet with a curl in it, so both faces are visible and
    // winding says nothing useful. Turning the normal toward the eye is right for
    // a sheet of powder a few centimetres thick — light gets through it either
    // way, and the alternative is a black inside face on the barrel.
    let Ng = normalize(input.vNormal);
    let facing = select(-1.0, 1.0, dot(Ng, V) >= 0.0);
    var N = Ng * facing;
    let geoN = N;

    // `Ng` is built by the sweep pointing to the *concave* side, so this is true
    // exactly when the eye is inside the curl. That is the one thing the shading
    // needs to know that the normal alone cannot say: the inside of a barrel of
    // snow is a cave, and it has to go dark and blue or the whole wall reads as a
    // cut-out lit from nowhere.
    let inside = facing > 0.0;

    // Broken snow grain. Cheap, and without it the wall is the one surface in
    // frame with no detail on it, which is instantly legible next to a snow
    // field carrying three scales of it.
    let ddxW = dpdx(world);
    let ddyW = dpdy(world);
    let footprint = max(length(vec2f(length(ddxW.xz), length(ddyW.xz))), 1e-4);
    // Two oblique projections of the world position rather than the XZ plane.
    // The wave face is close to vertical over most of its height, so a planar XZ
    // lookup barely moves across it and the grain comes out as horizontal
    // banding — the one pattern that reads as a rendering error rather than as
    // snow. Slicing 2D noise along two non-axis-aligned directions gives a field
    // that varies at the same rate whichever way the surface is facing, for the
    // cost of two dot products.
    let gp = vec2f(
        dot(world, vec3f(0.91, 0.23, -0.35)),
        dot(world, vec3f(0.28, 0.84, 0.46))
    );
    // Two scales, each faded out by pixel footprint, mirroring what the snow
    // material does over three. One scale alone gives the wall a single
    // characteristic grain size, which is exactly how it reads as a different
    // substance from the field it was thrown out of.
    let up = select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), abs(N.y) > 0.99);
    let T = normalize(cross(up, N));
    let B = cross(N, T);

    let fineFade = 1.0 - smoothstep(0.012, 0.09, footprint);
    if (fineFade > 0.002) {
        let g = noised(gp * 26.0);
        N = normalize(N + (T * g.y + B * g.z) * 0.15 * fineFade);
    }
    let coarseFade = 1.0 - smoothstep(0.09, 0.55, footprint);
    if (coarseFade > 0.002) {
        let g = noised(gp * 5.5);
        N = normalize(N + (T * g.y + B * g.z) * 0.10 * coarseFade);
    }

    // ------------------------------------------------------------- material
    // Freshly displaced snow: brighter and rougher than the pack it came out of.
    let albedo = vec3f(0.895, 0.920, 0.965);
    let roughness = 0.80;
    let f0 = vec3f(0.026);

    // Thin at the lip, deep at the base. This is the gradient the whole read
    // rests on — see the note at the top.
    //
    // The lip end does not go to zero. A wall of thrown powder is ten to thirty
    // centimetres through, not tissue: at 0.04 the transmission lobe runs at
    // near full amplitude with a nearly white tint, and since it is multiplied by
    // a 13-degree sun whose beam is roughly 17:13:6, the result was several times
    // brighter than the direct diffuse and unmistakably *warm*. On white snow
    // that reads as dirt — the outer face of the wall came out brown.
    let thickness = mix(0.92, 0.32, smoothstep(0.15, 0.95, q));

    // ------------------------------------------------------------- lighting
    let NdotL = dot(N, L);
    let NdotV = clamp(dot(N, V), 1e-4, 1.0);
    let noiseRot = ign(input.position.xy) * 6.28318530718;
    let shadow = sunShadow(world, geoN, input.vViewDist, noiseRot);

    let sun = uniforms.sunRadiance;
    const INV_PI: f32 = 0.31830988618;

    // ---- occlusion ---------------------------------------------------------
    // Analytic, because the shadow map cannot supply it. The wake is a
    // zero-thickness sheet, so a point on it sits at exactly the depth its own
    // caster wrote and can never self-occlude; and under a 13-degree sun the
    // lip's cast shadow lands metres away rather than on the face beneath it.
    // Every bit of the "inside the curl is dark" read therefore has to come from
    // here, and its absence is what made the first version look like a white
    // cut-out pasted over the snow.
    //
    //   base      the foot of the wall stands in the trench it came out of
    //   barrel    the concave side is enclosed by the overhang above it, and the
    //             harder the curl the less sky it sees
    // Only the inside of the curl, and nothing else.
    //
    // Every open face has to render at *exactly* the brightness of the snow it
    // was thrown out of, and the reason is the tonemapper rather than the
    // lighting. AgX desaturates hard as it approaches its shoulder, which is what
    // makes sunlit snow read as white despite being lit by a beam that is roughly
    // 17:13:6. Half a stop below that, the curve stops rolling the saturation off
    // and the same warm beam on the same white albedo comes back as tan. So a
    // broad, gentle darkening of the wall — which is what an ambient-occlusion
    // term looks like, and what two earlier passes here applied — does not read
    // as "slightly shaded snow". It reads as brown snow, next to white snow.
    //
    // The wall is therefore left at full brightness everywhere it is genuinely
    // open, and darkened only where it is genuinely enclosed.
    let barrel = select(0.0, smoothstep(0.05, 0.75, q) * (0.45 + 0.55 * input.vCurl), inside);
    let occ = mix(1.0, 0.30, barrel);

    let diff = wrapDiffuse(NdotL, 0.66);
    let directTerm = albedo * INV_PI * sun * diff * shadow;
    var color = directTerm;

    // Transmission, coupled much harder to the shadow term than the snow field's
    // is. On the ground a shadowed drift is still fed by light scattering in from
    // the lit snow a few centimetres away; a wall of powder standing in its own
    // shadow with air on both sides has no such neighbour, and leaving it at half
    // strength was most of why the shadowed side stayed white.
    // Strength well under the terrain's, and a wider scattering radius so the
    // tint reaches the blue end at a lower thickness. Together those keep the
    // backlit glow reading as light coming *through snow* rather than as the sun
    // reflecting off something tan.
    let sss = snowSubsurface(N, L, V, sun, thickness, uniforms.sssStrength * 0.45, 1.5);
    let sssTerm = sss * albedo * mix(0.18, 1.0, shadow);
    color += sssTerm;

    var specTerm = vec3f(0.0);
    if (NdotL > 0.0) {
        let H = normalize(V + L);
        let D = distributionGGX(clamp(dot(N, H), 0.0, 1.0), roughness);
        let Vis = visSmithGGXCorrelated(NdotV, NdotL, roughness);
        let F = fresnelSchlick(clamp(dot(V, H), 0.0, 1.0), f0);
        specTerm = sun * D * Vis * F * NdotL * shadow;
    }
    color += specTerm;

    // Ambient, plus the bounce off the enormous white surface underneath it.
    var irradiance = shIrradiance(N, uniforms.shR) * uniforms.ambientIntensity;
    irradiance += shIrradiance(vec3f(0.0, 1.0, 0.0), uniforms.shR)
                * uniforms.ambientIntensity * 0.30 * clamp(-N.y * 0.5 + 0.5, 0.0, 1.0) * albedo;
    let ambientTerm = albedo * INV_PI * irradiance;
    color += ambientTerm;

    let R = reflect(-V, N);
    let skyRefl = textureSampleLevel(skyLUT, skyLUTSampler, dirToLatLong(R), sqrt(roughness) * 6.0).rgb;
    let skyTerm = skyRefl * fresnelSchlickRough(NdotV, f0, roughness) * uniforms.ambientIntensity;
    color += skyTerm;

    // Spell light, above the occlusion so the barrel darkens it along with
    // everything else — a spell cast into the inside of a curl should light the
    // cave, not shine through the wall of it.
    if (uniforms.spellLightCount > 0.5) {
        color += spellLighting(
            world, N, V, albedo, thickness,
            uniforms.sssStrength * 0.45, 1.5,
            uniforms.spellLightPos, uniforms.spellLightCol, uniforms.spellLightCount
        );
    }

    // ---- occlusion, applied last and to everything ------------------------
    //
    // Two rules, both learned the hard way, and both about hue rather than
    // brightness:
    //
    //  1. It scales the *finished radiance*, not the ambient. The textbook AO
    //     scales ambient and leaves direct light alone, but in this scene the
    //     ambient is where all the blue lives — the sky is strongly blue-shifted
    //     by construction and the sun is a 13-degree beam at roughly 17:13:6.
    //     Attenuating one and not the other does not darken a surface, it
    //     re-weights a warm source against a cool one.
    //
    //  2. Wherever it *does* darken, it goes blue in proportion. A surface that
    //     dims without shifting hue drops below the tonemapper's desaturating
    //     shoulder still carrying the sun's warmth, and lands on tan. Snow does
    //     not do that: light reaching into a fold of snow has scattered through
    //     snow to get there, and snow absorbs red over any appreciable path,
    //     which is why a real snow cave is blue and not grey. Tying the tint to
    //     the darkening rather than to `barrel` directly means the two can never
    //     drift apart.
    let caveTint = mix(vec3f(1.0), vec3f(0.55, 0.72, 1.0), (1.0 - occ) * 0.95);
    color *= occ * caveTint;

    if (uniforms.glintIntensity > 0.001) {
        let g = snowGlints(
            world.xz, N, V, L, footprint,
            uniforms.glintIntensity, uniforms.glintGrazing
        );
        color += sun * g * shadow * 0.5;
    }

    color = applyAerial(
        color, uniforms.cameraPos, world, -V, L,
        skyLUT, skyLUTSampler, sun,
        uniforms.fogDensity, uniforms.fogHeightFalloff, uniforms.fogStart,
        uniforms.aerialStrength
    );

    // ------------------------------------------------------------------ debug
    //
    // Per-term, because "the wall is the wrong colour" is not a question any
    // amount of staring at the composite can answer. Each mode returns one term
    // in the same radiance units the beauty pass works in, so the tonemapper
    // shows them at the exposure they actually contribute at, and two of them
    // side by side say immediately which one is carrying the hue.
    //
    //   1 direct  2 subsurface  3 ambient  4 sky spec  5 sun spec
    //   6 occlusion (grey)      7 shadow (grey)        8 |N.L| (grey)
    let dbg = uniforms.wakeDebug;
    if (dbg > 0.5) {
        if (dbg < 1.5) { color = directTerm; }
        else if (dbg < 2.5) { color = sssTerm; }
        else if (dbg < 3.5) { color = ambientTerm; }
        else if (dbg < 4.5) { color = skyTerm; }
        else if (dbg < 5.5) { color = specTerm; }
        else if (dbg < 6.5) { color = vec3f(occ * 12.0); }
        else if (dbg < 7.5) { color = vec3f(shadow * 12.0); }
        else if (dbg < 8.5) { color = vec3f(max(NdotL, 0.0) * 12.0); }
        // Unscaled, to line up with the snow material's own `ndotl` view — the
        // only way to compare the two surfaces is on one screen at one scale.
        else if (dbg < 9.5) { color = vec3f(max(NdotL, 0.0)); }
        // 10: which side of the sheet the eye is on. Red = inside the curl,
        // green = the open outer face. The two walls are mirror images, so this
        // is the view that says whether they agree.
        else { color = select(vec3f(0.0, 9.0, 0.0), vec3f(9.0, 0.0, 0.0), inside); }
    }

    fragmentOutputs.color = vec4f(color, 1.0);
}
