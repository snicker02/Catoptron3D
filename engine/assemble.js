// Shader assembler. Emits a fragment shader containing ONLY the operators in the current stack
// (straight-line, no dispatch), only the selected primitive, and only the active shading
// features. Everything discrete is baked in; every continuous slider stays a uniform and never
// triggers a rebuild.
//
// Why this is stricter than the 2D assembler: in 2D the fold stack ran ONCE per pixel. Here it
// runs inside sdf(), which the compiler instantiates ~10x (1 march + 4 normal taps + 5 AO taps)
// and the marcher calls 64-256 times per ray. A live branch inside a fold is paid for hundreds
// of thousands of times per frame and expanded ten times at compile time. So discrete choices
// become literals and join the program signature.

import { PRELUDE, VS } from './prelude.js';
import { HELPERS } from './helpers.js';
import { OPS, discIdx, fnName, bankCount } from './ops.js';
import { flameKey, resolveFlame, flameVars, FLAME_VARIATIONS, MAX_XFORMS } from './flame.js';
const FLAME_VARIATION_COUNT = FLAME_VARIATIONS.length;

export { VS };

export const MAX_OPS = 8;

// NOTE: the order of this list is part of the preset format (state.prim is an index), so new
// primitives get APPENDED and existing ones never move.
// `frame` is an optional edge-only variant; primitives without one fall back to shell.
export const PRIMS = [
  { name: 'Box frame', fn: 'sdFrame',  deps: ['sdFrame'], frame: 'sdFrame', frameDeps: ['sdFrame'] },
  { name: 'Box',       fn: 'sdBox',    deps: ['sdBox'],
    frame: 'sdBoxFrame', frameDeps: ['sdBoxFrame'] },
  { name: 'Sphere',    fn: 'sdSphere', deps: ['sdSphere'],
    frame: 'sdSphereFrame', frameDeps: ['sdSphereFrame'] },
  { name: 'Octahedron',fn: 'sdOcta',   deps: ['sdOcta'],
    frame: 'sdOctaFrame', frameDeps: ['sdOctaFrame'] },
  { name: 'Torus',     fn: 'sdTorus',  deps: ['sdTorus'],
    frame: 'sdTorusFrame', frameDeps: ['sdTorusFrame'] },
  { name: 'City',      fn: 'sdCity',   deps: ['sdCity'],
    frame: 'sdCityFrame', frameDeps: ['sdCityFrame'] },
  { name: 'Crystal',   fn: 'sdCrystal', deps: ['sdCrystal'] }
];

export const PRIM_STYLES = ['solid', 'shell (hollow)', 'frame (edges)'];

export const MARCH_STEPS = [64, 96, 128, 192, 256, 384, 512, 768];

// transitive closure of helper deps, emitted in dependency order
function resolveHelpers(names){
  const need = new Set();
  const visit = h => {
    if(need.has(h)) return;
    if(!HELPERS[h]) throw new Error('unknown helper: ' + h);
    (HELPERS[h].deps || []).forEach(visit);
    need.add(h);
  };
  names.forEach(visit);
  return [...need].map(h => HELPERS[h].src).join('\n');
}

function opSource(slot){
  const op = OPS[slot.type];
  const d = discIdx(op).map(i => Math.round(slot.p[i]));
  return typeof op.glsl === 'function' ? op.glsl(d) : op.glsl;
}

// One fold call, wrapped in its own origin + orientation (both isometries, so s is untouched).
function foldCall(slot, i){
  const op = OPS[slot.type];
  const banks = [];
  for(let b = 0; b < bankCount(op); b++) banks.push(`uP${i}_${b}`);
  return [
    `    p -= uO${i};`,
    `    p = rotE3inv(p, uR${i});`,
    `    p = ${fnName(op, slot.p)}(p, ${banks.join(', ')}, s, trap, seam);`,
    `    p = rotE3(p, uR${i});`,
    `    p += uO${i};`
  ].join('\n');
}

