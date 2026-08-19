// Unified 3D operator registry — ordered array, indexed by stack type.
// Each record carries BOTH the UI param spec and the GLSL, so sliders and shader can't drift.
// Adding an operator = one entry here.
//
// SIGNATURE (fixed, every op):
//   vec3 fn(vec3 p, vec4 P0 [, vec4 P1 ...], inout float s, inout vec4 trap)
//   - bank count MUST equal ceil(params.length / 4). Getting this wrong is a link error.
//   - s: multiply in the OPERATOR NORM of this map's Jacobian at p. See prelude.js.
//   - trap: optional orbit-trap write. assemble.js also does a generic trap min per IFS pass,
//     so an op only touches trap when it has something better to contribute.
//
// lip:
//   'exact'  — s is the true local operator norm (or the map is an isometry, s unchanged).
//   'bound'  — s is a proven upper bound but not tight. Costs march steps, never correctness.
//   'repeat' — isometry within a cell, discontinuous across cells. Only valid as domain
//              repetition, and only while the primitive fits inside one cell. UI warns.
//
// A param with a `names` array is DISCRETE: it becomes a compile-time literal baked into the
// emitted source (and joins the program signature), not a runtime branch inside the DE. That
// matters here far more than in 2D — the DE is instantiated ~10x and called hundreds of times
// per pixel, so a live branch is paid for over and over.
// Discrete ops write `glsl` as a function of the discrete values; plain ops write a string.

const AXIS = ['X', 'Y', 'Z'];

