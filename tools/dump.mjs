// Dumps everything the GLSL gates need into JSON, so the Python/EGL side never has to
// parse JavaScript. Run:  node tools/dump.mjs > tools/dump.json
import { OPS, discIdx, bankCount, defaults } from '../engine/ops.js';
import { HELPERS } from '../engine/helpers.js';
import { assemble, signature, PRIMS, MARCH_STEPS } from '../engine/assemble.js';
import { parseFlame, resolveFlame, flameVars } from '../engine/flame.js';
import { readFileSync } from 'node:fs';
const FLAME = parseFlame(readFileSync(new URL('../examples/sierpinski-tetrahedron.flame', import.meta.url), 'utf8'));

const allHelpers = Object.keys(HELPERS).map(k => HELPERS[k].src).join('\n');

// every discrete combination of an op, so the gates cover baked variants too
function variants(op, ti){
  const d = discIdx(op);
  const combos = [[]];
  d.forEach(i => {
    const [, min, max] = op.params[i];
    const vals = [];
    for(let v = min; v <= max; v++) vals.push(v);
    const next = [];
    combos.forEach(c => vals.forEach(v => next.push(c.concat([v]))));
    combos.length = 0; combos.push(...next);
  });
  return combos.map(c => {
    const p = defaults(op).slice();
    d.forEach((pi, k) => { p[pi] = c[k]; });
    const src = typeof op.glsl === 'function' ? op.glsl(c.map(Math.round)) : op.glsl;
    const fn = d.length ? op.fn + '_' + c.map(Math.round).join('_') : op.fn;
    return { type: ti, name: op.name, fn, lip: op.lip, banks: bankCount(op), params: p, src };
  });
}

const ops = [];
OPS.forEach((op, i) => variants(op, i).forEach(v => ops.push(v)));

// compile gate: every op variant x every primitive, plus feature-flag and multi-op stacks
const shaders = [];
ops.forEach(v => {
  PRIMS.forEach((_, pi) => {
    shaders.push({
      label: `${v.fn} x ${PRIMS[pi].name}`,
      src: assemble({ stack: [{ type: v.type, p: v.params }], prim: pi,
                      iters: 4, steps: 96, ao: true, shadow: false, glow: false, bounces: 1 })
    });
  });
});
// every primitive x every style must link, and be distance-correct
PRIMS.forEach((_, pi) => {
  [0, 1, 2].forEach(stl => {
    shaders.push({
      label: `prim ${pi} style ${stl}`,
      src: assemble({ stack: [], prim: pi, primStyle: stl, iters: 1, steps: 96,
                      ao: true, shadow: false, glow: false, bounces: 0 })
    });
  });
});
[1, 2, 3, 4].forEach(a => shaders.push({
  label: `aa ${a}x${a}`,
  src: assemble({ stack: [], prim: 0, iters: 4, steps: 128, ao: true, shadow: false,
                  glow: false, bounces: 1, aa: a })
}));
shaders.push({
  label: 'aa 2x2 + glass + dispersion',
  src: assemble({ stack: [], prim: 6, iters: 2, steps: 128, ao: true, shadow: false, glow: true,
                  bounces: 3, transp: true, disp: true, aa: 2 })
});
[[true, true, true], [false, false, false], [true, false, true]].forEach((f, k) => {
  shaders.push({
    label: `feature flags ${k}`,
    src: assemble({ stack: ops.slice(0, 4).map(v => ({ type: v.type, p: v.params })),
                    prim: 0, iters: 6, steps: 128, ao: f[0], shadow: f[1], glow: f[2],
                    bounces: k })
  });
});
[[true,false],[true,true]].forEach(([tr, dp], i) => shaders.push({
  label: `glass transp=${tr} disp=${dp}`,
  src: assemble({ stack: [], prim: 6, iters: 1, steps: 96, ao: true, shadow: false,
                  glow: false, bounces: 3, transp: tr, disp: dp })
}));
[0, 1, 2, 3, 4, 5, 6].forEach(b => shaders.push({
  label: `bounces=${b}`,
  src: assemble({ stack: [{ type: 13, p: [2, 2, 2] }], prim: 0, iters: 2, steps: 96,
                  ao: true, shadow: false, glow: false, bounces: b })
}));
shaders.push({
  label: 'flame ifs',
  src: assemble({ stack: [{ type: 26, p: [0, 1] }], prim: 2, iters: 8, steps: 128,
                  ao: true, shadow: false, glow: false, bounces: 0, flame: FLAME })
});
shaders.push({
  label: 'max stack (8 ops)',
  src: assemble({ stack: ops.slice(0, 8).map(v => ({ type: v.type, p: v.params })),
                  prim: 0, iters: 8, steps: 128, ao: true, shadow: true, glow: true, bounces: 2 })
});

