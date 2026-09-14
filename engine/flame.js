import { forwardMap, isAffine } from './varfwd.js';
// JWildfire / Apophysis .flame reader — the linear (pure affine) subset.
//
// WHY ONLY LINEAR: a flame renders by CHAOS GAME — iterate a point forward under randomly
// chosen maps and accumulate a histogram. A distance estimator cannot do that. What it CAN do
// is run a contractive affine IFS BACKWARDS: at each step apply the inverse of the map that
// keeps you nearest the attractor, accumulating the expansion. That works for affine maps and
// only for affine maps, so an xform carrying any nonlinear variation is reported and skipped.
//
// COORDINATE CONVENTION: JWildfire stores a 3D xform as three 2D affines — coefs (XY),
// yzCoefs (YZ), zxCoefs (ZX) — and the composition order is not documented in the file.
//
// It has to be inferred, and ONE reference object is not enough to pin it down. A Sierpinski
// tetrahedron only requires every map to be a 0.5-similarity, and FOUR of the six orders satisfy
// that; the first version of this parser picked XY -> ZX -> YZ from among them and was wrong.
//
// A Jerusalem cube is the discriminating case, because it must be ISOTROPIC — it spans [0,1] on
// every axis. Under the old order it came out 0.41 x 1.0 x 1.0, squashed in x, because the XY
// block's translation was being scaled by a later block. Requiring BOTH properties leaves
// exactly one order:
//
//   order        Sierpinski 0.5-similarities   Jerusalem isotropic
//   xy->zx->yz              yes                       NO
//   yz->xy->zx              yes                       NO
//   yz->zx->xy              yes                       NO
//   zx->yz->xy              NO                        yes
//   zx->xy->yz              yes                       yes   <-- unique
//
// Both example flames are checked against these properties in tools/test-presets.mjs, so the
// order cannot drift back.
const PLANE_ORDER = ['zx', 'xy', 'yz'];

const PLANES = { xy: [0, 1], yz: [1, 2], zx: [2, 0] };

function nums(s){
  return String(s).trim().split(/\s+/).map(Number);
}

// "a b c d e f" is column-major: x' = a*x + c*y + e, y' = b*x + d*y + f
function planeAffine(c, i0, i1){
  const [a, b, cc, d, e, f] = c;
  const M = [1, 0, 0, 0, 1, 0, 0, 0, 1];          // row-major 3x3
  const T = [0, 0, 0];
  M[i0 * 3 + i0] = a;  M[i0 * 3 + i1] = cc;
  M[i1 * 3 + i0] = b;  M[i1 * 3 + i1] = d;
  T[i0] = e;  T[i1] = f;
  return { M, T };
}

const mul = (A, B) => {
  const C = new Array(9).fill(0);
  for(let i = 0; i < 3; i++) for(let j = 0; j < 3; j++){
    let s = 0;
    for(let k = 0; k < 3; k++) s += A[i * 3 + k] * B[k * 3 + j];
    C[i * 3 + j] = s;
  }
  return C;
};
const apply = (A, v) => [0, 1, 2].map(i => A[i * 3] * v[0] + A[i * 3 + 1] * v[1] + A[i * 3 + 2] * v[2]);

export function det3(M){
  return M[0] * (M[4] * M[8] - M[5] * M[7])
       - M[1] * (M[3] * M[8] - M[5] * M[6])
       + M[2] * (M[3] * M[7] - M[4] * M[6]);
}

export function inv3(M){
  const d = det3(M);
  if(Math.abs(d) < 1e-12) return null;            // singular map: not invertible, unusable
  const i = [
    (M[4] * M[8] - M[5] * M[7]), (M[2] * M[7] - M[1] * M[8]), (M[1] * M[5] - M[2] * M[4]),
    (M[5] * M[6] - M[3] * M[8]), (M[0] * M[8] - M[2] * M[6]), (M[2] * M[3] - M[0] * M[5]),
    (M[3] * M[7] - M[4] * M[6]), (M[1] * M[6] - M[0] * M[7]), (M[0] * M[4] - M[1] * M[3])
  ];
  return i.map(v => v / d);
}

// Largest singular value, by power iteration on M^T M. This is the exact operator norm, which
// is what the estimator needs when a map is not a similarity (shear or anisotropic scale).
export function opNorm(M){
  let v = [0.577, 0.577, 0.577];
  for(let it = 0; it < 60; it++){
    const Mv = apply(M, v);
    const MtMv = [0, 1, 2].map(i => M[0 * 3 + i] * Mv[0] + M[1 * 3 + i] * Mv[1] + M[2 * 3 + i] * Mv[2]);
    const n = Math.hypot(...MtMv);
    if(n < 1e-20) return 0;
    v = MtMv.map(x => x / n);
  }
  return Math.hypot(...apply(M, v)) / Math.hypot(...v);
}

