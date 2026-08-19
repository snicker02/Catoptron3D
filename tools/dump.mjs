// Dumps everything the GLSL gates need into JSON, so the Python/EGL side never has to
// parse JavaScript. Run:  node tools/dump.mjs > tools/dump.json
import { OPS, discIdx, bankCount, defaults } from '../engine/ops.js';
import { HELPERS } from '../engine/helpers.js';
import { assemble, signature, PRIMS, MARCH_STEPS } from '../engine/assemble.js';

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
[[true, true, true], [false, false, false], [true, false, true]].forEach((f, k) => {
  shaders.push({
    label: `feature flags ${k}`,
    src: assemble({ stack: ops.slice(0, 4).map(v => ({ type: v.type, p: v.params })),
                    prim: 0, iters: 6, steps: 128, ao: f[0], shadow: f[1], glow: f[2],
                    bounces: k })
  });
});
[0, 1, 2, 3, 4].forEach(b => shaders.push({
  label: `bounces=${b}`,
  src: assemble({ stack: [{ type: 13, p: [2, 2, 2] }], prim: 0, iters: 2, steps: 96,
                  ao: true, shadow: false, glow: false, bounces: b })
}));
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
  { label: 'mirror shells',  stack: [{ type: 15, p: [0.85, 0.2] }, { type: 14, p: [0.6, 0.6, 0.6] }], iters: 3 }
];
deStacks.forEach(d => {
  const c = { stack: d.stack, prim: 0, iters: d.iters, steps: 160,
              ao: false, shadow: false, glow: false, bounces: 0 };
  d.src = assemble(c);
  d.sig = signature(c);
});

process.stdout.write(JSON.stringify({
  helpers: allHelpers, ops, shaders, deStacks,
  prims: PRIMS.map(p => p.name), steps: MARCH_STEPS
}, null, 1));
