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
          c.bounces, ops].join('|');
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

  // The IFS contraction. Emitted only when iterating, so iters == 1 is byte-identical to a
  // plain single pass of the stack — same guarantee the 2D tool gives when IFS is off.
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
float march(vec3 ro, vec3 rd, out float glowAcc){
  float t = uMinDist;
  glowAcc = 0.0;
  for(int i = 0; i < ${cfg.steps}; i++){
    vec3 p = ro + rd * t;
    vec4 tr;
    float safe;
    float d = mapT(p, tr, safe);
    if(d < uEps * t) return t;                 // hit test: TRUE distance only
    ${cfg.glow ? 'glowAcc += 1.0 / (1.0 + d * d * 340.0);' : ''}
    t += max(safe * uStepScale, uEps * t);     // advance: clamped by any seam
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

void main(){
  vec2 uv = (gl_FragCoord.xy - uRes * 0.5) / uRes.y;

  vec3 ro = uCamPos;
  vec3 fwd = normalize(uCamTgt - ro);
  vec3 upRef = abs(fwd.y) > 0.999 ? vec3(0.0, 0.0, 1.0) : vec3(0.0, 1.0, 0.0);
  vec3 rgt = normalize(cross(fwd, upRef));
  vec3 upv = cross(rgt, fwd);
  vec3 rd = normalize(rgt * uv.x + upv * uv.y + fwd * uFov);

  // Specular bounce loop. Folding space makes mirror GEOMETRY; this makes the surfaces
  // actually mirror EACH OTHER, which is the other half of a hall of mirrors. Bounce count is
  // a compile-time literal, so 0 bounces emits a single march and costs nothing.
  vec3 accum = vec3(0.0);
  vec3 atten = vec3(1.0);
  float glowTot = 0.0;

  for(int b = 0; b < ${cfg.bounces + 1}; b++){
    float ga = 0.0;
    float t = march(ro, rd, ga);
    glowTot += ga * (b == 0 ? 1.0 : 0.55);

    if(t < 0.0){ accum += atten * background(rd); break; }

    vec3 p = ro + rd * t;
    vec3 n = calcNormal(p, t);
    vec4 trap;
    float safeIgn;
    mapT(p, trap, safeIgn);

    vec3 base;
    vec3 c = shadeSurface(p, n, rd, trap, base);
    float fg = clamp(1.0 - exp(-uFog * t * t * 0.01), 0.0, 1.0);
    c = aerial(c, rd, t);
${cfg.bounces > 0 ? `
    // Schlick, with the BASE reflectance as the control rather than a hardcoded constant.
    //
    // This used to read uReflect * mix(0.18, 1.0, pow(...)), which capped head-on reflection at
    // 18% of the slider — full value only appeared at grazing angles. A real mirror is ~95% at
    // every angle. Now Reflectivity IS F0, and Fresnel separately controls how much the grazing
    // angle lifts it toward 1: Fresnel 0 is a flat metal mirror, 1 is glassy edge-heavy falloff.
    float ct = clamp(dot(n, -rd), 0.0, 1.0);
    float F0 = clamp(uReflect, 0.0, 1.0);
    float F  = (F0 + (1.0 - F0) * uFresnel * pow(1.0 - ct, 5.0)) * (1.0 - fg);
    if(b == ${cfg.bounces}){ accum += atten * c; break; }
    accum += atten * c * (1.0 - F);
    // Metals tint what they reflect; dielectrics don't. The tint is NORMALISED so the brightest
    // channel stays at 1 — multiplying by a shaded colour each bounce crushed everything to
    // black by the third one. This carries hue without costing energy, which is what makes gold
    // read as gold through a stack of bounces instead of as a dark smear.
    vec3 tint = base / max(max(base.r, base.g), max(base.b, 1e-4));
    atten *= F * mix(vec3(1.0), tint, uMetal);
    if(max(atten.r, max(atten.g, atten.b)) < 0.004) break;
    ro = p + n * max(uEps * t, 1e-5) * 6.0;
    rd = reflect(rd, n);` : `
    accum += atten * c;
    break;`}
  }

  vec3 col = accum;
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