// Bookkeeping attributes: not variations, not geometry.
const IGNORE = new Set(['weight', 'color', 'color_type', 'colorType', 'symmetry', 'material',
  'material_speed', 'coefs', 'yzCoefs', 'zxCoefs', 'post', 'yzPostCoefs', 'zxPostCoefs',
  'chaos', 'opacity', 'var_color', 'name', 'antialias_amount', 'antialias_radius',
  'preserve_z', 'wfield_type', 'fx_priority']);

// The AFFINE variation family. All of these are the identity map scaled by their amount, so
// they compose with the affine exactly and their amounts simply add.
//
// `linear` only carries z when the flame sets preserve_z; `linear3D` always does. A 2D-only
// xform collapses z, which is a singular 3D map, so z is passed through with a warning rather
// than producing an uninvertible matrix.
const LINEAR_VARS = ['linear', 'linear3D', 'linearT3D'];

export function parseFlame(text){
  const warnings = [];
  const preserveZ = /\bpreserve_z="1"/.test(text);
  let flat = false;
  const nameM = /<flame[^>]*\bname="([^"]*)"/.exec(text);
  const name = nameM ? nameM[1] : 'flame';

  const xforms = [...text.matchAll(/<xform\b([^>]*?)\/?>/g)].map(m => m[1]);
  if(!xforms.length) throw new Error('no <xform> found — is this a .flame file?');

  const maps = [];
  xforms.forEach((attrs, idx) => {
    const at = {};
    for(const m of attrs.matchAll(/(\w+)="([^"]*)"/g)) at[m[1]] = m[2];

    // Reject anything outside the affine family. A variation's AMOUNT is free — it scales the
    // affine result — so only the variation's identity matters, not its weight.
    const nonlinear = Object.keys(at).filter(k =>
      !IGNORE.has(k) && !/_speed$|_fx_priority$|^mod_/.test(k) &&
      !LINEAR_VARS.includes(k) && Number(at[k]) !== 0);
    if(nonlinear.length){
      warnings.push(`xform ${idx + 1} skipped: nonlinear variation(s) ${nonlinear.join(', ')}`);
      return;
    }
    const k = LINEAR_VARS.reduce((acc, v) => acc + (at[v] === undefined ? 0 : Number(at[v])), 0);
    if(!isFinite(k) || Math.abs(k) < 1e-12){
      warnings.push(`xform ${idx + 1} skipped: no affine variation (linear / linear3D) present`);
      return;
    }
    if(at.linear !== undefined && at.linear3D === undefined && !preserveZ){
      flat = true;                                  // 2D flame: z would collapse
    }
    if(!at.coefs){ warnings.push(`xform ${idx + 1} skipped: no coefs`); return; }

    const src = { xy: nums(at.coefs),
                  yz: at.yzCoefs ? nums(at.yzCoefs) : [1, 0, 0, 1, 0, 0],
                  zx: at.zxCoefs ? nums(at.zxCoefs) : [1, 0, 0, 1, 0, 0] };

    let M = [1, 0, 0, 0, 1, 0, 0, 0, 1], T = [0, 0, 0];
    PLANE_ORDER.forEach(pl => {
      const [i0, i1] = PLANES[pl];
      const a = planeAffine(src[pl], i0, i1);
      M = mul(a.M, M);
      T = apply(a.M, T).map((v, i) => v + a.T[i]);
    });

    // The variation AMOUNT is not folded into the affine. It belongs to the variation and the
    // shader applies it there, so leaving it here would double-count it — and, more to the
    // point, folding it made the file's own numbers unreadable: an xform with offset (1, -1)
    // and amount 0.5 showed up in the panel as translation 0 and amount 1.

    // POST transform, if present: flame math is affine -> variations -> post affine. Ignoring a
    // post block would import silently wrong geometry, so it is composed rather than skipped.
    if(at.post || at.yzPostCoefs || at.zxPostCoefs){
      const psrc = { xy: at.post ? nums(at.post) : [1, 0, 0, 1, 0, 0],
                     yz: at.yzPostCoefs ? nums(at.yzPostCoefs) : [1, 0, 0, 1, 0, 0],
                     zx: at.zxPostCoefs ? nums(at.zxPostCoefs) : [1, 0, 0, 1, 0, 0] };
      let PM = [1, 0, 0, 0, 1, 0, 0, 0, 1], PT = [0, 0, 0];
      PLANE_ORDER.forEach(pl => {
        const [i0, i1] = PLANES[pl];
        const a = planeAffine(psrc[pl], i0, i1);
        PM = mul(a.M, PM);
        PT = apply(a.M, PT).map((v, i) => v + a.T[i]);
      });
      M = mul(PM, M);
      T = apply(PM, T).map((v, i) => v + PT[i]);
    }

    if(!inv3(M)){ warnings.push(`xform ${idx + 1} skipped: singular (zero determinant)`); return; }
    // Contractivity is a property of the EFFECTIVE map, so the variation amount has to be
    // included here even though it is no longer folded into the affine. Testing the bare affine
    // reported every xform of a perfectly good 0.5 flame as non-contractive.
    const sc = opNorm(M) * Math.abs(k);
    if(sc >= 0.999){
      warnings.push(`xform ${idx + 1} is not contractive (scale ${sc.toFixed(3)}) — ` +
                    'the attractor is unbounded and will not resolve');
    }
    const xf = makeXform(M, T, at.weight === undefined ? 1 : Number(at.weight));
    xf.vamt = k;                                   // the file's variation amount, shown as-is
    // XAOS: this xform's transition weights to every other. Only the ZERO PATTERN matters here.
    // A chaos-game renderer uses the magnitudes to shape DENSITY, but density is not geometry —
    // measured over a run of five million points, changing weights leaves the attractor's
    // support identical while a single xaos zero changes it permanently. So a transition is
    // either allowed or forbidden, and nothing in between reaches the estimator.
    xf.chaos = at.chaos ? nums(at.chaos).map(v => (v > 0 ? 1 : 0)) : null;
    maps.push(xf);
  });

  if(!maps.length){
    const why = warnings.length ? ' (' + warnings[0] + ')' : '';
    throw new Error('no usable affine xforms' + why);
  }
  if(flat){
    warnings.push('this is a 2D flame (linear without preserve_z) — z is passed through so the ' +
                  'attractor is planar rather than a collapsed, uninvertible map');
  }
  if(maps.length > MAX_XFORMS){
    warnings.push(`${maps.length} xforms found; only the first ${MAX_XFORMS} are used — ` +
                  'the rest are discarded and the attractor will not match the original');
    maps.length = MAX_XFORMS;
  }
  return { name, maps, warnings };
}

