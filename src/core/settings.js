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
    // Phase 8A beauty pass: dropped further toward the grazing end of the
    // range for a more dramatic late-afternoon read — longer shadows, harder
    // crest/lee separation. Still well clear of the point where the air mass
    // eats all the energy and the scene goes flat.
    sunElevation: 10.5,
    // Raised alongside a lower ambient (below): the previous 4.2/1.0 balance
    // put nearly as much light into the scene from the sky dome as from the
    // sun itself, which is exactly the "evenly illuminated, no dune reads
    // through lighting" complaint. A stronger sun against a dimmer fill is
    // what makes windward faces bright and lee faces read as genuinely dark.
    sunIntensity: 5.6,
    sunTempWarm: 1.0, // 0 = neutral white, 1 = full warm low-sun tint
    // Was 1.0 — enough ambient fill that shadows and lit faces sat within a
    // stop of each other. Cut to let the sun/shadow split actually show.
    ambientIntensity: 0.68,
    ambientBlue: 0.85, // strength of the cool shadow shift — trimmed slightly with it

    // ------------------------------------------------------------- atmosphere
    // Density down, falloff up, start pushed well out: haze now thins fast
    // with altitude (so it hugs the ground rather than sitting in a flat
    // slab) and only starts accumulating well past the foreground, instead
    // of softening the first hundred metres the player is standing in.
    fogDensity: 0.0048,
    fogHeightFalloff: 0.064,
    fogStart: 55,
    // Slightly reduced so full extinction is reached farther out — the near/
    // mid/far depth ladder item 6 asks for needs the far field to still be
    // the thing doing most of the desaturating, not a blanket over everything.
    aerialStrength: 0.86,
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
    // Raised for a stronger, more dramatic crest catch-light at grazing sun
    // angles — item 3's "dune crests should catch the low sun dramatically".
    glintIntensity: 0.34,
    glintGrazing: 0.66,
    sssStrength: 0.15,
    sssRadius: 1.0,
    // Raised for stronger multi-scale surface structure underfoot — item 1.
    // The shader already fades three tiling scales by pixel footprint, so
    // this does not introduce new shimmer, it just makes each of the three
    // read more strongly where it was already resolvable.
    detailNormalStrength: 1.35,
    macroHeightScale: 1.0,
    sastrugiStrength: 1.2,

    // -------------------------------------------------------- dune generator
    // Phase 4 art controls for the macro dune-field bake. Deliberately a
    // handful of meaningful knobs rather than exposing every noise
    // coefficient — see `lib/terrain.wgsl`'s `duneRidges`/`terrainRegionMask`
    // for what each one actually drives. Takes effect on the next terrain
    // bake (load, or a page refresh) — same as `macroHeightScale` and
    // `windDirection` already did; there is no live-rebake path for either.
    /** Base meso dune wavelength, metres. Individual dunes range roughly
     *  0.3x-3x this depending on how dense the local dune field is. */
    duneScale: 42,
    /** Target tangent of the lee (slip-face) slope angle. 0.64 ≈ 32.6
     *  degrees, close to dry sand's natural angle of repose. */
    leeSteepness: 0.64,
    /** 0 = one uniform mid-density dune field (closer to SNOWFLOW's original
     *  single-noise-field character); 1 = full regional contrast between
     *  dense dune country, barchan margins and open interdune flats. */
    macroVariation: 0.85,

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
    streakStrength: 1.15,

    // ---------------------------------------------------------------- spells
    /** Master toggle. Off cancels everything in flight and hides both meshes. */
    showSpells: true,
    /** Brightness of the dynamic lights the spells emit. */
    spellLight: 1.0,
    /** Density of the spray every spell throws — the five abilities' shared
     *  "ability particle density" control. */
    spellSpray: 1.0,
    /**
     * Artistic scale on how strongly compaction darkens the shared spell
     * sand-mass material (Dune Surge, Sand Lance, Sand Eruption, Sand Vortex —
     * see `water.fragment.wgsl`). Carried over under its SNOWFLOW name/uniform
     * slot rather than renamed; the right value still depends on the sun
     * elevation, so it stays a slider rather than a constant.
     */
    waterDepthTint: 1.0,
    /** Sand Eruption column height multiplier. */
    eruptionHeightScale: 1.0,
    /** Sand Vortex column/excavation radius multiplier. */
    vortexRadiusScale: 1.0,
    /** Dune Surge crest height multiplier. */
    duneSurgeHeightScale: 1.0,

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
    // Nudged down slightly, not up — sunIntensity carries the brightness
    // increase this pass wants, and dropping exposure to compensate keeps
    // this from being "raise exposure globally" (explicitly ruled out).
    exposure: 0.108,
    // Raised for stronger directional contrast — item 8's "increase
    // directional contrast, preserve shadow detail". Contrast here is
    // applied about middle grey in linear before the AgX curve (see
    // tonemap.fragment.wgsl), so it pushes into the shoulder rather than
    // clipping after it — shadow detail survives, only the spread widens.
    contrast: 1.30,
    // Cut so bloom stays a tight glow around the sun/glints/high-energy
    // effects rather than a broad wash over sunlit terrain — item 9's "do
    // not bloom terrain broadly".
    bloomStrength: 0.14,
    grainStrength: 0.020,
    // Raised for crisper sand microdetail — item 9. The sharpen pass is
    // already contrast-adaptive (clamped to the local min/max), so this
    // does not introduce haloing on flat expanses, only steepens edges that
    // already have a gradient.
    sharpenStrength: 0.70,
    // Restrained depth-aware desert heat distortion over distant sunlit
    // terrain. Implemented inside the existing DOF pass (see dof.fragment.wgsl)
    // rather than as a new render target or pass, so it is a few extra ALU ops
    // on an already-bound depth/colour pair, not a new cost category.
    heatShimmer: true,
    heatShimmerStrength: 0.35,

    // -------------------------------------------------------- locomotion
    // Phase 7, revised by the control-revision pass that removed Shift as a
    // sprint modifier: there is one ground-speed target now, not two tiers
    // gated behind a held key. Live-tunable rather than baked constants in
    // `controller.js`/`camera.js`, per the phase's debug-tuning requirement —
    // a deliberately small subset (move speed, ground response, turn
    // response, jump impulse, air control, dash speed/duration, camera
    // follow, mouse sensitivity), not every internal constant those files
    // define.
    moveRunSpeed: 7.2, // m/s — the one ground-movement target, always live
    moveGroundAccel: 70, // m/s^2, ground acceleration/deceleration response
    moveTurnRate: 16, // 1/s, facing-ease rate at zero speed (scales up with speed)
    moveJumpImpulse: 7.6, // m/s, initial vertical speed on jump
    moveAirControl: 30, // m/s^2, bounded airborne steering accel
    moveDashSpeed: 15, // m/s, ground dash burst speed
    moveDashDuration: 0.16, // seconds, ground dash active window
    cameraFollowRate: 7.5, // spring-arm pivot chase frequency
    mouseSensitivity: 1.0, // multiplier on raw mouse-look delta

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
        // Terrain-bake controls. Changes apply on the next bake (page
        // refresh) — there is no live-rebake path, matching the existing
        // "Dune height" slider above and `windDirection`.
        group: "Dune Field",
        items: [
            { k: "duneScale", l: "Dune spacing", t: "f", min: 10, max: 150, step: 1 },
            { k: "leeSteepness", l: "Slip-face angle", t: "f", min: 0.35, max: 0.85, step: 0.01 },
            { k: "macroVariation", l: "Regional variety", t: "f", min: 0, max: 1, step: 0.01 },
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
        group: "Locomotion",
        items: [
            { k: "moveRunSpeed", l: "Move speed", t: "f", min: 2, max: 14, step: 0.1 },
            { k: "moveGroundAccel", l: "Ground response", t: "f", min: 20, max: 140, step: 1 },
            { k: "moveTurnRate", l: "Turn response", t: "f", min: 4, max: 32, step: 0.5 },
            { k: "moveJumpImpulse", l: "Jump impulse", t: "f", min: 3, max: 14, step: 0.1 },
            { k: "moveAirControl", l: "Air control", t: "f", min: 5, max: 70, step: 1 },
            { k: "moveDashSpeed", l: "Dash speed", t: "f", min: 5, max: 26, step: 0.5 },
            { k: "moveDashDuration", l: "Dash duration", t: "f", min: 0.05, max: 0.4, step: 0.01 },
            { k: "cameraFollowRate", l: "Camera follow", t: "f", min: 2, max: 18, step: 0.1 },
            { k: "mouseSensitivity", l: "Mouse sensitivity", t: "f", min: 0.2, max: 3, step: 0.05 },
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
            { k: "waterDepthTint", l: "Sand density", t: "f", min: 0, max: 3, step: 0.01 },
            { k: "duneSurgeHeightScale", l: "Dune Surge height", t: "f", min: 0.3, max: 2, step: 0.01 },
            { k: "eruptionHeightScale", l: "Eruption height", t: "f", min: 0.3, max: 2, step: 0.01 },
            { k: "vortexRadiusScale", l: "Vortex radius", t: "f", min: 0.3, max: 2, step: 0.01 },
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
            { k: "resolutionScale", l: "Resolution", t: "f", min: 0.4, max: 1.25, step: 0.05 },
            {
                k: "debugView", l: "Debug view", t: "e",
                opts: ["beauty", "deform", "normals", "depth", "cascades", "footprint",
                       "fineNormals", "shadow", "ndotl", "shadowMap", "albedo"],
            },
        ],
    },
];

