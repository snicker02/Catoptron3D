// Emits one entry per factory preset: assembled shader plus the full resolved state, so the
// Python side can render each and confirm it produces a non-empty frame.
import { OPS } from '../engine/ops.js';
import { assemble, PRIMS } from '../engine/assemble.js';
import { FACTORY } from '../engine/factory.js';
import { apply as applyPreset } from '../engine/preset.js';
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../main.js', import.meta.url), 'utf8');
const defaults = (new Function(
  src.slice(src.indexOf('const state = {'), src.indexOf('\n};')) + '\n};\nreturn state;'))();
const out = FACTORY.map(p => {
  const r = applyPreset(p, defaults, OPS);
  const st = { ...defaults, ...r.state };
  return {
    name: p.name,
    state: st,
    stack: r.stack.map(sl => ({ type: sl.type, p: sl.p, o: sl.o, r: sl.r })),
    src: assemble({
      stack: r.stack.map(sl => ({ type: sl.type, p: sl.p, o: sl.o, r: sl.r })),
      prim: st.prim, primStyle: st.primStyle, iters: st.iters,
      steps: Math.min(st.steps, 256), ao: st.ao > 0, shadow: st.shadow > 0,
      glow: st.glow > 0, bounces: Math.min(st.bounces, 1),
      transp: st.transp > 0, disp: st.disp > 0, feedback: st.feedback,
      seamSurf: st.seamSurf > 0.5
    })
  };
});
console.log(JSON.stringify(out));