// Real flames routinely exceed a handful of xforms — a Jerusalem cube needs 20. The cap was 8,
// which silently discarded the rest and rendered a completely different attractor.
//
// The ceiling is the fragment uniform budget, not taste. Per xform the shader can reference
// 3 vec4 slots for the inverse matrix plus one each for the inverse translation, the expansion,
// the variation amount, the fixed point and three parameter vec4s. GLSL drops uniforms it never
// references, so a flame of plain linear3D xforms (no parameters, nearest-image selection) costs
// about 6 slots each and 24 fits comfortably inside the 224 that WebGL2 guarantees.
export const MAX_XFORMS = 24;

// Variations available INSIDE an xform.
//
// This list is much shorter than the fold stack's, and the reason is structural rather than
// effort: the flame path runs the maps BACKWARDS, so a variation here needs a closed-form
// INVERSE. sinusoidal, cylinder, waves and pdj are many-to-one and have none. bubble's image is
// bounded by its amount, so points outside it have no preimage at all. hyperbolic and curl
// invert to a quadratic with an ambiguous branch. The four below invert exactly.
//
// p1 / p2 are the variation's own parameters; a null slot means the variation has none.
// Verified against the JWildfire sources at
// src/org/jwildfire/create/tina/variation, and every inverse below was checked numerically for
// the property the backward path actually needs: V(V^-1(q)) == q.
// A variation's parameters are pinned to explicit SLOTS in a shared 12-float store, rather than
// packed positionally. Slots are never reused across variations, so switching a variation cannot
// silently reinterpret a value you set for a different one, and a preset stays meaningful.
export const VP_SLOTS = 12;

