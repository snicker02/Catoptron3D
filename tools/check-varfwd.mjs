// Extracts each variation's INVERSE straight out of the assembled shader and emits a probe that
// applies it to a grid of points. The JS forward is then checked against it by round trip:
// V(V^-1(q)) must be q. Verifying the forwards by reading them would prove nothing — they exist
// precisely to agree with code written months earlier.
import { assemble } from '../engine/assemble.js';
import { parseFlame, resolveFlame, FLAME_VARIATIONS, defaultVP } from '../engine/flame.js';

const mkFlame = (vari, vamt, vp) => ({
  name: 'probe', select: 0,
  maps: [{ M: [1,0,0,0,1,0,0,0,1], T: [0,0,0], scale: 1, rot: [0,0,0], tr: [0,0,0],
           vari, vamt, vp: vp || defaultVP(), chaos: null, on: true, weight: 1 }]
});

export function inverseGLSL(vari, vamt, vp){
  const f = mkFlame(vari, vamt, vp);
  const src = assemble({ stack: [{ type: 26, p: [1] }], prim: 2, iters: 1, steps: 32,
                         ao: false, shadow: false, glow: false, bounces: 0, flame: f });
  const a = src.indexOf('vec3 q = p;');
  const b = src.indexOf('q = uFlameMi[0]', a);
  if(a < 0 || b < 0) throw new Error('could not find the inverse block for variation ' + vari);
  return src.slice(src.indexOf('float ve = 1.0;', a) + 'float ve = 1.0;'.length, b);
}

if(process.argv[1] && process.argv[1].endsWith('check-varfwd.mjs')){
  const out = FLAME_VARIATIONS.map((v, i) => ({ id: i, name: v.name, inv: inverseGLSL(i, 0.7) }));
  console.log(JSON.stringify(out));
}
