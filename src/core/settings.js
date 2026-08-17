/**
 * Central tuning + toggle store.
 *
 * `S` is a flat plain object read directly by systems every frame — no getters,
 * no proxies, no allocation. `SCHEMA` is metadata the settings overlay builds
 * its widgets from, and `onChange` lets systems react to edits that need work
 * (rebuilding a render target, re-freezing a material) rather than just being
 * sampled next frame.
 */

/** @type {Record<string, number|boolean|string>} */
export const S = {
    // ---------------------------------------------------------------- quality
    preset: "ultra",
    resolutionScale: 1.0,

    // ------------------------------------------------------------------- sun
    sunAzimuth: 118, // degrees, compass bearing of the sun
    // Low enough for long raking shadows, high enough that the beam still
    // carries real energy — below ~10 degrees the air mass eats so much of it
    // that the scene goes flat and sky-lit.
    sunElevation: 13.0,
    sunIntensity: 4.2,
    sunTempWarm: 1.0, // 0 = neutral white, 1 = full warm low-sun tint
    ambientIntensity: 1.0,
    ambientBlue: 1.0, // strength of the cool shadow shift

    // ------------------------------------------------------------- atmosphere
    fogDensity: 0.0072,
    fogHeightFalloff: 0.045,
    fogStart: 24,
    aerialStrength: 1.0,
    // Degrees. Drives sastrugi shear and dune orientation. Held 70-80 degrees
    // away from `sunAzimuth`: sastrugi ridges run along the wind, so when the
    // two align the sun rakes down every ridge, lights both flanks identically
    // and the fine structure reads as flat ground.
    windDirection: 42,
    windStrength: 1.0,
    /** Far-field mountain range on the skybox. */
    showMountains: true,
    /** Peak height of that range, metres. */
    mountainHeight: 2150,
    /** Strength of the volumetric shafts spilling past dune crests. */
    shaftStrength: 0.30,

    // ------------------------------------------------------------------- sand
    // Sand grains sparkle far less than ice crystals (mostly quartz/mica
    // flecks rather than facets), and dry granular sand barely transmits
    // light at all, so both defaults sit well below SNOWFLOW's snow values.
    // Structurally still the same tunables — only the resting point changed.
    glintIntensity: 0.22,
    glintGrazing: 0.72, // how hard the grazing-angle gate bites
    sssStrength: 0.15,
    sssRadius: 1.0,
    detailNormalStrength: 1.0,
    macroHeightScale: 1.0,
    sastrugiStrength: 1.0,

    // ----------------------------------------------------------- deformation
    deformDepth: 1.0,
    deformBerm: 1.0,
    refillRate: 1.0,
    deformResolution: 2048,

    // ------------------------------------------------------------- snow-surf
    /** Height of the breaking wall thrown by a carve, as a multiple of 1.45 m. */
    wakeHeight: 1.0,
    /** Density of the plume shed off the wake's lip. */
    wakeSpray: 1.0,
    /** Screen-space speed streaks while surfing. */
    windStreaks: true,
    streakStrength: 1.0,

    // ---------------------------------------------------------------- spells
    /** Master toggle. Off cancels everything in flight and hides both meshes. */
    showSpells: true,
    /** Brightness of the dynamic lights the spells emit. */
    spellLight: 1.0,
    /** Density of the spray every spell throws. */
    spellSpray: 1.0,
    /**
     * Artistic scale on the water's absorption path — glacial melt at one end,
     * tap water at the other. The right value depends on the sun elevation, so
     * it is a slider rather than a constant.
     */
    waterDepthTint: 1.0,

    // ------------------------------------------------------------------ post
    taa: true,
    ssr: true,
    dof: true,
    bloom: true,
    grain: true,
    sharpen: true,
    tonemap: "agx", // "agx" | "aces" | "none"
    // SNOWFLOW measured sunlit snow at ~12 in linear, landing near AgX
    // normalised 0.79 — close enough to the shoulder for rich highlight
    // gradation without actually clipping. Sand's albedo is markedly lower
    // than snow's (see `SAND_ALBEDO` in sky.js and the ground material's own
    // constants), so the same exposure now sits comfortably further from the
    // shoulder: less risk of premature highlight clipping, less bloom bleed
    // off broad sunlit terrain (bloom's own knee is unchanged, in the same
    // exposed units), at the cost of the scene reading a little moodier
    // overall — which fits a late-golden-hour desert better than it would
    // have fit snow. Nudged up slightly rather than left exactly as-is, so
    // the frame is not simply dim: partial compensation, not full parity with
    // SNOWFLOW's brightness target.
    exposure: 0.118,
    contrast: 1.14,
    bloomStrength: 0.22,
    grainStrength: 0.022,
    sharpenStrength: 0.55,
    // Restrained depth-aware desert heat distortion over distant sunlit
    // terrain. Implemented inside the existing DOF pass (see dof.fragment.wgsl)
    // rather than as a new render target or pass, so it is a few extra ALU ops
    // on an already-bound depth/colour pair, not a new cost category.
    heatShimmer: true,
    heatShimmerStrength: 0.35,

    // --------------------------------------------------------------- systems
    showTerrain: true,
    showCharacter: true,
    showWake: true,
    showLightShafts: true,
    wireframe: false,
    freezeTime: false,

    // ----------------------------------------------------------------- debug
    debugView: "beauty", // beauty | deform | normals | depth | cascades | footprint | fineNormals
};