export const FLAME_VARIATIONS = [
  { name: 'linear3D',     params: [] },
  { name: 'spherical3D',  params: [] },
  { name: 'swirl',        params: [[0, 'Twist', -3, 3, 0.005, 0.8]] },
  { name: 'radial power', params: [[1, 'Power', -3, 3, 0.005, 2]] },
  { name: 'exp',          params: [] },
  { name: 'log',          params: [] },
  { name: 'unpolar',      params: [] },
  { name: 'polar',        params: [] },
  { name: 'zscale',       params: [] },
  { name: 'zcone',        params: [] },
  // The complex-analytic family — JWildfire's "complex vars by cothe" set. Every one of these
  // is many-to-one going forward, yet each has a PRINCIPAL inverse that is a true right inverse
  // (sin(asin z) == z identically), which is exactly and only what the backward path needs.
  // All are conformal, so the norm is |g'| = 1 / |f'(g(q))| — the forward derivative suffices.
  { name: 'sin',          params: [] },
  { name: 'cos',          params: [] },
  { name: 'tan',          params: [] },
  { name: 'sinh',         params: [] },
  { name: 'cosh',         params: [] },
  { name: 'tanh',         params: [] },
  { name: 'sec',          params: [] },
  { name: 'csc',          params: [] },
  { name: 'cot',          params: [] },
  { name: 'sech',         params: [] },
  { name: 'csch',         params: [] },
  { name: 'coth',         params: [] },
  // A genuine 3D Mobius: inversion about a centre, then rotate, scale and translate. Every
  // orientation-preserving Mobius of R^3 that is not a similarity has this form, and every step
  // inverts in closed form — verified exact both ways and conformal to 1e-8.
  //
  // NOT the same as JWildfire's `mobiq`. Mobiq is a quaternion Mobius that computes four
  // components and DISCARDS the k one, so it is a projection rather than a bijection of R^3:
  // inverting it would mean recovering the component it threw away, which has no closed form.
  // Mobiq can only ever be a fold; this can be an xform variation, and is the better map anyway.
  { name: 'mobius3D',     params: [
      [2, 'Centre X', -3, 3, 0.005, 0], [3, 'Centre Y', -3, 3, 0.005, 0],
      [4, 'Centre Z', -3, 3, 0.005, 0],
      [5, 'Move X', -3, 3, 0.005, 0],   [6, 'Move Y', -3, 3, 0.005, 0],
      [7, 'Move Z', -3, 3, 0.005, 0],
      [8, 'Scale', 0.05, 4, 0.005, 1],
      [9, 'Rotate X\u00b0', -180, 180, 0.5, 0], [10, 'Rotate Y\u00b0', -180, 180, 0.5, 0],
      [11, 'Rotate Z\u00b0', -180, 180, 0.5, 0]] }
];

// Defaults for the shared parameter store, taken from the variation specs.
export function defaultVP(){
  const vp = new Array(VP_SLOTS).fill(0);
  FLAME_VARIATIONS.forEach(v => v.params.forEach(([i, , , , , d]) => { vp[i] = d; }));
  return vp;
}

// An xform keeps its IMPORTED affine untouched and layers editable offsets on top, so the
// editor is non-destructive: "reset" restores exactly what the file said, and a preset can
// record what you changed rather than a mangled matrix.
export function makeXform(M, T, weight = 1){
  return {
    M: M.slice(), T: T.slice(),                    // base, from the file — never edited
    scale: 1, rot: [0, 0, 0], tr: [0, 0, 0],       // editable offsets
    // An imported flame folds its variation amount into the affine at parse time, so it arrives
    // as linear3D at amount 1. Switching to another variation layers it on top of that affine,
    // which is flame semantics: f(p) = V(affine(p)).
    vari: 0, vamt: 1, vp: defaultVP(),
    chaos: null,                                   // null means "may follow anything"

    on: true, weight
  };
}

export function identityXform(){
  // a plain 0.5 contraction toward the origin: a usable starting point for building by hand
  return makeXform([0.5, 0, 0, 0, 0.5, 0, 0, 0, 0.5], [0, 0, 0], 1);
}

function rotM(deg){
  const [a, b, c] = deg.map(d => d * Math.PI / 180);
  const cx = Math.cos(a), sx = Math.sin(a), cy = Math.cos(b), sy = Math.sin(b),
        cz = Math.cos(c), sz = Math.sin(c);
  const Rx = [1, 0, 0, 0, cx, -sx, 0, sx, cx];
  const Ry = [cy, 0, sy, 0, 1, 0, -sy, 0, cy];
  const Rz = [cz, -sz, 0, sz, cz, 0, 0, 0, 1];
  return mul(Rz, mul(Ry, Rx));
}

