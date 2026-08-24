// Catoptron 3D — UI, state, camera, render loop.
//
// DESIGN CONSTRAINTS HONOURED HERE (they make presets / keyframes / audio cheap later):
//  1. All state lives in one flat, JSON-serialisable object of numbers, plus `stack`.
//  2. renderScene(w, h) is the single draw entry point — every export path will call it.
//  3. Every slider declares its real min/max in the DOM, so audio targets can be auto-derived.
//  4. BUILD is logged at init, so "am I looking at the new code?" is one glance at the console.

import { BUILD } from './engine/prelude.js';
import { OPS, discIdx, bankCount, defaults } from './engine/ops.js';
import { PRIMS, PRIM_STYLES, MARCH_STEPS, MAX_OPS, signature } from './engine/assemble.js';
import { createProgramCache } from './engine/glcache.js';
import { capture, apply as applyPreset, encode, decode, PRESET_VERSION } from './engine/preset.js';
import { renderMarkdown } from './engine/markdown.js';
import { parseFlame, resolveFlame, resolveXform, identityXform, MAX_XFORMS,
         FLAME_VARIATIONS, flameVars, VP_SLOTS, defaultVP } from './engine/flame.js';

console.log('%c[catoptron3d] build ' + BUILD, 'color:#8ab8ff');

/* ── palettes (cosine: a + b*cos(TAU*(c*t+d))) ─────────────────────────────────────────── */
const DARK  = [[.045, .055, .075], [.012, .014, .020]];
const DAY   = [[.58, .72, .92],     [.86, .90, .95]];
const CLAY  = [[.80, .86, .94],     [.94, .95, .96]];
const LIT   = [[.16, .24, .38],     [.04, .06, .10]];

const PALETTES = [
  { name: 'Mirror dimension', a: [.42, .44, .52], b: [.38, .36, .44], c: [1, 1, 1],    d: [.62, .70, .82], bg: DARK },
  { name: 'Sanctum gold',     a: [.48, .38, .26], b: [.44, .36, .22], c: [1, 1, .8],   d: [.10, .18, .32], bg: DARK },
  { name: 'Cold glass',       a: [.36, .44, .52], b: [.32, .38, .44], c: [1, 1, 1],    d: [.55, .60, .68], bg: DARK },
  { name: 'Ember',            a: [.50, .28, .20], b: [.46, .26, .18], c: [1, .9, .7],  d: [.02, .12, .22], bg: DARK },
  { name: 'Spectral',         a: [.50, .50, .50], b: [.50, .50, .50], c: [1, 1, 1],    d: [0, .33, .67],   bg: DARK },
  { name: 'Bone',             a: [.62, .60, .56], b: [.32, .32, .30], c: [1, 1, 1],    d: [.30, .32, .35], bg: DARK },
  { name: 'Clay white',       a: [.84, .84, .85], b: [.11, .11, .12], c: [1, 1, 1],    d: [.20, .24, .28], bg: CLAY },
  { name: 'Daylight city',    a: [.58, .59, .61], b: [.26, .25, .24], c: [1, 1, 1],    d: [.45, .48, .54], bg: DAY },
  { name: 'Glacier glass',    a: [.40, .50, .60], b: [.30, .34, .38], c: [1, 1, 1],    d: [.55, .60, .68], bg: LIT }
];

/* ── state — flat and serialisable ─────────────────────────────────────────────────────── */
const state = {
  // camera
  tgtX: 0, tgtY: 0, tgtZ: 0,
  camDist: 5.2, camAzim: 0.9, camElev: 0.35, fov: 1.3, autoSpin: 0.0,
  // structure
  prim: 0, primStyle: 0, primSize: 1.0, primRound: 0.06, primAux: 0.35, primThick: 0.03,
  iters: 8, ifsScale: 1.9, ifsRotX: 0, ifsRotY: 0, ifsRotZ: 0,
  ifsCx: 1.0, ifsCy: 1.0, ifsCz: 1.0,
  feedback: 0, bailout: 6.0, juliaCx: 0.0, juliaCy: 0.0, juliaCz: 0.0,
  // march
  steps: 128, stepScale: 0.85, maxDist: 40, eps: 0.0009,
  // light
  lightAzim: 55, lightElev: 42, ambient: 0.30, ao: 1.0, shadow: 0.0,
  spec: 0.55, rim: 0.9, fog: 0.35, reflect: 0.55, fresnel: 0.6, metal: 0.0, bounces: 0,
  transp: 0.0, ior: 1.48, absorb: 0.6, disp: 0.0,
  // colour
  seamSurf: 0,
  flame: null,
  seed: 1337,
  xShards: 9, xFacets: 6, xLen: 1.3, xRad: 0.045, xTip: 1.15, xSpread: 1.0, xVary: 0.85,
  cityStreet: 0.28, cityHeight: 0.9, cityVar: 0.7, cityDetail: 0.0,
  sun: 0.0, haze: 0.0,
  palette: 0, trapScale: 0.55, trapShift: 0.12, glow: 0.0, exposure: 1.25, sat: 1.0,
  // user image
  envAmt: 0.0, envGain: 1.0, envRot: 0.0, texAmt: 0.0, texScale: 0.35,
  // framing + export
  aspect: 0, exportSize: 1,
  // quality
  renderScale: 0.75,
  stack: []
};

// Pristine defaults, snapshotted before anything touches state. Presets store only what differs
// from this and reset to it on load, which is what makes loading deterministic.
const DEFAULT_STATE = JSON.parse(JSON.stringify(state));

/* ── control schema — drives the panel AND declares ranges ─────────────────────────────── */
const GROUPS = [
  ['Camera', [
    ['camDist',  'Distance',    1.2, 40,  0.05, 2],
    ['fov',      'FOV',         0.5, 3.0, 0.01, 2],
    ['autoSpin', 'Auto-spin',  -1.5, 1.5, 0.01, 2],
    ['tgtX',     'Target X',   -8, 8, 0.005, 3],
    ['tgtY',     'Target Y',   -8, 8, 0.005, 3],
    ['tgtZ',     'Target Z',   -8, 8, 0.005, 3]
  ]],
  ['IFS recursion', [
    ['iters',    'Iterations',  1, 24,   1,     0],
    ['ifsScale', 'Scale/pass',  0.3, 3.0, 0.005, 3],
    ['ifsRotX',  'Rot X\u00b0', -180, 180, 0.5, 1],
    ['ifsRotY',  'Rot Y\u00b0', -180, 180, 0.5, 1],
    ['ifsRotZ',  'Rot Z\u00b0', -180, 180, 0.5, 1],
    ['ifsCx',    'Fixed X',   -3, 3, 0.005, 3],
    ['ifsCy',    'Fixed Y',   -3, 3, 0.005, 3],
    ['ifsCz',    'Fixed Z',   -3, 3, 0.005, 3],
    ['bailout',  'Bailout',    1.5, 24, 0.1,  1],
    ['juliaCx',  'Julia C x', -2, 2, 0.005, 3],
    ['juliaCy',  'Julia C y', -2, 2, 0.005, 3],
    ['juliaCz',  'Julia C z', -2, 2, 0.005, 3]
  ]],
  ['Primitive', [
    ['primSize',  'Size',   0.05, 3,   0.01,  2],
    ['primRound', 'Round',  0.0,  0.6, 0.005, 3],
    ['primAux',   'Aux',    0.02, 1.5, 0.01,  2],
    ['primThick', 'Shell / frame thickness', 0.002, 0.4, 0.002, 3]
  ]],
  ['Lighting', [
    ['lightAzim', 'Light azim\u00b0', 0, 360, 1,    0],
    ['lightElev', 'Light elev\u00b0', -20, 90, 1,   0],
    ['ambient',   'Ambient',   0, 1,   0.005, 3],
    ['ao',        'AO',        0, 3,   0.01,  2],
    ['shadow',    'Shadows',   0, 1,   0.01,  2],
    ['spec',      'Specular',  0, 2,   0.01,  2],
    ['rim',       'Rim',       0, 3,   0.01,  2],
    ['fog',       'Fog',       0, 3,   0.01,  2]
  ]],
  ['Crystal', [
    ['seed',    'Seed',      1, 9999, 1,   0],
    ['xShards', 'Shards',    1, 14,  1,     0],
    ['xFacets', 'Facets',    3, 12,  1,     0],
    ['xLen',    'Length',    0.1, 4, 0.01,  2],
    ['xRad',    'Radius',    0.004, 0.4, 0.002, 3],
    ['xTip',    'Point length', 0, 1.45, 0.005, 3],
    ['xSpread', 'Spread',    0, 1,   0.01,  2],
    ['xVary',   'Variation', 0, 1,   0.01,  2]
  ]],
  ['City', [
    ['cityStreet', 'Street width',    0.02, 0.9, 0.005, 3],
    ['cityHeight', 'Building height', 0.05, 4,   0.01,  2],
    ['cityVar',    'Height variance', 0,    1,   0.01,  2],
    ['cityDetail', 'Facade detail',   0,    1,   0.01,  2]
  ]],
  ['Sky', [
    ['sun',  'Sun', 0, 2, 0.01, 2],
    ['haze', 'Haze', 0, 2, 0.01, 2]
  ]],
  ['Image', [
    ['envAmt',   'Environment',   0, 1,   0.01,  2],
    ['envGain',  'Env brightness',0, 3,   0.01,  2],
    ['envRot',   'Env rotate',    0, 1,   0.005, 3],
    ['texAmt',   'Surface texture', 0, 1, 0.01,  2],
    ['texScale', 'Texture scale', 0.02, 3, 0.01, 2]
  ]],
  ['Colour', [
    ['trapScale', 'Trap scale', 0, 3,   0.005, 3],
    ['trapShift', 'Trap shift', 0, 1,   0.005, 3],
    ['glow',      'Glow',       0, 2,   0.01,  2],
    ['exposure',  'Exposure',   0.2, 3, 0.01,  2],
    ['sat',       'Saturation', 0, 2,   0.01,  2]
  ]],
  ['Quality', [
    ['stepScale',   'Step scale',  0.15, 1.0, 0.01,  2],
    ['maxDist',     'Max distance', 4, 120, 0.5,  1],
    ['eps',         'Hit epsilon', 0.0002, 0.006, 0.0001, 4],
    ['renderScale', 'Resolution',  0.25, 1.5, 0.05, 2]
  ]]
];

/* Groups that belong on the STRUCTURE panel (right). Everything else is look and output, and
   stays on the left. The split is "what am I building" vs "how is it presented". */
const RIGHT_GROUPS = new Set(['Primitive', 'IFS recursion', 'City', 'Crystal']);

/* ── GL bootstrap ──────────────────────────────────────────────────────────────────────── */
const cv = document.getElementById('c');
const gl = cv.getContext('webgl2', { preserveDrawingBuffer: true, antialias: false });
if(!gl){
  document.body.innerHTML =
    '<p style="color:#8ab8ff;font:13px ui-monospace,monospace;padding:40px">' +
    'WebGL 2 required — Chrome, Firefox, or Safari 15+.</p>';
  throw new Error('no webgl2');
}