/**
 * Widget metadata. `t`: "f" float slider, "b" bool toggle, "e" enum.
 * @type {{group:string, items:Array<{k:string,l:string,t:string,min?:number,max?:number,step?:number,opts?:string[]}>}[]}
 */
export const SCHEMA = [
    {
        group: "Sun & Sky",
        items: [
            { k: "sunAzimuth", l: "Azimuth", t: "f", min: 0, max: 360, step: 1 },
            { k: "sunElevation", l: "Elevation", t: "f", min: 0.5, max: 45, step: 0.1 },
            { k: "sunIntensity", l: "Intensity", t: "f", min: 0, max: 10, step: 0.05 },
            { k: "sunTempWarm", l: "Warmth", t: "f", min: 0, max: 1, step: 0.01 },
            { k: "ambientIntensity", l: "Ambient", t: "f", min: 0, max: 3, step: 0.01 },
            { k: "ambientBlue", l: "Ambient tint", t: "f", min: 0, max: 2, step: 0.01 },
        ],
    },
    {
        group: "Atmosphere",
        items: [
            { k: "fogDensity", l: "Dust density", t: "f", min: 0, max: 0.03, step: 0.0001 },
            { k: "fogHeightFalloff", l: "Height falloff", t: "f", min: 0, max: 0.3, step: 0.001 },
            { k: "aerialStrength", l: "Aerial persp.", t: "f", min: 0, max: 2, step: 0.01 },
            { k: "windDirection", l: "Wind dir", t: "f", min: 0, max: 360, step: 1 },
            { k: "windStrength", l: "Wind strength", t: "f", min: 0, max: 2, step: 0.01 },
            { k: "showMountains", l: "Far range", t: "b" },
            { k: "mountainHeight", l: "Range height", t: "f", min: 0, max: 2500, step: 10 },
            { k: "showLightShafts", l: "Light shafts", t: "b" },
            { k: "shaftStrength", l: "Shaft amt", t: "f", min: 0, max: 2, step: 0.01 },
        ],
    },
    {
        group: "Sand",
        items: [
            { k: "glintIntensity", l: "Glint", t: "f", min: 0, max: 2, step: 0.01 },
            { k: "glintGrazing", l: "Glint gate", t: "f", min: 0, max: 1, step: 0.01 },
            { k: "sssStrength", l: "Translucency", t: "f", min: 0, max: 3, step: 0.01 },
            { k: "sssRadius", l: "Translucency radius", t: "f", min: 0.1, max: 3, step: 0.01 },
            { k: "detailNormalStrength", l: "Detail normals", t: "f", min: 0, max: 2, step: 0.01 },
            { k: "macroHeightScale", l: "Dune height", t: "f", min: 0, max: 2, step: 0.01 },
            { k: "sastrugiStrength", l: "Ripple strength", t: "f", min: 0, max: 2, step: 0.01 },
        ],
    },
    {
        group: "Deformation",
        items: [
            { k: "deformDepth", l: "Depth", t: "f", min: 0, max: 3, step: 0.01 },
            { k: "deformBerm", l: "Berm mass", t: "f", min: 0, max: 3, step: 0.01 },
            { k: "refillRate", l: "Refill rate", t: "f", min: 0, max: 4, step: 0.01 },
        ],
    },
    {
        group: "Dune-surf",
        items: [
            { k: "wakeHeight", l: "Wake height", t: "f", min: 0, max: 2, step: 0.01 },
            { k: "wakeSpray", l: "Plume density", t: "f", min: 0, max: 2.5, step: 0.01 },
            { k: "windStreaks", l: "Speed streaks", t: "b" },
            { k: "streakStrength", l: "Streak amt", t: "f", min: 0, max: 2, step: 0.01 },
            { k: "showWake", l: "Wake mesh", t: "b" },
        ],
    },
    {
        group: "Spells",
        items: [
            { k: "showSpells", l: "Spells", t: "b" },
            { k: "spellLight", l: "Spell light", t: "f", min: 0, max: 3, step: 0.01 },
            { k: "spellSpray", l: "Spell spray", t: "f", min: 0, max: 2.5, step: 0.01 },
            { k: "waterDepthTint", l: "Water depth", t: "f", min: 0, max: 3, step: 0.01 },
        ],
    },
    {
        group: "Post",
        items: [
            { k: "taa", l: "TAA", t: "b" },
            { k: "ssr", l: "SSR (crust)", t: "b" },
            { k: "dof", l: "Depth of field", t: "b" },
            { k: "heatShimmer", l: "Heat shimmer", t: "b" },
            { k: "heatShimmerStrength", l: "Shimmer amt", t: "f", min: 0, max: 2, step: 0.01 },
            { k: "bloom", l: "Bloom", t: "b" },
            { k: "grain", l: "Film grain", t: "b" },
            { k: "sharpen", l: "Sharpen", t: "b" },
            { k: "tonemap", l: "Tonemap", t: "e", opts: ["agx", "aces", "none"] },
            { k: "exposure", l: "Exposure", t: "f", min: 0.01, max: 0.6, step: 0.005 },
            { k: "contrast", l: "Contrast", t: "f", min: 0.5, max: 2, step: 0.01 },
            { k: "bloomStrength", l: "Bloom amt", t: "f", min: 0, max: 1, step: 0.005 },
            { k: "grainStrength", l: "Grain amt", t: "f", min: 0, max: 0.1, step: 0.001 },
            { k: "sharpenStrength", l: "Sharpen amt", t: "f", min: 0, max: 1, step: 0.01 },
        ],
    },
    {
        group: "Systems",
        items: [
            { k: "showTerrain", l: "Terrain", t: "b" },
            { k: "showCharacter", l: "Character", t: "b" },
            { k: "wireframe", l: "Wireframe", t: "b" },
            { k: "freezeTime", l: "Freeze time", t: "b" },
            { k: "resolutionScale", l: "Resolution", t: "f", min: 0.5, max: 1.5, step: 0.05 },
            {
                k: "debugView", l: "Debug view", t: "e",
                opts: ["beauty", "deform", "normals", "depth", "cascades", "footprint",
                       "fineNormals", "shadow", "ndotl", "shadowMap", "albedo"],
            },
        ],
    },
];