// Effective map for an xform: f(x) = R * (scale * (Mx + T)) + translate.
// The editor offsets are applied AFTER the imported affine, which is what makes rotate and
// translate behave the way they look on screen.
export function resolveXform(x){
  const R = rotM(x.rot);
  const Ms = x.M.map(v => v * x.scale);
  // affine with the editor's offsets, WITHOUT the variation amount — this is what the shader
  // inverts, because it applies the variation's own inverse first
  const Aff = mul(R, Ms);
  const Taf = apply(R, x.T.map(v => v * x.scale)).map((v, i) => v + x.tr[i]);
  const Mi = inv3(Aff);
  if(!Mi) return null;
  // full effective map, amount included — what the hull, the image boxes and the displayed
  // contraction have to be computed from
  const a = isFinite(x.vamt) ? x.vamt : 1;
  const M = Aff.map(v => v * a);
  const T = Taf.map(v => v * a);
  const A = [1 - M[0], -M[1], -M[2], -M[3], 1 - M[4], -M[5], -M[6], -M[7], 1 - M[8]];
  const Ai = inv3(A);
  return {
    M, T, Mi,
    Ti: apply(Mi, Taf).map(v => -v),
    fp: Ai ? apply(Ai, T) : [0, 0, 0],
    scale: opNorm(M),
    expand: opNorm(Mi),
    Aff, Taf,                                      // affine WITHOUT the amount: the variation
                                                   // applies that, so the forward map needs both
                                                   // halves separately
    base: x.T,                                     // the file's own translation, for the panel
    chaos: x.chaos ? x.chaos.slice() : null,       // xaos row, needed to build the adjacency
    vari: Math.max(0, Math.min(FLAME_VARIATIONS.length - 1, x.vari | 0)),
    vamt: isFinite(x.vamt) ? x.vamt : 1,
    vp: (() => { const d = defaultVP();
                 for(let i = 0; i < VP_SLOTS; i++)
                   if(x.vp && isFinite(x.vp[i])) d[i] = x.vp[i];
                 return d; })()
  };
}

// Adjacency from the xaos rows: allow[i][j] is 1 when the chaos game may go from xform i to j.
// A missing chaos row means that xform imposes no restriction.
// Adjacency for the SURVIVING xforms. A chaos row is indexed by the xform's position in the
// FILE, so once any xform is disabled the rows have to be remapped through srcIndex rather than
// read positionally. Reading them positionally silently pointed each row at the wrong column and
// left the last transform with no permitted successors at all.
export function xaosMatrix(maps){
  const n = maps.length;
  return maps.map(a => Array.from({ length: n }, (_, b) => {
    const row = a.chaos;
    const col = maps[b].srcIndex;
    return (row && row.length > col) ? (row[col] ? 1 : 0) : 1;
  }));
}

export function xaosIsTrivial(A){
  return A.every(r => r.every(v => v === 1));
}

// PER-STATE hulls. With xaos this is a graph-directed IFS: the set a point occupies depends on
// which map was applied last. A_j = f_j( union of A_i over i that may precede j ), so each xform
// gets its own bounding box and they are NOT simply f_j(global hull).
// SAMPLED hull, for flames whose transforms are not affine.
//
// The corner iteration below assumes each map sends a box to a box, which is only true of an
// affine map. Put `exp` at amount 0.015 on a transform and the affine part is tiny while the real
// image is not: the hull collapsed to a box 0.003 units across, the containers stopped containing
// anything, and the render became a wash of noise.
//
// So when any transform carries a variation, the hull is MEASURED instead — run the chaos game
// with the true forward maps and take the extent of what comes out. Slower than the fixed point
// and correct for maps the fixed point cannot describe.
export function sampledHulls(maps, A, fwd, samples = 24000){
  const n = maps.length;
  let seed = 0x2545f491;
  const rnd = () => { seed ^= seed << 13; seed |= 0; seed ^= seed >>> 17;
                      seed ^= seed << 5; seed |= 0; return (seed >>> 0) / 4294967296; };
  const lo = maps.map(() => [1e30, 1e30, 1e30]);
  const hi = maps.map(() => [-1e30, -1e30, -1e30]);
  const gl = [1e30, 1e30, 1e30], gh = [-1e30, -1e30, -1e30];
  let p = [0, 0, 0], prev = -1;
  for(let i = 0; i < samples; i++){
    // respect xaos: only maps the grammar allows may follow the last one
    let k = (rnd() * n) | 0;
    for(let t = 0; t < n && prev >= 0 && !A[prev][k]; t++) k = (k + 1) % n;
    const q = fwd(maps[k], p);
    if(!isFinite(q[0]) || !isFinite(q[1]) || !isFinite(q[2])){ p = [0, 0, 0]; prev = -1; continue; }
    p = q; prev = k;
    if(i < 60) continue;                       // burn-in
    for(let a = 0; a < 3; a++){
      if(p[a] < lo[k][a]) lo[k][a] = p[a];
      if(p[a] > hi[k][a]) hi[k][a] = p[a];
      if(p[a] < gl[a]) gl[a] = p[a];
      if(p[a] > gh[a]) gh[a] = p[a];
    }
  }
  for(let j = 0; j < n; j++){
    if(lo[j][0] > hi[j][0]){ lo[j] = [0, 0, 0]; hi[j] = [0, 0, 0]; continue; }
    for(let a = 0; a < 3; a++){
      const pad = Math.max((hi[j][a] - lo[j][a]) * 0.02, 1e-4);
      lo[j][a] -= pad; hi[j][a] += pad;
    }
  }
  return { lo, hi, glo: gl, ghi: gh };
}

