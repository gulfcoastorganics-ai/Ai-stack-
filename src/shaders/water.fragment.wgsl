// -----------------------------------------------------------------------------
// Spell water — shading.
//
// The one material in the demo that is not snow. Four things have to be true at
// once or it reads as a blue plastic tube, and they pull against each other:
//
//   it is transparent      You see the field through it, displaced, and the
//                          displacement is what says "this is a lens" rather
//                          than "this is a coloured surface".
//   it is coloured by
//   what it absorbs        Not by an albedo. Water's colour is the *shortfall*
//                          of the light that made it through — red first, then
//                          green — so the tint follows the path length and a
//                          thin wisp comes out nearly clear while the belly of
//                          a metre-wide column goes deep teal.
//   it is mirror-bright    At 13 degrees a wet surface returns almost all of a
//                          grazing view. Fresnel does most of the work of making
//                          it look wet, and it is what keeps a body legible
//                          against a pale sky.
//   it scatters inside     A body of water thrown through the air is full of
//                          bubbles and entrained snow, and that internal
//                          scatter is what keeps the shadowed side of an arc
//                          alive.
//
// **Refraction without a scene copy.** The obvious implementation samples the
// framebuffer behind the surface, which means rendering the opaque pass twice or
// copying a bound render target mid-frame. Neither is necessary here, because of
// what is actually behind the water: sky, or snow, and nothing else. The sky LUT
// already stores both — the Nishita bake writes the iteratively-solved snow
// bounce into every direction below the horizon, precisely so that shadowed snow
// can be lit by the ground it sits on. So a single lookup along the refracted ray
// returns a physically-derived estimate of what is behind the water for *any*
// direction, up or down, at the cost of one texture fetch. Three fetches at three
// slightly different indices of refraction give the chromatic dispersion.
//
// What it cannot show is the specific dune or trail behind the water. At the
// distance and speed these effects are seen at, that is a trade worth making
// twice over: it is exact in hue and energy, it never breaks, it never has to be
// re-ordered against the transparent pass, and it costs three samples of a
// texture the shader is already binding.
// -----------------------------------------------------------------------------

#include<snowNoise>
#include<snowShading>
#include<snowSpellLights>
#include<snowAtmosphere>

varying vWorld: vec3f;
varying vNormal: vec3f;
varying vQ: f32;
varying vU: f32;
varying vRadius: f32;
varying vFoam: f32;
varying vMilk: f32;
varying vAlpha: f32;
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
uniform waterTime: f32;
/// Artistic scale on the absorption coefficients. One slider for "how deep does
/// this water read", which is the single most-tuned number in the material.
uniform waterDepthTint: f32;

uniform spellLightPos: array<vec4f, 4>;
uniform spellLightCol: array<vec4f, 4>;
uniform spellLightCount: f32;

#include<snowShadowLookup>