export function normalizeCfg(cfg){
  return {
    stack:  (cfg.stack || []).slice(0, MAX_OPS).map(sl => ({ type: sl.type, p: sl.p.slice() })),
    prim:   cfg.prim | 0,
    iters:  Math.max(1, Math.min(24, cfg.iters | 0 || 1)),
    steps:  cfg.steps | 0 || 128,
    ao:     !!cfg.ao,
    shadow: !!cfg.shadow,
    glow:   !!cfg.glow,
    seamSurf: !!cfg.seamSurf,
    primStyle: Math.max(0, Math.min(2, cfg.primStyle | 0)),
    transp:   !!cfg.transp,
    flameN:   Math.max(0, Math.min(MAX_XFORMS, cfg.flameN !== undefined
                ? cfg.flameN : resolveFlame(cfg.flame).length)),
    flameVars: cfg.flameVars || flameVars(cfg.flame),
    flameSelect: cfg.flameSelect !== undefined
                   ? (cfg.flameSelect ? 1 : 0)
                   : ((cfg.flame && cfg.flame.select) ? 1 : 0),
    disp:     !!cfg.disp,
    feedback: Math.max(0, Math.min(2, cfg.feedback | 0)),
    env:      !!cfg.env,
    tex:      !!cfg.tex,
    bounces: Math.max(0, Math.min(6, cfg.bounces | 0))
  };
}

// Param tweaks reuse a program; only a new type/order/discrete/feature combination compiles.
export function signature(cfg){
  const c = normalizeCfg(cfg);
  const ops = c.stack.map(sl => {
    const op = OPS[sl.type];
    const d = discIdx(op).map(i => Math.round(sl.p[i]));
    return sl.type + (d.length ? ':' + d.join('.') : '');
  }).join(',');
  return [c.prim, c.primStyle, c.iters, c.steps, c.ao ? 1 : 0, c.shadow ? 1 : 0, c.glow ? 1 : 0,
          c.seamSurf ? 1 : 0, c.feedback, c.env ? 1 : 0, c.tex ? 1 : 0,
          c.transp ? 1 : 0, c.disp ? 1 : 0, c.bounces,
          c.flameN, c.flameSelect, (c.flameVars || []).join(''), ops].join('|');
}