export function stateHulls(maps, A){
  const n = maps.length;

  // Iterate DOWNWARD from a box that provably contains the attractor, not upward from a seed
  // point. Seeding from the origin was wrong in a way that looked plausible: the seed never
  // leaves, so every state hull ends up containing (0,0,0) whether or not that point is in it,
  // and the boxes all overlap. Downward from a superset is monotone and lands on the truth.
  //
  // For contractions with |f| <= c and |T| <= t the attractor lies inside radius t/(1-c).
  let c = 0, t = 0;
  maps.forEach(m => {
    c = Math.max(c, opNorm(m.M));
    t = Math.max(t, Math.hypot(m.T[0], m.T[1], m.T[2]));
  });
  const R = (c < 0.999) ? (t / (1 - c)) * 1.0001 + 1e-6 : 1e6;

  // The box iteration is NOT monotone when a map rotates: the AABB of a rotated box inflates by
  // up to |cos|+|sin| per plane, and if that inflation beats the contraction the iteration grows
  // without bound. A -126.5 degree rotation at scale 0.72 gives 0.72 * 1.40 = 1.008, and the
  // hull ran away to +/-45 on a flame whose attractor fits inside a radius of 2.4.
  //
  // R is a genuine bound on the attractor, so clamping to it every step is both safe and enough:
  // divergence is capped, and for axis-aligned flames the clamp never binds.
  const clamp3 = v => v.map(x => Math.max(-R, Math.min(R, x)));
  let lo = maps.map(() => [-R, -R, -R]), hi = maps.map(() => [R, R, R]);
  for(let it = 0; it < 400; it++){
    const nlo = maps.map(() => [1e30, 1e30, 1e30]);
    const nhi = maps.map(() => [-1e30, -1e30, -1e30]);
    let any = false;
    for(let j = 0; j < n; j++){
      const m = maps[j];
      for(let i = 0; i < n; i++){
        if(!A[i][j]) continue;                     // i cannot precede j
        any = true;
        for(let cc = 0; cc < 8; cc++){
          const v = [(cc & 1) ? hi[i][0] : lo[i][0],
                     (cc & 2) ? hi[i][1] : lo[i][1],
                     (cc & 4) ? hi[i][2] : lo[i][2]];
          for(let r = 0; r < 3; r++){
            const w = m.M[r*3]*v[0] + m.M[r*3+1]*v[1] + m.M[r*3+2]*v[2] + m.T[r];
            if(w < nlo[j][r]) nlo[j][r] = w;
            if(w > nhi[j][r]) nhi[j][r] = w;
          }
        }
      }
      if(nlo[j][0] > nhi[j][0]){                   // unreachable state: no predecessor at all
        nlo[j] = [0, 0, 0]; nhi[j] = [0, 0, 0];
      } else {
        nlo[j] = clamp3(nlo[j]); nhi[j] = clamp3(nhi[j]);
      }
    }
    let done = true;
    for(let j = 0; j < n && done; j++)
      for(let r = 0; r < 3; r++)
        if(Math.abs(nlo[j][r] - lo[j][r]) > 1e-12 ||
           Math.abs(nhi[j][r] - hi[j][r]) > 1e-12) done = false;
    lo = nlo; hi = nhi;
    if(done || !any) break;
  }
  return { lo, hi };
}