const vao = gl.createVertexArray();
gl.bindVertexArray(vao);
const buf = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, buf);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
gl.enableVertexAttribArray(0);
gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

const cache = createProgramCache(gl, { max: 24 });
let cur = null, curSig = '', wantSig = '', wantSince = 0;

const $ = id => document.getElementById(id);
const setStat = s => { const e = $('stat'); if(e) e.textContent = s; };

/* ── config derived from state (the only thing that can trigger a recompile) ───────────── */
function currentCfg(){
  return {
    stack:  state.stack.map(sl => ({ type: sl.type, p: sl.p.slice() })),
    prim:   state.prim,
    flameN: resolveFlame(state.flame).length,
    flameVars: flameVars(state.flame),
    // NOT a ternary: this is a three-way mode, and coercing it to 0/1 silently turned
    // `image box` into `nearest fixed point`. The exact rule never reached the shader.
    flameSelect: (state.flame && state.flame.select) | 0,
    primStyle: Math.round(state.primStyle),
    iters:  Math.round(state.iters),
    steps:  Math.round(state.steps),
    ao:     state.ao > 0.001,
    shadow: state.shadow > 0.001,
    glow:   state.glow > 0.001,
    seamSurf: state.seamSurf > 0.5,
    transp: state.transp > 0.005 && state.bounces > 0,
    disp:   state.transp > 0.005 && state.bounces > 0 && state.disp > 0.005,
    feedback: Math.round(state.feedback),
    env:      imgReady && state.envAmt > 0.001,
    tex:      imgReady && state.texAmt > 0.001,
    bounces: Math.round(state.bounces)
  };
}

function syncProgram(now){
  const cfg = currentCfg();
  const sig = signature(cfg);
  if(sig === curSig) return;
  if(cache.has(cfg)){
    const r = cache.request(cfg);
    if(r.ready){ cur = r.entry; curSig = sig; setStat('cached \u00b7 ' + cache.size() + ' programs'); return; }
  }
  if(wantSig !== sig){ wantSig = sig; wantSince = now; setStat('building\u2026'); }
  if(now - wantSince < 140) return;          // debounce: dragging past a threshold shouldn't
  const r = cache.request(cfg);              // kick off a build every frame
  if(r.error){
    console.error('[catoptron3d] shader build failed\n' + r.error);
    setStat('build failed \u2014 see console');
    curSig = sig;                            // don't retry in a loop
    return;
  }
  if(r.ready){
    cur = r.entry; curSig = sig;
    setStat('shader ' + Math.round(r.entry.ms) + ' ms \u00b7 ' +
            Math.round(r.entry.src.length / 1024) + ' KB' + (cache.parallel ? '' : ' \u00b7 sync'));
    $('boot')?.classList.add('done');
  }
}

/* ── uniform push ──────────────────────────────────────────────────────────────────────── */
const u1 = (L, n, v) => { if(L[n]) gl.uniform1f(L[n], v); };
const u2 = (L, n, a, b) => { if(L[n]) gl.uniform2f(L[n], a, b); };
const u3 = (L, n, a, b, c) => { if(L[n]) gl.uniform3f(L[n], a, b, c); };
const u4 = (L, n, a, b, c, d) => { if(L[n]) gl.uniform4f(L[n], a, b, c, d); };

function camPos(){
  // Orbit AROUND the target, not around the origin. Imported flames are rarely centred on the
  // origin — a Jerusalem cube occupies [0,1]^3 — so without this they sit off to one side and
  // orbiting swings them out of frame.
  const ce = Math.cos(state.camElev), se = Math.sin(state.camElev);
  return [state.tgtX + Math.cos(state.camAzim) * ce * state.camDist,
          state.tgtY + se * state.camDist,
          state.tgtZ + Math.sin(state.camAzim) * ce * state.camDist];
}

function renderScene(w, h){
  if(!cur || !cur.locs) return;
  const L = cur.locs;
  gl.useProgram(cur.prog);
  gl.bindVertexArray(vao);
  gl.viewport(0, 0, w, h);

  u2(L, 'uRes', w, h);
  u1(L, 'uTime', animTime);

  const cp = camPos();
  u3(L, 'uCamPos', cp[0], cp[1], cp[2]);
  u3(L, 'uCamTgt', state.tgtX, state.tgtY, state.tgtZ);
  u1(L, 'uFov', state.fov);

  u1(L, 'uMinDist', 0.001);
  u1(L, 'uMaxDist', state.maxDist);
  u1(L, 'uStepScale', state.stepScale);
  u1(L, 'uEps', state.eps);

  u3(L, 'uIfsCenter', state.ifsCx, state.ifsCy, state.ifsCz);
  u1(L, 'uIfsScale', state.ifsScale);
  u3(L, 'uIfsRot', state.ifsRotX, state.ifsRotY, state.ifsRotZ);
  u1(L, 'uBailout', state.bailout);
  u3(L, 'uJuliaC', state.juliaCx, state.juliaCy, state.juliaCz);

  u1(L, 'uPrimSize', state.primSize);
  u1(L, 'uPrimRound', state.primRound);
  u1(L, 'uPrimAux', state.primAux);
  u1(L, 'uPrimThick', state.primThick);

  const la = state.lightAzim * Math.PI / 180, le = state.lightElev * Math.PI / 180;
  u3(L, 'uLightDir', Math.cos(la) * Math.cos(le), Math.sin(le), Math.sin(la) * Math.cos(le));
  u1(L, 'uAmbient', state.ambient);
  u1(L, 'uAoStr', state.ao);
  u1(L, 'uSpec', state.spec);
  u1(L, 'uReflect', state.reflect);
  u1(L, 'uFresnel', state.fresnel);
  u1(L, 'uMetal', state.metal);
  u1(L, 'uTransp', state.transp);
  u1(L, 'uIOR', state.ior);
  u1(L, 'uAbsorb', state.absorb);
  u1(L, 'uDisp', state.disp);
  u1(L, 'uRim', state.rim);
  u1(L, 'uFog', state.fog);

  const P = PALETTES[state.palette] || PALETTES[0];
  u3(L, 'uPal0', P.a[0], P.a[1], P.a[2]);
  u3(L, 'uPal1', P.b[0], P.b[1], P.b[2]);
  u3(L, 'uPal2', P.c[0], P.c[1], P.c[2]);
  u3(L, 'uPal3', P.d[0], P.d[1], P.d[2]);
  const bg = P.bg || DARK;
  u3(L, 'uBgTop', bg[0][0], bg[0][1], bg[0][2]);
  u3(L, 'uBgBot', bg[1][0], bg[1][1], bg[1][2]);
  // Uniform ARRAYS are uploaded whole, at the [0] location.
  //
  // WebGL enumerates an array as a single active uniform named "uFlameMi[0]" — the other
  // indices are simply not in the list. Looking up "uFlameMi[1]" in the cached location map
  // silently returns nothing, so a per-index loop would have uploaded transform 1 and quietly
  // dropped the rest. Passing a longer array to the [0] location fills consecutive elements.
  // Uniform ARRAYS are uploaded whole, at the [0] location, and at exactly their ACTIVE length.
  //
  // Two traps here, both silent. WebGL enumerates an array as a single active uniform named
  // "uFlameMi[0]" — the other indices are not in the list at all, so a per-index location lookup
  // would upload transform 1 and quietly drop the rest. And the driver trims each array
  // INDEPENDENTLY to the highest index that array is actually indexed with, so uFlameFp can come
  // back shorter than uFlameMi; uploading more than that is an error, not a harmless overrun.
  const fm = resolveFlame(state.flame);
  if(fm.length){
    const sizes = cur.sizes || {};
    const put = (nm, per, pick, setter) => {
      const loc = L[nm + '[0]'];
      if(!loc) return;
      const n = sizes[nm + '[0]'] || fm.length;
      const buf = new Float32Array(n * per);
      for(let i = 0; i < Math.min(n, fm.length); i++) buf.set(pick(fm[i]), i * per);
      setter(loc, buf);
    };
    put('uFlameMi', 9, m => {
      const I = m.Mi;                                  // row-major -> column-major
      return [I[0], I[3], I[6], I[1], I[4], I[7], I[2], I[5], I[8]];
    }, (loc, b) => gl.uniformMatrix3fv(loc, false, b));
    put('uFlameTi', 3, m => m.Ti, (loc, b) => gl.uniform3fv(loc, b));
    put('uFlameFp', 3, m => m.fp, (loc, b) => gl.uniform3fv(loc, b));
    put('uFlameEx', 1, m => [m.expand], (loc, b) => gl.uniform1fv(loc, b));
    put('uFlameVAmt', 1, m => [m.vamt], (loc, b) => gl.uniform1fv(loc, b));
    // 12 parameter slots per xform, across three vec4 arrays
    put('uFlameVP', 4, m => m.vp.slice(0, 4),  (loc, b) => gl.uniform4fv(loc, b));
    put('uFlameVQ', 4, m => m.vp.slice(4, 8),  (loc, b) => gl.uniform4fv(loc, b));
    put('uFlameVR', 4, m => m.vp.slice(8, 12), (loc, b) => gl.uniform4fv(loc, b));
    put('uFlameBLo', 3, m => m.blo || [0, 0, 0], (loc, b) => gl.uniform3fv(loc, b));
    put('uFlameBHi', 3, m => m.bhi || [0, 0, 0], (loc, b) => gl.uniform3fv(loc, b));
    const hull = fm.hull || { lo: [-1, -1, -1], hi: [1, 1, 1] };
    u3(L, 'uHullLo', hull.lo[0], hull.lo[1], hull.lo[2]);
    u3(L, 'uHullHi', hull.hi[0], hull.hi[1], hull.hi[2]);
  }
  u1(L, 'uSeed', state.seed);
  u1(L, 'uXShards', state.xShards);
  u1(L, 'uXFacets', state.xFacets);
  u1(L, 'uXLen', state.xLen);
  u1(L, 'uXRad', state.xRad);
  u1(L, 'uXTip', state.xTip);
  u1(L, 'uXSpread', state.xSpread);
  u1(L, 'uXVary', state.xVary);
  u1(L, 'uCityStreet', state.cityStreet);
  u1(L, 'uCityHeight', state.cityHeight);
  u1(L, 'uCityVar', state.cityVar);
  u1(L, 'uCityDetail', state.cityDetail);
  u1(L, 'uSun', state.sun);
  u1(L, 'uEnvAmt', state.envAmt);
  u1(L, 'uEnvGain', state.envGain);
  u1(L, 'uEnvRot', state.envRot);
  u1(L, 'uTexAmt', state.texAmt);
  u1(L, 'uTexScale', state.texScale);
  if(L['uImg'] && imgTex){
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, imgTex);
    gl.uniform1i(L['uImg'], 0);
  }
  u1(L, 'uHaze', state.haze);
  u1(L, 'uTrapScale', state.trapScale);
  u1(L, 'uTrapShift', state.trapShift);
  u1(L, 'uGlow', state.glow);
  u1(L, 'uExposure', state.exposure);
  u1(L, 'uSat', state.sat);

  state.stack.forEach((sl, i) => {
    const op = OPS[sl.type];
    for(let b = 0; b < bankCount(op); b++){
      u4(L, `uP${i}_${b}`,
        sl.p[b * 4 + 0] ?? 0, sl.p[b * 4 + 1] ?? 0,
        sl.p[b * 4 + 2] ?? 0, sl.p[b * 4 + 3] ?? 0);
    }
    u3(L, `uO${i}`, sl.o[0], sl.o[1], sl.o[2]);
    u3(L, `uR${i}`, sl.r[0], sl.r[1], sl.r[2]);
  });

  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}


