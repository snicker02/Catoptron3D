// Convert the ad-hoc STARTERS table into real presets, so factory and user entries share one
// format, one loader and one list. Run once; the output is checked in as engine/factory.js.
import { readFileSync, writeFileSync } from 'node:fs';
import { OPS } from '/home/claude/catoptron3d/engine/ops.js';
import { capture, PRESET_VERSION } from '/home/claude/catoptron3d/engine/preset.js';
const src = readFileSync('/home/claude/catoptron3d/main.js','utf8');
const grab = (a,b) => src.slice(src.indexOf(a), src.indexOf(b));
const DEFAULT_STATE = (new Function(grab('const state = {','\n};')+'\n};\nreturn state;'))();
const STARTERS = (new Function(grab('const STARTERS = {','function applyStarter')+'\nreturn STARTERS;'))();
const RESET = (new Function(grab('const STARTER_RESET = {','function applyStarter')+'\nreturn STARTER_RESET;'))();
const newSlot = t => ({ type: t, p: OPS[t].params.map(q => q[4]), o:[0,0,0], r:[0,0,0] });
const out = [];
for(const [name, st] of Object.entries(STARTERS)){
  const s = JSON.parse(JSON.stringify(DEFAULT_STATE));
  Object.assign(s, RESET);
  s.stack = st.stack.map(e => { const sl = newSlot(e.t); e.p.forEach((v,i)=>{ sl.p[i]=v; }); return sl; });
  Object.assign(s, st.set);
  s.flame = null;
  out.push(capture(s, DEFAULT_STATE, OPS, name));
}
writeFileSync('/home/claude/catoptron3d/engine/factory.js',
`/* Factory presets — generated from the former Starters table by tools/gen-factory.mjs.
   They are ordinary presets in the ordinary format: the same loader, the same list, the same
   import/export. They differ only in being read-only.

   Two regimes are represented deliberately, because they need opposite settings and a preset
   layer that only covered one of them would be useless for the other:
     FRACTAL  — IFS contraction around 1.9, camera outside, the fold stack shrinks space.
     MIRROR   — contraction 1.0 so space is not shrunk at all, camera INSIDE the shell spacing,
                primitive translated off the fold axis so the reflections have something to
                catch. A mirror preset with the camera outside shows a dead box.
*/
export const PRESET_VERSION_FACTORY = ${PRESET_VERSION};
export const FACTORY = ${JSON.stringify(out, null, 1)};
`);
console.log('wrote', out.length, 'factory presets');
const frac = out.filter(p => (p.s.ifsScale ?? 1) > 1.5).length;
console.log('fractal regime (ifsScale > 1.5):', frac, ' mirror/other:', out.length - frac);