// The attractor's bounding box, found by iterating B -> union of f_i(B) to a fixed point.
// Cheap, exact for a contractive IFS, and it is what makes the good selection rule possible.
export function flameHull(maps){
  let lo = [0, 0, 0], hi = [0, 0, 0];
  for(let it = 0; it < 300; it++){
    let nlo = lo.slice(), nhi = hi.slice();
    maps.forEach(m => {
      for(let c = 0; c < 8; c++){
        const v = [(c & 1) ? hi[0] : lo[0], (c & 2) ? hi[1] : lo[1], (c & 4) ? hi[2] : lo[2]];
        for(let r = 0; r < 3; r++){
          const w = m.M[r*3]*v[0] + m.M[r*3+1]*v[1] + m.M[r*3+2]*v[2] + m.T[r];
          if(w < nlo[r]) nlo[r] = w;
          if(w > nhi[r]) nhi[r] = w;
        }
      }
    });
    const done = nlo.every((v, i) => Math.abs(v - lo[i]) < 1e-12) &&
                 nhi.every((v, i) => Math.abs(v - hi[i]) < 1e-12);
    lo = nlo; hi = nhi;
    if(done) break;
  }
  return { lo, hi };
}

// Axis-aligned box of f_i(hull) — the region this map is responsible for.
function imageBox(m, hull){
  const lo = [1e30, 1e30, 1e30], hi = [-1e30, -1e30, -1e30];
  for(let c = 0; c < 8; c++){
    const v = [(c & 1) ? hull.hi[0] : hull.lo[0],
               (c & 2) ? hull.hi[1] : hull.lo[1],
               (c & 4) ? hull.hi[2] : hull.lo[2]];
    for(let r = 0; r < 3; r++){
      const w = m.M[r*3]*v[0] + m.M[r*3+1]*v[1] + m.M[r*3+2]*v[2] + m.T[r];
      if(w < lo[r]) lo[r] = w;
      if(w > hi[r]) hi[r] = w;
    }
  }
  return { lo, hi };
}

// All enabled xforms, resolved. This is what the renderer uploads.
// MEMO. resolveFlame is not cheap — stateHulls alone is a 400-iteration fixed point over every
// map's eight corners — and currentCfg() calls it on every frame to build the shader signature.
// Measured before this cache: 5 ms for an 8-map flame and 16 ms for a 20-map one, per call, twice
// a frame. That is the whole frame budget spent recomputing something that only changes when a
// transform is edited.
//
// The key is a cheap numeric hash of exactly the inputs that affect the result. Building it is
// linear in the transform count, against a fixed point that is quadratic in it.
let memoKey = null, memoVal = null;

// Hash the float's BITS, not an arithmetic mangling of its value. The first attempt used
// `v * 2^32 | 0`, which maps every integer to zero — so a rotation of 13 degrees, a scale of 1
// and a weight of 1 all hashed identically and edits between them were invisible. A soak of 400
// random edits caught 14 stale results; with the bit view it catches none.
const _f64 = new Float64Array(1);
const _i32 = new Int32Array(_f64.buffer);

function flameKeyNum(flame){
  let h = 0x811c9dc5;
  const mix = v => {
    _f64[0] = v;
    h ^= _i32[0]; h = Math.imul(h, 0x01000193) | 0;
    h ^= _i32[1]; h = Math.imul(h, 0x01000193) | 0;
  };
  const maps = flame.maps;
  mix(maps.length);
  for(let i = 0; i < maps.length; i++){
    const x = maps[i];
    for(let j = 0; j < 9; j++) mix(x.M[j]);
    for(let j = 0; j < 3; j++){ mix(x.T[j]); mix(x.rot[j]); mix(x.tr[j]); }
    mix(x.scale); mix(x.vamt); mix(x.vari); mix(x.weight === undefined ? 1 : x.weight);
    mix(x.on === false ? 0 : 1);
    for(let j = 0; j < VP_SLOTS; j++) mix(x.vp ? x.vp[j] : 0);
    if(x.chaos){ mix(x.chaos.length); for(let j = 0; j < x.chaos.length; j++) mix(x.chaos[j] ? 1 : 0); }
    else mix(-1);
  }
  return h;
}

export function invalidateFlameCache(){ memoKey = null; memoVal = null; }

