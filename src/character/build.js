/**
 * Procedural character geometry.
 *
 * Nothing here is authored in a DCC tool. Every surface is a lofted tube, a
 * swept ring or a Bezier-blended shell evaluated from the bind-pose skeleton, so
 * the whole figure is a few hundred lines of tables and a smooth-normal pass.
 *
 * Three meshes come out, because three different vertex programs drive them:
 *
 *   body   linearly blend-skinned to the bones — head, cowl, torso, arms,
 *          trousers, boots, belt.
 *   cloth  driven from the simulated garment grids, sampled with Catmull-Rom in
 *          the vertex shader so a 24x14 solve renders as a smooth surface.
 *   fur    shell fur: the same rim ring emitted N times, each pushed further
 *          along its normal, alpha-tested into strands.
 *
 * Normals are never derived analytically. Everything is built as positions plus
 * indices and then run through one area-weighted smooth-normal pass, which is
 * both less code and immune to the sign errors that analytic normals on a swept
 * surface invite. Closed rings share their seam vertex rather than duplicating
 * it, so the seam is smooth too.
 *
 * Build time only — none of this runs after load, and it allocates freely.
 */

import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import {
    B_ROOT, B_SPINE, B_CHEST, B_NECK, B_HEAD, B_HOOD,
    B_UPPER_L, B_FORE_L, B_HAND_L, B_UPPER_R, B_FORE_R, B_HAND_R,
    B_THIGH_L, B_SHIN_L, B_FOOT_L, B_THIGH_R, B_SHIN_R, B_FOOT_R,
} from "./figure.js";

// ------------------------------------------------------------- material slots
//
// SANDSTORM Phase 5: slot indices and which geometry reads which slot are
// unchanged from SNOWFLOW — only what each slot's colours/params represent
// changed (see the `PALETTE`/`PARAMS` tables in character.js) — plus one new
// slot, M_METAL, using what was SNOWFLOW's unused eighth "spare" entry.
export const M_ROBE = 0;     // outer coat, charcoal/deep brown
export const M_MANTLE = 1;   // shoulder wrap, weathered sandstone/khaki
export const M_TUNIC = 2;    // inner tunic lining
export const M_LEATHER = 3;  // belt and boots
export const M_SKIN = 4;     // face, deep in shade
export const M_TRIM = 5;     // the scarf/wrap accent — the one controlled rust colour
export const M_FUR = 6;      // frayed wrap-fibre trim (see buildFur's note — no longer at the hood)
export const M_METAL = 7;    // sparse buckle/clip accents

/**
 * Segments around a limb. Phase 8B: raised from 14 — with the camera now
 * sitting closer (see `camera.js`) and the environment carrying real
 * microdetail, 14-gon limbs started reading as faceted cylinders rather
 * than round ones. 20 removes that at a triangle-count cost this build
 * comfortably affords: one hero character, built once at load, never
 * rebuilt per frame.
 */
const SEG = 20;

// -----------------------------------------------------------------------------

class Builder {
    constructor() {
        this.pos = [];
        this.nrm = [];
        this.uv = [];
        /** (matId, ao) on the body; (shellT, ao) on the fur. */
        this.aux = [];
        this.bi = [];       // bone indices, 4 per vertex
        this.bw = [];       // bone weights, 4 per vertex
        this.idx = [];
        /** Fur supplies its own normals; everything else has them derived. */
        this.explicitNormals = false;
    }

    /** @returns {number} the new vertex's index */
    vert(x, y, z, u, v, matId, ao, b0, w0, b1, w1) {
        this.pos.push(x, y, z);
        this.nrm.push(0, 0, 0);
        this.uv.push(u, v);
        this.aux.push(matId, ao);
        this.bi.push(b0, b1 || 0, 0, 0);
        this.bw.push(w0, w1 || 0, 0, 0);
        return this.pos.length / 3 - 1;
    }

    normal(vi, x, y, z) {
        this.nrm[vi * 3] = x;
        this.nrm[vi * 3 + 1] = y;
        this.nrm[vi * 3 + 2] = z;
    }

    tri(a, b, c) {
        this.idx.push(a, b, c);
    }

    quad(a, b, c, d) {
        // Both diagonals of every quad get used across the mesh, alternating is
        // not worth the bookkeeping on shapes this smooth.
        this.idx.push(a, b, c, a, c, d);
    }
}

/**
 * Area-weighted smooth normals.
 *
 * Area weighting rather than plain averaging: a long thin triangle at a cap
 * would otherwise pull the pole normal off toward its own plane.
 */
function computeNormals(pos, idx) {
    const n = new Float32Array(pos.length);
    for (let i = 0; i < idx.length; i += 3) {
        const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
        const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
        const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
        // Un-normalised cross product: its length is twice the triangle area,
        // which is exactly the weight we want.
        const fx = uy * vz - uz * vy;
        const fy = uz * vx - ux * vz;
        const fz = ux * vy - uy * vx;
        n[a] += fx; n[a + 1] += fy; n[a + 2] += fz;
        n[b] += fx; n[b + 1] += fy; n[b + 2] += fz;
        n[c] += fx; n[c + 1] += fy; n[c + 2] += fz;
    }
    for (let i = 0; i < n.length; i += 3) {
        const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
        n[i] /= l; n[i + 1] /= l; n[i + 2] /= l;
    }
    return n;
}

/**
 * Loft a closed tube through a list of rings.
 *
 * Each ring is `[cx, cy, cz, rx, rz, ao, b0, w0, b1, w1]` and the cross-section
 * plane is derived from the direction to the neighbouring rings, so a limb that
 * bends in the bind pose still gets circular sections rather than sheared ones.
 *
 * @param {Builder} B
 * @param {number[][]} rings
 * @param {number} matId
 * @param {[number,number,number]} ref reference axis the section frame avoids
 */