export function assemble(cfgIn){
  const cfg = normalizeCfg(cfgIn);
  const prim = PRIMS[cfg.prim] || PRIMS[0];

  // ── uniform declarations, one block per fold slot ──
  const decls = cfg.stack.map((sl, i) => {
    const op = OPS[sl.type];
    let d = '';
    for(let b = 0; b < bankCount(op); b++) d += `uniform vec4 uP${i}_${b};\n`;
    return d + `uniform vec3 uO${i};\nuniform vec3 uR${i};`;
  }).join('\n');

  // ── helpers: op deps + primitive deps + always-on ──
  // frame style uses the edge variant where one exists; everything else falls back to shell,
  // which is universal and exact
  const useFrame = cfg.primStyle === 2 && !!prim.frame;
  const useShell = cfg.primStyle === 1 || (cfg.primStyle === 2 && !prim.frame);
  const primFn = useFrame ? prim.frame : prim.fn;
  const helperNames = ['rot3', 'palette',
                       ...(useFrame ? prim.frameDeps : prim.deps)];
  cfg.stack.forEach(sl => (OPS[sl.type].deps || []).forEach(h => helperNames.push(h)));
  const helperSrc = resolveHelpers(helperNames);

  // ── op bodies, deduped by EMITTED name (so two slots of the same op+mode share one body,
  //    but the same op at two different discrete modes emits two distinct functions) ──
  const seen = new Set();
  const opSrc = cfg.stack.map(sl => {
    const key = fnName(OPS[sl.type], sl.p);
    if(seen.has(key)) return '';
    seen.add(key);
    return opSource(sl);
  }).filter(Boolean).join('\n\n');

  const folds = cfg.stack.map(foldCall).join('\n');

  // ── flame fold ──
  // Emitted here rather than in ops.js because the code depends on the CONFIG: each xform's
  // variation is compiled in (they emit different inverse code), while amounts and parameters
  // stay uniforms so the editor sliders remain live. The loop over xforms is fully unrolled, so
  // there is no dynamic branch and no dynamic array indexing.
  //
  // A flame xform is f(p) = V(affine(p)), and this path needs f inverse:
  //     f^-1(q) = affine^-1( V^-1(q) )
  // so each block applies the variation's inverse first and the affine inverse second.
  // slot -> uniform component, across three vec4 arrays per xform
  const VP = (k, i) => `${['uFlameVP', 'uFlameVQ', 'uFlameVR'][Math.floor(i / 4)]}[${k}].${'xyzw'[i % 4]}`;

  const V_INV = [
    // linear3D: V(p) = A*p
    k => `      { float A = uFlameVAmt[${k}]; A = abs(A) < 1e-5 ? 1e-5 : A;
        q = q / A; ve = 1.0 / abs(A); }`,
    // spherical3D: an involution, so the inverse is the same map with the same amount
    k => `      { float A = uFlameVAmt[${k}];
        float r2 = max(dot(q, q), 1e-9);
        q = q * (A / r2); ve = abs(A) / r2; }`,
    // swirl: radius is preserved (up to the amount) and the angle turns by -k*r^2, so undoing
    // it is exact — unwind the amount first, then turn the angle back by the SAME r
    k => `      { float A = uFlameVAmt[${k}]; A = abs(A) < 1e-5 ? 1e-5 : A;
        float kk = ${VP(k, 0)};
        vec3 u = q / A;
        float r2 = u.x * u.x + u.y * u.y;
        float th = kk * r2;
        float c = cos(th), sn = sin(th);
        q = vec3(c * u.x - sn * u.y, sn * u.x + c * u.y, u.z);
        float cc = 2.0 * abs(kk) * r2;
        ve = (1.0 / abs(A)) * sqrt(1.0 + cc * cc * 0.5 + cc * sqrt(1.0 + cc * cc * 0.25)); }`,
    // radial power: rho -> A*rho^n with the direction kept, so the inverse is (rho/A)^(1/n).
    // Radial and tangential eigenvalues differ, hence the max.
    k => `      { float A = uFlameVAmt[${k}]; A = abs(A) < 1e-5 ? 1e-5 : A;
        float n = ${VP(k, 1)}; n = abs(n) < 0.05 ? (n < 0.0 ? -0.05 : 0.05) : n;
        float r = max(length(q), 1e-9);
        float rin = pow(max(r / abs(A), 1e-12), 1.0 / n);
        q = q * (rin / r);
        float tang = rin / r;
        float radial = abs(rin / (n * r));
        ve = max(tang, radial); }`,
    // exp: V(p) = A*e^x*(cos y, sin y), z scaled. The inverse is the PRINCIPAL log, which is a
    // right inverse everywhere off the axis — exactly what the backward path needs, even though
    // exp is many-to-one going forward. Conformal, so the norm is 1/|q_xy|.
    k => `      { float A = uFlameVAmt[${k}]; A = abs(A) < 1e-5 ? 1e-5 : A;
        float rr = max(length(q.xy), 1e-7);
        q = vec3(log(rr / abs(A)), atan(q.y, q.x), q.z / A);
        ve = max(1.0 / rr, 1.0 / abs(A)); }`,
    // log: the mirror image of exp — its inverse IS exp.
    k => `      { float A = uFlameVAmt[${k}]; A = abs(A) < 1e-5 ? 1e-5 : A;
        float e = exp(q.x / A);
        q = vec3(e * cos(q.y / A), e * sin(q.y / A), q.z / A);
        ve = max(e / abs(A), 1.0 / abs(A)); }`,
    // unpolar: A*e^y*(sin x, cos x) — exp with the axes swapped, inverted the same way
    k => `      { float A = uFlameVAmt[${k}]; A = abs(A) < 1e-5 ? 1e-5 : A;
        float rr = max(length(q.xy), 1e-7);
        q = vec3(atan(q.x, q.y), log(rr / abs(A)), q.z / A);
        ve = max(1.0 / rr, 1.0 / abs(A)); }`,
    // polar: (A*theta/pi, A*(r-1)). Its preimage needs r > 0, so a point below that has none —
    // report a huge distance instead so the selection simply picks a different map.
    k => `      { float A = uFlameVAmt[${k}]; A = abs(A) < 1e-5 ? 1e-5 : A;
        float th = PI * q.x / A;
        float rr = q.y / A + 1.0;
        if(rr <= 1e-6){ q = vec3(1e12); ve = 1e12; }
        else {
          q = vec3(rr * cos(th), rr * sin(th), q.z / A);
          ve = max(PI * rr / abs(A), 1.0 / abs(A));
        } }`,
    // zscale: (x, y, A*z). JWildfire's zscale only WRITES z, so on its own it would collapse a
    // dimension; the standard usage pairs it with linear3D, and that pairing is what this is.
    k => `      { float A = uFlameVAmt[${k}]; A = abs(A) < 1e-5 ? 1e-5 : A;
        q = vec3(q.x, q.y, q.z / A);
        ve = max(1.0, 1.0 / abs(A)); }`,
    // zcone: (x, y, z + A*sqrt(x^2+y^2)) — again the linear3D pairing. A shear in z, so the
    // inverse just subtracts the cone back off.
    k => `      { float A = uFlameVAmt[${k}];
        q = vec3(q.x, q.y, q.z - A * length(q.xy));
        ve = sqrt(3.0 + A * A); }`
  ];

  // The complex-analytic family, generated from one template. Each entry is
  //   [ inverse expression, |forward derivative| expression ]
  // evaluated at w = f^-1(q/A). Because these maps are conformal the inverse's derivative is
  // just the reciprocal of the forward one, so only the FORWARD derivative has to be written —
  // twelve hand-derived inverse derivatives would have been twelve chances to be subtly wrong.
  const CX = [
    ['sin',  'casin(u)',        'ccos(w)'],
    ['cos',  'cacos(u)',        'csin(w)'],
    ['tan',  'catan(u)',        'cinv(csqr(ccos(w)))'],
    ['sinh', 'casinh(u)',       'ccosh(w)'],
    ['cosh', 'cacosh(u)',       'csinh(w)'],
    ['tanh', 'catanh(u)',       'cinv(csqr(ccosh(w)))'],
    ['sec',  'cacos(cinv(u))',  'cdiv(csin(w), csqr(ccos(w)))'],
    ['csc',  'casin(cinv(u))',  'cdiv(ccos(w), csqr(csin(w)))'],
    ['cot',  'catan(cinv(u))',  'cinv(csqr(csin(w)))'],
    ['sech', 'cacosh(cinv(u))', 'cdiv(csinh(w), csqr(ccosh(w)))'],
    ['csch', 'casinh(cinv(u))', 'cdiv(ccosh(w), csqr(csinh(w)))'],
    ['coth', 'catanh(cinv(u))', 'cinv(csqr(csinh(w)))']
  ];
  CX.forEach(([, inv, der]) => V_INV.push(k => `      { float A = uFlameVAmt[${k}]; A = abs(A) < 1e-5 ? 1e-5 : A;
        vec2 u = vec2(q.x, q.y) / A;
        vec2 w = ${inv};
        float dm = max(length(${der}), 1e-7);
        q = vec3(w.x, w.y, q.z / A);
        ve = max(1.0 / (abs(A) * dm), 1.0 / abs(A)); }`));

  // mobius3D: T(p) = b + lambda*R*(p-a)/|p-a|^2. The inverse undoes translate, scale and
  // rotation, then inverts about the centre again — every step closed form, and conformal, so
  // the norm is exactly 1/(lambda*|u|^2).
  V_INV.push(k => `      { float A = uFlameVAmt[${k}]; A = abs(A) < 1e-5 ? 1e-5 : A;
        vec3 ctr = vec3(${VP(k, 2)}, ${VP(k, 3)}, ${VP(k, 4)});
        vec3 mv  = vec3(${VP(k, 5)}, ${VP(k, 6)}, ${VP(k, 7)});
        float lam = ${VP(k, 8)}; lam = abs(lam) < 1e-4 ? 1e-4 : lam;
        vec3 rot = vec3(${VP(k, 9)}, ${VP(k, 10)}, ${VP(k, 11)});
        vec3 u = rotE3inv((q / A - mv) / lam, rot);
        float uu = max(dot(u, u), 1e-12);
        q = ctr + u / uu;
        ve = 1.0 / (abs(A) * abs(lam) * uu); }`);

  // V_INV is indexed by the variation id, so it must line up with FLAME_VARIATIONS exactly.
  // An off-by-one here silently gives an xform a DIFFERENT variation's inverse, which renders
  // as plausible-but-wrong geometry rather than as an error.
  if(V_INV.length !== FLAME_VARIATION_COUNT){
    throw new Error('variation table desync: ' + V_INV.length + ' inverses for ' +
                    FLAME_VARIATION_COUNT + ' variations');
  }

  const flameBlocks = (cfg.flameVars || []).slice(0, cfg.flameN).map((v, k) => `
    {
      vec3 q = p;
      float ve = 1.0;
${(V_INV[v] || V_INV[0])(k)}
      q = uFlameMi[${k}] * q + uFlameTi[${k}];
      float ex = ve * uFlameEx[${k}];
      vec3 dv = ${cfg.flameSelect ? `p - uFlameFp[${k}]` : 'q'};
      float d = dot(dv, dv) * bias;
      if(d < best){ best = d; bq = q; bex = ex; }
    }`).join('');

  // Complex arithmetic, emitted once and only when a flame is present.
  const CPLX = `
vec2 cmul(vec2 a, vec2 b){ return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }
vec2 cinv(vec2 a){ float d = max(dot(a, a), 1e-12); return vec2(a.x, -a.y) / d; }
vec2 cdiv(vec2 a, vec2 b){ return cmul(a, cinv(b)); }
vec2 csqr(vec2 a){ return vec2(a.x * a.x - a.y * a.y, 2.0 * a.x * a.y); }
vec2 cexpc(vec2 a){ float e = exp(a.x); return vec2(e * cos(a.y), e * sin(a.y)); }
vec2 clog(vec2 a){ return vec2(0.5 * log(max(dot(a, a), 1e-30)), atan(a.y, a.x)); }
vec2 csqrtc(vec2 a){
  float r = sqrt(max(length(a), 1e-30));
  float t = atan(a.y, a.x) * 0.5;
  return vec2(r * cos(t), r * sin(t));
}
vec2 csin(vec2 a){ return vec2(sin(a.x) * cosh(a.y), cos(a.x) * sinh(a.y)); }
vec2 ccos(vec2 a){ return vec2(cos(a.x) * cosh(a.y), -sin(a.x) * sinh(a.y)); }
vec2 csinh(vec2 a){ return vec2(sinh(a.x) * cos(a.y), cosh(a.x) * sin(a.y)); }
vec2 ccosh(vec2 a){ return vec2(cosh(a.x) * cos(a.y), sinh(a.x) * sin(a.y)); }
vec2 cmi(vec2 a){ return vec2(a.y, -a.x); }            // multiply by -i
vec2 cpi(vec2 a){ return vec2(-a.y, a.x); }            // multiply by +i
vec2 casin(vec2 z){ return cmi(clog(cpi(z) + csqrtc(vec2(1.0, 0.0) - csqr(z)))); }
vec2 cacos(vec2 z){ return cmi(clog(z + cpi(csqrtc(vec2(1.0, 0.0) - csqr(z))))); }
vec2 catan(vec2 z){ return 0.5 * cpi(clog(cdiv(vec2(0.0, 1.0) + z, vec2(0.0, 1.0) - z))); }
vec2 casinh(vec2 z){ return clog(z + csqrtc(csqr(z) + vec2(1.0, 0.0))); }
vec2 cacosh(vec2 z){ return clog(z + csqrtc(csqr(z) - vec2(1.0, 0.0))); }
vec2 catanh(vec2 z){ return 0.5 * clog(cdiv(vec2(1.0, 0.0) + z, vec2(1.0, 0.0) - z)); }
`;

  const flameSrc = `\n#define FLAME_N ${cfg.flameN}` + (cfg.flameN ? CPLX + `
vec3 flameFold(vec3 p, inout float s, inout vec4 trap, float bias){
  float best = 1e18;
  vec3 bq = p;
  float bex = 1.0;
${flameBlocks}
  s *= bex;
  trap = min(trap, vec4(abs(bq), dot(bq, bq)));
  return bq;
}` : '');

  // The IFS contraction, plus optional ESCAPE-TIME feedback.
  //
  // Without feedback this is a pure iterated function system: the attractor of the fold stack.
  // Mandelbox, Mandelbulb and the quaternion Julias are NOT that — each pass re-adds a point,
  // p = scale*p + c, which turns the attractor into an escape-time set. Two things are needed
  // and neither existed before:
  //   1. the ORIGINAL sample point p0 must survive into the loop, and
  //   2. the derivative recurrence becomes ADDITIVE: dr = dr*|scale| + 1, because d(p0)/d(p0)
  //      is 1. A purely multiplicative s cannot express that, and using one gives a DE that is
  //      wrong by a growing factor.
  // A fixed Julia constant contributes no derivative, so only the orbit mode adds the 1.
  const feedTerm = ['', '\n      p += p0;\n      s = s + 1.0;',
                        '\n      p += uJuliaC;'][cfg.feedback];
  const contraction = cfg.iters > 1 ? `
    {
      vec3 d = rotE3((p - uIfsCenter) * uIfsScale, uIfsRot);
      p = d + uIfsCenter;
      s *= uIfsScale;                 // exact: rotation is free, uniform scale is k${feedTerm}
    }` : '';

  return `${PRELUDE}
${decls}
${helperSrc}
${flameSrc}

${opSrc}

float prim(vec3 p){
  float d = ${primFn}(p);
${useShell ? `  // Shell: the signed distance to the SURFACE of a solid rather than to its interior.
  // Exact for every primitive — |grad(|d| - t)| = |grad d| = 1 away from the medial axis — so
  // this is the one hollowing operation that needs no per-shape work.
  d = abs(d) - max(uPrimThick, 1e-4);` : ''}
  return d;
}

// ── the distance estimator ──────────────────────────────────────────────────────────────
// s accumulates the local linear expansion of the whole fold stack; the estimate is the
// primitive's distance in folded space divided back out by it.
float mapT(vec3 p, out vec4 trap, out float safe){
  vec3 p0 = p;                        // the original sample point, for escape-time feedback
  float s = 1.0;
  float seam = 1e9;
  trap = vec4(1e9);
  for(int i = 0; i < ${cfg.iters}; i++){
${cfg.feedback ? `    // Escape-time bailout. Without it a power map runs to infinity in a few passes and the
    // estimate is garbage; with it the orbit freezes at the escape point, which is what the
    // classic |p|/dr formula is evaluated at.
    if(dot(p, p) > uBailout * uBailout) break;
` : ''}${folds}
    trap = min(trap, vec4(abs(p), dot(p, p)));${contraction}
  }
  float d = prim(p) / s;
  // The seam bounds how far the marcher may ADVANCE, but it is not a surface — unless you ask
  // for it. Fold membrane mode returns the clamped value as the distance, so the marcher lands
  // on the cut plane and shades it as a visible sheet. That is the accidental look this bug
  // originally produced, kept as an opt-in effect: the mirror dimension does show you its fold
  // planes. Off by default, because a phantom surface is the wrong default.
  //
  // The bug, for the record:
  //
  // Returning min(prim/s, seam) as one number was wrong: near a tear the value goes to zero, the
  // hit test d < eps*t fires, and the marcher shades a phantom surface on the cut plane. It
  // showed up as smooth contour bands that ignored iterations, IFS scale, palette, AO and step
  // scale but tracked epsilon — the signature of a false hit, not of geometry. So the distance
  // and the safe step are now separate outputs: hit-test against the true distance, advance by
  // the clamped one.
  safe = min(d, seam);
  return ${cfg.seamSurf ? 'safe' : 'd'};
}

float map(vec3 p){ vec4 t; float sf; return mapT(p, t, sf); }

vec3 calcNormal(vec3 p, float t){
  float e = max(uEps * t, 1e-5);
  vec2 k = vec2(1.0, -1.0);
  return normalize(
    vec3( k.x, k.y, k.y) * map(p + vec3( k.x, k.y, k.y) * e) +
    vec3( k.y, k.y, k.x) * map(p + vec3( k.y, k.y, k.x) * e) +
    vec3( k.y, k.x, k.y) * map(p + vec3( k.y, k.x, k.y) * e) +
    vec3( k.x, k.x, k.x) * map(p + vec3( k.x, k.x, k.x) * e));
}
${cfg.ao ? `
float calcAO(vec3 p, vec3 n){
  float o = 0.0, w = 1.0;
  for(int i = 0; i < 5; i++){
    float h = 0.01 + 0.12 * float(i);
    o += max(0.0, h - map(p + n * h)) * w;
    w *= 0.7;
  }
  return clamp(1.0 - uAoStr * o * 2.5, 0.0, 1.0);
}` : ''}
${cfg.shadow ? `
float softShadow(vec3 p, vec3 l){
  float res = 1.0, t = 0.02;
  for(int i = 0; i < 24; i++){
    float h = map(p + l * t);
    if(h < 0.0008) return 0.0;
    res = min(res, 12.0 * h / t);
    t += clamp(h, 0.02, 0.4);
    if(t > 6.0) break;
  }
  return clamp(res, 0.0, 1.0);
}` : ''}

// march returns hit distance, or -1.0 on miss. glowAcc is a cheap proximity accumulator:
// rays that graze the surface without hitting pick up light, which is what makes fold seams
// and fractal filigree read as emissive rather than as noise.
// The side argument is +1 outside the solid and -1 inside it. Negating the estimate lets the same routine
// walk the INTERIOR until it reaches the surface again, which is what refraction requires: a
// transmitted ray has to be tracked through the medium, not just bent at the entry face.
float march(vec3 ro, vec3 rd, float side, out float glowAcc){
  float t = uMinDist;
  glowAcc = 0.0;
  for(int i = 0; i < ${cfg.steps}; i++){
    vec3 p = ro + rd * t;
    vec4 tr;
    float safe;
    float d = side * mapT(p, tr, safe);
    if(d < uEps * t) return t;                 // hit test: TRUE distance only
    ${cfg.glow ? 'glowAcc += 1.0 / (1.0 + d * d * 340.0);' : ''}
    t += max(side * safe * uStepScale, uEps * t);
    if(t > uMaxDist) break;
  }
  return -1.0;
}

vec3 background(vec3 rd){
  vec3 L = normalize(uLightDir);
  float up = clamp(rd.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 sky = mix(uBgBot, uBgTop, pow(up, 0.75));
  if(uSun > 0.001){
    float sd = max(dot(rd, L), 0.0);
    sky += vec3(1.0, 0.96, 0.88) * pow(sd, 260.0) * uSun * 3.0;   // disc
    sky += vec3(1.0, 0.90, 0.78) * pow(sd, 6.0) * uSun * 0.16;    // forward scatter
  }
${cfg.env ? `
  // Equirectangular environment map. This is the placement that matters for a mirror tool: the
  // photo lands in every reflection, which is what makes a folded plane read as real glass
  // rather than as tinted plastic.
  vec2 euv = vec2(atan(rd.z, rd.x) / TAU + 0.5 + uEnvRot,
                  acos(clamp(rd.y, -1.0, 1.0)) / PI);
  sky = mix(sky, texture(uImg, euv).rgb * uEnvGain, uEnvAmt);` : ''}
  return sky;
}

// Aerial perspective: distant geometry washes toward the sky it is seen against, which is what
// gives the reference frames their depth. Plain fog to a single flat colour cannot do that.
vec3 aerial(vec3 col, vec3 rd, float t){
  float f = clamp(1.0 - exp(-uFog * t * t * 0.01), 0.0, 1.0);
  vec3 h = mix(uBgBot, uBgTop, clamp(rd.y * 0.5 + 0.5, 0.0, 1.0));
  return mix(col, h * (1.0 + uHaze * 0.4), f);
}

vec3 shadeSurface(vec3 p, vec3 n, vec3 rd, vec4 trap, out vec3 albedo){
  float ct = clamp(sqrt(max(trap.w, 0.0)) * uTrapScale + uTrapShift, 0.0, 1.0);
  vec3 base = palette(ct);
${cfg.tex ? `
  // Triplanar projection — no UVs exist on an implicit surface, so the photo is blended from
  // three axis-aligned projections weighted by the normal.
  vec3 an = abs(n);
  an /= max(an.x + an.y + an.z, 1e-4);
  vec3 tx = texture(uImg, vec2(p.y, p.z) * uTexScale).rgb * an.x
          + texture(uImg, vec2(p.x, p.z) * uTexScale).rgb * an.y
          + texture(uImg, vec2(p.x, p.y) * uTexScale).rgb * an.z;
  base = mix(base, tx, uTexAmt);` : ''}
  albedo = base;

  float aoV = ${cfg.ao ? 'calcAO(p, n)' : '1.0'};
  vec3  L   = normalize(uLightDir);
  float sha = ${cfg.shadow ? 'softShadow(p, L)' : '1.0'};
  float dif = max(dot(n, L), 0.0);
  vec3  hv  = normalize(L - rd);
  float spe = pow(max(dot(n, hv), 0.0), 34.0) * uSpec;
  float fre = pow(1.0 - max(dot(n, -rd), 0.0), 4.0) * uRim;

  vec3 col  = base * (uAmbient * aoV + dif * sha * aoV);
  col += vec3(spe) * sha * aoV;
  col += base * fre;
  return col;
}

// One light path. Pulled out of main() so that dispersion can run it three times with a
// different IOR per channel — the physically real cause of the rainbow fringing in glass.
vec3 tracePath(vec3 ro, vec3 rd, float ior, out float glowTot){
  vec3 accum = vec3(0.0);
  vec3 atten = vec3(1.0);
  float side = 1.0;                    // +1 travelling outside the solid, -1 inside it
  glowTot = 0.0;

  for(int b = 0; b < ${cfg.bounces + 1}; b++){
    float ga = 0.0;
    float t = march(ro, rd, side, ga);
    glowTot += ga * (b == 0 ? 1.0 : 0.55);

    if(t < 0.0){ accum += atten * background(rd); break; }

    vec3 p = ro + rd * t;
    vec3 gn = calcNormal(p, t);
    vec3 n  = gn * side;               // always faces the incoming ray
    vec4 trap;
    float safeIgn;
    mapT(p, trap, safeIgn);

    vec3 base;
    vec3 c = shadeSurface(p, n, rd, trap, base);
    c = aerial(c, rd, t);
${cfg.transp ? `
    // Beer-Lambert: light that crossed the medium is absorbed in proportion to path length,
    // and in the COMPLEMENT of the material colour — that is what makes thick glass saturate
    // toward its own hue instead of merely getting darker.
    if(side < 0.0){
      vec3 tint = base / max(max(base.r, base.g), max(base.b, 1e-4));
      atten *= exp(-uAbsorb * t * (vec3(1.0) - tint));
    }` : ''}

    float ct = clamp(dot(n, -rd), 0.0, 1.0);
    float F0 = clamp(uReflect, 0.0, 1.0);
    float F  = (F0 + (1.0 - F0) * uFresnel * pow(1.0 - ct, 5.0)) * (1.0 - clamp(1.0 - exp(-uFog * t * t * 0.01), 0.0, 1.0));
${cfg.transp ? `
    // Opaque fraction shades normally; the rest is carried through the interface.
    accum += atten * c * (1.0 - uTransp);
    vec3 thru = atten * uTransp;

    // The reflected share is approximated with the environment rather than traced. Tracing both
    // branches at every interface is exponential; refraction is the one that has to be followed
    // exactly, because it is what carries the image through the glass.
    accum += thru * F * background(reflect(rd, n));

    if(b == ${cfg.bounces}){ accum += thru * (1.0 - F) * background(rd); break; }

    atten = thru * (1.0 - F);
    float eta = (side > 0.0) ? (1.0 / max(ior, 1.0001)) : max(ior, 1.0001);
    vec3 rr = refract(rd, n, eta);
    if(dot(rr, rr) < 1e-8){
      rd = reflect(rd, n);             // total internal reflection: stay on this side
    } else {
      rd = rr;
      side = -side;                    // crossed the boundary
    }
    ro = p + rd * max(uEps * t, 1e-5) * 6.0;
    if(max(atten.r, max(atten.g, atten.b)) < 0.004) break;` :
cfg.bounces > 0 ? `
    if(b == ${cfg.bounces}){ accum += atten * c; break; }
    accum += atten * c * (1.0 - F);
    vec3 tint = base / max(max(base.r, base.g), max(base.b, 1e-4));
    atten *= F * mix(vec3(1.0), tint, uMetal);
    if(max(atten.r, max(atten.g, atten.b)) < 0.004) break;
    ro = p + n * max(uEps * t, 1e-5) * 6.0;
    rd = reflect(rd, n);` : `
    accum += atten * c;
    break;`}
  }
  return accum;
}

void main(){
  vec2 uv = (gl_FragCoord.xy - uRes * 0.5) / uRes.y;

  vec3 ro = uCamPos;
  vec3 fwd = normalize(uCamTgt - ro);
  vec3 upRef = abs(fwd.y) > 0.999 ? vec3(0.0, 0.0, 1.0) : vec3(0.0, 1.0, 0.0);
  vec3 rgt = normalize(cross(fwd, upRef));
  vec3 upv = cross(rgt, fwd);
  vec3 rd = normalize(rgt * uv.x + upv * uv.y + fwd * uFov);

  float glowTot = 0.0;
  vec3 col;
${cfg.disp ? `
  // Dispersion: three separate paths, one per channel, with the IOR spread around uIOR.
  // Three full traces is the honest cost of the effect; there is no cheap version that bends
  // the channels differently without actually following them.
  col = vec3(0.0);
  for(int ch = 0; ch < 3; ch++){
    float g;
    float iorCh = uIOR + (float(ch) - 1.0) * uDisp * 0.06;
    col[ch] = tracePath(ro, rd, iorCh, g)[ch];
    glowTot = max(glowTot, g);
  }` : `
  col = tracePath(ro, rd, uIOR, glowTot);`}

  ${cfg.glow ? 'col += palette(clamp(glowTot * 0.03 + uTrapShift, 0.0, 1.0)) * glowTot * uGlow * 0.02;' : ''}

  col *= uExposure;
  float lum = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(vec3(lum), col, uSat);
  col = (col * (2.51 * col + 0.03)) / (col * (2.43 * col + 0.59) + 0.14);   // ACES-ish
  col = pow(clamp(col, 0.0, 1.0), vec3(1.0 / 2.2));
  col *= 1.0 - 0.36 * pow(dot(uv * 0.8, uv * 0.8), 1.6);

  fragColor = vec4(col, 1.0);
}`;
}