export const OPS = [

  { name: 'Translate', fn: 'opTranslate', lip: 'exact', deps: [],
    params: [['X', -4, 4, 0.01, 0], ['Y', -4, 4, 0.01, 0], ['Z', -4, 4, 0.01, 0]],
    glsl: `vec3 opTranslate(vec3 p, vec4 P, inout float s, inout vec4 trap){
  return p - vec3(P.x, P.y, P.z);   // isometry: s unchanged
}` },

  { name: 'Rotate', fn: 'opRotate', lip: 'exact', deps: ['rot3'],
    params: [['Angle X', -180, 180, 0.5, 0], ['Angle Y', -180, 180, 0.5, 30], ['Angle Z', -180, 180, 0.5, 0]],
    glsl: `vec3 opRotate(vec3 p, vec4 P, inout float s, inout vec4 trap){
  return rotE3(p, vec3(P.x, P.y, P.z));   // isometry: s unchanged
}` },

  { name: 'Scale', fn: 'opScale', lip: 'exact', deps: [],
    params: [['Factor', 0.2, 4, 0.005, 1.6]],
    glsl: `vec3 opScale(vec3 p, vec4 P, inout float s, inout vec4 trap){
  float k = max(abs(P.x), 1e-4);
  s *= k;                            // exact: uniform scale, |J| = k
  return p * k;
}` },

  { name: 'Mirror plane', fn: 'opMirror', lip: 'exact', deps: [],
    params: [['Axis', 0, 2, 1, 0, AXIS], ['Offset', -3, 3, 0.01, 0]],
    disc: [0],
    glsl: d => {
      const c = 'xyz'[d[0]], o = ['p.y, p.z', 'p.x, p.z', 'p.x, p.y'][d[0]];
      const build = [`vec3(m, ${o})`, `vec3(p.x, m, p.z)`, `vec3(p.x, p.y, m)`][d[0]];
      return `vec3 opMirror_${d[0]}(vec3 p, vec4 P, inout float s, inout vec4 trap){
  float m = P.y + abs(p.${c} - P.y);   // reflection: isometry, s unchanged
  return ${build};
}`;
    } },

  // FLOAT32 NOTE (measured, not guessed): this op round-trips through atan -> sin/cos. In
  // float64 it is isometric to 3e-9; in float32 the reconstruction loses up to ~4% of distance
  // accuracy at some angles, so the estimator can locally under-report by that much. It is one
  // of the two things the default step scale of 0.9 is paying for. Same applies to any future
  // angular fold. tools/validate.py reports these as "in float32 margin" rather than failures.
  { name: 'Sector fold', fn: 'opSector', lip: 'exact', deps: [],
    params: [['Segments', 2, 24, 1, 6], ['Offset\u00b0', -180, 180, 0.5, 0], ['Axis', 0, 2, 1, 1, AXIS]],
    disc: [2],
    glsl: d => {
      // work in the plane orthogonal to the chosen axis
      const pl = [['p.y', 'p.z', 'p.x'], ['p.z', 'p.x', 'p.y'], ['p.x', 'p.y', 'p.z']][d[0]];
      const out = [`vec3(${pl[2]}, u, v)`, `vec3(v, ${pl[2]}, u)`, `vec3(u, v, ${pl[2]})`][d[0]];
      return `vec3 opSector_${d[0]}(vec3 p, vec4 P, inout float s, inout vec4 trap){
  float n = max(P.x, 1.0);
  float r = length(vec2(${pl[0]}, ${pl[1]}));
  float a = atan(${pl[1]}, ${pl[0]}) + P.y * DEG;
  float seg = TAU / n;
  a = mod(a, seg);
  a = abs(a - seg * 0.5);            // rotation + reflection: isometry, s unchanged
  float u = cos(a) * r;
  float v = sin(a) * r;
  return ${out};
}`;
    } },

  { name: 'Box fold', fn: 'opBoxFold', lip: 'exact', deps: [],
    params: [['Limit', 0.2, 3, 0.01, 1]],
    glsl: `vec3 opBoxFold(vec3 p, vec4 P, inout float s, inout vec4 trap){
  float L = max(P.x, 1e-3);
  return clamp(p, -L, L) * 2.0 - p;  // piecewise reflection: isometry, s unchanged
}` },

  { name: 'Sphere fold', fn: 'opSphereFold', lip: 'exact', deps: [],
    params: [['Min radius', 0.05, 2, 0.005, 0.5], ['Fixed radius', 0.2, 3, 0.01, 1]],
    glsl: `vec3 opSphereFold(vec3 p, vec4 P, inout float s, inout vec4 trap){
  float mr2 = max(P.x * P.x, 1e-6);
  float fr2 = max(P.y * P.y, 1e-6);
  float r2  = dot(p, p);
  float k   = 1.0;
  if(r2 < mr2)      k = fr2 / mr2;   // inner: uniform scale
  else if(r2 < fr2) k = fr2 / r2;    // shell: inversion, conformal
  s *= k;                            // exact in both branches
  return p * k;
}` },

  { name: 'Sphere inversion', fn: 'opInvert', lip: 'exact', deps: [],
    params: [['Radius', 0.1, 3, 0.01, 1]],
    glsl: `vec3 opInvert(vec3 p, vec4 P, inout float s, inout vec4 trap){
  float r2 = max(dot(p, p), 1e-6);
  float k  = (P.x * P.x) / r2;
  s *= k;                            // exact: conformal, |J| = R^2/|p|^2
  trap = min(trap, vec4(abs(p), r2));
  return p * k;
}` },

  { name: 'Octahedral fold', fn: 'opOcta', lip: 'exact', deps: [],
    params: [['Offset', -1.5, 1.5, 0.005, 0]],
    glsl: `vec3 opOcta(vec3 p, vec4 P, inout float s, inout vec4 trap){
  vec3 q = abs(p);                   // explicit temps — no swizzle-write-from-swizzle-read
  if(q.x < q.y){ float t = q.x; q.x = q.y; q.y = t; }
  if(q.x < q.z){ float t = q.x; q.x = q.z; q.z = t; }
  if(q.y < q.z){ float t = q.y; q.y = q.z; q.z = t; }
  return q - vec3(P.x);              // reflections + sort + translate: isometry
}` },

  { name: 'Tetrahedral fold', fn: 'opTetra', lip: 'exact', deps: [],
    params: [['Offset', -1.5, 1.5, 0.005, 0]],
    glsl: `vec3 opTetra(vec3 p, vec4 P, inout float s, inout vec4 trap){
  vec3 q = p;
  if(q.x + q.y < 0.0){ float t = q.x; q.x = -q.y; q.y = -t; }
  if(q.x + q.z < 0.0){ float t = q.x; q.x = -q.z; q.z = -t; }
  if(q.y + q.z < 0.0){ float t = q.y; q.y = -q.z; q.z = -t; }
  return q - vec3(P.x);              // isometry
}` },

  { name: 'Twist', fn: 'opTwist', lip: 'exact', deps: ['rot3'],
    params: [['Amount', -3, 3, 0.01, 0.6], ['Axis', 0, 2, 1, 1, AXIS]],
    disc: [1],
    glsl: d => {
      const along = ['p.x', 'p.y', 'p.z'][d[0]];
      const perp = [['p.y', 'p.z'], ['p.z', 'p.x'], ['p.x', 'p.y']][d[0]];
      const rot = ['rotX', 'rotY', 'rotZ'][d[0]];
      return `vec3 opTwist_${d[0]}(vec3 p, vec4 P, inout float s, inout vec4 trap){
  float k = P.x;
  float r = length(vec2(${perp[0]}, ${perp[1]}));
  float c = abs(k) * r;
  // Exact operator norm of J for a shear-twist: max eigenvalue of J^T J works out to
  // 1 + c^2/2 + c*sqrt(1 + c^2/4). Reduces to 1 at k=0, so Twist at 0 is free and exact.
  s *= sqrt(1.0 + c * c * 0.5 + c * sqrt(1.0 + c * c * 0.25));
  return ${rot}(p, k * ${along});
}`;
    } },

  { name: 'Domain repeat', fn: 'opRepeat', lip: 'repeat', deps: [],
    params: [['Period X', 0.2, 8, 0.01, 2], ['Period Y', 0.2, 8, 0.01, 2], ['Period Z', 0.2, 8, 0.01, 2]],
    glsl: `vec3 opRepeat(vec3 p, vec4 P, inout float s, inout vec4 trap){
  vec3 c = max(vec3(P.x, P.y, P.z), vec3(1e-3));
  return p - c * round(p / c);       // isometry INSIDE a cell; discontinuous across cells.
}` }
];

// Discrete param indices for an op (those with a names list), in param order.
export function discIdx(op){
  if(op.disc) return op.disc;
  const out = [];
  op.params.forEach((pr, i) => { if(pr[5]) out.push(i); });
  return out;
}

// Emitted GLSL function name for a given slot — discrete values are baked into the name.
export function fnName(op, vals){
  const d = discIdx(op);
  if(!d.length) return op.fn;
  return op.fn + '_' + d.map(i => Math.round(vals[i])).join('_');
}

export function bankCount(op){ return Math.max(1, Math.ceil(op.params.length / 4)); }

export function defaults(op){ return op.params.map(pr => pr[4]); }