function loft(B, rings, matId, ref, capStart, capEnd) {
    const n = rings.length;
    const first = [];
    let prevRow = null;
    let vAcc = 0;

    for (let r = 0; r < n; r++) {
        const cur = rings[r];
        const prev = rings[Math.max(0, r - 1)];
        const next = rings[Math.min(n - 1, r + 1)];

        let ax = next[0] - prev[0], ay = next[1] - prev[1], az = next[2] - prev[2];
        let al = Math.hypot(ax, ay, az) || 1;
        ax /= al; ay /= al; az /= al;

        // U = axis x ref, W = axis x U — the two axes of the section plane.
        let ux = ay * ref[2] - az * ref[1];
        let uy = az * ref[0] - ax * ref[2];
        let uz = ax * ref[1] - ay * ref[0];
        let ul = Math.hypot(ux, uy, uz) || 1;
        ux /= ul; uy /= ul; uz /= ul;
        const wx = ay * uz - az * uy;
        const wy = az * ux - ax * uz;
        const wz = ax * uy - ay * ux;

        if (r > 0) {
            vAcc += Math.hypot(cur[0] - prev[0], cur[1] - prev[1], cur[2] - prev[2]);
        }

        // Texture coordinates are metres of surface, not normalised. Every
        // scale in the fabric shader — the weave, the yarn slub — is a physical
        // size, and normalised UVs would make each of them a different size on
        // every part of the body.
        const circ = Math.PI * (cur[3] + cur[4]);

        const row = [];
        for (let s = 0; s < SEG; s++) {
            const a = (s / SEG) * Math.PI * 2;
            const ca = Math.cos(a), sa = Math.sin(a);
            const px = cur[0] + ux * cur[3] * sa + wx * cur[4] * ca;
            const py = cur[1] + uy * cur[3] * sa + wy * cur[4] * ca;
            const pz = cur[2] + uz * cur[3] * sa + wz * cur[4] * ca;
            row.push(B.vert(
                px, py, pz,
                (s / SEG) * circ, vAcc,
                matId, cur[5], cur[6], cur[7], cur[8], cur[9]
            ));
        }

        if (prevRow) {
            for (let s = 0; s < SEG; s++) {
                const s2 = (s + 1) % SEG;
                B.quad(prevRow[s], prevRow[s2], row[s2], row[s]);
            }
        }
        if (r === 0) first.push(...row);
        prevRow = row;
    }

    // Caps: a fan to a centre vertex placed on the ring's own axis.
    if (capStart) capRing(B, rings[0], rings[1], first, matId, true);
    if (capEnd) capRing(B, rings[n - 1], rings[n - 2], prevRow, matId, false);
}

function capRing(B, ring, neighbour, row, matId, isStart) {
    let ax = ring[0] - neighbour[0], ay = ring[1] - neighbour[1], az = ring[2] - neighbour[2];
    const al = Math.hypot(ax, ay, az) || 1;
    ax /= al; ay /= al; az /= al;
    const ext = Math.max(ring[3], ring[4]) * 0.7;
    const c = B.vert(
        ring[0] + ax * ext, ring[1] + ay * ext, ring[2] + az * ext,
        0.5, 0.5, matId, ring[5], ring[6], ring[7], ring[8], ring[9]
    );
    for (let s = 0; s < SEG; s++) {
        const s2 = (s + 1) % SEG;
        if (isStart) B.tri(c, row[s2], row[s]);
        else B.tri(c, row[s], row[s2]);
    }
}

/**
 * A minimal oriented box — eight vertices, six quads, disconnected from
 * whatever it sits against (same trick the belt buckle already used, pulled
 * out into a helper so the belt pouches and strap buckle below don't repeat
 * it). `half` is the box's own half-extents along its own X/Y/Z; `ax`/`ay`
 * are that box's local X and Y axes in world space (Z is derived), so the
 * same helper can place a box flat against the belt or angled across the
 * chest without a second code path.
 */
function buildBox(B, cx, cy, cz, half, ax, ay, matId, ao, bones) {
    const azx = ax[1] * ay[2] - ax[2] * ay[1];
    const azy = ax[2] * ay[0] - ax[0] * ay[2];
    const azz = ax[0] * ay[1] - ax[1] * ay[0];
    const corner = (sx, sy, sz) => {
        const x = cx + (ax[0] * sx * half[0] + ay[0] * sy * half[1] + azx * sz * half[2]);
        const y = cy + (ax[1] * sx * half[0] + ay[1] * sy * half[1] + azy * sz * half[2]);
        const z = cz + (ax[2] * sx * half[0] + ay[2] * sy * half[1] + azz * sz * half[2]);
        return B.vert(x, y, z, (sx + 1) * 0.5, (sy + 1) * 0.5, matId, ao, bones[0], bones[1], bones[2], bones[3]);
    };
    const p000 = corner(-1, -1, -1), p100 = corner(1, -1, -1);
    const p110 = corner(1, 1, -1), p010 = corner(-1, 1, -1);
    const p001 = corner(-1, -1, 1), p101 = corner(1, -1, 1);
    const p111 = corner(1, 1, 1), p011 = corner(-1, 1, 1);
    B.quad(p001, p101, p111, p011); // +Z
    B.quad(p100, p000, p010, p110); // -Z
    B.quad(p000, p001, p011, p010); // -X
    B.quad(p101, p100, p110, p111); // +X
    B.quad(p010, p011, p111, p110); // +Y
    B.quad(p001, p000, p100, p101); // -Y
}