/** Quality presets. Only the keys that differ from `ultra` need listing. */
export const PRESETS = {
    ultra: {},
    high: { deformResolution: 2048, resolutionScale: 1.0, ssr: true, dof: true },
    balanced: {
        deformResolution: 1024, resolutionScale: 0.85,
        ssr: false, dof: false,
    },
};

/** @type {Map<string, Set<(v:any, k:string) => void>>} */
const listeners = new Map();

/**
 * Subscribe to a settings key. Returns an unsubscribe function.
 * @param {string|string[]} keys
 * @param {(v:any, k:string) => void} fn
 */
export function onChange(keys, fn) {
    const list = typeof keys === "string" ? [keys] : keys;
    for (let i = 0; i < list.length; i++) {
        let set = listeners.get(list[i]);
        if (!set) {
            set = new Set();
            listeners.set(list[i], set);
        }
        set.add(fn);
    }
    return () => {
        for (let i = 0; i < list.length; i++) listeners.get(list[i])?.delete(fn);
    };
}

/**
 * Write a settings value and notify subscribers. Never called from the render
 * loop — only from the overlay and preset application.
 * @param {string} k
 * @param {number|boolean|string} v
 */
export function set(k, v) {
    if (S[k] === v) return;
    S[k] = v;
    const set_ = listeners.get(k);
    if (set_) for (const fn of set_) fn(v, k);
}

/** @param {keyof typeof PRESETS} name */
export function applyPreset(name) {
    const p = PRESETS[name];
    if (!p) return;
    S.preset = name;
    for (const k in p) set(k, p[k]);
}

/**
 * Effective aerial-perspective density, including wind-driven desert dust.
 *
 * SANDSTORM addition: every material that sets `fogDensity` as a uniform
 * (the ground, the wake, the spray, the sky/far-range) now reads this instead
 * of `S.fogDensity` directly, so "the same wind reacts modestly everywhere"
 * lives in one place rather than four. Pure function of two numbers already
 * read every frame — no allocation, no new render pass, no readback.
 *
 * The `fogHeightFalloff` term already does "falls off with altitude" and
 * `fogStart`/the aerial-perspective distance ramp already do "near terrain,
 * toward the horizon" for any density value, so wind only needs to scale the
 * one number those mechanisms are built on. Below the calm threshold this is
 * an exact no-op — `S.fogDensity` — which matters because it means "no wind"
 * reproduces SNOWFLOW's baseline aerial perspective exactly rather than a
 * slightly-different resting state.
 */
export function effectiveFogDensity() {
    const calm = 0.3;
    const gust = Math.max(0, S.windStrength - calm);
    return S.fogDensity * (1 + 0.65 * gust);
}