/* ── starters ──────────────────────────────────────────────────────────────────────────────
   Mirror folds are isometries, so they want IFS contraction at 1.0 — iterating then reaches
   further out through the tiling instead of shrinking. The fractal default of 1.9 collapses
   them, which makes mirror mode nearly undiscoverable without these.                        */
const STARTERS = {
  // The boot state. Listed FIRST and used by both startup and New, so the thing the app opens
  // with is always reachable again — it used to be hand-built at boot and existed nowhere in
  // this table, which meant loading any other starter lost it for good.
  'Folded frames': {
    stack: [{ t: 8, p: [0.42] }, { t: 5, p: [1.0] }],
    set: { iters: 8, ifsScale: 1.9, ifsCx: 1, ifsCy: 1, ifsCz: 1,
           prim: 0, primStyle: 0, primSize: 1.0, primRound: 0.06,
           steps: 128, stepScale: 0.85, eps: 0.0009, maxDist: 40,
           bounces: 0, reflect: 0.55, fresnel: 0.6, metal: 0,
           ao: 1.0, shadow: 0, fog: 0.35, haze: 0, sun: 0,
           ambient: 0.30, spec: 0.55, rim: 0.9,
           tgtX: 0, tgtY: 0, tgtZ: 0,
  camDist: 5.2, fov: 1.3, camAzim: 0.9, camElev: 0.35,
           palette: 0, trapScale: 0.55, trapShift: 0.12, glow: 0,
           sat: 1.0, exposure: 1.25, renderScale: 0.75 }
  },
  'Mirror room': {
    stack: [{ t: 13, p: [2, 2, 2] }, { t: 14, p: [0.9, 0.9, 0.9] }],
    set: { iters: 2, ifsScale: 1.0, prim: 0, primSize: 0.62, primRound: 0.05, steps: 192,
           bounces: 2, reflect: 0.62, ao: 0.8, fog: 0.18, camDist: 3.4, fov: 1.5,
           camAzim: 0.9, camElev: 0.35, palette: 2, trapScale: 0.5, exposure: 1.35 }
  },
  'Kaleidoscope tube': {
    stack: [{ t: 4, p: [6, 0, 2] }, { t: 12, p: [2, 1.5, 0] }, { t: 0, p: [0.95, 0, 0] }],
    set: { iters: 2, ifsScale: 1.0, prim: 4, primSize: 0.42, primRound: 0.10, primAux: 0.13,
           steps: 192, bounces: 2, reflect: 0.55, ao: 0.9, fog: 0.16, camDist: 2.6, fov: 1.7,
           camAzim: 1.5708, camElev: 0.02, palette: 1, trapScale: 0.8, exposure: 1.35 }
  },
  'Hex mirror hall': {
    stack: [{ t: 16, p: [0, 1.1, 1] }, { t: 12, p: [1, 1.8, 0] }],
    set: { iters: 3, ifsScale: 1.0, prim: 0, primSize: 0.45, primRound: 0.05, steps: 256,
           bounces: 2, reflect: 0.72, ao: 0.7, fog: 0.16, camDist: 2.4, fov: 1.6,
           camAzim: 0.9, camElev: 0.02, palette: 0, trapScale: 0.55, exposure: 1.45 }
  },
  'Mirror shells': {
    stack: [{ t: 15, p: [2.0, 0.0] }, { t: 13, p: [2.6, 2.6, 2.6] }],
    set: { iters: 2, ifsScale: 1.0, prim: 0, primSize: 0.9, primRound: 0.05, steps: 256,
           bounces: 2, reflect: 0.6, ao: 0.9, fog: 0.18, camDist: 6.0, fov: 1.2,
           camAzim: 0.9, camElev: 0.24, palette: 3, trapScale: 0.55, exposure: 1.35 }
  },
  'Folded city': {
    stack: [{ t: 17, p: [90, -90, 0] }],
    set: { iters: 1, ifsScale: 1.0, prim: 5, primSize: 0.42, primRound: 0.03, steps: 192,
           bounces: 0, reflect: 0.0, ao: 1.0, fog: 0.055, haze: 0.45, sun: 1.0,
           cityStreet: 0.34, cityHeight: 2.6, cityVar: 0.9, cityDetail: 0.0,
           camDist: 27, fov: 1.15, camAzim: -1.5708, camElev: 0.26,
           ambient: 0.42, spec: 0.2, rim: 0.3, palette: 7, trapScale: 0.4, trapShift: 0.25,
           sat: 0.8, exposure: 1.12, renderScale: 0.6 }
  },
  'Wire city': {
    stack: [{ t: 17, p: [90, -90, 0] }],
    set: { iters: 1, ifsScale: 1.0, prim: 5, primStyle: 2, primThick: 0.022,
           primSize: 0.42, steps: 256, bounces: 0, reflect: 0,
           ao: 1.0, fog: 0.05, haze: 0.35, sun: 1.0,
           cityStreet: 0.34, cityHeight: 2.6, cityVar: 0.9, cityDetail: 0.0,
           camDist: 24, fov: 1.15, camAzim: -1.5708, camElev: 0.24,
           ambient: 0.42, spec: 0.25, rim: 0.35, palette: 6, trapScale: 0.4, trapShift: 0.25,
           sat: 0.8, exposure: 1.15, renderScale: 0.6 }
  },
  'Clay corner': {
    stack: [{ t: 17, p: [90, -90, 0] }, { t: 17, p: [0, -90, 2] }],
    set: { iters: 1, ifsScale: 1.0, prim: 5, primSize: 0.42, primRound: 0.03, steps: 192,
           bounces: 0, reflect: 0.0, ao: 1.0, fog: 0.055, haze: 0.35, sun: 1.0,
           cityStreet: 0.34, cityHeight: 2.4, cityVar: 0.9, cityDetail: 0.0,
           camDist: 26, fov: 1.25, camAzim: -2.356, camElev: 0.35,
           ambient: 0.42, spec: 0.2, rim: 0.3, palette: 6, trapScale: 0.4, trapShift: 0.25,
           sat: 0.8, exposure: 1.12, renderScale: 0.6 }
  },
  'City vortex': {
    stack: [{ t: 18, p: [0.55, 1] }],
    set: { iters: 2, ifsScale: 1.0, prim: 5, primSize: 0.6, primRound: 0.03, steps: 192,
           bounces: 0, reflect: 0.0, ao: 1.0, fog: 0.09, haze: 0.4, sun: 1.0,
           cityStreet: 0.34, cityHeight: 1.4, cityVar: 0.9, cityDetail: 0.0,
           camDist: 20, fov: 1.25, camAzim: -1.5708, camElev: 0.78,
           ambient: 0.42, spec: 0.2, rim: 0.3, palette: 7, trapScale: 0.4, trapShift: 0.25,
           sat: 0.8, exposure: 1.12, renderScale: 0.6 }
  },
  'Crystal cluster': {
    stack: [{ t: 8, p: [0.0] }],
    set: { iters: 3, ifsScale: 0.8, ifsCx: 0, ifsCy: 0, ifsCz: 0, prim: 6, primStyle: 0,
           steps: 256, stepScale: 0.85, eps: 0.00035, seed: 1337,
           xShards: 10, xFacets: 6, xLen: 1.0, xRad: 0.035, xTip: 1.25, xSpread: 0.75, xVary: 0.85,
           bounces: 1, reflect: 0.6, fresnel: 0.9, metal: 0,
           ao: 1.1, fog: 0.08, haze: 0, sun: 0, ambient: 0.14, spec: 1.3, rim: 1.8,
           camDist: 2.8, fov: 1.2, camAzim: 0.9, camElev: 0.20,
           palette: 2, trapScale: 0.9, trapShift: 0.10, sat: 1.0, exposure: 1.6,
           renderScale: 0.7 }
  },
  'Crystal glass': {
    stack: [{ t: 8, p: [0.0] }],
    set: { iters: 3, ifsScale: 0.8, ifsCx: 0, ifsCy: 0, ifsCz: 0, prim: 6, primStyle: 0,
           steps: 256, stepScale: 0.85, eps: 0.00035, seed: 1337,
           xShards: 10, xFacets: 6, xLen: 1.0, xRad: 0.035, xTip: 1.25, xSpread: 0.75, xVary: 0.85,
           bounces: 4, reflect: 0.55, fresnel: 0.9, metal: 0,
           transp: 0.95, ior: 1.48, absorb: 1.2, disp: 0.0,
           ao: 1.0, fog: 0.05, haze: 0, sun: 0, ambient: 0.16, spec: 1.4, rim: 1.6,
           glow: 1.4, camDist: 2.8, fov: 1.2, camAzim: 0.9, camElev: 0.20,
           palette: 8, trapScale: 0.9, trapShift: 0.10, sat: 1.0, exposure: 1.6,
           renderScale: 0.55 }
  },
  'Crystal field': {
    stack: [{ t: 11, p: [2.6, 2.6, 2.6] }],
    set: { iters: 1, ifsScale: 1.0, prim: 6, primStyle: 0,
           steps: 256, stepScale: 0.85, eps: 0.00035, seed: 1337,
           xShards: 12, xFacets: 6, xLen: 1.1, xRad: 0.030, xTip: 1.25, xSpread: 1.0, xVary: 0.85,
           bounces: 1, reflect: 0.6, fresnel: 0.9, metal: 0,
           ao: 1.1, fog: 0.08, haze: 0, sun: 0, ambient: 0.14, spec: 1.3, rim: 1.8,
           camDist: 5.5, fov: 1.2, camAzim: 0.9, camElev: 0.14,
           palette: 2, trapScale: 0.9, trapShift: 0.10, sat: 1.0, exposure: 1.6,
           renderScale: 0.6 }
  },
  'Crystal lattice': {
    stack: [{ t: 19, p: [7, 1.2] }],
    set: { iters: 1, ifsScale: 1.0, prim: 4, primSize: 0.24, primRound: 0.04, primAux: 0.075,
           steps: 256, bounces: 0, reflect: 0.0, ao: 1.0, fog: 0.10, haze: 0, sun: 0,
           camDist: 13, fov: 0.95, camAzim: 0.85, camElev: 0.55,
           ambient: 0.32, spec: 0.5, rim: 0.6, palette: 5, trapScale: 0.6, trapShift: 0.15,
           sat: 1.0, exposure: 1.3, renderScale: 0.7 }
  },
  'Icosahedral': {
    stack: [{ t: 20, p: [2, 0.0] }, { t: 0, p: [0.0, 0.0, -1.0] }],
    set: { iters: 3, ifsScale: 1.0, prim: 2, primSize: 0.30, primRound: 0.05, steps: 256,
           bounces: 1, reflect: 0.55, fresnel: 0.45, metal: 0, ao: 1.0, fog: 0.15,
           haze: 0, sun: 0, camDist: 3.4, fov: 1.3, camAzim: 0.9, camElev: 0.28,
           ambient: 0.32, spec: 0.5, rim: 0.6, palette: 2, trapScale: 0.7, trapShift: 0.15,
           sat: 1.0, exposure: 1.3, renderScale: 0.7 }
  },
  'Hyperbolic': {
    stack: [{ t: 21, p: [2, 1.35] }, { t: 0, p: [0.0, 0.0, -0.8] }],
    set: { iters: 2, ifsScale: 1.0, prim: 2, primSize: 0.22, primRound: 0.05, steps: 256,
           bounces: 1, reflect: 0.55, fresnel: 0.45, metal: 0, ao: 1.0, fog: 0.15,
           haze: 0, sun: 0, camDist: 2.8, fov: 1.3, camAzim: 0.9, camElev: 0.26,
           ambient: 0.32, spec: 0.5, rim: 0.6, palette: 2, trapScale: 0.7, trapShift: 0.15,
           sat: 1.0, exposure: 1.3, renderScale: 0.7 }
  },
  'Mandelbox': {
    stack: [{ t: 5, p: [1.0] }, { t: 6, p: [0.5, 1.0] }],
    set: { iters: 12, ifsScale: 2.0, ifsCx: 0, ifsCy: 0, ifsCz: 0, feedback: 1, bailout: 20,
           prim: 2, primSize: 0.0, steps: 768, stepScale: 0.85, eps: 0.00006, maxDist: 120,
           bounces: 0, reflect: 0, ao: 1.0, fog: 0.02,
           camDist: 22, fov: 1.1, camAzim: 0.9, camElev: 0.28,
           ambient: 0.30, spec: 0.5, rim: 0.5, palette: 4, trapScale: 0.10, trapShift: 0.15,
           exposure: 1.3, renderScale: 0.55 }
  },
  'Mandelbulb': {
    stack: [{ t: 25, p: [8] }],
    set: { iters: 10, ifsScale: 1.0, ifsCx: 0, ifsCy: 0, ifsCz: 0, feedback: 1, bailout: 4,
           prim: 2, primSize: 0.0, steps: 512, stepScale: 0.85, eps: 0.00018, maxDist: 40,
           bounces: 0, reflect: 0, ao: 1.0, fog: 0.10,
           camDist: 2.5, fov: 1.2, camAzim: 0.9, camElev: 0.30,
           ambient: 0.30, spec: 0.5, rim: 0.5, palette: 5, trapScale: 1.1, trapShift: 0.15,
           exposure: 1.3, renderScale: 0.6 }
  },
  'Menger sponge': {
    stack: [{ t: 24, p: [3, 2] }],
    set: { iters: 4, ifsScale: 1.0, ifsCx: 0, ifsCy: 0, ifsCz: 0, feedback: 0,
           prim: 1, primSize: 1.0, primRound: 0.02, steps: 256, stepScale: 0.85,
           eps: 0.0005, maxDist: 40, bounces: 0, reflect: 0, ao: 1.0, fog: 0.10,
           camDist: 4.2, fov: 1.2, camAzim: 0.9, camElev: 0.30,
           ambient: 0.30, spec: 0.5, rim: 0.5, palette: 5, trapScale: 0.4, trapShift: 0.15,
           exposure: 1.3, renderScale: 0.7 }
  }
};