/** Bone blend along the spine, by bind-pose height. */
function spineBones(y) {
    if (y < 1.06) {
        const t = Math.min(1, Math.max(0, (y - 0.88) / 0.18));
        return [B_ROOT, 1 - t * 0.5, B_SPINE, t * 0.5];
    }
    if (y < 1.26) {
        const t = (y - 1.06) / 0.20;
        return [B_SPINE, 1 - t, B_CHEST, t];
    }
    const t = Math.min(1, (y - 1.26) / 0.20);
    return [B_CHEST, 1 - t * 0.35, B_NECK, t * 0.35];
}

/** Ring helper: `[cx,cy,cz, rx,rz, ao, b0,w0,b1,w1]`. */
function ring(cx, cy, cz, rx, rz, ao, bones) {
    return [cx, cy, cz, rx, rz, ao, bones[0], bones[1], bones[2], bones[3]];
}


// -----------------------------------------------------------------------------
//  Body
// -----------------------------------------------------------------------------

/**
 * The figure under the garments: head, cowl, torso, arms, trousers, boots.
 *
 * Most of this is only seen in slivers — the robe covers the torso, the mantle
 * covers the shoulders. What is genuinely on screen is the hood silhouette, the
 * boots, and the forearms, so that is where the ring counts go.
 */
