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

export const PRIMS = [
  { name: 'Box frame', fn: 'sdFrame',  deps: ['sdFrame'] },
  { name: 'Box',       fn: 'sdBox',    deps: ['sdBox'] },
  { name: 'Sphere',    fn: 'sdSphere', deps: ['sdSphere'] },
  { name: 'Octahedron',fn: 'sdOcta',   deps: ['sdOcta'] },
  { name: 'Torus',     fn: 'sdTorus',  deps: ['sdTorus'] }
];

export const MARCH_STEPS = [64, 96, 128, 192, 256, 384];

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
    `    p = ${fnName(op, slot.p)}(p, ${banks.join(', ')}, s, trap);`,
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
    bounces: Math.max(0, Math.min(4, cfg.bounces | 0))
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
  return [c.prim, c.iters, c.steps, c.ao ? 1 : 0, c.shadow ? 1 : 0, c.glow ? 1 : 0,
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
  const helperNames = ['rot3', 'palette', ...prim.deps];
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
  const contraction = cfg.iters > 1 ? `
    {
      vec3 d = rotE3((p - uIfsCenter) * uIfsScale, uIfsRot);
      p = d + uIfsCenter;
      s *= uIfsScale;                 // exact: rotation is free, uniform scale is k
    }` : '';

  return `${PRELUDE}
${decls}
${helperSrc}

${opSrc}

float prim(vec3 p){ return ${prim.fn}(p); }

// ── the distance estimator ──────────────────────────────────────────────────────────────
// s accumulates the local linear expansion of the whole fold stack; the estimate is the
// primitive's distance in folded space divided back out by it.
float mapT(vec3 p, out vec4 trap){
  float s = 1.0;
  trap = vec4(1e9);
  for(int i = 0; i < ${cfg.iters}; i++){
${folds}
    trap = min(trap, vec4(abs(p), dot(p, p)));${contraction}
  }
  return prim(p) / s;
}

float map(vec3 p){ vec4 t; return mapT(p, t); }

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
    float d = map(p);
    if(d < uEps * t) return t;
    ${cfg.glow ? 'glowAcc += 1.0 / (1.0 + d * d * 340.0);' : ''}
    t += max(d * uStepScale, uEps * t);
    if(t > uMaxDist) break;
  }
  return -1.0;
}

vec3 background(vec3 rd){
  float up = rd.y * 0.5 + 0.5;
  return mix(uBgBot, uBgTop, up * up);
}

vec3 shadeSurface(vec3 p, vec3 n, vec3 rd, vec4 trap){
  float ct = clamp(sqrt(max(trap.w, 0.0)) * uTrapScale + uTrapShift, 0.0, 1.0);
  vec3 base = palette(ct);

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
    mapT(p, trap);

    vec3 c = shadeSurface(p, n, rd, trap);
    float fg = clamp(1.0 - exp(-uFog * t * t * 0.01), 0.0, 1.0);
    c = mix(c, background(rd), fg);
${cfg.bounces > 0 ? `
    // Schlick-weighted: grazing angles reflect hardest, which is what makes a folded plane
    // read as glass rather than as painted metal.
    float F = uReflect * mix(0.18, 1.0, pow(1.0 - max(dot(n, -rd), 0.0), 5.0)) * (1.0 - fg);
    if(b == ${cfg.bounces}){ accum += atten * c; break; }
    accum += atten * c * (1.0 - F);
    atten *= F;
    if(max(atten.r, max(atten.g, atten.b)) < 0.006) break;
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