// de gate: a few real stacks, assembled but with main() stripped by the Python side
const deStacks = [
  { label: 'octa + boxfold', stack: [{ type: 8, p: [0.42] }, { type: 5, p: [1.0] }], iters: 8 },
  { label: 'mandelbox',      stack: [{ type: 5, p: [1.0] }, { type: 6, p: [0.5, 1.0] }], iters: 6 },
  { label: 'tetra',          stack: [{ type: 9, p: [0.6] }], iters: 9 },
  { label: 'twist + sector', stack: [{ type: 10, p: [0.6, 1] }, { type: 4, p: [6, 0, 1] }], iters: 3 },
  { label: 'inversion',      stack: [{ type: 7, p: [1.0] }, { type: 5, p: [1.0] }], iters: 5 },
  { label: 'mirror room',    stack: [{ type: 13, p: [2, 2, 2] }, { type: 14, p: [0.9, 0.9, 0.9] }], iters: 2 },
  { label: 'mirror corridor',stack: [{ type: 12, p: [1, 1.6, 0] }], iters: 2 },
  { label: 'kaleido tile',   stack: [{ type: 16, p: [0, 1.4, 1] }, { type: 12, p: [1, 2.2, 0] }], iters: 3 },
  { label: 'mandelbox',      stack: [{ type: 5, p: [1.0] }, { type: 6, p: [0.5, 1.0] }],
    iters: 8, feedback: 1, prim: 2 },
  { label: 'mandelbulb',     stack: [{ type: 25, p: [8] }], iters: 6, feedback: 1, prim: 2 },
  { label: 'julia bulb',     stack: [{ type: 25, p: [8] }], iters: 6, feedback: 2, prim: 2 },
  { label: 'menger',         stack: [{ type: 24, p: [3, 2] }], iters: 4, prim: 1 },
  { label: 'poly icosa',     stack: [{ type: 20, p: [2, 0] }], iters: 2 },
  { label: 'hyperbolic',     stack: [{ type: 21, p: [2, 1.28] }], iters: 1 },
  { label: 'glide',          stack: [{ type: 22, p: [1, 0, 0.5, 40] }], iters: 2 },
  { label: 'tubes',          stack: [{ type: 23, p: [1, 0.8, 0] }], iters: 2 },
  { label: 'sg Pm-3m',       stack: [{ type: 19, p: [7, 1.2] }], iters: 1 },
  { label: 'sg Im-3m',       stack: [{ type: 19, p: [8, 1.2] }], iters: 1 },
  { label: 'sg Fm-3m',       stack: [{ type: 19, p: [9, 1.2] }], iters: 1 },
  { label: 'sg P212121',     stack: [{ type: 19, p: [10, 1.2] }], iters: 1 },
  { label: 'sg P63/mmc',     stack: [{ type: 19, p: [11, 1.2] }], iters: 1 },
  { label: 'sg P-1',         stack: [{ type: 19, p: [1, 1.2] }], iters: 1 },
  { label: 'sg P-3m1',       stack: [{ type: 19, p: [6, 1.2] }], iters: 1 },
  { label: 'sg P6/mmm',      stack: [{ type: 19, p: [5, 1.2] }], iters: 1 },
  { label: 'mirror shells',  stack: [{ type: 15, p: [0.85, 0.2] }, { type: 14, p: [0.6, 0.6, 0.6] }], iters: 3 },
  { label: 'hinge fold',     stack: [{ type: 17, p: [90, 90, 0] }, { type: 17, p: [90, 90, 2] }], iters: 2 },
  { label: 'vortex',         stack: [{ type: 18, p: [0.7, 1] }], iters: 2 },
  { label: 'flame ifs 6',    stack: [{ type: 26, p: [0, 1] }], iters: 6,  prim: 2, flame: FLAME },
  { label: 'flame ifs 12',   stack: [{ type: 26, p: [1, 1] }], iters: 12, prim: 2, flame: FLAME },
  { label: 'flame xaos',     stack: [{ type: 26, p: [1] }], iters: 6, prim: 7,
    flame: (() => { const f = parseFlame(readFileSync(new URL('../examples/square-corners-linear3d.flame', import.meta.url),'utf8'));
                    f.select = 2; f.maps.forEach((x, i) => { x.chaos = [1, 1, 1, 0]; }); return f; })() },
  { label: 'flame boxsel',   stack: [{ type: 26, p: [1] }], iters: 7, prim: 7,
    flame: (() => { const f = parseFlame(readFileSync(new URL('../examples/jerusalem-cube.flame', import.meta.url),'utf8'));
                    f.select = 2; return f; })() },
  { label: 'flame hull prim', stack: [{ type: 26, p: [1] }], iters: 5, prim: 7,
    flame: (() => { const f = parseFlame(readFileSync(new URL('../examples/sierpinski-tetrahedron.flame', import.meta.url),'utf8'));
                    f.select = 2; return f; })() },
  { label: 'flame var 00',  stack: [{ type: 26, p: [1] }], iters: 4, prim: 2,
    flame: (() => { const f = parseFlame(readFileSync(new URL('../examples/square-corners-linear3d.flame', import.meta.url),'utf8'));
                    f.maps.forEach(x => { x.vari = 0; x.vamt = 0.9; }); return f; })() },
  { label: 'flame var 01',  stack: [{ type: 26, p: [1] }], iters: 4, prim: 2,
    flame: (() => { const f = parseFlame(readFileSync(new URL('../examples/square-corners-linear3d.flame', import.meta.url),'utf8'));
                    f.maps.forEach(x => { x.vari = 1; x.vamt = 0.9; }); return f; })() },
  { label: 'flame var 02',  stack: [{ type: 26, p: [1] }], iters: 4, prim: 2,
    flame: (() => { const f = parseFlame(readFileSync(new URL('../examples/square-corners-linear3d.flame', import.meta.url),'utf8'));
                    f.maps.forEach(x => { x.vari = 2; x.vamt = 0.9; }); return f; })() },
  { label: 'flame var 03',  stack: [{ type: 26, p: [1] }], iters: 4, prim: 2,
    flame: (() => { const f = parseFlame(readFileSync(new URL('../examples/square-corners-linear3d.flame', import.meta.url),'utf8'));
                    f.maps.forEach(x => { x.vari = 3; x.vamt = 0.9; }); return f; })() },
  { label: 'flame var 04',  stack: [{ type: 26, p: [1] }], iters: 4, prim: 2,
    flame: (() => { const f = parseFlame(readFileSync(new URL('../examples/square-corners-linear3d.flame', import.meta.url),'utf8'));
                    f.maps.forEach(x => { x.vari = 4; x.vamt = 0.9; }); return f; })() },
  { label: 'flame var 05',  stack: [{ type: 26, p: [1] }], iters: 4, prim: 2,
    flame: (() => { const f = parseFlame(readFileSync(new URL('../examples/square-corners-linear3d.flame', import.meta.url),'utf8'));
                    f.maps.forEach(x => { x.vari = 5; x.vamt = 0.9; }); return f; })() },
  { label: 'flame var 06',  stack: [{ type: 26, p: [1] }], iters: 4, prim: 2,
    flame: (() => { const f = parseFlame(readFileSync(new URL('../examples/square-corners-linear3d.flame', import.meta.url),'utf8'));
                    f.maps.forEach(x => { x.vari = 6; x.vamt = 0.9; }); return f; })() },
  { label: 'flame var 07',  stack: [{ type: 26, p: [1] }], iters: 4, prim: 2,
    flame: (() => { const f = parseFlame(readFileSync(new URL('../examples/square-corners-linear3d.flame', import.meta.url),'utf8'));
                    f.maps.forEach(x => { x.vari = 7; x.vamt = 0.9; }); return f; })() },
  { label: 'flame var 08',  stack: [{ type: 26, p: [1] }], iters: 4, prim: 2,
    flame: (() => { const f = parseFlame(readFileSync(new URL('../examples/square-corners-linear3d.flame', import.meta.url),'utf8'));
                    f.maps.forEach(x => { x.vari = 8; x.vamt = 0.9; }); return f; })() },
  { label: 'flame var 09',  stack: [{ type: 26, p: [1] }], iters: 4, prim: 2,
    flame: (() => { const f = parseFlame(readFileSync(new URL('../examples/square-corners-linear3d.flame', import.meta.url),'utf8'));
                    f.maps.forEach(x => { x.vari = 9; x.vamt = 0.9; }); return f; })() },
  { label: 'flame var 10',  stack: [{ type: 26, p: [1] }], iters: 4, prim: 2,
    flame: (() => { const f = parseFlame(readFileSync(new URL('../examples/square-corners-linear3d.flame', import.meta.url),'utf8'));
                    f.maps.forEach(x => { x.vari = 10; x.vamt = 0.9; }); return f; })() },
  { label: 'flame var 11',  stack: [{ type: 26, p: [1] }], iters: 4, prim: 2,
    flame: (() => { const f = parseFlame(readFileSync(new URL('../examples/square-corners-linear3d.flame', import.meta.url),'utf8'));
                    f.maps.forEach(x => { x.vari = 11; x.vamt = 0.9; }); return f; })() },
  { label: 'flame var 12',  stack: [{ type: 26, p: [1] }], iters: 4, prim: 2,
    flame: (() => { const f = parseFlame(readFileSync(new URL('../examples/square-corners-linear3d.flame', import.meta.url),'utf8'));
                    f.maps.forEach(x => { x.vari = 12; x.vamt = 0.9; }); return f; })() },
  { label: 'flame var 13',  stack: [{ type: 26, p: [1] }], iters: 4, prim: 2,
    flame: (() => { const f = parseFlame(readFileSync(new URL('../examples/square-corners-linear3d.flame', import.meta.url),'utf8'));
                    f.maps.forEach(x => { x.vari = 13; x.vamt = 0.9; }); return f; })() },
  { label: 'flame var 14',  stack: [{ type: 26, p: [1] }], iters: 4, prim: 2,
    flame: (() => { const f = parseFlame(readFileSync(new URL('../examples/square-corners-linear3d.flame', import.meta.url),'utf8'));
                    f.maps.forEach(x => { x.vari = 14; x.vamt = 0.9; }); return f; })() },
  { label: 'flame var 15',  stack: [{ type: 26, p: [1] }], iters: 4, prim: 2,
    flame: (() => { const f = parseFlame(readFileSync(new URL('../examples/square-corners-linear3d.flame', import.meta.url),'utf8'));
                    f.maps.forEach(x => { x.vari = 15; x.vamt = 0.9; }); return f; })() },
  { label: 'flame var 16',  stack: [{ type: 26, p: [1] }], iters: 4, prim: 2,
    flame: (() => { const f = parseFlame(readFileSync(new URL('../examples/square-corners-linear3d.flame', import.meta.url),'utf8'));
                    f.maps.forEach(x => { x.vari = 16; x.vamt = 0.9; }); return f; })() },
  { label: 'flame var 17',  stack: [{ type: 26, p: [1] }], iters: 4, prim: 2,
    flame: (() => { const f = parseFlame(readFileSync(new URL('../examples/square-corners-linear3d.flame', import.meta.url),'utf8'));
                    f.maps.forEach(x => { x.vari = 17; x.vamt = 0.9; }); return f; })() },
  { label: 'flame var 18',  stack: [{ type: 26, p: [1] }], iters: 4, prim: 2,
    flame: (() => { const f = parseFlame(readFileSync(new URL('../examples/square-corners-linear3d.flame', import.meta.url),'utf8'));
                    f.maps.forEach(x => { x.vari = 18; x.vamt = 0.9; }); return f; })() },
  { label: 'flame var 19',  stack: [{ type: 26, p: [1] }], iters: 4, prim: 2,
    flame: (() => { const f = parseFlame(readFileSync(new URL('../examples/square-corners-linear3d.flame', import.meta.url),'utf8'));
                    f.maps.forEach(x => { x.vari = 19; x.vamt = 0.9; }); return f; })() },
  { label: 'flame var 20',  stack: [{ type: 26, p: [1] }], iters: 4, prim: 2,
    flame: (() => { const f = parseFlame(readFileSync(new URL('../examples/square-corners-linear3d.flame', import.meta.url),'utf8'));
                    f.maps.forEach(x => { x.vari = 20; x.vamt = 0.9; }); return f; })() },
  { label: 'flame var 21',  stack: [{ type: 26, p: [1] }], iters: 4, prim: 2,
    flame: (() => { const f = parseFlame(readFileSync(new URL('../examples/square-corners-linear3d.flame', import.meta.url),'utf8'));
                    f.maps.forEach(x => { x.vari = 21; x.vamt = 0.9; }); return f; })() },
  { label: 'flame var 22',  stack: [{ type: 26, p: [1] }], iters: 4, prim: 2,
    flame: (() => { const f = parseFlame(readFileSync(new URL('../examples/square-corners-linear3d.flame', import.meta.url),'utf8'));
                    f.maps.forEach(x => { x.vari = 22; x.vamt = 0.9; }); return f; })() },
  { label: 'flame mixed',    stack: [{ type: 26, p: [1] }], iters: 5, prim: 2,
    flame: (() => { const f = parseFlame(readFileSync(new URL('../examples/square-corners-linear3d.flame', import.meta.url),'utf8'));
                    f.maps.forEach((x, i) => { x.vari = (i * 5) % 23; x.vamt = 0.9; }); return f; })() },
  { label: 'v sinusoidal',   stack: [{ type: 27, p: [1] }], iters: 4, prim: 2 },
  { label: 'v spherical3D',  stack: [{ type: 28, p: [1] }], iters: 4, prim: 2 },
  { label: 'v bubble',       stack: [{ type: 29, p: [1] }], iters: 4, prim: 2 },
  { label: 'v cylinder',     stack: [{ type: 30, p: [1, 0] }], iters: 3, prim: 2 },
  { label: 'v hyperbolic',   stack: [{ type: 31, p: [1, 2] }], iters: 3, prim: 2 },
  { label: 'v swirl',        stack: [{ type: 32, p: [1, 1, 2] }], iters: 3, prim: 2 },
  { label: 'v curl',         stack: [{ type: 33, p: [1, 0.7, -0.4, 2] }], iters: 3, prim: 2 },
  { label: 'v waves',        stack: [{ type: 34, p: [1, 1, 0.5] }], iters: 3, prim: 2 },
  { label: 'v polar',        stack: [{ type: 36, p: [1, 2] }], iters: 3, prim: 2 },
  { label: 'v disc',         stack: [{ type: 37, p: [1, 2] }], iters: 3, prim: 2 },
  { label: 'v diamond',      stack: [{ type: 38, p: [1, 2] }], iters: 3, prim: 2 },
  { label: 'v handkerchief', stack: [{ type: 39, p: [1, 2] }], iters: 3, prim: 2 },
  { label: 'v heart',        stack: [{ type: 40, p: [1, 2] }], iters: 3, prim: 2 },
  { label: 'v spiral',       stack: [{ type: 41, p: [1, 2] }], iters: 3, prim: 2 },
  { label: 'v exponential',  stack: [{ type: 42, p: [1, 2] }], iters: 3, prim: 2 },
  { label: 'v cosine',       stack: [{ type: 43, p: [1, 2] }], iters: 3, prim: 2 },
  { label: 'v eyefish',      stack: [{ type: 44, p: [1, 2] }], iters: 3, prim: 2 },
  { label: 'v blob',         stack: [{ type: 45, p: [1, 2] }], iters: 3, prim: 2 },
  { label: 'v secant',       stack: [{ type: 46, p: [1, 2] }], iters: 3, prim: 2 },
  { label: 'v pdj',          stack: [{ type: 35, p: [1, 1.8, -1.4, 1.2, -1.7] }], iters: 2, prim: 2 },
  { label: 'crystal',        stack: [], iters: 1, prim: 6 },
  { label: 'crystal folded', stack: [{ type: 20, p: [2, 0.0] }], iters: 2, prim: 6 },
  { label: 'city plain',     stack: [], iters: 1, prim: 5 },
  { label: 'city frame',     stack: [], iters: 1, prim: 5, primStyle: 2 },
  { label: 'city shell',     stack: [], iters: 1, prim: 5, primStyle: 1 },
  { label: 'sphere frame',   stack: [], iters: 1, prim: 2, primStyle: 2 },
  { label: 'octa frame',     stack: [], iters: 1, prim: 3, primStyle: 2 },
  { label: 'torus frame',    stack: [], iters: 1, prim: 4, primStyle: 2 },
  { label: 'box shell',      stack: [], iters: 1, prim: 1, primStyle: 1 },
  { label: 'city folded',    stack: [{ type: 17, p: [90, 90, 0] }], iters: 2, prim: 5 }
];
// resolved transforms travel with the stack so the validator can upload them
deStacks.forEach(d => { if(d.flame){ d.flameMaps = resolveFlame(d.flame); } });
deStacks.forEach(d => {
  const c = { stack: d.stack, prim: d.prim || 0, iters: d.iters, steps: 160,
              ao: false, shadow: false, glow: false, bounces: 0,
              feedback: d.feedback || 0, primStyle: d.primStyle || 0,
              flame: d.flame || null };
  d.src = assemble(c);
  d.sig = signature(c);
});

process.stdout.write(JSON.stringify({
  helpers: allHelpers, ops, shaders, deStacks,
  prims: PRIMS.map(p => p.name), steps: MARCH_STEPS
}, null, 1));