export function buildBody(scene) {
    const B = new Builder();

    // ---- torso ------------------------------------------------------------
    const torso = [];
    // Waist narrowed and the chest/shoulder line widened a touch further —
    // "shoulders wider than waist" needs to be unambiguous even through a
    // coat, since the coat's own drape takes its cue from the body under it.
    const TORSO = [
        [0.88, 0.148, 0.118], [0.98, 0.136, 0.107], [1.06, 0.124, 0.098],
        [1.14, 0.136, 0.106], [1.22, 0.158, 0.119], [1.30, 0.178, 0.129],
        [1.38, 0.184, 0.130], [1.44, 0.164, 0.118],
    ];
    for (let i = 0; i < TORSO.length; i++) {
        const [y, rx, rz] = TORSO[i];
        torso.push(ring(0, y, 0, rx, rz, 0.72, spineBones(y)));
    }
    loft(B, torso, M_TRIM, [0, 0, 1], true, false);

    // ---- belt -------------------------------------------------------------
    const belt = [
        ring(0, 0.955, 0, 0.153, 0.124, 0.62, spineBones(0.955)),
        ring(0, 0.995, 0, 0.160, 0.130, 0.70, spineBones(0.995)),
        ring(0, 1.035, 0, 0.152, 0.123, 0.62, spineBones(1.035)),
    ];
    loft(B, belt, M_LEATHER, [0, 0, 1], false, false);

    // ---- belt buckle --------------------------------------------------
    // A minimal flat box glued to the belt's front-centre point, on the new
    // M_METAL slot (item 6/16). Disconnected from the belt loft rather than
    // welded into it — eight vertices, six quads, no shared topology to keep
    // correct — so it stays a negligible, genuinely sparse metal accent
    // rather than a reason to touch the belt's own ring math.
    {
        const bx = 0.045, by = 0.026, bz = 0.014;
        const cx = 0, cy = 0.995, cz = 0.140;
        const bones = spineBones(0.995);
        const v = (x, y, z, u, uvv) =>
            B.vert(x, y, z, u, uvv, M_METAL, 0.75, bones[0], bones[1], bones[2], bones[3]);
        const p000 = v(cx - bx, cy - by, cz - bz, 0, 0);
        const p100 = v(cx + bx, cy - by, cz - bz, 1, 0);
        const p110 = v(cx + bx, cy + by, cz - bz, 1, 1);
        const p010 = v(cx - bx, cy + by, cz - bz, 0, 1);
        const p001 = v(cx - bx, cy - by, cz + bz, 0, 0);
        const p101 = v(cx + bx, cy - by, cz + bz, 1, 0);
        const p111 = v(cx + bx, cy + by, cz + bz, 1, 1);
        const p011 = v(cx - bx, cy + by, cz + bz, 0, 1);
        B.quad(p001, p101, p111, p011); // front (+z, faces outward)
        B.quad(p100, p000, p010, p110); // back
        B.quad(p000, p001, p011, p010); // left
        B.quad(p101, p100, p110, p111); // right
        B.quad(p010, p011, p111, p110); // top
        B.quad(p001, p000, p100, p101); // bottom
    }

    // ---- utility belt pouches + diagonal strap -----------------------------
    // Three asymmetric pouches (deliberately uneven sizes/positions, not a
    // mirrored pair) and a diagonal equipment strap crossing the torso —
    // item 2's explicit "2-3 asymmetric pouches" and "diagonal equipment
    // strap". All rigid accessory geometry, bound the same way the belt and
    // buckle already are: not simulated cloth, no new bones.
    {
        const beltBones = spineBones(0.97);
        // Right hip: one larger pouch.
        buildBox(
            B, 0.148, 0.945, 0.078, [0.032, 0.042, 0.026],
            [1, 0, 0], [0, 1, 0], M_LEATHER, 0.58, beltBones
        );
        // Left hip: two smaller pouches, offset and unevenly sized — the
        // asymmetry against the single right-hip pouch above.
        buildBox(
            B, -0.150, 0.958, 0.058, [0.024, 0.032, 0.020],
            [1, 0, 0], [0, 1, 0], M_LEATHER, 0.58, beltBones
        );
        buildBox(
            B, -0.150, 0.918, 0.098, [0.019, 0.023, 0.017],
            [1, 0, 0], [0, 1, 0], M_LEATHER, 0.54, beltBones
        );

        // Diagonal strap: left shoulder to right hip, crossing the chest.
        // Bound per-ring by height the same way the torso itself is (there
        // is no single bone a diagonal strap could rigidly follow), so it
        // rides the spine/chest blend rather than a fixed joint.
        const strapA = [-0.145, 1.335, 0.078];
        const strapB = [0.140, 0.965, 0.100];
        const strapSteps = 6;
        const strap = [];
        for (let i = 0; i <= strapSteps; i++) {
            const t = i / strapSteps;
            const x = strapA[0] + (strapB[0] - strapA[0]) * t;
            const y = strapA[1] + (strapB[1] - strapA[1]) * t;
            const z = strapA[2] + (strapB[2] - strapA[2]) * t;
            strap.push(ring(x, y, z, 0.026, 0.014, 0.55, spineBones(y)));
        }
        loft(B, strap, M_LEATHER, [0, 0, 1], true, true);
    }

    // ---- neck + head ------------------------------------------------------
    const neck = [
        ring(0, 1.42, -0.005, 0.062, 0.058, 0.35, [B_NECK, 1, B_HEAD, 0]),
        ring(0, 1.50, 0.000, 0.058, 0.055, 0.30, [B_NECK, 0.5, B_HEAD, 0.5]),
        ring(0, 1.56, 0.002, 0.062, 0.060, 0.28, [B_HEAD, 1, 0, 0]),
    ];
    loft(B, neck, M_SKIN, [0, 0, 1], false, false);

    // The skull. Deliberately featureless: the face stays in shadow under the
    // cowl, and a half-finished face is far worse than a silhouette. It carries
    // a heavy baked occlusion so the cavity reads dark even when the sun swings
    // round to face it.
    const head = [];
    for (let i = 0; i <= 8; i++) {
        const a = (i / 8) * Math.PI;
        const y = HEAD_C[1] - Math.cos(a) * 0.105;
        const r = Math.sin(a);
        // Radii trimmed slightly (0.089/0.096 -> 0.082/0.088): paired with
        // the tighter hood above, so the head+hood silhouette reads as a
        // head with a garment over it rather than one large rounded mass.
        head.push(ring(
            0, y, HEAD_C[2] + r * 0.006,
            0.082 * r + 0.004, 0.088 * r + 0.004,
            0.22, [B_HEAD, 1, 0, 0]
        ));
    }
    loft(B, head, M_SKIN, [0, 0, 1], true, true);

    // ---- eyes ---------------------------------------------------------
    // Narrow, readable, not realistic: two small flat strips at brow
    // height, in the gap between the scarf's top edge (y ~1.642, below)
    // and the hood's own shadow (above) — the one place on the whole
    // skull actually meant to be seen. The read comes almost entirely
    // from occlusion, not shape: everywhere else on the skull carries a
    // heavy baked `ao` of 0.22 specifically so the shadowed hood interior
    // stays dark regardless of sun angle (see the skull's own comment
    // above); these two strips carry a much lighter 0.62, so the shading
    // pass's occlusion term barely touches them and they catch a genuine
    // glint of reflected/ambient light against the darkness around them
    // — "the eye opening should catch a tiny amount of reflected light so
    // the head doesn't collapse into black", without modelling an actual
    // eye. Built the same disconnected-box way as the belt buckle/pouches:
    // a handful of vertices glued to the skull, no shared topology.
    for (let e = 0; e < 2; e++) {
        const ex = e === 0 ? -1 : 1;
        buildBox(
            B, ex * 0.032, 1.663, 0.080,
            [0.015, 0.007, 0.004], [1, 0, 0], [0, 1, 0],
            M_SKIN, 0.62, [B_HEAD, 1, 0, 0]
        );
    }

    // A scarf across the lower face, as in the reference. It is what stops the
    // shadowed skull reading as an empty hood.
    //
    // Visual-pass target: bulked up from a thin wrap (radii barely past the
    // trimmed skull's own 0.082/0.088) to a genuinely thick winding — real
    // wound cloth is several layers, not a single skin-tight band, and the
    // reference art's neck wrap reads noticeably thicker than the jaw it
    // sits under.
    const scarf = [
        ring(0, 1.558, 0.012, 0.100, 0.106, 0.30, [B_HEAD, 1, 0, 0]),
        ring(0, 1.602, 0.015, 0.112, 0.118, 0.34, [B_HEAD, 1, 0, 0]),
        ring(0, 1.642, 0.010, 0.108, 0.114, 0.30, [B_HEAD, 1, 0, 0]),
    ];
    loft(B, scarf, M_TRIM, [0, 0, 1], false, false);

    buildHood(B);

    // ---- arms -------------------------------------------------------------
    for (let a = 0; a < 2; a++) {
        const s = a === 0 ? -1 : 1;
        const up = a === 0 ? B_UPPER_L : B_UPPER_R;
        const fo = a === 0 ? B_FORE_L : B_FORE_R;
        const hd = a === 0 ? B_HAND_L : B_HAND_R;

        // Phase 8B repair: `limbRings` only interpolates radius linearly
        // between its two endpoints, which is exactly what reads as a
        // tapered tube rather than a limb — real deltoids bulge below the
        // shoulder joint and real forearms are thickest just past the
        // elbow, not at either end. Built explicitly instead, the same way
        // the hand/boot lists already are, so the radius profile can be
        // genuinely non-monotonic.
        const upperT = [0, 0.15, 0.4, 0.7, 1.0];
        const upperR = [0.058, 0.070, 0.058, 0.050, 0.044];
        const upper = [];
        for (let i = 0; i < upperT.length; i++) {
            const t = upperT[i];
            const x = s * (0.185 + 0.045 * t);
            const y = 1.400 + (1.123 - 1.400) * t;
            const w = Math.min(1, Math.max(0, (t - 0.72) / 0.28));
            upper.push(ring(x, y, 0, upperR[i], upperR[i], 0.55, [up, 1 - w, fo, w]));
        }
        loft(B, upper, M_ROBE, [0, 0, 1], true, false);

        const foreT = [0, 0.2, 0.5, 0.8, 1.0];
        const foreR = [0.048, 0.053, 0.044, 0.038, 0.034];
        const fore = [];
        for (let i = 0; i < foreT.length; i++) {
            const t = foreT[i];
            const x = s * (0.230 + (0.243 - 0.230) * t);
            const y = 1.123 + (0.866 - 1.123) * t;
            const z = 0.016 * t;
            const w = Math.min(1, Math.max(0, (t - 0.75) / 0.25));
            fore.push(ring(x, y, z, foreR[i], foreR[i], 0.62, [fo, 1 - w, hd, w]));
        }
        loft(B, fore, M_ROBE, [0, 0, 1], false, false);

        // Phase 8B: the hand no longer needs individually simulated fingers,
        // but it needs to read as a hand rather than a mitt. Two changes from
        // the old four-ring taper: a genuine wrist-to-palm transition (the
        // wrist ring is narrower than the palm now, not the same width), and
        // a flattened cross-section through the palm/knuckle rings — real
        // hands are wider than they are thick, and a round cross-section is
        // exactly what reads as a sphere-tipped stick.
        const hand = [
            ring(s * 0.243, 0.866, 0.016, 0.036, 0.032, 0.55, [hd, 1, 0, 0]),
            ring(s * 0.245, 0.838, 0.022, 0.052, 0.030, 0.55, [hd, 1, 0, 0]),
            ring(s * 0.247, 0.805, 0.030, 0.055, 0.028, 0.52, [hd, 1, 0, 0]),
            ring(s * 0.248, 0.770, 0.036, 0.045, 0.024, 0.50, [hd, 1, 0, 0]),
            ring(s * 0.249, 0.744, 0.040, 0.026, 0.018, 0.48, [hd, 1, 0, 0]),
        ];
        loft(B, hand, M_LEATHER, [1, 0, 0], false, true);

        // A thumb silhouette — a short, independent, sharply-tapered stub
        // glued to the palm's outer edge rather than welded into the hand
        // loft's topology (same trick as the belt buckle below: a handful of
        // vertices with no shared seam to keep correct). Angled forward and
        // down off the palm so it reads as a digit crossing in front of the
        // hand, not a second wrist.
        {
            const tx0 = s * 0.243 + s * 0.030, ty0 = 0.828, tz0 = 0.040;
            const tx1 = s * 0.243 + s * 0.046, ty1 = 0.802, tz1 = 0.062;
            const tx2 = s * 0.243 + s * 0.052, ty2 = 0.784, tz2 = 0.074;
            const thumb = [
                ring(tx0, ty0, tz0, 0.017, 0.017, 0.55, [hd, 1, 0, 0]),
                ring(tx1, ty1, tz1, 0.016, 0.016, 0.52, [hd, 1, 0, 0]),
                ring(tx2, ty2, tz2, 0.010, 0.010, 0.48, [hd, 1, 0, 0]),
            ];
            loft(B, thumb, M_LEATHER, [0, 1, 0], false, true);
        }
    }

    // ---- legs and boots ---------------------------------------------------
    for (let l = 0; l < 2; l++) {
        const s = l === 0 ? -1 : 1;
        const th = l === 0 ? B_THIGH_L : B_THIGH_R;
        const sh = l === 0 ? B_SHIN_L : B_SHIN_R;
        const ft = l === 0 ? B_FOOT_L : B_FOOT_R;

        // Non-monotonic, like the arms above: real thigh mass peaks below
        // the hip, not at it, and a defined "knee break" — narrower right
        // at the joint than either the thigh above or the calf below — is
        // most of what separates a leg from a tapered pole.
        const thighT = [0, 0.25, 0.55, 0.85, 1.0];
        const thighR = [0.108, 0.120, 0.102, 0.090, 0.084];
        const thigh = [];
        for (let i = 0; i < thighT.length; i++) {
            const t = thighT[i];
            const y = 0.905 + (0.460 - 0.905) * t;
            const w = Math.min(1, Math.max(0, (t - 0.74) / 0.26));
            thigh.push(ring(s * 0.100, y, 0, thighR[i], thighR[i], 0.5, [th, 1 - w, sh, w]));
        }
        loft(B, thigh, M_ROBE, [0, 0, 1], true, false);

        // Trousers narrow to the ankle then flare into the boot shaft.
        const shin = [
            ring(s * 0.100, 0.460, 0, 0.086, 0.086, 0.55, [sh, 1, 0, 0]),
            ring(s * 0.100, 0.360, 0.004, 0.076, 0.076, 0.55, [sh, 1, 0, 0]),
            ring(s * 0.100, 0.270, 0.006, 0.070, 0.070, 0.52, [sh, 1, 0, 0]),
            ring(s * 0.100, 0.200, 0.006, 0.075, 0.076, 0.48, [sh, 0.6, ft, 0.4]),
            ring(s * 0.100, 0.140, 0.004, 0.080, 0.082, 0.44, [sh, 0.25, ft, 0.75]),
            ring(s * 0.100, 0.100, 0.000, 0.074, 0.078, 0.42, [ft, 1, 0, 0]),
        ];
        loft(B, shin, M_ROBE, [0, 0, 1], false, false);

        // The boot runs along the foot's own axis, so it swings with the ankle
        // roll rather than being a block bolted to the shin.
        //
        // Phase 8B: seven rings instead of six, with a genuine heel counter
        // (a distinct bulge right behind the ankle, not a plain taper) and a
        // toe box that lifts at the very tip — "substantial desert boots"
        // with "slight upward toe curvature", instead of a sock-shaped tube.
        const boot = [
            ring(s * 0.100, 0.050, -0.095, 0.042, 0.048, 0.32, [ft, 1, 0, 0]),
            ring(s * 0.100, 0.064, -0.070, 0.052, 0.064, 0.38, [ft, 1, 0, 0]),
            ring(s * 0.100, 0.056, -0.014, 0.058, 0.062, 0.42, [ft, 1, 0, 0]),
            ring(s * 0.100, 0.049, 0.050, 0.058, 0.052, 0.46, [ft, 1, 0, 0]),
            ring(s * 0.100, 0.045, 0.108, 0.053, 0.043, 0.48, [ft, 1, 0, 0]),
            ring(s * 0.100, 0.048, 0.160, 0.038, 0.031, 0.50, [ft, 1, 0, 0]),
            ring(s * 0.100, 0.058, 0.198, 0.022, 0.018, 0.50, [ft, 1, 0, 0]),
        ];
        loft(B, boot, M_LEATHER, [0, 1, 0], true, true);
    }

    return finishSkinned(scene, "charBody", B);
}