const STARTER_RESET = { tgtX: 0, tgtY: 0, tgtZ: 0, primStyle: 0, primThick: 0.03, seed: 1337,
                        transp: 0, ior: 1.48, absorb: 0.6, disp: 0,
                        xShards: 9, xFacets: 6, xLen: 1.3, xRad: 0.045, xTip: 1.15,
                        xSpread: 1.0, xVary: 0.85, feedback: 0, bailout: 6.0, stepScale: 0.85, eps: 0.0009, maxDist: 40,
                        primRound: 0.06, primAux: 0.35, juliaCx: 0, juliaCy: 0, juliaCz: 0, seamSurf: 0, fresnel: 0.6, metal: 0.0, sun: 0, haze: 0, cityDetail: 0, ambient: 0.30, spec: 0.55,
                        rim: 0.9, sat: 1.0, renderScale: 0.75, trapShift: 0.12 };

function applyStarter(name){
  const st = STARTERS[name];
  if(!st) return;
  Object.assign(state, STARTER_RESET);
  state.stack = st.stack.map(e => {
    const sl = newSlot(e.t);
    e.p.forEach((v, i) => { sl.p[i] = v; });
    return sl;
  });
  Object.assign(state, st.set);
  renderStack();
  rebuildGlobals();
  const nb = $('presetName');
  if(nb && !nb.value) nb.value = name;
  pushHistory();
  setStat('loaded \u201c' + name + '\u201d');
}




/* ── flame import ──────────────────────────────────────────────────────────────────────────
   A JWildfire .flame renders by chaos game, which a distance estimator cannot do. What it can
   do is run a contractive affine IFS BACKWARDS. So the LINEAR subset imports exactly and
   anything carrying a nonlinear variation is reported and skipped rather than approximated.  */

// Flames that ship with the app. They live as real .flame files in examples/ so they double as
// import test material; the panel just fetches them.
// Each entry may carry the view settings that make it look right on load. Without them an
// import lands on generic defaults and a perfectly good flame can render as a speck.
const EXAMPLE_FLAMES = [
  ['Flame IFS base', 'examples/flame-ifs-base.flame', {
    iters: 10, bounces: 0, reflect: 0.55, ao: 1.0, fog: 0.35,
    camAzim: -1.434, camElev: -0.565, fov: 1.3,
    palette: 0, trapScale: 0.55, trapShift: 0.12, exposure: 1.25, renderScale: 0.7
  }],
  ['Jerusalem cube (20 xforms)', 'examples/jerusalem-cube.flame', {
    iters: 7, bounces: 1, reflect: 0.35, ao: 1.0, fog: 0.05,
    ambient: 0.30, spec: 0.6, rim: 0.7,
    camAzim: 0.78, camElev: 0.42, palette: 5, exposure: 1.3, renderScale: 0.6
  }],
  ['Sierpinski tetrahedron', 'examples/sierpinski-tetrahedron.flame', {
    iters: 9, camAzim: 0.9, camElev: 0.28, bounces: 1, reflect: 0.3, renderScale: 0.65
  }],
  ['Square corners (linear3D)', 'examples/square-corners-linear3d.flame', {
    iters: 9, camAzim: 0.9, camElev: 0.9, bounces: 1, reflect: 0.3, renderScale: 0.65
  }]
];

// Opening the Flame tab with nothing loaded shows an empty editor, which reads as broken. So
// the first visit loads the default example — ONCE per session, tracked by a flag rather than
// by "is there a flame", so that deliberately clearing it and coming back leaves it cleared.
let flameAutoTried = false;

function autoLoadFlame(){
  if(flameAutoTried || state.flame) return;
  flameAutoTried = true;
  const e = EXAMPLE_FLAMES[0];
  loadExampleFlame(e[1], e[0], e[2]);
}

async function loadExampleFlame(path, label, settings){
  try {
    const r = await fetch('./' + path, { cache: 'no-cache' });
    if(!r.ok) throw new Error('HTTP ' + r.status);
    loadFlameText(await r.text(), label, settings);
  } catch(e){
    console.error(e);
    setStat('could not load example (' + e.message + ') \u2014 serve the folder over http');
  }
}

// The picker lists the exact rule first because it is the right default; the stored ids keep
// their original meaning so old presets still mean what they meant.
const SEL_UI = [2, 0, 1];

function refreshFlameLabel(){
  const e = $('flameName');
  if(!e) return;
  const n = resolveFlame(state.flame).length;
  const w = (state.flame && state.flame.warnings) ? state.flame.warnings.length : 0;
  e.textContent = state.flame
    ? state.flame.name + ' \u00b7 ' + n + ' active of ' + state.flame.maps.length +
      (w ? '  \u26a0 ' + w + ' warning' + (w > 1 ? 's' : '') + ' (console)' : '')
    : 'no flame \u2014 import one, or add a transform to build by hand';
  e.style.color = w ? 'var(--warn1)' : '';
}

/* ── flame transform editor ────────────────────────────────────────────────────────────────
   One card per xform. Each keeps its IMPORTED affine untouched and layers scale / rotate /
   translate on top, so "reset edits" restores the file exactly and a preset records the edits
   rather than a flattened matrix. The matrices are uniforms, so none of these sliders rebuild
   the shader — only adding, removing or disabling a transform does, because the COUNT is
   compiled in.                                                                              */