/**
 * Quality presets. Only the keys that differ from `ultra` need listing.
 *
 * Phase 8A: renamed `balanced` to `medium` and added `low` as a genuine
 * emergency fallback, per item 17's "keep LOW / MEDIUM / HIGH / ULTRA" and
 * "do not silently run ULTRA on low-end hardware if it causes severe frame
 * drops". `ultra` is unchanged — it is still the base `S` defaults, tuned
 * for screenshots on capable hardware. `resolutionScale` now compounds with
 * `main.js`'s `adaptToDeviceRatio: true` (added this pass so the render
 * target actually matches device pixels instead of CSS pixels — see the
 * engine-creation comment there), so the lower tiers pull it down more
 * aggressively than before: a HiDPI display at `ultra`'s 1.0 now renders at
 * genuinely more pixels than it did before that change, and a low-end
 * device needs more headroom back, not less.
 */
export const PRESETS = {
    ultra: {},
    high: { deformResolution: 2048, resolutionScale: 0.9, ssr: true, dof: true, heatShimmer: true },
    medium: {
        deformResolution: 1024, resolutionScale: 0.75,
        ssr: false, dof: true, heatShimmer: false,
    },
    low: {
        deformResolution: 512, resolutionScale: 0.55,
        ssr: false, dof: false, heatShimmer: false,
    },
};

/** Ordered worst-to-best, for the runtime auto-downgrade in `main.js`. */
export const PRESET_ORDER = ["low", "medium", "high", "ultra"];

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