/**
 * The cowl.
 *
 * Built as a swept Bezier: each strand runs from a point on the face-opening rim
 * to a point on the ring where the hood meets the shoulders, bowed outward by a
 * control point that is pushed furthest over the crown. That gives a genuinely
 * deep hood with a rolled opening, rather than a sphere with a hole in it.
 *
 * The rim curve this produces is reused verbatim by the fur trim, so the two can
 * never drift apart.
 */
const HOOD_COLS = 34;
const HOOD_ROWS = 9;
const HEAD_C = [0, 1.655, 0.005];
const FACE_DIR = (() => {
    const v = [0, -0.28, 0.96];
    const l = Math.hypot(v[0], v[1], v[2]);
    return [v[0] / l, v[1] / l, v[2] / l];
})();

/** Face-opening rim point at parameter `s` (0 = crown, 0.5 = under the chin). */
export function hoodRimPoint(s, out) {
    const a = s * Math.PI * 2;
    // U spans the rim horizontally, W vertically, both perpendicular to FACE_DIR.
    const ux = 1, uy = 0, uz = 0;
    const wx = FACE_DIR[1] * uz - FACE_DIR[2] * uy;
    const wy = FACE_DIR[2] * ux - FACE_DIR[0] * uz;
    const wz = FACE_DIR[0] * uy - FACE_DIR[1] * ux;
    const cx = HEAD_C[0] + FACE_DIR[0] * 0.105;
    const cy = HEAD_C[1] + FACE_DIR[1] * 0.105;
    const cz = HEAD_C[2] + FACE_DIR[2] * 0.105;
    out[0] = cx + ux * 0.152 * Math.sin(a) + wx * 0.163 * Math.cos(a);
    out[1] = cy + uy * 0.152 * Math.sin(a) + wy * 0.163 * Math.cos(a);
    out[2] = cz + uz * 0.152 * Math.sin(a) + wz * 0.163 * Math.cos(a);
    return out;
}

