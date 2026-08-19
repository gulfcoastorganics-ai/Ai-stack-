// -----------------------------------------------------------------------------
// snowNoise — shared procedural noise library.
//
// Registered into Babylon's WGSL include store as <snowNoise>, so both the
// offline height bake and the runtime snow material evaluate byte-identical
// functions. Everything that shapes the surface lives here.
//
// The gradient noise carries analytic derivatives (Inigo Quilez's formulation).
// That matters twice over: derivative-damped fBm is what gives dunes their
// smooth crests and flat troughs instead of generic cloud-lumps, and exact
// surface derivatives mean the fine detail can be shaded without ever taking a
// finite difference.
// -----------------------------------------------------------------------------

const PI: f32 = 3.14159265359;

// ------------------------------------------------------------------- hashing

fn hash11(n: f32) -> f32 {
    var p = fract(n * 0.1031);
    p *= p + 33.33;
    p *= p + p;
    return fract(p);
}

fn hash21(p: vec2f) -> f32 {
    var p3 = fract(vec3f(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

fn hash22(p: vec2f) -> vec2f {
    var p3 = fract(vec3f(p.xyx) * vec3f(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.xx + p3.yz) * p3.zy);
}

fn hash33(p: vec3f) -> vec3f {
    var p3 = fract(p * vec3f(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yxz + 33.33);
    return fract((p3.xxy + p3.yxx) * p3.zyx);
}

/// Unit-length 2D gradient vector for a lattice point.
fn grad2(i: vec2f) -> vec2f {
    let a = hash21(i) * 6.28318530718;
    return vec2f(cos(a), sin(a));
}

// --------------------------------------------------- gradient noise + deriv

/// Perlin-style gradient noise. Returns vec3f(value, d/dx, d/dy).
/// Value range is roughly [-1, 1].
fn noised(p: vec2f) -> vec3f {
    let i = floor(p);
    let f = p - i;

    // Quintic fade: C2 continuous, so derivatives are smooth too.
    let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    let du = 30.0 * f * f * (f * (f - 2.0) + 1.0);

    let ga = grad2(i + vec2f(0.0, 0.0));
    let gb = grad2(i + vec2f(1.0, 0.0));
    let gc = grad2(i + vec2f(0.0, 1.0));
    let gd = grad2(i + vec2f(1.0, 1.0));

    let va = dot(ga, f - vec2f(0.0, 0.0));
    let vb = dot(gb, f - vec2f(1.0, 0.0));
    let vc = dot(gc, f - vec2f(0.0, 1.0));
    let vd = dot(gd, f - vec2f(1.0, 1.0));

    let k0 = va;
    let k1 = vb - va;
    let k2 = vc - va;
    let k3 = va - vb - vc + vd;

    let value = k0 + k1 * u.x + k2 * u.y + k3 * u.x * u.y;

    let deriv = ga
        + u.x * (gb - ga)
        + u.y * (gc - ga)
        + u.x * u.y * (ga - gb - gc + gd)
        + du * (vec2f(u.y, u.x) * k3 + vec2f(k1, k2));

    return vec3f(value, deriv);
}

/// Value-only gradient noise, for places that never need the slope.
fn noise2(p: vec2f) -> f32 {
    return noised(p).x;
}

/// 3D value noise — used by volumetrics and particle jitter, not by the surface.
fn noise3(p: vec3f) -> f32 {
    let i = floor(p);
    let f = fract(p);
    let u = f * f * (3.0 - 2.0 * f);

    let a = dot(hash33(i + vec3f(0.0, 0.0, 0.0)), vec3f(1.0)) / 3.0;
    let b = dot(hash33(i + vec3f(1.0, 0.0, 0.0)), vec3f(1.0)) / 3.0;
    let c = dot(hash33(i + vec3f(0.0, 1.0, 0.0)), vec3f(1.0)) / 3.0;
    let d = dot(hash33(i + vec3f(1.0, 1.0, 0.0)), vec3f(1.0)) / 3.0;
    let e = dot(hash33(i + vec3f(0.0, 0.0, 1.0)), vec3f(1.0)) / 3.0;
    let g = dot(hash33(i + vec3f(1.0, 0.0, 1.0)), vec3f(1.0)) / 3.0;
    let h = dot(hash33(i + vec3f(0.0, 1.0, 1.0)), vec3f(1.0)) / 3.0;
    let k = dot(hash33(i + vec3f(1.0, 1.0, 1.0)), vec3f(1.0)) / 3.0;

    return mix(
        mix(mix(a, b, u.x), mix(c, d, u.x), u.y),
        mix(mix(e, g, u.x), mix(h, k, u.x), u.y),
        u.z
    ) * 2.0 - 1.0;
}

// ----------------------------------------------------------------- rotation

fn rot2(a: f32) -> mat2x2f {
    let c = cos(a);
    let s = sin(a);
    return mat2x2f(c, -s, s, c);
}

// ---------------------------------------------------------------------- fBm

/// Plain fBm. Returns vec3f(value, d/dx, d/dy), derivatives chain-ruled through
/// the per-octave rotation so they stay exact.
fn fbmd(p0: vec2f, octaves: i32, lacunarity: f32, gain: f32) -> vec3f {
    var p = p0;
    var amp = 0.5;
    var freq = 1.0;
    var sum = 0.0;
    var deriv = vec2f(0.0);

    // Per-octave rotation kills the axis-aligned grid signature of raw Perlin.
    let m = rot2(0.517);
    var xform = mat2x2f(1.0, 0.0, 0.0, 1.0);

    for (var i = 0; i < octaves; i++) {
        let n = noised(p * freq);
        sum += amp * n.x;
        // d/dp0 = amp * freq * (dn/dp * accumulated rotation)
        deriv += amp * freq * (n.yz * xform);
        amp *= gain;
        freq *= lacunarity;
        p = m * p;
        xform = m * xform;
    }
    return vec3f(sum, deriv);
}

/// Derivative-damped fBm. Each octave is attenuated by the slope accumulated so
/// far, so detail collects in flat areas and thins out on steep faces. This is
/// the single biggest reason the dunes read as wind-packed drifts rather than
/// as a generic noise field.
fn fbmDamped(p0: vec2f, octaves: i32, lacunarity: f32, gain: f32, damp: f32) -> vec3f {
    var p = p0;
    var amp = 0.5;
    var freq = 1.0;
    var sum = 0.0;
    var deriv = vec2f(0.0);

    let m = rot2(0.517);
    var xform = mat2x2f(1.0, 0.0, 0.0, 1.0);

    for (var i = 0; i < octaves; i++) {
        let n = noised(p * freq);
        let w = 1.0 / (1.0 + damp * dot(deriv, deriv));
        sum += amp * w * n.x;
        deriv += amp * w * freq * (n.yz * xform);
        amp *= gain;
        freq *= lacunarity;
        p = m * p;
        xform = m * xform;
    }
    return vec3f(sum, deriv);
}

/// Ridged noise with derivatives — sharp crests, smooth valleys. Sastrugi.
/// Built as 1 - |n|, whose derivative is -sign(n) * dn.
fn ridgedd(p0: vec2f, octaves: i32, lacunarity: f32, gain: f32) -> vec3f {
    var p = p0;
    var amp = 0.5;
    var freq = 1.0;
    var sum = 0.0;
    var deriv = vec2f(0.0);
    var prev = 1.0;

    let m = rot2(0.717);
    var xform = mat2x2f(1.0, 0.0, 0.0, 1.0);

    for (var i = 0; i < octaves; i++) {
        let n = noised(p * freq);
        let s = sign(n.x);
        let r = 1.0 - abs(n.x);
        // Squaring sharpens the crest; `prev` couples octaves so ridges align.
        let r2 = r * r;
        let dr2 = -2.0 * r * s;

        sum += amp * r2 * prev;
        deriv += amp * prev * freq * (dr2 * n.yz * xform);
        prev = mix(1.0, r2, 0.65);

        amp *= gain;
        freq *= lacunarity;
        p = m * p;
        xform = m * xform;
    }
    return vec3f(sum, deriv);
}

// ------------------------------------------------------------------ shaping

/// Smooth absolute value — avoids the derivative discontinuity of abs().
fn sabs(x: f32, k: f32) -> f32 {
    return sqrt(x * x + k * k) - k;
}

fn smoothMin(a: f32, b: f32, k: f32) -> f32 {
    let h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
    return mix(b, a, h) - k * h * (1.0 - h);
}

fn smoothMax(a: f32, b: f32, k: f32) -> f32 {
    return -smoothMin(-a, -b, k);
}

fn remap(v: f32, a: f32, b: f32, c: f32, d: f32) -> f32 {
    return c + (d - c) * clamp((v - a) / (b - a), 0.0, 1.0);
}

/// Interleaved gradient noise — the stable per-pixel dither TAA tolerates.
fn ign(pix: vec2f) -> f32 {
    return fract(52.9829189 * fract(dot(pix, vec2f(0.06711056, 0.00583715))));
}