export function resolveFlame(flame){
  if(!flame || !flame.maps) return [];
  const key = flameKeyNum(flame);
  if(key === memoKey && memoVal) return memoVal;
  const out = [];
  flame.maps.forEach((x, i) => {
    if(out.length >= MAX_XFORMS) return;
    if(x.on === false) return;
    // A zero-weight xform is never chosen by the chaos game, so it is not part of the attractor
    // at all. Above zero the weight changes DENSITY rather than shape, which a surface renderer
    // cannot show — but zero is a genuine geometric switch and has to be honoured.
    if(isFinite(x.weight) && x.weight <= 0) return;
    const r = resolveXform(x);
    if(!r) return;
    r.srcIndex = i;                                // position in the FILE, for the xaos lookup
    out.push(r);
  });
  if(out.length){
    const A = xaosMatrix(out);
    // The corner fixed point is only valid when every map is affine. A variation makes the map
    // non-affine, and the hull it produces then describes a transform nobody is rendering.
    const affine = out.every(isAffine);
    let sh, lo, hi;
    if(affine){
      sh = stateHulls(out, A);
      lo = [0, 1, 2].map(r => Math.min(...sh.lo.map(v => v[r])));
      hi = [0, 1, 2].map(r => Math.max(...sh.hi.map(v => v[r])));
    } else {
      sh = sampledHulls(out, A, forwardMap);
      lo = sh.glo; hi = sh.ghi;
      for(let a = 0; a < 3; a++){
        const pad = Math.max((hi[a] - lo[a]) * 0.02, 1e-4);
        lo[a] -= pad; hi[a] += pad;
      }
    }
    out.forEach((m, j) => { m.blo = sh.lo[j]; m.bhi = sh.hi[j]; });
    out.affine = affine;
    out.hull = { lo, hi };
    out.xaos = A;

    // Does the exact rule actually apply? "Image box" is exact only while the image boxes are
    // DISJOINT. The image of a rotated map is not axis-aligned, so its AABB is much larger than
    // the image itself, and with enough rotation every box overlaps every other. The rule then
    // has nothing to discriminate on and the choice becomes arbitrary inside the overlap — which
    // is what paints phantom surface and terraces on it.
    //
    // The panel calls the rule "exact for affine". For a flame like that it is not, and saying so
    // is worth more than a rule that quietly degrades.
    let pairs = 0, overlapping = 0;
    for(let i = 0; i < out.length; i++){
      for(let j = i + 1; j < out.length; j++){
        pairs++;
        const hit = [0, 1, 2].every(a =>
          Math.min(out[i].bhi[a], out[j].bhi[a]) - Math.max(out[i].blo[a], out[j].blo[a]) > 1e-6);
        if(hit) overlapping++;
      }
    }
    out.boxOverlap = { pairs, overlapping, exact: overlapping === 0 };
  }
  memoKey = key; memoVal = out;
  return out;
}

// Only the COUNT is baked into the shader; the matrices are uniforms, so editing a transform
// is free rather than a recompile. That is the whole reason the editor feels live.
// Variation TYPES are compiled in (each emits different inverse code), so they belong in the
// signature; their amounts and parameters are uniforms and do not.
export function flameKey(flame){
  const r = resolveFlame(flame);
  const sel = Math.max(0, Math.min(3, (flame && flame.select) | 0));
  const ax = (r.xaos || []).map(row => row.join('')).join('');
  return r.length + ':' + sel + ':' + r.map(m => m.vari).join('') + ':' + ax;
}

export function flameVars(flame){ return resolveFlame(flame).map(m => m.vari); }

// The GUARANTEED minimum expansion of a variation's inverse, per pass.
//
// Most inverses divide by the amount somewhere, so they carry a floor of 1/|amount| however
// benign the geometry looks. That floor is what makes a small amount dangerous: log at 0.1
// multiplies the accumulated scale by at least 10 every iteration, and after nine passes s is
// past 1e9 — at which point prim(q)/s is zero for every point and the frame reads as solid.
//
// Reporting it lets the panel say WHY a flame washes out, instead of leaving it to be discovered
// by sliding things at random.
export function inverseFloor(m){
  const a = Math.max(Math.abs(m.vamt), 1e-5);
  switch(m.vari | 0){
    case 1:  return 1;              // spherical3D: an involution, the amount cancels
    case 9:  return 1;              // zcone: no division by the amount
    case 22: return 1 / a;          // mobius3D
    default: return 1 / a;          // everything else divides by the amount at least once
  }
}

// Worst-case accumulated scale after `iters` passes, using each map's affine expansion too.
export function projectedScale(maps, iters){
  if(!maps.length) return 1;
  const per = Math.max(...maps.map(m => inverseFloor(m) * (m.expand || 1)));
  return Math.pow(per, Math.max(1, iters | 0));
}