function hoodBasePoint(s, out) {
    const a = s * Math.PI * 2;
    out[0] = 0.212 * Math.sin(a);
    out[1] = 1.352;
    out[2] = -0.012 - 0.182 * Math.cos(a);
    return out;
}

function buildHood(B) {
    const rim = [0, 0, 0];
    const base = [0, 0, 0];
    let prevRow = null;

    for (let r = 0; r <= HOOD_ROWS; r++) {
        const t = r / HOOD_ROWS;
        const row = [];
        for (let c = 0; c < HOOD_COLS; c++) {
            const s = c / HOOD_COLS;
            hoodRimPoint(s, rim);
            hoodBasePoint(s, base);

            // Control point.
            //
            // Not the chord's midpoint pushed away from the skull: at the crown
            // the chord runs from a rim point above and in front of the head to
            // a base point below and behind it, straight through the skull, so
            // its midpoint is already inside the head and "away from the head
            // centre" points down into the shoulders.
            //
            // The control direction has to be stated, not derived. It sweeps
            // from up-and-back over the crown, through sideways at the temples,
            // to down-and-forward under the chin — which is the same sweep the
            // rim parameter already makes, so it comes straight off `s`.
            const a = s * Math.PI * 2;
            const sa = Math.sin(a), ca = Math.cos(a);
            let nx = sa * 1.0;
            let ny = ca * 0.84;
            let nz = ca * -0.54;
            const nl = Math.hypot(nx, ny, nz) || 1;
            nx /= nl; ny /= nl; nz /= nl;
            // Radius out from the head: widest over the crown, tightest at the
            // throat, which is what gives the cowl its peak.
            //
            // Pulled in modestly from 0.205/0.062 — at the old radius the
            // hood's control point sat far enough clear of the skull that
            // the whole hood read as one oversized rounded mass. Kept
            // conservative (not cut further) because this same radius feeds
            // the Bezier control point between the rim and base curves
            // below (each with their own, larger, fixed radii) — pull it in
            // too far and the control point falls inside the chord between
            // them instead of bowing outward past it, which would pinch the
            // hood rather than shrink it.
            const rad = 0.185 + 0.055 * ca;
            const mx = HEAD_C[0] + nx * rad;
            const my = HEAD_C[1] + ny * rad;
            const mz = HEAD_C[2] + nz * rad;

            const it = 1 - t;
            const px = it * it * rim[0] + 2 * it * t * mx + t * t * base[0];
            const py = it * it * rim[1] + 2 * it * t * my + t * t * base[1];
            const pz = it * it * rim[2] + 2 * it * t * mz + t * t * base[2];

            // Occlusion: the inside of a cowl sees almost no sky. It is the
            // single cheapest thing that makes a hood read as deep.
            const ao = 0.34 + 0.55 * Math.min(1, t * 2.2);
            // UVs in metres: the rim is about a metre round and the sweep from
            // rim to shoulder about 45 cm.
            row.push(B.vert(px, py, pz, s * 1.02, t * 0.45, M_ROBE, ao, B_HOOD, 1, 0, 0));
        }
        if (prevRow) {
            for (let c = 0; c < HOOD_COLS; c++) {
                const c2 = (c + 1) % HOOD_COLS;
                B.quad(prevRow[c], prevRow[c2], row[c2], row[c]);
            }
        }
        prevRow = row;
    }
}

