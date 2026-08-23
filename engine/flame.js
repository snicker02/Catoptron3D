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
// It was determined empirically against a known Sierpinski tetrahedron: of the six possible
// orders, two produce singular values [1, 0.5, 0.25] and are definitively wrong, and four
// produce exact 0.5-similarities as a Sierpinski demands. XY -> ZX -> YZ is used.
// The four survivors differ only for an xform with non-diagonal blocks in TWO planes at once;
// for the common case (rotation in one plane) they agree exactly. If an import ever comes out
// visibly wrong, PLANE_ORDER below is the single thing to change.

const PLANE_ORDER = ['xy', 'zx', 'yz'];

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

// Variation attributes that are not part of the affine transform and not geometry we can use.
const IGNORE = new Set(['weight', 'color', 'color_type', 'symmetry', 'material', 'material_speed',
  'coefs', 'yzCoefs', 'zxCoefs', 'chaos', 'opacity', 'var_color', 'name',
  'linear_fx_priority', 'colorType']);

export function parseFlame(text){
  const warnings = [];
  const nameM = /<flame[^>]*\bname="([^"]*)"/.exec(text);
  const name = nameM ? nameM[1] : 'flame';

  const xforms = [...text.matchAll(/<xform\b([^>]*?)\/?>/g)].map(m => m[1]);
  if(!xforms.length) throw new Error('no <xform> found — is this a .flame file?');

  const maps = [];
  xforms.forEach((attrs, idx) => {
    const at = {};
    for(const m of attrs.matchAll(/(\w+)="([^"]*)"/g)) at[m[1]] = m[2];

    // reject anything that is not a pure linear xform
    const nonlinear = Object.keys(at).filter(k =>
      !IGNORE.has(k) && !/_speed$|^mod_/.test(k) && k !== 'linear' && Number(at[k]) !== 0);
    const lin = at.linear === undefined ? 0 : Number(at.linear);
    if(nonlinear.length){
      warnings.push(`xform ${idx + 1} skipped: nonlinear variation(s) ${nonlinear.join(', ')}`);
      return;
    }
    if(Math.abs(lin - 1) > 1e-9){
      warnings.push(`xform ${idx + 1} skipped: linear weight is ${lin}, only 1.0 is affine`);
      return;
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

    if(!inv3(M)){ warnings.push(`xform ${idx + 1} skipped: singular (zero determinant)`); return; }
    const sc = opNorm(M);
    if(sc >= 0.999){
      warnings.push(`xform ${idx + 1} is not contractive (scale ${sc.toFixed(3)}) — ` +
                    'the attractor is unbounded and will not resolve');
    }
    maps.push(makeXform(M, T, at.weight === undefined ? 1 : Number(at.weight)));
  });

  if(!maps.length) throw new Error('no usable linear xforms — this flame needs variations we cannot fold');
  if(maps.length > 8){
    warnings.push(`${maps.length} maps found; only the first 8 are used`);
    maps.length = 8;
  }
  return { name, maps, warnings };
}

export const MAX_XFORMS = 8;

// An xform keeps its IMPORTED affine untouched and layers editable offsets on top, so the
// editor is non-destructive: "reset" restores exactly what the file said, and a preset can
// record what you changed rather than a mangled matrix.
export function makeXform(M, T, weight = 1){
  return {
    M: M.slice(), T: T.slice(),                    // base, from the file — never edited
    scale: 1, rot: [0, 0, 0], tr: [0, 0, 0],       // editable offsets
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
    expand: opNorm(Mi)
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
export function flameKey(flame){
  return String(resolveFlame(flame).length);
}
