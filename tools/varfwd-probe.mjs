import { PRELUDE, VS } from '/home/claude/catoptron3d/engine/prelude.js';
import { HELPERS } from '/home/claude/catoptron3d/engine/helpers.js';
import { assemble } from '/home/claude/catoptron3d/engine/assemble.js';
import { defaultVP } from '/home/claude/catoptron3d/engine/flame.js';
import { readFileSync } from 'node:fs';
const inv = JSON.parse(readFileSync('/tmp/inv.json','utf8'));
const keep = Object.keys(HELPERS).filter(n => !/uPrim|uX[A-Z]|uCity|uSeed|uHull|uSdf/.test(HELPERS[n].src));
const help = keep.map(n => HELPERS[n].src).join('\n');
// the complex-arithmetic block is emitted inside assemble, so take it from a shader that has it
const f = { name:'p', select:0, maps:[{ M:[1,0,0,0,1,0,0,0,1], T:[0,0,0], scale:1, rot:[0,0,0],
  tr:[0,0,0], vari:10, vamt:0.7, vp:defaultVP(), chaos:null, on:true, weight:1 }] };
const src = assemble({ stack:[{type:26,p:[1]}], prim:2, iters:1, steps:32,
                       ao:false, shadow:false, glow:false, bounces:0, flame:f });
const a = src.indexOf('vec2 cmul');
const b = src.indexOf('vec3 flameFold');
if(a < 0 || b < 0) throw new Error('complex block not found');
console.log(JSON.stringify({ vs: VS, pre: PRELUDE, help, cplx: src.slice(a, b), inv }));