// -----------------------------------------------------------------------------
//  Fur
// -----------------------------------------------------------------------------

/** Shells in the remaining band. Below about 18 the layering is visible as banding. */
const CUFF_SHELLS = 16;

/**
 * Shell fur — repurposed this phase as frayed wrap-fibre trim rather than fur.
 *
 * A trim band is modelled as a partial torus around the edge it decorates: a
 * ring of cross-sections, each an arc of directions pointing away from the
 * garment. That surface is then emitted once per shell, each copy pushed
 * further along its own direction, and the fragment shader alpha-tests a hashed
 * strand field whose threshold rises with the shell parameter — so strands
 * taper, end at different lengths, and the band reads as loose fibres rather
 * than as a smooth sausage. The mechanism is unchanged from SNOWFLOW's hood
 * fur; only where it is used and how far the strands reach changed.
 *
 * SANDSTORM: SNOWFLOW ran this band around the hood rim as well as the cuffs.
 * A desert hood should not read as fur-trimmed, so that band is gone —
 * `hoodRimPoint`'s geometry is still shared with `buildHood` for the opening
 * itself, just no longer decorated with shells here. What remains is the
 * forearm-wrap band, shortened and coarsened from a plush cuff into the frayed
 * ends of a wound cloth wrap (item 2's "wrapped forearms", item 9's "frayed
 * edges / loose fabric fibres").
 *
 * Bone-bound rather than cloth-bound, deliberately: the wrap rides the
 * forearm bone, which is rigid. Binding it to a simulated surface would need
 * the shell direction to come out of the cloth solve — a second vertex
 * program, for very little visible gain.
 */
export function buildFur(scene) {
    const B = new Builder();
    B.explicitNormals = true;

    // ---- forearm wrap fray -------------------------------------------------
    for (let a = 0; a < 2; a++) {
        const s = a === 0 ? -1 : 1;
        const bone = a === 0 ? B_FORE_L : B_FORE_R;
        const n = 12;
        const cb = new Float32Array(n * 3);
        const co = new Float32Array(n * 3);
        // The forearm runs almost straight down in the bind pose, so the band's
        // ring sits in the XZ plane around it and its outward is radial.
        for (let c = 0; c < n; c++) {
            const ang = (c / n) * Math.PI * 2;
            const rx = Math.sin(ang), rz = Math.cos(ang);
            // Sits on the forearm partway to the wrist, where a wound wrap's
            // frayed lower edge would end.
            cb[c * 3] = s * 0.240 + rx * 0.066;
            cb[c * 3 + 1] = 0.900;
            cb[c * 3 + 2] = 0.012 + rz * 0.064;
            co[c * 3] = rx; co[c * 3 + 1] = 0; co[c * 3 + 2] = rz;
        }
        // Shorter and coarser than SNOWFLOW's cuff fur (len 0.032 -> 0.020):
        // a handful of frayed threads reads convincingly at this length,
        // where the same length read as a lush pelt.
        emitFurBand(B, n, cb, co, 0.012, 0.020, CUFF_SHELLS, bone, 0.52);
    }

    return finishSkinned(scene, "charFur", B, true);
}

/** Cross-section steps across a fur band, and the arc they cover. */
const FUR_ARC_STEPS = 4;
const FUR_ARC = 2.1; // radians, centred on the outward direction

/**
 * One fur band.
 *
 * @param {Builder} B
 * @param {number} cols positions around the ring
 * @param {Float32Array} bases ring positions, 3 floats each
 * @param {Float32Array} outs unit outward direction per ring position
 * @param {number} r0 radius of the band's core, metres
 * @param {number} len strand length beyond the core, metres
 * @param {number} shells
 * @param {number} bone
 * @param {number} ao
 */