function renderXforms(){
  const host = $('xforms');
  if(!host) return;
  host.innerHTML = '';
  const fl = state.flame;
  if(!fl || !fl.maps.length){
    host.innerHTML = '<p class="empty">No transforms. Import a .flame, or press ' +
                     '<b>+ transform</b> to start from a plain 0.5 contraction.</p>';
    return;
  }

  fl.maps.forEach((x, i) => {
    const r = resolveXform(x);
    const card = document.createElement('div');
    card.className = 'xf' + (x.on === false ? ' off' : '');

    const head = document.createElement('div');
    head.className = 'xfhead';
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = 'T' + (i + 1);
    const sc = document.createElement('span');
    sc.className = 'sc';
    // a map at or above 1.0 cannot converge; say so rather than let it render as noise
    sc.textContent = r ? (r.scale < 0.999 ? '\u00d7' + r.scale.toFixed(3)
                                          : '\u00d7' + r.scale.toFixed(3) + ' not contractive')
                       : 'singular';
    if(r && r.scale >= 0.999) sc.style.color = 'var(--warn1)';
    head.append(nm, sc);
    head.append(
      mkBtn(x.on === false ? '\u25cb' : '\u25c9', () => {
        x.on = x.on === false; renderXforms(); refreshFlameLabel(); pushHistory();
      }),
      mkBtn('\u29c9', () => {
        if(fl.maps.length >= MAX_XFORMS){ setStat('8 transforms is the limit'); return; }
        fl.maps.splice(i + 1, 0, JSON.parse(JSON.stringify(x)));
        renderXforms(); refreshFlameLabel(); pushHistory();
      }),
      mkBtn('\u00d7', () => {
        fl.maps.splice(i, 1);
        if(!fl.maps.length) state.flame = null;
        renderXforms(); refreshFlameLabel(); pushHistory();
      })
    );
    card.append(head);

    // Variation selector — the flame-editor move: swap linear3D for spherical on one xform.
    // Marked baked because the variation TYPE compiles in (each emits different inverse code);
    // its amount and parameter are uniforms and stay live.
    card.append(mkSelect('Variation', FLAME_VARIATIONS.map(v => v.name), x.vari,
                         v => { x.vari = v; renderXforms(); pushHistory(); }, true));
    card.append(mkSlider('Var amount', -3, 3, 0.005, x.vamt,
                         v => { x.vamt = v; touchXform(); }, 3));
    // only the selected variation's own parameters are shown; slots are fixed, so a value set
    // for one variation is still there if you switch back
    const spec = FLAME_VARIATIONS[x.vari];
    (spec ? spec.params : []).forEach(([slot, label, mn, mx, st]) => {
      card.append(mkSlider(label, mn, mx, st, x.vp[slot],
                           v => { x.vp[slot] = v; touchXform(); }, 3));
    });
    card.append(mkSlider('Scale', 0.05, 2, 0.005, x.scale, v => { x.scale = v; touchXform(); }, 3));
    ['X', 'Y', 'Z'].forEach((ax, k) => card.append(
      mkSlider('Rotate ' + ax + '\u00b0', -180, 180, 0.5, x.rot[k],
               v => { x.rot[k] = v; touchXform(); }, 1)));
    ['X', 'Y', 'Z'].forEach((ax, k) => card.append(
      mkSlider('Move ' + ax, -2, 2, 0.005, x.tr[k],
               v => { x.tr[k] = v; touchXform(); }, 3)));
    host.append(card);
  });
}

// A slider edit changes uniforms only; just refresh the contraction readouts.
function touchXform(){
  const fl = state.flame;
  if(!fl) return;
  document.querySelectorAll('#xforms .xf .sc').forEach((el, i) => {
    const r = resolveXform(fl.maps[i]);
    if(!r){ el.textContent = 'singular'; return; }
    el.textContent = '\u00d7' + r.scale.toFixed(3) + (r.scale < 0.999 ? '' : ' not contractive');
    el.style.color = r.scale < 0.999 ? '' : 'var(--warn1)';
  });
}

function addXform(){
  if(!state.flame) state.flame = { name: 'hand-built', maps: [] };
  if(state.flame.maps.length >= MAX_XFORMS){ setStat('8 transforms is the limit'); return; }
  state.flame.maps.push(identityXform());
  ensureFlameOp();
  renderXforms(); rebuildGlobals(); refreshFlameLabel(); pushHistory();
}

function resetXformEdits(){
  if(!state.flame) return;
  state.flame.maps.forEach(x => { x.scale = 1; x.rot = [0, 0, 0]; x.tr = [0, 0, 0]; x.on = true; });
  renderXforms(); refreshFlameLabel(); pushHistory();
  setStat('edits reset to the imported flame');
}

// A flame with no Flame IFS fold in the stack renders nothing, which reads as a broken import.
// Every import gets a viewable setup, not just the first. This used to return early once any
// Flame IFS op existed, so loading a second flame kept the previous primitive, iteration count
// and epsilon — the new attractor rendered through the old settings and looked broken.
// Aim the orbit camera at the imported attractor and back off far enough to see all of it.
// Imported flames are rarely centred on the origin, and without this the object sits off frame.
function frameFlame(){
  const fm = resolveFlame(state.flame);
  if(!fm.length || !fm.hull) return;
  const { lo, hi } = fm.hull;
  state.tgtX = (lo[0] + hi[0]) * 0.5;
  state.tgtY = (lo[1] + hi[1]) * 0.5;
  state.tgtZ = (lo[2] + hi[2]) * 0.5;
  const r = 0.5 * Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  state.camDist = Math.max(1.2, r / Math.max(0.2, Math.tan(state.fov * 0.5)) * 1.15);
}

function ensureFlameOp(){
  if(!state.stack.some(sl => OPS[sl.type].name === 'Flame IFS')){
    state.stack = [newSlot(OPS.findIndex(o => o.name === 'Flame IFS'))];
  }
  state.iters = 8;
  state.ifsScale = 1.0;
  state.ifsCx = 0; state.ifsCy = 0; state.ifsCz = 0;
  state.prim = PRIMS.findIndex(p => p.name === 'Flame hull');
  state.primStyle = 0;
  state.eps = 0.0004;
  state.steps = 384;
  state.stepScale = 0.85;
  renderStack();
}

function loadFlameText(text, label, settings){
  try {
    const f = parseFlame(text);
    flameAutoTried = true;
    state.flame = f;
    if(f.select === undefined) f.select = 2;   // exact selection by default on import
    ensureFlameOp();
    frameFlame();                              // point the camera at the attractor's own centre
    if(settings) Object.assign(state, settings);
    renderXforms(); rebuildGlobals(); refreshFlameLabel(); pushHistory();
    if(f.warnings.length){
      console.warn('[catoptron3d] flame import:\n  ' + f.warnings.join('\n  '));
      setStat(f.maps.length + ' maps \u00b7 ' + f.warnings.length + ' skipped \u2014 see console');
    } else {
      setStat('imported ' + label + ' \u00b7 ' + f.maps.length + ' transforms');
    }
    showTab('flame');
  } catch(e){
    console.error(e);
    setStat('flame import failed: ' + e.message);
  }
}

function clearFlame(){
  flameAutoTried = true;
  state.flame = null;
  state.stack = state.stack.filter(sl => OPS[sl.type].name !== 'Flame IFS');
  renderStack(); renderXforms(); rebuildGlobals(); refreshFlameLabel(); pushHistory();
  setStat('flame cleared');
}

function showTab(which){
  const fold = which === 'fold';
  $('paneFold').style.display  = fold ? '' : 'none';
  $('paneFlame').style.display = fold ? 'none' : '';
  $('tabFold').classList.toggle('on', fold);
  $('tabFlame').classList.toggle('on', !fold);
}


/* ── quick render ──────────────────────────────────────────────────────────────────────────
   The viewport is deliberately undersampled — Resolution defaults below 1, and it drops further
   while you are dragging — so the live image is softer and noisier than a save will be. This
   renders ONE frame at the exact dimensions the exporter would use and holds it on screen, so
   what you are looking at is the saved image, just scaled to fit.

   It is the export path minus the encode, which is the point: if the preview looks right the
   file will too, because the same call produced both. */
let previewHold = false;

function quickRender(){
  if(!cur){ setStat('shader still building\u2026'); return; }
  const [sw, sh] = exportDims();
  const pw = cv.width, ph = cv.height;

  cv.width = sw; cv.height = sh;
  if(cv.width !== sw || cv.height !== sh){
    cv.width = pw; cv.height = ph; W = 0; H = 0;
    setStat('that size was refused by the browser');
    return;
  }
  renderScene(cv.width, cv.height);
  if(gl.isContextLost()){
    setStat('context lost \u2014 reload and try a smaller window');
    return;
  }
  previewHold = true;
  $('quickBtn').classList.add('on');
  setStat('preview ' + sw + '\u00d7' + sh + ' \u2014 this is the save. Any change resumes live.');
}

// Anything that changes the image drops the hold, so the preview can never go quietly stale.
function releasePreview(){
  if(!previewHold) return;
  previewHold = false;
  W = 0; H = 0;                       // force the loop to resize and redraw
  $('quickBtn').classList.remove('on');
}

/* ── top bar ───────────────────────────────────────────────────────────────────────────────
   New / pause / undo / redo / panels / fullscreen / help / theme, mirroring the 2D tool.      */

let paused = false;
let panelsHidden = false;

/* undo / redo.
   History entries are captured presets, which is the same pure snapshot the preset system
   already produces — so undo cannot drift from what a save would record. One entry per GESTURE
   rather than per frame: sliders push on `change` (pointer released), not on `input`. */
let hist = [], histAt = -1;
let histLast = '';

function pushHistory(){
  const snap = JSON.stringify(capture(state, DEFAULT_STATE, OPS));
  if(snap === histLast) return;
  histLast = snap;
  hist = hist.slice(0, histAt + 1);
  hist.push(snap);
  if(hist.length > 80) hist.shift();
  histAt = hist.length - 1;
  syncHistButtons();
}

function stepHistory(dir){
  const n = histAt + dir;
  if(n < 0 || n >= hist.length) return;
  histAt = n;
  histLast = hist[n];
  loadPreset(JSON.parse(hist[n]));
  syncHistButtons();
  setStat(dir < 0 ? 'undo' : 'redo');
}

function syncHistButtons(){
  const u = $('undoBtn'), r = $('redoBtn');
  if(u) u.disabled = histAt <= 0;
  if(r) r.disabled = histAt >= hist.length - 1;
}

const BOOT_STARTER = 'Folded frames';

function newProject(){
  if(!confirm('Start from defaults? This clears the current look.')) return;
  Object.keys(DEFAULT_STATE).forEach(k => { if(k !== 'stack') state[k] = DEFAULT_STATE[k]; });
  state.flame = null;
  applyStarter(BOOT_STARTER);
  const nb = $('presetName'); if(nb) nb.value = '';
  history.replaceState(null, '', location.pathname);
  relayout(); pushHistory();
  setStat('new project');
}

function setPaused(v){
  paused = v;
  $('pauseBtn').classList.toggle('on', paused);
  $('pauseBtn').innerHTML = paused ? '&#9654;' : '&#10074;&#10074;';
}

function setPanels(hidden){
  panelsHidden = hidden;
  $('panel').classList.toggle('hidden', hidden);
  $('panelR').classList.toggle('hidden', hidden);
  $('panelsBtn').classList.toggle('on', hidden);
  relayout();
}

function setTheme(name){
  document.body.classList.remove('theme-grey', 'theme-light');
  if(name !== 'dark') document.body.classList.add('theme-' + name);
  try { localStorage.setItem('catoptron3d.theme', name); } catch(e){}
}

/* Help shows README.md itself rather than a second copy that would drift out of date. */
let helpLoaded = false;
async function toggleHelp(force){
  const el = $('help');
  const show = force !== undefined ? force : !el.classList.contains('show');
  el.classList.toggle('show', show);
  $('helpClose').style.display = show ? '' : 'none';
  $('helpBtn').classList.toggle('on', show);
  if(show && !helpLoaded){
    helpLoaded = true;
    $('helpDoc').innerHTML = '<p>loading README\u2026</p>';
    try {
      const r = await fetch('./README.md', { cache: 'no-cache' });
      if(!r.ok) throw new Error(r.status);
      $('helpDoc').innerHTML = renderMarkdown(await r.text());
    } catch(e){
      helpLoaded = false;
      $('helpDoc').innerHTML = '<h2>Guide unavailable</h2><p>README.md could not be loaded ' +
        '(' + String(e.message || e) + '). Serving the folder over http rather than opening ' +
        'the file directly will fix it \u2014 ES modules need that anyway.</p>';
    }
  }
  if(show) el.scrollTop = 0;
}