/// Absorption per metre of path, exaggerated well past real water.
///
/// Clear water absorbs about 0.45/m in red and 0.05/m in blue, which over the
/// ten to forty centimetres a spell body is actually thick produces a tint of a
/// few percent — invisible. A bent body should be *strongly* coloured at arm's
/// length, because it is glacial melt full of entrained snow rather than a
/// swimming pool. These coefficients put the same tint at a tenth of the path
/// length.
const WATER_ABSORB: vec3f = vec3f(3.40, 0.72, 0.34);

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    if (input.vAlpha <= 0.003 || input.vRadius <= 0.0005) { discard; }

    let world = input.vWorld;
    let V = normalize(uniforms.cameraPos - world);
    let L = uniforms.sunDir;

    // Both faces of the body are visible — it is transparent, and the sheet
    // profile is genuinely open — so winding says nothing. Turn the normal
    // toward the eye, exactly as the wake and the garments do.
    let Ng = normalize(input.vNormal);
    var N = select(-Ng, Ng, dot(Ng, V) >= 0.0);
    let geoN = N;

    // Flow-map ripple. Two counter-drifting octaves sliced along two oblique
    // world directions rather than the XZ plane: the body is as often vertical
    // as horizontal, and a planar lookup bands it into horizontal stripes on the
    // vertical parts — the one pattern that reads as a rendering error.
    let ddxW = dpdx(world);
    let ddyW = dpdy(world);
    let footprint = max(length(vec2f(length(ddxW.xz), length(ddyW.xz))), 1e-4);
    let fp = vec2f(
        dot(world, vec3f(0.88, 0.31, -0.36)),
        dot(world, vec3f(0.24, 0.79, 0.56))
    );

    let up = select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), abs(N.y) > 0.99);
    let T = normalize(cross(up, N));
    let B = cross(N, T);

    //
    // This is where *all* of the fine surface detail lives, and it has to be:
    // the mesh is 64 columns by 12 rings whatever the strand is doing, so
    // anything finer than that in the geometry is not detail, it is aliasing.
    // See the note on `waterRelief`. Here the sampling rate is the pixel, so
    // three octaves are affordable and the footprint fade keeps each of them
    // switched off before it can shimmer.
    let t = uniforms.waterTime;
    let rippleFade = 1.0 - smoothstep(0.03, 0.22, footprint);
    if (rippleFade > 0.002) {
        let g1 = noised(fp * 8.5 + vec2f(t * 0.7, -t * 0.5));
        let g2 = noised(fp * 21.0 + vec2f(-t * 1.6, t * 1.1));
        N = normalize(N + (T * (g1.y * 0.085 + g2.y * 0.055)
                         + B * (g1.z * 0.085 + g2.z * 0.055)) * rippleFade);
    }
    let fineFade = 1.0 - smoothstep(0.006, 0.045, footprint);
    if (fineFade > 0.002) {
        let g3 = noised(fp * 62.0 + vec2f(t * 3.1, t * 2.2));
        N = normalize(N + (T * g3.y + B * g3.z) * 0.030 * fineFade);
    }

    let NdotV = clamp(dot(N, V), 1e-4, 1.0);
    let NdotL = dot(N, L);
    let noiseRot = ign(input.position.xy) * 6.28318530718;
    let shadow = sunShadow(world, geoN, input.vViewDist, noiseRot);

    let sun = uniforms.sunRadiance;
    const INV_PI: f32 = 0.31830988618;

    // ---- how far the light travelled through the body ---------------------
    // Grazing views cut a long chord, head-on views a short one. That single
    // relationship is most of what makes a tube of water look like a volume
    // rather than like a shell: the silhouette is always the deepest part of it.
    //
    // The constant term matters as much as the grazing one. Keying the path
    // purely off view angle puts *all* of the colour at the silhouette — which
    // is also exactly where Fresnel is strongest, so the reflection replaces the
    // tint precisely where it exists and the body comes out white. Giving the
    // path a floor proportional to the radius means a fat body is coloured all
    // the way across it, which is what a 30 cm rope of glacial melt looks like.
    let path = clamp(
        input.vRadius * (1.25 + 1.9 * (1.0 - NdotV)) * uniforms.waterDepthTint,
        0.01, 3.0
    );
    let transmit = exp(-WATER_ABSORB * path);

    // ---- refraction, with dispersion --------------------------------------
    // Three indices, one per channel. The spread is small — real dispersion in
    // water is about half a percent across the visible band — but on a surface
    // this curved the ray fans far enough to put a visible fringe on the rim,
    // which is exactly where the eye looks for it.
    let rr = refract(-V, N, 1.0 / 1.3300);
    let rg = refract(-V, N, 1.0 / 1.3330);
    let rb = refract(-V, N, 1.0 / 1.3400);
    // Total internal reflection returns a zero vector; fall back to the mirror
    // direction there, which is what actually happens.
    let mirror = reflect(-V, N);
    let dr = select(mirror, rr, dot(rr, rr) > 0.5);
    let dg = select(mirror, rg, dot(rg, rg) > 0.5);
    let db = select(mirror, rb, dot(rb, rb) > 0.5);

    // A mid mip: the body is rippled, so a mirror-sharp background through it
    // would alias, and a little blur is what a centimetre of moving water does
    // to what is behind it anyway.
    let behind = vec3f(
        textureSampleLevel(skyLUT, skyLUTSampler, dirToLatLong(dr), 1.6).r,
        textureSampleLevel(skyLUT, skyLUTSampler, dirToLatLong(dg), 1.6).g,
        textureSampleLevel(skyLUT, skyLUTSampler, dirToLatLong(db), 1.6).b
    );
    var color = behind * transmit;

    // ---- internal scatter --------------------------------------------------
    // Light that entered the body, bounced off entrained air and snow, and came
    // back out toward the eye. Peaks looking into the sun through the thin
    // parts, so the arc lights up from the inside where the sun is behind it.
    //
    // Tinted by what the water did *not* absorb on the way in and out, so the
    // glow is teal at depth and near-white at the edges, for free.
    //
    // The 1/PI is not decoration. A scattering lobe is a *distribution*, and
    // multiplying radiance by one without the 1/PI that belongs in front of it
    // overstates the peak by a factor of three — which on a term already fed by
    // a 17:13:6 sun put this several times brighter than sunlit snow. The body
    // clipped to flat white along its whole length and no amount of tinting
    // underneath could show through it. Exactly the failure the spray's forward
    // scatter had, for exactly the same reason.
    let inScatter = backScatter(N, L, V, 0.55, 2.6, 1.0);
    let scatterTint = mix(vec3f(0.40, 0.80, 1.0), vec3f(0.72, 0.94, 1.0), exp(-path * 1.6));
    color += sun * INV_PI * scatterTint * inScatter
           * (0.55 + 1.3 * input.vMilk) * uniforms.sssStrength
           * mix(0.30, 1.0, shadow);

    // Sky filling the body from above. Without this the shadowed side of an arc
    // has nothing in it but the refraction, and goes dead.
    color += shIrradiance(N, uniforms.shR) * uniforms.ambientIntensity * INV_PI
           * scatterTint * (0.35 + 0.5 * input.vMilk);

    // ---- slush -------------------------------------------------------------
    // `milkiness` is what a spell dials to move between clear bent water and the
    // snow it tore out of the ground on the way up. It is not a colour: it is an
    // opaque diffuse population *inside* the body, so it fills in behind the
    // transparency rather than tinting it, and the two coexist the way real
    // slush does.
    if (input.vMilk > 0.002) {
        let slushAlbedo = vec3f(0.86, 0.90, 0.96);
        let d = wrapDiffuse(NdotL, 0.62);
        var slush = slushAlbedo * INV_PI * sun * d * shadow;
        slush += slushAlbedo * INV_PI * shIrradiance(N, uniforms.shR)
               * uniforms.ambientIntensity;
        slush += snowSubsurface(N, L, V, sun, 0.45, uniforms.sssStrength * 0.8, 1.2)
               * slushAlbedo * mix(0.35, 1.0, shadow);
        color = mix(color, slush, input.vMilk * 0.85);
    }

    // ---- foam --------------------------------------------------------------
    // The leading edge, where the body is tearing itself apart against the air
    // and the snow. Opaque, white, and broken up by a drifting noise so it is a
    // froth rather than a painted band.
    var foam = input.vFoam;
    if (foam > 0.002) {
        let fn2 = noise2(fp * 22.0 + vec2f(t * 1.7, -t * 1.1)) * 0.5 + 0.5;
        let fn3 = noise2(fp * 61.0 - vec2f(t * 3.3, t * 2.1)) * 0.5 + 0.5;
        foam = clamp(foam * (0.35 + 1.5 * fn2 * (0.5 + 0.7 * fn3)), 0.0, 1.0);
        let foamAlbedo = vec3f(0.93, 0.955, 0.99);
        var fc = foamAlbedo * INV_PI * sun * wrapDiffuse(NdotL, 0.72) * shadow;
        fc += foamAlbedo * INV_PI * shIrradiance(N, uniforms.shR) * uniforms.ambientIntensity;
        fc += snowSubsurface(N, L, V, sun, 0.25, uniforms.sssStrength, 1.4)
            * foamAlbedo * mix(0.4, 1.0, shadow);
        color = mix(color, fc, foam);
    }

    // ---- reflection --------------------------------------------------------
    // Fresnel on water is the whole reason it looks wet, and at a 13-degree sun
    // over a bright sky it is the strongest single term in the frame. Applied
    // after the body terms because it sits *on* the surface: what it returns
    // never went through the water and is therefore never tinted by it.
    //
    // Capped at 0.72 rather than run to the full Schlick 1.0 at grazing. A flat
    // sea does go to a perfect mirror at the horizon, but that limit assumes a
    // surface you cannot see the far side of. This body is a decimetre through
    // and lit from inside it, so letting the reflection reach unity deletes the
    // volume exactly at the silhouette — the one place the eye reads the
    // material from.
    //
    // `milkiness` has to take the *surface* out as well as filling the body in.
    // A vortex of lifted snow at 0.88 milk was still returning a third of the
    // sky at grazing and running a 0.27 roughness lobe, and it came out looking
    // like moulded plastic: opaque, which was right, and polished, which was not.
    // A mass of ice crystals in air has no specular surface at all.
    let F = min(fresnelSchlick(NdotV, vec3f(0.02)), vec3f(0.72));
    let skyRefl = textureSampleLevel(skyLUT, skyLUTSampler, dirToLatLong(mirror), 0.7).rgb;
    color = mix(color, skyRefl, F * (1.0 - foam * 0.7) * (1.0 - input.vMilk * 0.88));

    // Sun glint. A tight lobe, because water is smooth: this is the highlight
    // that runs along the top of an arc and sells its curvature.
    if (NdotL > 0.0) {
        let H = normalize(V + L);
        let rough = mix(0.055, 0.68, max(foam * 0.55, input.vMilk));
        let D = distributionGGX(clamp(dot(N, H), 0.0, 1.0), rough);
        let Vis = visSmithGGXCorrelated(NdotV, NdotL, rough);
        let Fs = fresnelSchlick(clamp(dot(V, H), 0.0, 1.0), vec3f(0.02));
        color += sun * D * Vis * Fs * NdotL * shadow;
    }

    // Shed droplets on the outer skin catch the sun as points. The snow's own
    // glint field, at a much finer cell and gated the same way, so the sparkle
    // on the water and the sparkle on the field are the same effect.
    if (uniforms.glintIntensity > 0.001) {
        let g = snowGlints(
            fp, N, V, L, footprint,
            uniforms.glintIntensity * (0.6 + 0.8 * max(foam, input.vMilk)),
            uniforms.glintGrazing
        );
        color += sun * g * shadow * 0.7;
    }

    // ---- spell light -------------------------------------------------------
    // A spell body lit by its own emitter. This is why a Bloom's column glows
    // from inside instead of being a dark shape against a lit crater.
    if (uniforms.spellLightCount > 0.5) {
        color += spellLightingSurface(
            world, N, V, mix(vec3f(0.35, 0.62, 0.78), vec3f(0.9), input.vMilk),
            vec3f(0.02), 0.12, 0.55,
            uniforms.spellLightPos, uniforms.spellLightCol, uniforms.spellLightCount
        );
    }

    // ---- opacity -----------------------------------------------------------
    //
    // Nearly opaque, which is the opposite of the obvious answer and is the
    // single change that made this read as water rather than as frosted glass.
    //
    // Running the alpha off Fresnel — transparent face-on, mirror at grazing,
    // which is what clear water does — comes out pale and washed, because the
    // background is then counted *twice*: once through the refracted sky lookup,
    // which is the physically-placed, dispersed, absorbed version of it, and
    // again through the blend, which is the undistorted version at full
    // brightness. Over a snow field the second one is white and it wins. A high
    // alpha deletes the duplicate and leaves the refraction as the only path the
    // background takes through the body.
    //
    // What is left for the alpha to do is the ends. The radius tapers to nothing
    // there, so keying opacity to the radius closes the tube on a soft point
    // rather than on a ring of visible section. That is also why nothing fades
    // in `u`: `u` means "along the spine" and cannot tell a ribbon's trailing
    // wisp from the symmetric horn of a crescent wave.
    let taper = clamp(input.vRadius / 0.055, 0.0, 1.0);
    let clearAlpha = taper * mix(0.74, 0.97, 1.0 - NdotV);
    let alpha = mix(clearAlpha, taper, max(foam, input.vMilk * 0.9)) * input.vAlpha;
    if (alpha < 0.004) { discard; }

    color = applyAerial(
        color, uniforms.cameraPos, world, -V, L,
        skyLUT, skyLUTSampler, sun,
        uniforms.fogDensity, uniforms.fogHeightFalloff, uniforms.fogStart,
        uniforms.aerialStrength
    );

    fragmentOutputs.color = vec4f(color, alpha);
}
