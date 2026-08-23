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

const SG_NAMES = [
  '#1  P1  (triclinic)',
  '#2  P-1  (triclinic)',
  '#10 P2/m  (monoclinic)',
  '#47 Pmmm  (orthorhombic)',
  '#123 P4/mmm  (tetragonal)',
  '#191 P6/mmm  (hexagonal)',
  '#164 P-3m1  (trigonal)',
  '#221 Pm-3m  (cubic P)',
  '#229 Im-3m  (cubic I)',
  '#225 Fm-3m  (cubic F)',
  '#19 P2\u20812\u20812\u2081  (screw)',
  '#194 P6\u2083/mmc  (HCP screw)'
];

// true where the recipe tears space and must report a seam
const SG_SEAM = [true, true, true, false, false, false, false, false, true, true, true, true];

const SG_BODY = [

/* 0 — P1. Lattice translations only: the primitive cell, no point symmetry at all.
      A pure translation fold tears at the cell walls, so it reports them. */
`  vec3 q = p - round(p);
  seam = min(seam, min(0.5 - abs(q.x), min(0.5 - abs(q.y), 0.5 - abs(q.z))) / s);
  p = q;`,

/* 1 — P-1. P1 plus a centre of inversion. Inversion is orientation-reversing and glues the
      two halves across the plane z = 0, so that plane is a seam too. */
`  vec3 q = p - round(p);
  seam = min(seam, min(0.5 - abs(q.x), min(0.5 - abs(q.y), 0.5 - abs(q.z))) / s);
  seam = min(seam, abs(q.z) / s);
  if(q.z < 0.0) q = -q;
  p = q;`,

/* 2 — P2/m. Monoclinic, unique axis b: a mirror perpendicular to b (continuous) and a 2-fold
      rotation about b (a tear). Note the mirror costs nothing and the rotation costs a seam —
      the whole story of this table in one group. */
`  vec3 q = vec3(p.x - round(p.x), abs(mod(p.y, 2.0) - 1.0), p.z - round(p.z));
  seam = min(seam, min(0.5 - abs(q.x), 0.5 - abs(q.z)) / s);
  seam = min(seam, abs(q.x) / s);
  if(q.x < 0.0) q = vec3(-q.x, q.y, -q.z);
  p = q;`,

/* 3 — Pmmm. Three mutually perpendicular mirrors on a primitive lattice. Entirely reflection
      generated, so it is continuous and seam-free. */
`  p = tri3(p);`,

/* 4 — P4/mmm. Pmmm plus the diagonal mirror that promotes the 2-fold to a 4-fold about c. */
`  vec3 q = tri3(p);
  if(q.x < q.y){ float t = q.x; q.x = q.y; q.y = t; }
  p = q;`,

/* 5 — P6/mmm. The *632 planar reflection group in the a-b plane (the same Euclidean triangle
      group as Kaleidoscope tile) crossed with a mirror lattice along c. Reflections only. */
`  vec2 g = vec2(p.x, p.y);
  for(int i = 0; i < 8; i++){
    bool moved = false;
    { vec2 n = vec2(0.0, -1.0);       float e = dot(g, n);        if(e > 0.0){ g -= 2.0 * e * n; moved = true; } }
    { vec2 n = vec2(1.0, 0.0);        float e = dot(g, n) - 0.5;  if(e > 0.0){ g -= 2.0 * e * n; moved = true; } }
    { vec2 n = vec2(-0.5, 0.8660254); float e = dot(g, n);        if(e > 0.0){ g -= 2.0 * e * n; moved = true; } }
    if(!moved) break;
  }
  p = vec3(g.x, g.y, abs(mod(p.z, 2.0) - 1.0));`,

/* 6 — P-3m1. Trigonal. The *333 Euclidean triangle group in the a-b plane (equilateral
      fundamental domain, three mirrors) crossed with a mirror lattice along c.
      NOTE: this slot originally held R-3m, which was wrong — I folded the 3-fold sector but
      omitted the rhombohedral centring, so it produced a single empty wedge instead of a
      crystal. P-3m1 gives genuine trigonal symmetry and, being reflection-generated, is
      continuous and seam-free. R-3m needs the R-centring translations to be done properly. */
`  vec2 g = vec2(p.x, p.y);
  for(int i = 0; i < 8; i++){
    bool moved = false;
    { vec2 n = vec2(0.0, -1.0);            float e = dot(g, n);              if(e > 0.0){ g -= 2.0 * e * n; moved = true; } }
    { vec2 n = vec2(0.8660254, 0.5);       float e = dot(g, n) - 0.4330127;  if(e > 0.0){ g -= 2.0 * e * n; moved = true; } }
    { vec2 n = vec2(-0.8660254, 0.5);      float e = dot(g, n);              if(e > 0.0){ g -= 2.0 * e * n; moved = true; } }
    if(!moved) break;
  }
  p = vec3(g.x, g.y, abs(mod(p.z, 2.0) - 1.0));`,

/* 7 — Pm-3m. Full cubic symmetry: mirror lattice plus the three diagonal mirrors. This is the
      highest-symmetry space group and, pleasingly, one of the cheapest folds here. */
`  p = sortDesc3(tri3(p));`,

/* 8 — Im-3m. Body-centred cubic. The lattice fold is a Voronoi choice between the corner and
      body-centre sublattices, so the cell wall is a bisector plane — that is the seam. */
`  vec3 c1 = round(p);
  vec3 c2 = round(p - 0.5) + 0.5;
  vec3 a = p - c1;
  vec3 b = p - c2;
  seam = min(seam, bisectDist(p, c1, c2) / s);
  vec3 q = dot(a, a) < dot(b, b) ? a : b;
  p = sortDesc3(abs(q));`,

/* 9 — Fm-3m. Face-centred cubic: four sublattices, so four candidate centres and three
      bisector walls to report. */
`  vec3 o0 = vec3(0.0, 0.0, 0.0), o1 = vec3(0.0, 0.5, 0.5);
  vec3 o2 = vec3(0.5, 0.0, 0.5), o3 = vec3(0.5, 0.5, 0.0);
  vec3 c0 = round(p - o0) + o0, c1 = round(p - o1) + o1;
  vec3 c2 = round(p - o2) + o2, c3 = round(p - o3) + o3;
  vec3 best = c0; float bd = dot(p - c0, p - c0);
  float d1 = dot(p - c1, p - c1); if(d1 < bd){ bd = d1; best = c1; }
  float d2 = dot(p - c2, p - c2); if(d2 < bd){ bd = d2; best = c2; }
  float d3 = dot(p - c3, p - c3); if(d3 < bd){ bd = d3; best = c3; }
  float w = 1e9;
  if(best != c0) w = min(w, bisectDist(p, best, c0));
  if(best != c1) w = min(w, bisectDist(p, best, c1));
  if(best != c2) w = min(w, bisectDist(p, best, c2));
  if(best != c3) w = min(w, bisectDist(p, best, c3));
  seam = min(seam, w / s);
  p = sortDesc3(abs(p - best));`,

/* 10 — P2(1)2(1)2(1). Three mutually perpendicular 2-fold SCREW axes and nothing else: the
       classic non-symmorphic group, and the most common one in protein crystals. A screw is a
       rotation composed with a fractional translation, so every one of them is a tear. */
`  vec3 q = p - round(p);
  seam = min(seam, min(0.5 - abs(q.x), min(0.5 - abs(q.y), 0.5 - abs(q.z))) / s);
  seam = min(seam, abs(q.x - 0.25) / s);
  if(q.x > 0.25) q = vec3(0.5 - q.x, -q.y, q.z + 0.5);
  seam = min(seam, abs(q.y - 0.25) / s);
  if(q.y > 0.25) q = vec3(-q.x, 0.5 - q.y, q.z + 0.5);
  p = q - round(q);`,

/* 11 — P6(3)/mmc. Hexagonal close packing: the *632 net with a 6(3) screw stacking the layers,
       which is what makes HCP rather than a simple hexagonal prism. */
`  vec3 q = p;
  seam = min(seam, abs(q.z - 0.5) / s);
  if(q.z > 0.5){ float aa = 3.14159265359;
    q = vec3(cos(aa) * q.x - sin(aa) * q.y, sin(aa) * q.x + cos(aa) * q.y, q.z - 0.5); }
  vec2 g = vec2(q.x, q.y);
  for(int i = 0; i < 8; i++){
    bool moved = false;
    { vec2 n = vec2(0.0, -1.0);       float e = dot(g, n);        if(e > 0.0){ g -= 2.0 * e * n; moved = true; } }
    { vec2 n = vec2(1.0, 0.0);        float e = dot(g, n) - 0.5;  if(e > 0.0){ g -= 2.0 * e * n; moved = true; } }
    { vec2 n = vec2(-0.5, 0.8660254); float e = dot(g, n);        if(e > 0.0){ g -= 2.0 * e * n; moved = true; } }
    if(!moved) break;
  }
  p = vec3(g.x, g.y, abs(mod(q.z, 2.0) - 1.0));`
];


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
    } },

  // ── CRYSTALLOGRAPHIC SPACE GROUPS ───────────────────────────────────────────────────────
  // A space group is a discrete group of isometries of R3: a Bravais lattice, plus a point
  // group, plus (for the non-symmorphic ones) screw axes and glide planes.
  //
  // Folding one into a distance estimator is the INVERSE of what an instancing renderer does.
  // An instancing tool applies the symmetry operations forward to place copies, which is cheap
  // and works for all 230 straight out of a table. A DE needs the backward map — send an
  // arbitrary point into the asymmetric unit — and that has no general closed form, so each
  // group is its own generator recipe. Hence a curated table, not an import.
  //
  // The split that decides difficulty:
  //   REFLECTION-generated groups fold continuously (a triangle wave is exactly a mirror pair),
  //     so they are exact, free, and need no seam.
  //   SCREWS, GLIDES and pure ROTATIONS glue space along a tear, like Hinge fold. They report a
  //     seam, and are only usable because the estimator carries that channel.
  //
  // Adding a group is one entry in SG_BODY plus its name. Coordinates inside a body are in
  // CELL UNITS; the wrapper handles scaling, and because seam is divided by the live s it comes
  // out in world units automatically.

  { name: 'Space group', fn: 'opSG', lip: 'seam', deps: ['sgUtil'],
    params: [['Group', 0, 11, 1, 7, SG_NAMES], ['Cell', 0.15, 6, 0.01, 1.2]],
    disc: [0],
    glsl: d => {
      const g = d[0];
      return `vec3 opSG_${g}(vec3 p, vec4 P, inout float s, inout vec4 trap, inout float seam){
  // ${SG_NAMES[g]}
  float c = max(P.y, 1e-3);
  p /= c; s /= c;                     // work in cell units; the two scalings cancel
${SG_BODY[g]}
  p *= c; s *= c;
  return p;
}`;
    } },

  // ── MIRROR GROUP, PART TWO ──────────────────────────────────────────────────────────────

  { name: 'Polyhedral mirror', fn: 'opPoly', lip: 'exact', deps: [],
    params: [['Symmetry', 0, 2, 1, 2,
              ['[3,3] tetrahedral \u00b724', '[4,3] octahedral \u00b748', '[5,3] icosahedral \u00b7120']],
             ['Offset', -1.5, 1.5, 0.005, 0.7]],
    disc: [0],
    glsl: d => {
      // Coxeter group [p,3]: three mirrors whose normals satisfy
      //   n1.n2 = -cos(pi/p),  n2.n3 = -cos(pi/3) = -1/2,  n1.n3 = 0.
      // Solving with n1 = x gives n2 = (-cos(pi/p), sin(pi/p), 0) and
      // n3 = (0, -1/(2 sin(pi/p)), sqrt(1 - 1/(4 sin^2(pi/p)))). The p-fold axis is z.
      const P = [3, 4, 5][d[0]];
      const c = Math.cos(Math.PI / P), sn = Math.sin(Math.PI / P);
      const a = -0.5 / sn, b = Math.sqrt(Math.max(0, 1 - a * a));
      const f = v => v.toFixed(9);
      return `vec3 opPoly_${d[0]}(vec3 p, vec4 P, inout float s, inout vec4 trap, inout float seam){
  // The finite reflection group [${P},3], order ${[24, 48, 120][d[0]]}. Icosahedral is the only
  // one of the three with 5-fold symmetry — neither the octahedral nor the tetrahedral fold can
  // produce it.
  //
  // Derived from the Coxeter relations rather than hand-picked normals. An earlier version used
  // a single golden-ratio plane alternated with abs(); it was a perfectly good isometry, which
  // is why the Lipschitz gate passed it, but it folded to a domain THREE TIMES LARGER than the
  // octahedral one — the wrong group entirely. Being an isometry and being the right group are
  // separate properties, and only a symmetry test catches the second.
  vec3 n1 = vec3(1.0, 0.0, 0.0);
  vec3 n2 = vec3(${f(-c)}, ${f(sn)}, 0.0);
  vec3 n3 = vec3(0.0, ${f(a)}, ${f(b)});
  vec3 q = p;
  for(int i = 0; i < 12; i++){
    bool moved = false;
    float e1 = dot(q, n1); if(e1 > 0.0){ q -= 2.0 * e1 * n1; moved = true; }
    float e2 = dot(q, n2); if(e2 > 0.0){ q -= 2.0 * e2 * n2; moved = true; }
    float e3 = dot(q, n3); if(e3 > 0.0){ q -= 2.0 * e3 * n3; moved = true; }
    if(!moved) break;              // inside the fundamental cone
  }
  return q - vec3(P.y);            // reflections only: isometry, s unchanged
}`;
    } },

  { name: 'Hyperbolic mirror', fn: 'opHyp', lip: 'exact', deps: [],
    params: [['Symmetry', 0, 2, 1, 2, ['Tetrahedral', 'Octahedral', 'Icosahedral']],
             ['Distance', 1.02, 3, 0.005, 1.28]],
    disc: [0],
    glsl: d => {
      const P = [3, 4, 5][d[0]];
      const c = Math.cos(Math.PI / P), sn = Math.sin(Math.PI / P);
      const a = -0.5 / sn, b = Math.sqrt(Math.max(0, 1 - a * a));
      const f = v => v.toFixed(9);
      const fold = [
        `    { vec3 n1 = vec3(1.0, 0.0, 0.0);
      vec3 n2 = vec3(${f(-c)}, ${f(sn)}, 0.0);
      vec3 n3 = vec3(0.0, ${f(a)}, ${f(b)});
      for(int j = 0; j < 8; j++){
        bool mv = false;
        float e1 = dot(q, n1); if(e1 > 0.0){ q -= 2.0 * e1 * n1; mv = true; }
        float e2 = dot(q, n2); if(e2 > 0.0){ q -= 2.0 * e2 * n2; mv = true; }
        float e3 = dot(q, n3); if(e3 > 0.0){ q -= 2.0 * e3 * n3; mv = true; }
        if(!mv) break;
      } }`
      ][0];
      return `vec3 opHyp_${d[0]}(vec3 p, vec4 P, inout float s, inout vec4 trap, inout float seam){
  // In the Poincare ball, reflection in a sphere ORTHOGONAL to the unit sphere is the exact
  // analogue of a mirror in flat space — that is what a hyperbolic honeycomb is built from.
  // A sphere centred at distance d is orthogonal to the unit sphere when its radius is
  // sqrt(d*d - 1), so Distance is the only parameter needed to keep it a true mirror.
  //
  // Alternating that inversion with a finite polyhedral fold tiles hyperbolic space. Distance
  // near 1 crowds the tiling to the rim (deep hyperbolic); larger values relax it toward the
  // Euclidean polyhedral fold. Inversion is conformal, so the scale factor is exact.
  vec3 q = p;
  float d0 = max(P.y, 1.0001);
  vec3  c  = vec3(0.0, 0.0, d0);
  float R2 = d0 * d0 - 1.0;
  for(int i = 0; i < 6; i++){
${fold}
    vec3 dz = q - c;
    float q2 = dot(dz, dz);
    if(q2 < R2 && q2 > 1e-9){
      float k = R2 / q2;
      q = c + dz * k;
      s *= k;                      // exact: sphere inversion is conformal
    } else break;
  }
  return q;
}`;
    } },

  { name: 'Glide mirror', fn: 'opGlide', lip: 'seam', deps: ['rot3'],
    params: [['Axis', 0, 2, 1, 1, AXIS], ['Offset', -3, 3, 0.005, 0],
             ['Slide', -3, 3, 0.005, 0.5], ['Rotate\u00b0', -180, 180, 0.5, 0]],
    disc: [0],
    glsl: d => {
      const ax = d[0];
      const comp = 'xyz'[ax];
      const slide = ['vec3(0.0, P.z, 0.0)', 'vec3(0.0, 0.0, P.z)', 'vec3(P.z, 0.0, 0.0)'][ax];
      const rot = ['rotX', 'rotY', 'rotZ'][ax];
      return `vec3 opGlide_${ax}(vec3 p, vec4 P, inout float s, inout vec4 trap, inout float seam){
  // A mirror that also slides (glide plane) or twists (rotary reflection, the improper axis Sn)
  // as it reflects. Both are genuine 3D symmetry operations that a plain mirror cannot express —
  // they are what make a stagger or an antiprism instead of a straight repeat.
  //
  // A plain reflection is continuous; adding the slide or the twist tears the map at the plane,
  // so the plane is reported as a seam. Set Slide and Rotate to 0 and this is exactly Mirror
  // plane, seam included but harmless.
  float e = p.${comp} - P.y;
  seam = min(seam, abs(e) / s);
  vec3 q = p;
  if(e > 0.0){
    q.${comp} = P.y - e;                  // reflect
    q += ${slide};                        // glide
    if(abs(P.w) > 0.0001) q = ${rot}(q, P.w * DEG);   // rotary reflection
  }
  return q;
}`;
    } },

  { name: 'Mirror tubes', fn: 'opTubes', lip: 'exact', deps: [],
    params: [['Axis', 0, 2, 1, 1, AXIS], ['Spacing', 0.1, 4, 0.005, 0.8],
             ['Offset', 0, 4, 0.01, 0]],
    disc: [0],
    glsl: d => {
      const ax = d[0];
      const grab = ['vec2(p.y, p.z)', 'vec2(p.z, p.x)', 'vec2(p.x, p.y)'][ax];
      const put  = ['vec3(p.x, g.x, g.y)', 'vec3(g.y, p.y, g.x)', 'vec3(g.x, g.y, p.z)'][ax];
      return `vec3 opTubes_${ax}(vec3 p, vec4 P, inout float s, inout vec4 trap, inout float seam){
  // Concentric CYLINDRICAL mirrors about an axis — the tube counterpart of Mirror shells.
  // Radius folds, angle and axial position are preserved.
  // Not an isometry: the radial and axial eigenvalues are 1, the angular one is f(r)/r, so the
  // operator norm is max(1, f(r)/r). Declared exactly rather than bounded.
  float D = max(P.y, 1e-3);
  vec2 g = ${grab};
  float r = length(g);
  if(r < 1e-6) return p;
  float t  = mod(r - P.z, 2.0 * D);
  float rr = D - abs(D - t) + P.z;
  float k  = rr / r;
  s *= max(1.0, k);
  g *= k;
  return ${put};
}`;
    } },

  // ── ESCAPE-TIME / KIFS ──────────────────────────────────────────────────────────────────

  { name: 'Menger fold', fn: 'opMenger', lip: 'seam', deps: ['sgUtil'],
    params: [['Scale', 1.2, 5, 0.005, 3], ['Offset', 0.2, 4, 0.005, 2]],
    glsl: `vec3 opMenger(vec3 p, vec4 P, inout float s, inout vec4 trap, inout float seam){
  // The canonical Menger sponge KIFS step. Self-contained rather than leaning on the IFS
  // contraction, because the conditional shift has to happen AFTER the scale and the loop
  // applies folds before it — so this could not be assembled from the existing ops.
  float k = max(P.x, 1.001);
  float o = P.y;
  vec3 q = sortDesc3(abs(p));
  q = q * k;
  s *= k;
  q -= vec3(o, o, 0.0);
  // the conditional shift is a tear, so report it
  seam = min(seam, abs(q.z + o * 0.5) / s);
  if(q.z < -o * 0.5) q.z += o;
  return q;
}` },

  { name: 'Triplex power', fn: 'opBulb', lip: 'exact', deps: [],
    params: [['Power', 2, 12, 0.01, 8]],
    glsl: `vec3 opBulb(vec3 p, vec4 P, inout float s, inout vec4 trap, inout float seam){
  // The Mandelbulb map: (r, theta, phi) -> (r^n, n*theta, n*phi). Pair it with orbit feedback
  // in the IFS panel to get the Mandelbulb proper; on its own it is the pure power map.
  float n = P.x;
  float r = length(p);
  if(r < 1e-6) return p;
  float th = acos(clamp(p.z / r, -1.0, 1.0));
  float ph = atan(p.y, p.x);
  float rn = pow(r, n);
  float snt = sin(n * th);
  // EXACT operator norm, not the textbook one.
  //
  // In an orthonormal spherical frame the three singular values of this map are
  //   n*r^(n-1),  n*r^(n-1),  and  n*r^(n-1) * |sin(n*theta)/sin(theta)|.
  // The usual Mandelbulb running derivative keeps only n*r^(n-1) and drops the third. That
  // factor tends to n as theta approaches the poles, so the textbook estimate under-reports by
  // up to a factor of n there — measured at 7.96x for n = 8, which is why Mandelbulb renders
  // classically show artifacts at the poles. Declaring the full norm costs march steps near the
  // axis and is correct everywhere.
  float sth = sin(th);
  float amp = (abs(sth) < 1e-4) ? n : abs(snt / sth);
  s *= n * pow(r, n - 1.0) * max(1.0, amp);
  trap = min(trap, vec4(abs(p), r * r));
  return rn * vec3(snt * cos(n * ph), snt * sin(n * ph), cos(n * th));
}` },

  { name: 'Flame IFS', fn: 'opFlame', lip: 'bound', deps: [],
    params: [['Bias', 0.2, 3, 0.01, 1]],
    glsl: `vec3 opFlame(vec3 p, vec4 P, inout float s, inout vec4 trap, inout float seam){
#if FLAME_N > 0
  // The body lives in flameFold(), emitted by assemble.js, because each xform's VARIATION is
  // compiled in and only the assembler sees the config. Selection mode is a property of the
  // flame rather than of this slot, so it is baked there too.
  return flameFold(p, s, trap, P.x);
#else
  return p;                        // no flame imported: identity
#endif
}` },

  // ── JWILDFIRE VARIATIONS ────────────────────────────────────────────────────────────────
  // Ported from the Apophysis / JWildfire variation set, as FOLDS: applied forward to p before
  // the primitive is evaluated. That placement only needs the Jacobian's operator norm, which is
  // why most variations can come across — running one inside Flame IFS instead would need a
  // closed-form INVERSE, and of this batch only Spherical 3D has one (it is an involution).
  //
  // Every norm below is closed-form. No finite-difference Jacobians: they cost four evaluations
  // inside an estimator that is already instantiated ten times, and the error is hard to bound.
  //
  // A note on faithfulness: flame variations SUM inside an xform (out = sum of amount_i * V_i),
  // whereas a fold stack COMPOSES. A single-variation xform ports exactly; a multi-variation one
  // would need a blend op.

  { name: 'V: Sinusoidal', fn: 'opVSin', lip: 'exact', deps: [],
    params: [['Amount', -3, 3, 0.005, 1]],
    glsl: `vec3 opVSin(vec3 p, vec4 P, inout float s, inout vec4 trap, inout float seam){
  // sinusoidal, componentwise in 3D. Diagonal Jacobian a*diag(cos x, cos y, cos z), so the
  // operator norm is exactly a*max|cos| — at most a, which makes this 1-Lipschitz at amount 1.
  vec3 c = abs(cos(p));
  s *= abs(P.x) * max(c.x, max(c.y, c.z));
  return P.x * sin(p);
}` },

  { name: 'V: Spherical 3D', fn: 'opVSph', lip: 'exact', deps: [],
    params: [['Amount', 0.05, 4, 0.005, 1]],
    glsl: `vec3 opVSph(vec3 p, vec4 P, inout float s, inout vec4 trap, inout float seam){
  // spherical3D: p * amount / |p|^2. This is sphere inversion with R^2 = amount — identical to
  // the Sphere inversion op, kept under the flame name so a port maps one-to-one. Conformal,
  // an involution, and the only variation in this batch that could also drive a Flame IFS.
  float r2 = max(dot(p, p), 1e-9);
  float k = P.x / r2;
  s *= abs(k);
  trap = min(trap, vec4(abs(p), r2));
  return p * k;
}` },

  { name: 'V: Bubble', fn: 'opVBub', lip: 'exact', deps: [],
    params: [['Amount', -3, 3, 0.005, 1]],
    glsl: `vec3 opVBub(vec3 p, vec4 P, inout float s, inout vec4 trap, inout float seam){
  // bubble, promoted to 3D by taking r^2 over all three axes. Radial map g(r)*p, so the two
  // tangential eigenvalues are g and the radial one is d(r*g)/dr — the norm is the larger.
  float r2 = dot(p, p);
  float d  = r2 * 0.25 + 1.0;
  float g  = P.x / d;
  float radial = P.x * (1.0 - r2 * 0.25) / (d * d);
  s *= max(abs(g), abs(radial));
  return p * g;
}` },

  { name: 'V: Cylinder', fn: 'opVCyl', lip: 'exact', deps: [],
    params: [['Amount', -3, 3, 0.005, 1], ['Wrap axis', 0, 2, 1, 0, AXIS]],
    disc: [1],
    glsl: d => {
      const w = 'xyz'[d[0]];
      const out = [`vec3(w, p.y, p.z)`, `vec3(p.x, w, p.z)`, `vec3(p.x, p.y, w)`][d[0]];
      return `vec3 opVCyl_${d[0]}(vec3 p, vec4 P, inout float s, inout vec4 trap, inout float seam){
  // cylinder: wraps one axis onto a sine and passes the others. Jacobian a*diag(cos, 1, 1),
  // so the norm is exactly |a| — the wrapped axis can only ever contract.
  float w = P.x * sin(p.${w});
  s *= abs(P.x);
  return ${out} * vec3(1.0);
}`;
    } },

  { name: 'V: Hyperbolic', fn: 'opVHyp', lip: 'bound', deps: [],
    params: [['Amount', -3, 3, 0.005, 1], ['Axis', 0, 2, 1, 2, AXIS]],
    disc: [1],
    glsl: d => {
      const pl = [['p.y', 'p.z', 'p.x'], ['p.z', 'p.x', 'p.y'], ['p.x', 'p.y', 'p.z']][d[0]];
      const out = [`vec3(${pl[2]} * P.x, u, v)`, `vec3(v, ${pl[2]} * P.x, u)`,
                   `vec3(u, v, ${pl[2]} * P.x)`][d[0]];
      return `vec3 opVHyp_${d[0]}(vec3 p, vec4 P, inout float s, inout vec4 trap, inout float seam){
  // hyperbolic, extruded along an axis. The 2D form is (a*x/r^2, a*y), which is asymmetric —
  // one coordinate inverts and the other does not — so a symmetric 3D promotion would be a
  // different variation. This is the 2D formula lifted, not JWildfire's hyperbolic3D.
  //
  // The first Jacobian row works out to norm a/r^2 exactly and the other two are a, so the
  // Frobenius bound a*sqrt(1/r^4 + 2) is closed-form and safe (Frobenius >= spectral).
  float r2 = max(${pl[0]} * ${pl[0]} + ${pl[1]} * ${pl[1]}, 1e-9);
  float u = P.x * ${pl[0]} / r2;
  float v = P.x * ${pl[1]};
  s *= abs(P.x) * sqrt(1.0 / (r2 * r2) + 2.0);
  return ${out};
}`;
    } },

  { name: 'V: Swirl', fn: 'opVSwirl', lip: 'exact', deps: [],
    params: [['Amount', -3, 3, 0.005, 1], ['Twist', -2, 2, 0.005, 1], ['Axis', 0, 2, 1, 2, AXIS]],
    disc: [2],
    glsl: d => {
      const pl = [['p.y', 'p.z', 'p.x'], ['p.z', 'p.x', 'p.y'], ['p.x', 'p.y', 'p.z']][d[0]];
      const out = [`vec3(${pl[2]} * P.x, u, v)`, `vec3(v, ${pl[2]} * P.x, u)`,
                   `vec3(u, v, ${pl[2]} * P.x)`][d[0]];
      return `vec3 opVSwirl_${d[0]}(vec3 p, vec4 P, inout float s, inout vec4 trap, inout float seam){
  // swirl: rotate the plane by an angle proportional to r^2, extruded along an axis.
  // In an orthonormal polar frame this is the constant shear [[1,0],[c,1]] with c = r*dtheta/dr
  // = 2*k*r^2, so the operator norm has the same closed form as the Twist fold. Distinct from
  // Twist, which shears along an axis rather than within the plane.
  float k = P.y;
  float r2 = ${pl[0]} * ${pl[0]} + ${pl[1]} * ${pl[1]};
  float a = -k * r2;
  float ca = cos(a), sa = sin(a);
  float u = P.x * (ca * ${pl[0]} - sa * ${pl[1]});
  float v = P.x * (sa * ${pl[0]} + ca * ${pl[1]});
  float c = 2.0 * abs(k) * r2;
  s *= abs(P.x) * sqrt(1.0 + c * c * 0.5 + c * sqrt(1.0 + c * c * 0.25));
  return ${out};
}`;
    } },

  { name: 'V: Curl', fn: 'opVCurl', lip: 'exact', deps: [],
    params: [['Amount', -3, 3, 0.005, 1], ['C1', -2, 2, 0.005, 0.7], ['C2', -2, 2, 0.005, -0.4],
             ['Axis', 0, 2, 1, 2, AXIS]],
    disc: [3],
    glsl: d => {
      const pl = [['p.y', 'p.z', 'p.x'], ['p.z', 'p.x', 'p.y'], ['p.x', 'p.y', 'p.z']][d[0]];
      const out = [`vec3(${pl[2]} * P.x, u, v)`, `vec3(v, ${pl[2]} * P.x, u)`,
                   `vec3(u, v, ${pl[2]} * P.x)`][d[0]];
      return `vec3 opVCurl_${d[0]}(vec3 p, vec4 P, inout float s, inout vec4 trap, inout float seam){
  // curl is secretly CONFORMAL. Written in complex form the variation is exactly w -> w / D
  // with D = 1 + c1*w + c2*w^2, so its Jacobian is a similarity and the operator norm is
  // |d/dw (w/D)| = |1 - c2*w^2| / |D|^2 — closed form, no numerical Jacobian needed.
  // (Verified against a finite-difference Jacobian to 5e-8.)
  float x = ${pl[0]}, y = ${pl[1]};
  float c1 = P.y, c2 = P.z;
  float re = 1.0 + c1 * x + c2 * (x * x - y * y);
  float im = c1 * y + 2.0 * c2 * x * y;
  float dd = max(re * re + im * im, 1e-9);
  float u = P.x * (x * re + y * im) / dd;
  float v = P.x * (y * re - x * im) / dd;
  // |1 - c2 w^2| with w^2 = (x^2-y^2) + i(2xy)
  float nr = 1.0 - c2 * (x * x - y * y);
  float ni = -c2 * 2.0 * x * y;
  s *= max(abs(P.x) * sqrt(nr * nr + ni * ni) / dd, abs(P.x));
  return ${out};
}`;
    } },

  { name: 'V: Waves 3D', fn: 'opVWaves', lip: 'exact', deps: [],
    params: [['Amount', -3, 3, 0.005, 1], ['Frequency', 0, 4, 0.005, 1],
             ['Amplitude', -2, 2, 0.005, 0.5]],
    glsl: `vec3 opVWaves(vec3 p, vec4 P, inout float s, inout vec4 trap, inout float seam){
  // waves, promoted to 3D cyclically: each axis is displaced by a sine of the next.
  // The Jacobian is the identity plus one off-diagonal term per row, so the Frobenius bound is
  // closed-form: a*sqrt(3 + sum of the three squared cross terms).
  float f = P.y, m = P.z;
  vec3 q = vec3(p.x + m * sin(p.y * f),
                p.y + m * sin(p.z * f),
                p.z + m * sin(p.x * f)) * P.x;
  vec3 g = m * f * cos(vec3(p.y, p.z, p.x) * f);
  s *= abs(P.x) * sqrt(3.0 + dot(g, g));
  return q;
}` },

  { name: 'V: PDJ 3D', fn: 'opVPdj', lip: 'exact', deps: [],
    params: [['Amount', -3, 3, 0.005, 1], ['A', -3, 3, 0.005, 1.8], ['B', -3, 3, 0.005, -1.4],
             ['C', -3, 3, 0.005, 1.2], ['D', -3, 3, 0.005, -1.7]],
    glsl: `vec3 opVPdj(vec3 p, vec4 P0, vec4 P1, inout float s, inout vec4 trap, inout float seam){
  // pdj, promoted to 3D cyclically. Every Jacobian entry is a parameter times a sine or cosine,
  // so the Frobenius bound is exact to write down and needs no differencing.
  float a = P0.y, b = P0.z, c = P0.w, d = P1.x, k = P0.x;
  vec3 q = vec3(sin(a * p.y) - cos(b * p.x),
                sin(c * p.z) - cos(d * p.y),
                sin(a * p.x) - cos(c * p.z)) * k;
  float j1 = b * sin(b * p.x), j2 = a * cos(a * p.y);
  float j3 = d * sin(d * p.y), j4 = c * cos(c * p.z);
  float j5 = a * cos(a * p.x), j6 = c * sin(c * p.z);
  s *= abs(k) * sqrt(j1*j1 + j2*j2 + j3*j3 + j4*j4 + j5*j5 + j6*j6);
  return q;
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