function wireTopBar(){
  $('quickBtn').onclick  = () => (previewHold ? releasePreview() : quickRender());
  $('newBtn').onclick    = newProject;
  $('pauseBtn').onclick  = () => setPaused(!paused);
  $('undoBtn').onclick   = () => stepHistory(-1);
  $('redoBtn').onclick   = () => stepHistory(1);
  $('panelsBtn').onclick = () => setPanels(!panelsHidden);
  $('helpBtn').onclick   = () => toggleHelp();
  $('helpClose').onclick = () => toggleHelp(false);
  $('fsBtn').onclick     = () => {
    if(document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen?.();
  };
  let theme = 'dark';
  try { theme = localStorage.getItem('catoptron3d.theme') || 'dark'; } catch(e){}
  $('themeSel').value = theme;
  setTheme(theme);
  $('themeSel').onchange = e => setTheme(e.target.value);

  // one history entry per gesture: `change` fires when a slider is released
  ['panel', 'panelR'].forEach(id => {
    $(id).addEventListener('input', releasePreview);
    $(id).addEventListener('change', releasePreview);
    $(id).addEventListener('change', pushHistory);
    $(id).addEventListener('pointerup', () => setTimeout(pushHistory, 0));
  });

  addEventListener('keydown', e => {
    if(/input|select|textarea/i.test(e.target.tagName)) return;
    const k = e.key.toLowerCase();
    if(k === 'r' && !e.ctrlKey && !e.metaKey && !e.altKey){
      e.preventDefault();
      return previewHold ? releasePreview() : quickRender();
    }
    releasePreview();
    if((e.ctrlKey || e.metaKey) && k === 'z'){ e.preventDefault(); stepHistory(e.shiftKey ? 1 : -1); return; }
    if(e.ctrlKey || e.metaKey || e.altKey) return;
    if(k === ' '){ e.preventDefault(); setPaused(!paused); }
    else if(k === 'h'){ e.preventDefault(); setPanels(!panelsHidden); }
    else if(k === 'f'){ e.preventDefault(); $('fsBtn').click(); }
    else if(k === '?' || (k === '/' && e.shiftKey)){ e.preventDefault(); toggleHelp(); }
    else if(k === 'escape'){ toggleHelp(false); }
  });
}

/* ── presets ───────────────────────────────────────────────────────────────────────────────
   Storage and UI only; the format lives in engine/preset.js and is tested headlessly by
   tools/test-presets.mjs. Three routes out of the tool:
     - named slots in localStorage (fast, this machine only)
     - a .json file (portable, archivable)
     - a URL hash (a look becomes a link)
   The loaded image is NOT part of a preset: a photo cannot go in a URL, and silently baking one
   into a file would make presets unpredictably large. Reload the image after loading a preset. */
const LS_KEY = 'catoptron3d.presets';

function lsRead(){
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); }
  catch(e){ return {}; }                       // private mode, quota, corrupt entry — all fine
}
function lsWrite(obj){
  try { localStorage.setItem(LS_KEY, JSON.stringify(obj)); return true; }
  catch(e){ setStat('could not save \u2014 storage unavailable'); return false; }
}

function currentPreset(name){ return capture(state, DEFAULT_STATE, OPS, name); }

function loadPreset(p){
  const r = applyPreset(p, DEFAULT_STATE, OPS);
  Object.assign(state, r.state);
  state.stack = r.stack;
  state.flame = r.flame || null;
  renderXforms();
  refreshFlameLabel();
  renderStack();
  rebuildGlobals();
  relayout();
  if(r.warnings.length){
    console.warn('[catoptron3d] preset loaded with warnings:\n  ' + r.warnings.join('\n  '));
    setStat('loaded with ' + r.warnings.length + ' warning(s) \u2014 see console');
  } else {
    setStat('loaded' + (p.name ? ' \u201c' + p.name + '\u201d' : ''));
  }
}

function refreshPresetList(){
  const sel = $('presetList');
  if(!sel) return;
  const all = lsRead();
  const names = Object.keys(all).sort((a, b) => a.localeCompare(b));
  sel.innerHTML = '';
  if(!names.length){
    const o = document.createElement('option');
    o.textContent = '(none saved)'; o.value = '';
    sel.append(o);
    return;
  }
  names.forEach(n => {
    const o = document.createElement('option');
    o.value = n; o.textContent = n;
    sel.append(o);
  });
}

function savePreset(){
  const name = ($('presetName').value || '').trim();
  if(!name){ setStat('name the preset first'); return; }
  const all = lsRead();
  if(all[name] && !confirm('Overwrite preset \u201c' + name + '\u201d?')) return;
  all[name] = currentPreset(name);
  if(lsWrite(all)){
    refreshPresetList();
    $('presetList').value = name;
    setStat('saved \u201c' + name + '\u201d');
  }
}

function deletePreset(){
  const name = $('presetList').value;
  if(!name) return;
  if(!confirm('Delete preset \u201c' + name + '\u201d?')) return;
  const all = lsRead();
  delete all[name];
  lsWrite(all);
  refreshPresetList();
  setStat('deleted \u201c' + name + '\u201d');
}

