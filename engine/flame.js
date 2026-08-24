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

    // the variation amount scales the affine result
    M = M.map(v => v * k);
    T = T.map(v => v * k);

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
    const sc = opNorm(M);
    if(sc >= 0.999){
      warnings.push(`xform ${idx + 1} is not contractive (scale ${sc.toFixed(3)}) — ` +
                    'the attractor is unbounded and will not resolve');
    }
    maps.push(makeXform(M, T, at.weight === undefined ? 1 : Number(at.weight)));
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
  const M = mul(R, Ms);
  const T = apply(R, x.T.map(v => v * x.scale)).map((v, i) => v + x.tr[i]);
  const Mi = inv3(M);
  if(!Mi) return null;
  const A = [1 - M[0], -M[1], -M[2], -M[3], 1 - M[4], -M[5], -M[6], -M[7], 1 - M[8]];
  const Ai = inv3(A);
  return {
    M, T, Mi,
    Ti: apply(Mi, T).map(v => -v),
    fp: Ai ? apply(Ai, T) : [0, 0, 0],
    scale: opNorm(M),
    expand: opNorm(Mi),
    vari: Math.max(0, Math.min(FLAME_VARIATIONS.length - 1, x.vari | 0)),
    vamt: isFinite(x.vamt) ? x.vamt : 1,
    vp: (() => { const d = defaultVP();
                 for(let i = 0; i < VP_SLOTS; i++)
                   if(x.vp && isFinite(x.vp[i])) d[i] = x.vp[i];
                 return d; })()
  };
}

// All enabled xforms, resolved. This is what the renderer uploads.
export function resolveFlame(flame){
  if(!flame || !flame.maps) return [];
  return flame.maps.filter(x => x.on !== false)
                   .map(resolveXform)
                   .filter(Boolean)
                   .slice(0, MAX_XFORMS);
}

// Only the COUNT is baked into the shader; the matrices are uniforms, so editing a transform
// is free rather than a recompile. That is the whole reason the editor feels live.
// Variation TYPES are compiled in (each emits different inverse code), so they belong in the
// signature; their amounts and parameters are uniforms and do not.
export function flameKey(flame){
  const r = resolveFlame(flame);
  const sel = flame && flame.select ? 1 : 0;
  return r.length + ':' + sel + ':' + r.map(m => m.vari).join('');
}

export function flameVars(flame){ return resolveFlame(flame).map(m => m.vari); }