function emitFurBand(B, cols, bases, outs, r0, len, shells, bone, ao) {
    const dir = new Float32Array((cols * (FUR_ARC_STEPS + 1)) * 3);

    // Precompute the cross-section directions once: each is the outward vector
    // rotated about the ring's own tangent.
    for (let c = 0; c < cols; c++) {
        const cn = (c + 1) % cols;
        const cp = (c - 1 + cols) % cols;
        let tx = bases[cn * 3] - bases[cp * 3];
        let ty = bases[cn * 3 + 1] - bases[cp * 3 + 1];
        let tz = bases[cn * 3 + 2] - bases[cp * 3 + 2];
        const tl = Math.hypot(tx, ty, tz) || 1;
        tx /= tl; ty /= tl; tz /= tl;

        const ox = outs[c * 3], oy = outs[c * 3 + 1], oz = outs[c * 3 + 2];
        // Third axis of the cross-section plane.
        const ax = ty * oz - tz * oy;
        const ay = tz * ox - tx * oz;
        const az = tx * oy - ty * ox;

        for (let k = 0; k <= FUR_ARC_STEPS; k++) {
            const phi = (k / FUR_ARC_STEPS - 0.5) * FUR_ARC;
            const cs = Math.cos(phi), sn = Math.sin(phi);
            const o = (c * (FUR_ARC_STEPS + 1) + k) * 3;
            dir[o] = ox * cs + ax * sn;
            dir[o + 1] = oy * cs + ay * sn;
            dir[o + 2] = oz * cs + az * sn;
        }
    }

    // Arc length around the ring, so the strand field has a uniform pitch in
    // metres regardless of how big the band is. The shader multiplies this by a
    // density in cells per metre; anything else makes hood fur and cuff fur
    // come out at different scales.
    const arc = new Float32Array(cols + 1);
    for (let c = 1; c <= cols; c++) {
        const a = ((c - 1) % cols) * 3;
        const b = (c % cols) * 3;
        arc[c] = arc[c - 1] + Math.hypot(
            bases[b] - bases[a], bases[b + 1] - bases[a + 1], bases[b + 2] - bases[a + 2]
        );
    }

    const stride = FUR_ARC_STEPS + 1;
    for (let s = 0; s < shells; s++) {
        const t = s / (shells - 1);
        const rowBase = B.pos.length / 3;

        for (let c = 0; c <= cols; c++) {
            const ci = c % cols;
            for (let k = 0; k <= FUR_ARC_STEPS; k++) {
                const o = (ci * stride + k) * 3;
                const dx = dir[o], dy = dir[o + 1], dz = dir[o + 2];
                const rad = r0 + len * t;
                const across = (k / FUR_ARC_STEPS - 0.5) * FUR_ARC * r0;
                const vi = B.vert(
                    bases[ci * 3] + dx * rad,
                    bases[ci * 3 + 1] + dy * rad,
                    bases[ci * 3 + 2] + dz * rad,
                    arc[c], across,
                    t, ao, bone, 1, 0, 0
                );
                B.normal(vi, dx, dy, dz);
            }
        }

        // Shells are independent sheets: each is stitched only to itself, never
        // to its neighbours. That is the whole idea — the gaps between them are
        // where you see through to the shell behind.
        for (let c = 0; c < cols; c++) {
            for (let k = 0; k < FUR_ARC_STEPS; k++) {
                const a = rowBase + c * stride + k;
                B.quad(a, a + 1, a + stride + 1, a + stride);
            }
        }
    }
}

// -----------------------------------------------------------------------------

function finishSkinned(scene, name, B, isFur) {
    const pos = new Float32Array(B.pos);
    const idx = new Uint32Array(B.idx);
    const nrm = B.explicitNormals ? new Float32Array(B.nrm) : computeNormals(pos, idx);

    const mesh = new Mesh(name, scene);
    const vd = new VertexData();
    vd.positions = pos;
    vd.indices = idx;
    vd.normals = nrm;
    vd.uvs = new Float32Array(B.uv);
    vd.applyToMesh(mesh, false);

    mesh.setVerticesData("aux", new Float32Array(B.aux), false, 2);
    mesh.setVerticesData("boneIdx", new Float32Array(B.bi), false, 4);
    mesh.setVerticesData("boneWt", new Float32Array(B.bw), false, 4);

    // The mesh is placed entirely by the vertex shader from bone matrices, so
    // its world matrix is the identity for ever and its bounding box is a lie.
    mesh.alwaysSelectAsActiveMesh = true;
    mesh.isPickable = false;
    mesh.freezeWorldMatrix();
    mesh.doNotSyncBoundingInfo = true;
    mesh.metadata = { triangles: idx.length / 3, vertices: pos.length / 3, fur: !!isFur };
    return mesh;
}

// -----------------------------------------------------------------------------
//  Cloth render mesh
// -----------------------------------------------------------------------------

/**
 * The render mesh for the simulated garments.
 *
 * It carries no positions of its own — `position` is `(u, v, panelIndex)` and
 * the vertex shader reconstructs the surface by Catmull-Rom interpolation of the
 * panel's simulated node grid. That decoupling is what lets a 24x14 verlet solve
 * render as a smooth 48x28 surface, and it means the sim cost is independent of
 * how finely the garment is tessellated.
 *
 * @param {import("./cloth.js").ClothPanel[]} panels
 */
export function buildClothMesh(scene, panels) {
    const pos = [];
    const uv = [];
    const aux = [];
    const idx = [];

    for (let pi = 0; pi < panels.length; pi++) {
        const p = panels[pi];
        const cu = p.renderCols;
        const cv = p.renderRows;
        const base = pos.length / 3;

        for (let j = 0; j <= cv; j++) {
            const v = j / cv;
            for (let i = 0; i <= cu; i++) {
                const u = i / cu;
                pos.push(u, v, pi);
                uv.push(u * p.weaveU, v * p.weaveV);
                // (matId, ao). Garments darken toward the hem, where they sit in
                // their own folds and close to the ground.
                aux.push(p.matId, p.aoTop + (p.aoBottom - p.aoTop) * v);
            }
        }

        const stride = cu + 1;
        for (let j = 0; j < cv; j++) {
            for (let i = 0; i < cu; i++) {
                const a = base + j * stride + i;
                const b = a + 1;
                const c = a + stride;
                const d = c + 1;
                idx.push(a, b, d, a, d, c);
            }
        }
    }

    const mesh = new Mesh("charCloth", scene);
    const vd = new VertexData();
    vd.positions = new Float32Array(pos);
    vd.indices = new Uint32Array(idx);
    vd.uvs = new Float32Array(uv);
    vd.applyToMesh(mesh, false);
    mesh.setVerticesData("aux", new Float32Array(aux), false, 2);

    mesh.alwaysSelectAsActiveMesh = true;
    mesh.isPickable = false;
    mesh.freezeWorldMatrix();
    mesh.doNotSyncBoundingInfo = true;
    mesh.metadata = { triangles: idx.length / 3, vertices: pos.length / 3 };
    return mesh;
}