function exportPreset(){
  const name = ($('presetName').value || 'catoptron3d').trim();
  const blob = new Blob([JSON.stringify(currentPreset(name), null, 1)],
                        { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name.replace(/[^\w\-]+/g, '_') + '.json';
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function importPresetFile(file){
  if(!file) return;
  const rd = new FileReader();
  rd.onload = () => {
    try {
      const p = JSON.parse(rd.result);
      loadPreset(p);
      if(p.name) $('presetName').value = p.name;
      pushHistory();
    } catch(e){
      console.error(e);
      setStat('not a valid preset file');
    }
  };
  rd.readAsText(file);
}

async function copyLink(){
  const name = ($('presetName').value || '').trim();
  const hash = encode(currentPreset(name));
  const url = location.origin + location.pathname + '#p=' + hash;
  history.replaceState(null, '', '#p=' + hash);
  try {
    await navigator.clipboard.writeText(url);
    setStat('link copied \u00b7 ' + url.length + ' chars');
  } catch(e){
    setStat('link is in the address bar \u2014 copy it from there');
  }
}

function loadFromHash(){
  const m = /[#&]p=([A-Za-z0-9\-_]+)/.exec(location.hash || '');
  if(!m) return false;
  try {
    const p = decode(m[1]);
    loadPreset(p);
    if(p.name && $('presetName')) $('presetName').value = p.name;
    return true;
  } catch(e){
    console.error('[catoptron3d] bad preset link', e);
    setStat('that link is not a valid preset');
    return false;
  }
}

/* ── stack ─────────────────────────────────────────────────────────────────────────────── */
function newSlot(type){
  return { type, p: defaults(OPS[type]), o: [0, 0, 0], r: [0, 0, 0] };
}

function addOp(type){
  if(state.stack.length >= MAX_OPS){ setStat('stack is full (' + MAX_OPS + ')'); return; }
  state.stack.push(newSlot(type));
  renderStack();
}

function renderStack(){
  const host = $('stack');
  host.innerHTML = '';
  state.stack.forEach((sl, i) => {
    const op = OPS[sl.type];
    const card = document.createElement('div');
    card.className = 'card';

    const head = document.createElement('div');
    head.className = 'cardhead';
    const lipTag = { exact: 'exact', bound: 'bound', repeat: 'cell' }[op.lip];
    head.innerHTML = `<span class="cname">${i + 1}. ${op.name}</span>` +
                     `<span class="lip lip-${op.lip}" title="DE scale factor: ${op.lip}">${lipTag}</span>`;
    const btns = document.createElement('span');
    btns.className = 'cbtns';
    btns.append(
      mkBtn('\u2191', () => { if(i > 0){ swap(i, i - 1); } }),
      mkBtn('\u2193', () => { if(i < state.stack.length - 1){ swap(i, i + 1); } }),
      mkBtn('\u00d7', () => { state.stack.splice(i, 1); renderStack(); })
    );
    head.append(btns);
    card.append(head);

    if(op.lip === 'repeat'){
      const w = document.createElement('div');
      w.className = 'warn';
      w.textContent = 'Domain repeat is only distance-correct while the primitive fits inside one cell.';
      card.append(w);
    }

    const disc = discIdx(op);
    op.params.forEach((spec, pi) => {
      const [label, min, max, step, , names] = spec;
      if(names){
        card.append(mkSelect(label, names, sl.p[pi], v => { sl.p[pi] = v; renderStack(); },
                             disc.includes(pi)));
      } else {
        card.append(mkSlider(label, min, max, step, sl.p[pi], v => { sl.p[pi] = v; }));
      }
    });

    const place = document.createElement('details');
    place.className = 'place';
    place.innerHTML = '<summary>placement</summary>';
    ['X', 'Y', 'Z'].forEach((ax, k) => {
      place.append(mkSlider('Origin ' + ax, -3, 3, 0.005, sl.o[k], v => { sl.o[k] = v; }));
    });
    ['X', 'Y', 'Z'].forEach((ax, k) => {
      place.append(mkSlider('Rotate ' + ax + '\u00b0', -180, 180, 0.5, sl.r[k], v => { sl.r[k] = v; }));
    });
    card.append(place);
    host.append(card);
  });
  if(!state.stack.length){
    host.innerHTML = '<p class="empty">No folds yet. Add one above — ' +
                     'Octahedral fold or Box fold is the place to start.</p>';
  }
}

function swap(a, b){
  const t = state.stack[a]; state.stack[a] = state.stack[b]; state.stack[b] = t;
  renderStack();
}

/* ── widget factories (every slider carries its real min/max in the DOM) ───────────────── */
function mkBtn(txt, fn){
  const b = document.createElement('button');
  b.className = 'mini'; b.textContent = txt; b.onclick = fn;
  return b;
}

function mkSlider(label, min, max, step, val, onInput, dp){
  const row = document.createElement('div');
  row.className = 'ctrl';
  const digits = dp ?? (String(step).includes('.') ? String(step).split('.')[1].length : 0);
  const lab = document.createElement('label');
  const out = document.createElement('span');
  out.textContent = Number(val).toFixed(digits);
  lab.append(document.createTextNode(label), out);
  const inp = document.createElement('input');
  inp.type = 'range'; inp.min = min; inp.max = max; inp.step = step; inp.value = val;
  inp.addEventListener('input', () => {
    const v = parseFloat(inp.value);
    out.textContent = v.toFixed(digits);
    onInput(v);
    bumpInteract();
  });
  row.append(lab, inp);
  return row;
}

function mkSelect(label, names, val, onChange, isDiscrete){
  const row = document.createElement('div');
  row.className = 'ctrl';
  const lab = document.createElement('label');
  lab.append(document.createTextNode(label));
  if(isDiscrete){
    const t = document.createElement('span');
    t.className = 'baked'; t.textContent = 'baked';
    t.title = 'Compile-time literal — changing this rebuilds the shader';
    lab.append(t);
  }
  const sel = document.createElement('select');
  names.forEach((n, i) => {
    const o = document.createElement('option');
    o.value = i; o.textContent = n; if(i === Math.round(val)) o.selected = true;
    sel.append(o);
  });
  sel.addEventListener('change', () => onChange(parseInt(sel.value, 10)));
  row.append(lab, sel);
  return row;
}

/* ── panel build ───────────────────────────────────────────────────────────────────────── */
function rebuildGlobals(){
  $('globals').innerHTML = '';
  $('globalsR').innerHTML = '';
  buildGlobals();
}

function buildGlobals(){
  const host  = $('globals');
  const hostR = $('globalsR');
  const fg = $('flameGlobals');
  if(fg){
    fg.innerHTML = '';
    fg.append(mkSelect('Map selection',
                       ['image box (exact for affine)', 'nearest image', 'nearest fixed point'],
                       SEL_UI.indexOf((state.flame && state.flame.select) | 0),
                       v => { if(state.flame) state.flame.select = SEL_UI[v]; }, true));
    const sn = document.createElement('p');
    sn.className = 'note';
    sn.textContent = 'Inversive variations (spherical3D, mobius3D) want NEAREST FIXED POINT. '
      + 'Under nearest image they collapse distant points onto the inversion centre, the same '
      + 'map always wins, and the parameters stop having any visible effect.';
    fg.append(sn);
    fg.append(mkSlider('Iterations', 1, 24, 1, state.iters, v => { state.iters = v; }, 0));
    fg.append(mkSlider('Primitive size', 0.002, 0.6, 0.002, state.primSize,
                       v => { state.primSize = v; }, 3));
  }

  // primitive + march steps + palette (discrete: they rebuild)
  const g0 = section('Renderer');
  g0.append(mkSelect('Primitive', PRIMS.map(p => p.name), state.prim,
                     v => { state.prim = v; }, true));
  g0.append(mkSelect('March steps', MARCH_STEPS.map(s => String(s)),
                     MARCH_STEPS.indexOf(state.steps),
                     v => { state.steps = MARCH_STEPS[v]; }, true));
  g0.append(mkSelect('Style', PRIM_STYLES, state.primStyle,
                     v => { state.primStyle = v; }, true));
  g0.append(mkSelect('Fold membrane', ['off', 'show seams'], state.seamSurf,
                     v => { state.seamSurf = v; }, true));
  g0.append(mkSelect('Mirror bounces', ['0 \u2014 off', '1', '2', '3', '4', '5', '6'],
                     state.bounces, v => { state.bounces = v; }, true));
  g0.append(mkSlider('Reflectivity', 0, 1, 0.01, state.reflect, v => { state.reflect = v; }, 2));
  g0.append(mkSlider('Fresnel edge', 0, 1, 0.01, state.fresnel, v => { state.fresnel = v; }, 2));
  g0.append(mkSlider('Metal tint', 0, 1, 0.01, state.metal, v => { state.metal = v; }, 2));
  g0.append(mkSlider('Transparency', 0, 1, 0.01, state.transp, v => { state.transp = v; }, 2));
  g0.append(mkSlider('Refractive index', 1.0, 2.6, 0.005, state.ior, v => { state.ior = v; }, 3));
  g0.append(mkSlider('Absorption', 0, 6, 0.02, state.absorb, v => { state.absorb = v; }, 2));
  g0.append(mkSlider('Dispersion', 0, 1, 0.01, state.disp, v => { state.disp = v; }, 2));
  const rn = document.createElement('p');
  rn.className = 'note';
  rn.textContent = 'Reflection and transparency both need bounces > 0. Dispersion traces three paths.  0.85 is a strong mirror; 1.00 with Fresnel 0 is perfect. '
    + 'Enclosed mirror rooms blow out at high values \u2014 drop Exposure to compensate.';
  g0.append(rn);
  hostR.append(g0);

  GROUPS.forEach(([title, rows]) => {
    const g = section(title);
    if(title === 'IFS recursion'){
      g.append(mkSelect('Feedback',
        ['off \u2014 pure IFS', 'orbit (Mandelbrot)', 'constant (Julia)'],
        state.feedback, v => { state.feedback = v; }, true));
      const n = document.createElement('p');
      n.className = 'note';
      n.textContent = 'Feedback re-adds a point each pass, turning the attractor into an '
        + 'escape-time set \u2014 Mandelbox, Mandelbulb, Julia. Needs iterations > 1.';
      g.append(n);
    }
    if(title === 'Colour'){
      g.append(mkSelect('Palette', PALETTES.map(p => p.name), state.palette,
                        v => { state.palette = v; }, false));
    }
    rows.forEach(([key, label, min, max, step, dp]) => {
      g.append(mkSlider(label, min, max, step, state[key], v => { state[key] = v; }, dp));
    });
    (RIGHT_GROUPS.has(title) ? hostR : host).append(g);
  });

}

function buildPanel(){
  buildGlobals();
  const gi = section('Image');
  gi.append(mkSelect('Aspect', ASPECTS.map(a => a[0]), state.aspect,
                     v => { state.aspect = v; W = 0; H = 0; }, false));
  gi.append(mkSelect('Export size', EXPORT_SIZES.map(a => a[0]), state.exportSize,
                     v => { state.exportSize = v; }, false));
  $('imgpanel').append(gi);
  $('imgFile').addEventListener('change', e => loadImageFile(e.target.files[0]));
  $('imgBtn').onclick = () => $('imgFile').click();
  $('imgClear').onclick = clearImage;
  refreshImgLabel();

  $('tabFold').onclick    = () => showTab('fold');
  $('tabFlame').onclick   = () => { showTab('flame'); autoLoadFlame(); };
  $('flameBtn').onclick   = () => $('flameFile').click();
  $('flameClear').onclick = clearFlame;
  $('flameAdd').onclick   = addXform;
  $('flameReset').onclick = resetXformEdits;
  const exSel = $('flameExample');
  EXAMPLE_FLAMES.forEach(([nm], i) => {
    const o = document.createElement('option');
    o.value = String(i); o.textContent = nm;
    exSel.append(o);
  });
  $('flameLoadEx').onclick = () => {
    const e = EXAMPLE_FLAMES[parseInt(exSel.value, 10) || 0];
    if(e) loadExampleFlame(e[1], e[0], e[2]);
  };
  $('flameFile').addEventListener('change', e => {
    const f = e.target.files[0];
    if(!f) return;
    const rd = new FileReader();
    rd.onload = () => loadFlameText(rd.result, f.name);
    rd.readAsText(f);
  });
  renderXforms();
  refreshFlameLabel();

  $('presetSave').onclick   = savePreset;
  $('presetLoad').onclick   = () => {
    const n = $('presetList').value;
    if(!n) return;
    const all = lsRead();
    if(all[n]){ loadPreset(all[n]); $('presetName').value = n; pushHistory(); }
  };
  $('presetDelete').onclick = deletePreset;
  $('presetExport').onclick = exportPreset;
  $('presetImport').onclick = () => $('presetFile').click();
  $('presetFile').addEventListener('change', e => importPresetFile(e.target.files[0]));
  $('presetLink').onclick   = copyLink;
  refreshPresetList();

  const starters = $('starters');
  Object.keys(STARTERS).forEach(k => {
    const b = document.createElement('button');
    b.textContent = k;
    b.onclick = () => applyStarter(k);
    starters.append(b);
  });
  const addSel = $('addOp');
  OPS.forEach((op, i) => {
    const o = document.createElement('option');
    o.value = i; o.textContent = op.name;
    addSel.append(o);
  });
  $('addBtn').onclick = () => addOp(parseInt(addSel.value, 10));
  $('clearBtn').onclick = () => { state.stack = []; renderStack(); };
  $('pngBtn2').onclick = savePNG;
  $('toggle').onclick  = () => { $('panel').classList.toggle('hidden'); relayout(); };
  $('toggleR').onclick = () => { $('panelR').classList.toggle('hidden'); relayout(); };
}

function section(title){
  const d = document.createElement('div');
  d.className = 'group';
  const h = document.createElement('h2');
  h.textContent = title;
  d.append(h);
  return d;
}

/* ── camera interaction ────────────────────────────────────────────────────────────────── */
let drag = false, lx = 0, ly = 0;
const keys = {};

cv.addEventListener('pointerdown', e => { drag = true; lx = e.clientX; ly = e.clientY; cv.setPointerCapture(e.pointerId); });
cv.addEventListener('pointerup',   e => { drag = false; });
cv.addEventListener('pointermove', e => {
  if(!drag) return;
  state.camAzim -= (e.clientX - lx) * 0.007;
  state.camElev = Math.max(-1.5, Math.min(1.5, state.camElev - (e.clientY - ly) * 0.007));
  lx = e.clientX; ly = e.clientY;
  bumpInteract();
});
cv.addEventListener('wheel', e => {
  state.camDist = Math.max(1.2, Math.min(40, state.camDist * (1 + e.deltaY * 0.0012)));
  syncSliderDisplay('camDist');
  e.preventDefault(); bumpInteract();
}, { passive: false });

addEventListener('keydown', e => {
  if(/input|select|textarea/i.test(e.target.tagName)) return;
  keys[e.key.toLowerCase()] = true;
  if(['arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(e.key.toLowerCase())) e.preventDefault();
});
addEventListener('keyup', e => { keys[e.key.toLowerCase()] = false; });

function navStep(dt){
  const fine = keys['shift'] ? 0.25 : 1;
  const a = 1.1 * dt * fine, z = 4.0 * dt * fine;
  let moved = false;
  if(keys['a'] || keys['arrowleft'])  { state.camAzim -= a; moved = true; }
  if(keys['d'] || keys['arrowright']) { state.camAzim += a; moved = true; }
  if(keys['w'] || keys['arrowup'])    { state.camElev = Math.min(1.5, state.camElev + a * 0.7); moved = true; }
  if(keys['s'] || keys['arrowdown'])  { state.camElev = Math.max(-1.5, state.camElev - a * 0.7); moved = true; }
  if(keys['q']) { state.camDist = Math.min(40, state.camDist + z); moved = true; }
  if(keys['e']) { state.camDist = Math.max(1.2, state.camDist - z); moved = true; }
  if(moved) bumpInteract();
}

/* ── resolution ladder: drop while the user is moving, restore when idle ───────────────── */
let lastInteract = -1e9;
function bumpInteract(){
  lastInteract = performance.now();
  if(previewHold) releasePreview();   // orbiting, dollying or navigating drops a held preview
}

function syncSliderDisplay(){ /* sliders are one-way; camera keys/wheel don't write back */ }

/* ── loop ──────────────────────────────────────────────────────────────────────────────── */
let W = 0, H = 0, animTime = 0, lastT = 0, fpsArr = [];

function frame(now){
  const dt0 = Math.min((now - lastT) / 1000, 0.05) || 0.016;
  lastT = now;
  const dt = paused ? 0 : dt0;
  animTime += dt;
  fpsArr.push(1 / dt); if(fpsArr.length > 40) fpsArr.shift();

  navStep(dt0);                       // navigation still works while paused
  state.camAzim += state.autoSpin * dt;

  syncProgram(now);

  if(previewHold){                    // a held preview is a still; do not redraw over it
    requestAnimationFrame(frame);
    return;
  }
  const busy = (now - lastInteract) < 220;
  const q = state.renderScale * (busy ? 0.55 : 1.0);
  const [dw, dh] = displaySize();
  const nW = Math.max(1, Math.floor(dw * q));
  const nH = Math.max(1, Math.floor(dh * q));
  if(nW !== W || nH !== H || cv.style.width !== dw + 'px'){
    W = nW; H = nH;
    cv.width = W; cv.height = H;
    cv.style.width = dw + 'px';
    cv.style.height = dh + 'px';
    cv.style.left = (padL + (availW || innerWidth) * 0.5) + 'px';
    cv.style.top  = (TOPBAR + (innerHeight - TOPBAR) * 0.5) + 'px';
  }

  renderScene(W, H);
  if(cur) $('boot')?.classList.add('done');

  const fps = Math.round(fpsArr.reduce((a, b) => a + b, 0) / fpsArr.length);
  $('fps').textContent = fps + ' fps \u00b7 ' + W + '\u00d7' + H;
  requestAnimationFrame(frame);
}


/* ── user image ────────────────────────────────────────────────────────────────────────────
   A photo has no obvious job in a procedural 3D scene — there is no source plane to fold. It
   gets two placements instead, and the first is the one that matters here: as an equirectangular
   ENVIRONMENT it lands in every reflection, which is what sells a mirror. As a triplanar
   SURFACE TEXTURE it paints the folded geometry directly.
   Both are compile-time flags, so an unused image emits no sampling code at all.             */
let imgTex = null, imgReady = false, imgAspect = 1, imgName = '';

function loadImageFile(file){
  if(!file) return;
  const url = URL.createObjectURL(file);
  const im = new Image();
  im.onload = () => {
    if(!imgTex) imgTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, imgTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, im);
    // WebGL2 handles non-power-of-two with REPEAT and mipmaps, so no resize is needed.
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    imgReady = true;
    imgAspect = im.width / Math.max(im.height, 1);
    imgName = file.name;
    if(state.envAmt < 0.001 && state.texAmt < 0.001) state.envAmt = 0.85;   // show it immediately
    URL.revokeObjectURL(url);
    rebuildGlobals();
    refreshImgLabel();
    setStat('image ' + im.width + '\u00d7' + im.height);
  };
  im.onerror = () => { URL.revokeObjectURL(url); setStat('could not read that image'); };
  im.src = url;
}

function clearImage(){
  imgReady = false;
  imgName = '';
  state.envAmt = 0; state.texAmt = 0;
  rebuildGlobals();
  refreshImgLabel();
}

function refreshImgLabel(){
  const e = $('imgName');
  if(e) e.textContent = imgReady ? imgName : 'no image loaded';
}

/* ── framing ───────────────────────────────────────────────────────────────────────────────
   Aspect letterboxes the canvas inside the window so what you frame is what you export.     */
const ASPECTS = [
  ['free (window)', 0],
  ['source image',  -1],
  ['1:1 square',    1],
  ['4:5 portrait',  4 / 5],
  ['3:4 portrait',  3 / 4],
  ['2:3 portrait',  2 / 3],
  ['9:16 reel',     9 / 16],
  ['4:3 landscape', 4 / 3],
  ['3:2 landscape', 3 / 2],
  ['16:9 wide',     16 / 9]
];

/* ── layout ────────────────────────────────────────────────────────────────────────────────
   The canvas is centred in whatever space the panels leave. Below 1180px the rails overlay
   instead of reserving width: two 300px panels plus a usable viewport does not fit on a tablet,
   and at 1024px reserving both would leave a 424px slot to work in.                           */
let padL = 0, availW = 0;

const TOPBAR = 44;

function relayout(){
  const wide = innerWidth >= 1180;
  const lOpen = !$('panel').classList.contains('hidden');
  const rOpen = !$('panelR').classList.contains('hidden');
  padL = (wide && lOpen) ? 300 : 0;
  const padR = (wide && rOpen) ? 300 : 0;
  availW = Math.max(160, innerWidth - padL - padR);
  $('toggle').classList.toggle('tucked', !lOpen);
  $('toggleR').classList.toggle('tucked', !rOpen);
  // keep the readout and the boot message over the canvas, not under a panel
  const hud = $('hud'), boot = $('boot');
  if(hud) hud.style.left = (padL + 12) + 'px';
  if(boot) boot.style.left = (padL + availW * 0.5) + 'px';
  if(boot) boot.style.top = (TOPBAR + (innerHeight - TOPBAR) * 0.5) + 'px';
  W = 0; H = 0;                       // force the frame loop to resize
}

addEventListener('resize', relayout);

function aspectRatio(){
  const a = ASPECTS[state.aspect] ? ASPECTS[state.aspect][1] : 0;
  if(a === -1) return imgReady ? imgAspect : 0;
  return a;
}

// CSS pixel size of the canvas for the current aspect, fitted inside the window.
function displaySize(){
  const aw = availW || innerWidth;
  const ah = Math.max(80, innerHeight - TOPBAR);
  const ar = aspectRatio();
  if(!ar) return [aw, ah];
  let w = aw, h = w / ar;
  if(h > ah){ h = ah; w = h * ar; }
  return [Math.max(1, Math.floor(w)), Math.max(1, Math.floor(h))];
}

const EXPORT_SIZES = [
  ['\u00d71 view',   1], ['\u00d72 view', 2], ['\u00d74 view', 4],
  ['1080 px tall', -1080], ['1440 px tall', -1440],
  ['2160 px tall', -2160], ['2880 px tall', -2880]
];

function exportDims(){
  const [dw, dh] = displaySize();
  const spec = EXPORT_SIZES[state.exportSize] ? EXPORT_SIZES[state.exportSize][1] : 1;
  if(spec > 0) return fitExport(dw * spec, dh * spec);
  const h = -spec;
  const ar = aspectRatio() || (dw / dh);
  return fitExport(Math.round(h * ar), h);
}

/* ── PNG export ────────────────────────────────────────────────────────────────────────────
   iOS notes, learned from a real 404 report:

   1. NEVER use canvas.toDataURL() for a full-size export. A 2048x2732 PNG base64-encodes to
      tens of MB, which is far past Safari's URL length limit. Safari then fails to parse the
      string as a data: URL and falls back to treating it as a RELATIVE PATH — so the browser
      requests something like /Catoptron3D/data:image/png;base64,iVBOR... and the host answers
      404. Desktop Chrome and Firefox tolerate huge data URLs, so this only shows up on iOS.
      toBlob + createObjectURL gives a short URL and fixes it.

   2. Safari caps canvas backing-store area (~16.7 MP on iOS 12+, and a 4096 max dimension).
      Past that the allocation is silently refused or comes back blank, so clamp before
      rendering rather than after.

   3. The download attribute is unreliable on iOS. The share sheet is the real "save to Photos"
      path, so try it first — but toBlob is async and the user-gesture window can expire, so
      always leave a visible tap-to-save link as a guaranteed manual fallback.                */

const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
               (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const MAX_EXPORT_PX  = IS_IOS ? 16.0e6 : 80e6;
const MAX_EXPORT_DIM = IS_IOS ? 4096   : 16384;

function fitExport(w, h){
  let k = Math.min(1, MAX_EXPORT_DIM / Math.max(w, h));
  const px = w * k * h * k;
  if(px > MAX_EXPORT_PX) k *= Math.sqrt(MAX_EXPORT_PX / px);
  return [Math.max(1, Math.floor(w * k)), Math.max(1, Math.floor(h * k))];
}

function offerSaveLink(url, name){
  const host = $('savelink');
  host.innerHTML = '';
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.target = '_blank';
  a.rel = 'noopener';
  a.textContent = IS_IOS ? 'tap to open \u2014 then long-press to save' : 'download ' + name;
  host.append(a);
}

function savePNG(){
  if(!cur){ setStat('shader still building\u2026'); return; }

  const [sw, sh] = exportDims();
  const pw = cv.width, ph = cv.height;

  cv.width = sw; cv.height = sh;
  if(cv.width !== sw || cv.height !== sh){          // allocation refused outright
    cv.width = pw; cv.height = ph; W = 0; H = 0;
    setStat('export size refused by the browser');
    return;
  }
  renderScene(cv.width, cv.height);
  if(gl.isContextLost()){
    setStat('context lost during export \u2014 reload and try a smaller window');
    return;
  }

  const outW = cv.width, outH = cv.height;
  const name = 'catoptron3d_' + outW + 'x' + outH + '_' + Date.now() + '.png';
  const restore = () => { cv.width = pw; cv.height = ph; W = 0; H = 0; };

  if(!cv.toBlob){                                    // very old browser
    restore();
    setStat('this browser cannot export PNG');
    return;
  }

  setStat('encoding ' + outW + '\u00d7' + outH + '\u2026');
  cv.toBlob(async blob => {
    restore();
    if(!blob){ setStat('export failed \u2014 try a smaller window'); return; }

    const url = URL.createObjectURL(blob);
    offerSaveLink(url, name);                        // always available, whatever else happens

    if(IS_IOS && navigator.canShare){
      try {
        const file = new File([blob], name, { type: 'image/png' });
        if(navigator.canShare({ files: [file] })){
          await navigator.share({ files: [file], title: 'Catoptron 3D' });
          setStat('saved \u00b7 ' + outW + '\u00d7' + outH);
          setTimeout(() => URL.revokeObjectURL(url), 60000);
          return;
        }
      } catch(e){
        if(e && e.name === 'AbortError'){ setStat('export cancelled'); return; }
        // otherwise fall through to the link below
      }
    }

    const a = document.createElement('a');
    a.href = url; a.download = name; a.rel = 'noopener';
    document.body.append(a); a.click(); a.remove();
    setStat('saved ' + outW + '\u00d7' + outH + ' \u00b7 or use the link');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }, 'image/png');
}

/* ── boot ──────────────────────────────────────────────────────────────────────────────── */
buildPanel();
wireTopBar();
relayout();
// A starting stack that shows what the tool is for: octahedral mirror planes plus a box fold,
// recursed. Both are exact isometries, so this is a mathematically clean first image.
if(!loadFromHash()){
  applyStarter(BOOT_STARTER);
  const nb = $('presetName'); if(nb) nb.value = '';
}
pushHistory();
requestAnimationFrame(frame);
