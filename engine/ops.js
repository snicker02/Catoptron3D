// Unified 3D operator registry — ordered array, indexed by stack type.
// Each record carries BOTH the UI param spec and the GLSL, so sliders and shader can't drift.
// Adding an operator = one entry here.
//
// SIGNATURE (fixed, every op):
//   vec3 fn(vec3 p, vec4 P0 [, vec4 P1 ...], inout float s, inout vec4 trap, inout float seam)
//   - bank count MUST equal ceil(params.length / 4). Getting this wrong is a link error.
//   - s: multiply in the OPERATOR NORM of this map's Jacobian at p. See prelude.js.
//   - trap: optional orbit-trap write. assemble.js also does a generic trap min per IFS pass,
//     so an op only touches trap when it has something better to contribute.
//   - seam: distance to any DISCONTINUITY this op introduces, in ORIGINAL space, so divide by
//     the current s. The estimator finishes with min(prim(p)/s, seam). This is what makes a
//     torn map safe: away from the seam the fold is locally isometric and the estimate holds;
//     near it you are bounded by the distance to the tear, so you can never step through it.
//     Continuous folds (every reflection) leave seam alone.
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
    glsl: `vec3 opTranslate(vec3 p, vec4 P, inout float s, inout vec4 trap, inout float seam){
  return p - vec3(P.x, P.y, P.z);   // isometry: s unchanged
}` },

  { name: 'Rotate', fn: 'opRotate', lip: 'exact', deps: ['rot3'],
    params: [['Angle X', -180, 180, 0.5, 0], ['Angle Y', -180, 180, 0.5, 30], ['Angle Z', -180, 180, 0.5, 0]],
    glsl: `vec3 opRotate(vec3 p, vec4 P, inout float s, inout vec4 trap, inout float seam){
  return rotE3(p, vec3(P.x, P.y, P.z));   // isometry: s unchanged
}` },

  { name: 'Scale', fn: 'opScale', lip: 'exact', deps: [],
    params: [['Factor', 0.2, 4, 0.005, 1.6]],
    glsl: `vec3 opScale(vec3 p, vec4 P, inout float s, inout vec4 trap, inout float seam){
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
      return `vec3 opMirror_${d[0]}(vec3 p, vec4 P, inout float s, inout vec4 trap, inout float seam){
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
      return `vec3 opSector_${d[0]}(vec3 p, vec4 P, inout float s, inout vec4 trap, inout float seam){
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
    glsl: `vec3 opBoxFold(vec3 p, vec4 P, inout float s, inout vec4 trap, inout float seam){
  float L = max(P.x, 1e-3);
  return clamp(p, -L, L) * 2.0 - p;  // piecewise reflection: isometry, s unchanged
}` },

  { name: 'Sphere fold', fn: 'opSphereFold', lip: 'exact', deps: [],
    params: [['Min radius', 0.05, 2, 0.005, 0.5], ['Fixed radius', 0.2, 3, 0.01, 1]],
    glsl: `vec3 opSphereFold(vec3 p, vec4 P, inout float s, inout vec4 trap, inout float seam){
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
    glsl: `vec3 opInvert(vec3 p, vec4 P, inout float s, inout vec4 trap, inout float seam){
  float r2 = max(dot(p, p), 1e-6);
  float k  = (P.x * P.x) / r2;
  s *= k;                            // exact: conformal, |J| = R^2/|p|^2
  trap = min(trap, vec4(abs(p), r2));
  return p * k;
}` },

  { name: 'Octahedral fold', fn: 'opOcta', lip: 'exact', deps: [],
    params: [['Offset', -1.5, 1.5, 0.005, 0]],
    glsl: `vec3 opOcta(vec3 p, vec4 P, inout float s, inout vec4 trap, inout float seam){
  vec3 q = abs(p);                   // explicit temps — no swizzle-write-from-swizzle-read
  if(q.x < q.y){ float t = q.x; q.x = q.y; q.y = t; }
  if(q.x < q.z){ float t = q.x; q.x = q.z; q.z = t; }
  if(q.y < q.z){ float t = q.y; q.y = q.z; q.z = t; }
  return q - vec3(P.x);              // reflections + sort + translate: isometry
}` },

  { name: 'Tetrahedral fold', fn: 'opTetra', lip: 'exact', deps: [],
    params: [['Offset', -1.5, 1.5, 0.005, 0]],
    glsl: `vec3 opTetra(vec3 p, vec4 P, inout float s, inout vec4 trap, inout float seam){
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
      return `vec3 opTwist_${d[0]}(vec3 p, vec4 P, inout float s, inout vec4 trap, inout float seam){
  float k = P.x;
  float r = length(vec2(${perp[0]}, ${perp[1]}));
  float c = abs(k) * r;
  // Exact operator norm of J for a shear-twist: max eigenvalue of J^T J works out to
  // 1 + c^2/2 + c*sqrt(1 + c^2/4). Reduces to 1 at k=0, so Twist at 0 is free and exact.
  s *= sqrt(1.0 + c * c * 0.5 + c * sqrt(1.0 + c * c * 0.25));
  return ${rot}(p, k * ${along});
}`;
    } },

  { name: 'Domain repeat', fn: 'opRepeat', lip: 'seam', deps: [],
    params: [['Period X', 0.2, 8, 0.01, 2], ['Period Y', 0.2, 8, 0.01, 2], ['Period Z', 0.2, 8, 0.01, 2]],
    glsl: `vec3 opRepeat(vec3 p, vec4 P, inout float s, inout vec4 trap, inout float seam){
  vec3 c = max(vec3(P.x, P.y, P.z), vec3(1e-3));
  vec3 q = p - c * round(p / c);     // isometry INSIDE a cell; torn across cell walls
  vec3 w = c * 0.5 - abs(q);         // distance to the nearest wall in each axis
  seam = min(seam, min(w.x, min(w.y, w.z)) / s);
  return q;
}` },

  // ── MIRROR GROUP ────────────────────────────────────────────────────────────────────────
  // These differ from the fractal folds above in one structural way: they contain no scale at
  // all. A fractal fold contracts, so structure NESTS; a mirror fold is a pure isometry, so
  // space TILES at constant size. That is what reads as a hall of mirrors rather than a
  // fractal, and it is why these ops want IFS contraction at 1.0 (see the Mirror room starter).
  //
  // They are also the safest ops here. Reflection folding is CONTINUOUS and globally
  // 1-Lipschitz — unlike Domain repeat, which teleports — so it can never over-report distance.
  // Iterating them folds any point into the fundamental domain, which is what generates the
  // tiling; more iterations just means the fold reaches further out.

  { name: 'Mirror corridor', fn: 'opCorridor', lip: 'exact', deps: [],
    params: [['Axis', 0, 2, 1, 0, AXIS], ['Spacing', 0.15, 8, 0.01, 2], ['Offset', -4, 4, 0.01, 0]],
    disc: [0],
    glsl: d => {
      const c = 'xyz'[d[0]];
      const out = [`vec3(m, p.y, p.z)`, `vec3(p.x, m, p.z)`, `vec3(p.x, p.y, m)`][d[0]];
      return `vec3 opCorridor_${d[0]}(vec3 p, vec4 P, inout float s, inout vec4 trap, inout float seam){
  // Two facing mirrors: the classic infinite corridor. A triangle wave IS the reflection
  // sequence of a parallel mirror pair, so this is exact and needs no iteration.
  float D = max(P.y, 1e-3);
  float t = mod(p.${c} - P.z, 2.0 * D);
  float m = D - abs(D - t) + P.z;   // continuous, 1-Lipschitz: s unchanged
  return ${out};
}`;
    } },

  { name: 'Mirror room', fn: 'opMirrorRoom', lip: 'exact', deps: [],
    params: [['Size X', 0.15, 8, 0.01, 2], ['Size Y', 0.15, 8, 0.01, 2], ['Size Z', 0.15, 8, 0.01, 2]],
    glsl: `vec3 opMirrorRoom(vec3 p, vec4 P, inout float s, inout vec4 trap, inout float seam){
  // Three orthogonal mirror pairs — the infinity room. Everything folds into one box.
  vec3 D = max(vec3(P.x, P.y, P.z), vec3(1e-3));
  vec3 t = mod(p, 2.0 * D);
  return D - abs(D - t);            // isometry, s unchanged
}` },

  { name: 'Corner mirror', fn: 'opCorner', lip: 'exact', deps: [],
    params: [['Offset X', -3, 3, 0.005, 0], ['Offset Y', -3, 3, 0.005, 0], ['Offset Z', -3, 3, 0.005, 0]],
    glsl: `vec3 opCorner(vec3 p, vec4 P, inout float s, inout vec4 trap, inout float seam){
  // Three mutually perpendicular mirrors meeting at a point — a retroreflector.
  // Unlike Octahedral fold this does NOT sort the axes, so it keeps 8-fold cubic symmetry
  // instead of collapsing to a single 48th of space.
  return abs(p) - vec3(P.x, P.y, P.z);
}` },

  { name: 'Mirror shells', fn: 'opShells', lip: 'exact', deps: [],
    params: [['Spacing', 0.1, 4, 0.005, 1], ['Offset', 0, 4, 0.01, 0]],
    glsl: `vec3 opShells(vec3 p, vec4 P, inout float s, inout vec4 trap, inout float seam){
  // Concentric spherical mirrors: radius folds, direction is preserved.
  // NOT an isometry — the radial eigenvalue is 1 but the two angular ones are f(r)/r, so the
  // operator norm is max(1, f(r)/r). Declared exactly rather than bounded.
  float D = max(P.x, 1e-3);
  float r = length(p);
  if(r < 1e-6) return p;
  float t  = mod(r - P.y, 2.0 * D);
  float rr = D - abs(D - t) + P.y;
  float k  = rr / r;
  s *= max(1.0, k);
  trap = min(trap, vec4(abs(p), r * r));
  return p * k;
}` },

  { name: 'Kaleidoscope tile', fn: 'opTriGroup', lip: 'exact', deps: [],
    params: [['Group', 0, 2, 1, 0, ['*632 hex', '*442 square', '*333 triangle']],
             ['Cell', 0.2, 6, 0.01, 1.5],
             ['Axis', 0, 2, 1, 1, AXIS]],
    disc: [0, 2],
    glsl: d => {
      // Euclidean triangle reflection groups. A triangle whose angles are pi/p, pi/q, pi/r with
      // 1/p+1/q+1/r == 1 generates a wallpaper group by reflection alone — there are exactly
      // three: (2,3,6), (2,4,4), (3,3,3). Each mirror is (normal, offset) in the folding plane.
      const TRI = [
        // *632 : 30-60-90 triangle
        [['vec2(0.0,-1.0)', '0.0'], ['vec2(1.0,0.0)', 'a'], ['vec2(-0.5,0.8660254)', '0.0']],
        // *442 : 45-90-45 triangle
        [['vec2(0.0,-1.0)', '0.0'], ['vec2(1.0,0.0)', 'a'], ['vec2(-0.7071068,0.7071068)', '0.0']],
        // *333 : equilateral
        [['vec2(0.0,-1.0)', '0.0'], ['vec2(0.8660254,0.5)', '0.8660254*a'], ['vec2(-0.8660254,0.5)', '0.0']]
      ][d[0]];
      const ax = d[1];
      const grab = ['vec2(p.y, p.z)', 'vec2(p.z, p.x)', 'vec2(p.x, p.y)'][ax];
      const put  = ['vec3(p.x, q.x, q.y)', 'vec3(q.y, p.y, q.x)', 'vec3(q.x, q.y, p.z)'][ax];
      const refl = TRI.map(([n, off], i) =>
        `    { vec2 n${i} = ${n}; float e${i} = dot(q, n${i}) - (${off});
      if(e${i} > 0.0){ q -= 2.0 * e${i} * n${i}; moved = true; } }`).join('\n');
      return `vec3 opTriGroup_${d[0]}_${ax}(vec3 p, vec4 P, inout float s, inout vec4 trap, inout float seam){
  float a = max(P.y, 1e-3);
  vec2 q = ${grab};
  for(int i = 0; i < 8; i++){
    bool moved = false;
${refl}
    if(!moved) break;             // inside the fundamental triangle
  }
  return ${put};                  // reflections only: isometry, s unchanged
}`;
    } },

  // ── ARCHITECTURAL FOLDS ─────────────────────────────────────────────────────────────────
  // The two folds the reference footage actually turns on.

  { name: 'Hinge fold', fn: 'opHinge', lip: 'seam', deps: [],
    params: [['Cut\u00b0', -180, 180, 0.5, 90], ['Fold\u00b0', -180, 180, 0.5, 90],
             ['Axis', 0, 2, 1, 0, AXIS]],
    disc: [2],
    glsl: d => {
      const ax = d[0];
      const grab = ['vec2(p.y, p.z)', 'vec2(p.z, p.x)', 'vec2(p.x, p.y)'][ax];
      const put  = ['vec3(p.x, q.x, q.y)', 'vec3(q.y, p.y, q.x)', 'vec3(q.x, q.y, p.z)'][ax];
      return `vec3 opHinge_${ax}(vec3 p, vec4 P, inout float s, inout vec4 trap, inout float seam){
  // Rotate one half-space about a hinge line by an ARBITRARY angle. This is the fold in the
  // reference footage: at 90 degrees it stands the far half of the world up on its edge.
  // Stack several to box the world in.
  //
  // Each branch is a rigid rotation, so s is untouched — but unlike a reflection this map is
  // DISCONTINUOUS: a rotation about a line moves the points of the cut plane, so the two halves
  // are glued along a tear. That is not a defect of the implementation; it is why every
  // distance-estimated fractal folds with abs(). The seam clamp is what makes it usable: report
  // the distance to the cut and the estimator will never step across it.
  float phi = P.x * DEG;
  float th  = P.y * DEG;
  vec2 n = vec2(cos(phi), sin(phi));
  vec2 q = ${grab};
  seam = min(seam, abs(dot(q, n)) / s);
  if(dot(q, n) > 0.0){
    float c = cos(th), sn = sin(th);
    q = vec2(c * q.x - sn * q.y, sn * q.x + c * q.y);
  }
  return ${put};
}`;
    } },

  { name: 'Spiral vortex', fn: 'opVortex', lip: 'exact', deps: [],
    params: [['Amount', -2.5, 2.5, 0.005, 0.7], ['Axis', 0, 2, 1, 1, AXIS]],
    disc: [1],
    glsl: d => {
      const ax = d[0];
      const grab = ['vec2(p.y, p.z)', 'vec2(p.z, p.x)', 'vec2(p.x, p.y)'][ax];
      const put  = ['vec3(p.x, q.x, q.y)', 'vec3(q.y, p.y, q.x)', 'vec3(q.x, q.y, p.z)'][ax];
      return `vec3 opVortex_${ax}(vec3 p, vec4 P, inout float s, inout vec4 trap, inout float seam){
  // Logarithmic spiral: angle shifted by k*ln(r). Distinct from Twist, which shears ALONG an
  // axis; this shears in the plane, which is what drives a street grid into a vortex.
  // In an orthonormal polar frame the Jacobian is the constant shear [[1,0],[k,1]], so the
  // operator norm is the same closed form as Twist and does not grow with radius.
  float k = P.x;
  vec2 q = ${grab};
  float r = length(q);
  if(r < 1e-5) return p;
  float a = atan(q.y, q.x) + k * log(r);
  float c = abs(k);
  s *= sqrt(1.0 + c * c * 0.5 + c * sqrt(1.0 + c * c * 0.25));
  q = r * vec2(cos(a), sin(a));
  return ${put};
}`;
    } }
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
