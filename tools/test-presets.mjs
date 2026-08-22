// Preset format tests. Run: node tools/test-presets.mjs
// These are pure-function tests, so they run headlessly and catch the failures that actually
// matter for presets: silent drift, lost values, and unrecoverable operator mismatches.

import { OPS } from '../engine/ops.js';
import { capture, apply, encode, decode, migrate, PRESET_VERSION } from '../engine/preset.js';
import { assemble, signature } from '../engine/assemble.js';
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if(cond){ pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); }
};

const defaults = {
  camDist: 5.2, fov: 1.3, iters: 8, ifsScale: 1.9, reflect: 0.55, bounces: 0,
  palette: 0, prim: 0, feedback: 0, bailout: 6.0, exposure: 1.05, stepScale: 0.85
};

function mkStack(){
  return [
    { type: 13, p: [2, 2, 2], o: [0, 0, 0], r: [0, 0, 0] },
    { type: 25, p: [8], o: [0.1, -0.2, 0.3], r: [10, 20, 30] }
  ];
}
const mkState = () => ({ ...defaults, camDist: 3.4, iters: 12, feedback: 1, bounces: 2,
                         reflect: 0.85, stack: mkStack() });

console.log('preset format v' + PRESET_VERSION + '\n');

// 1. round trip
{
  const st = mkState();
  const r = apply(capture(st, defaults, OPS, 'x'), defaults, OPS);
  const same = Object.keys(defaults).every(k => k === 'stack' || r.state[k] === st[k]);
  ok('state round-trips exactly', same,
     same ? '' : Object.keys(defaults).filter(k => r.state[k] !== st[k]).join(', '));
  ok('stack length preserved', r.stack.length === 2);
  ok('stack params preserved', JSON.stringify(r.stack[1].p) === JSON.stringify([8]));
  ok('origin/rotation preserved',
     JSON.stringify(r.stack[1].o) === JSON.stringify([0.1, -0.2, 0.3]) &&
     JSON.stringify(r.stack[1].r) === JSON.stringify([10, 20, 30]));
  ok('no warnings on a clean round trip', r.warnings.length === 0, r.warnings.join('; '));
}

// 2. omitted keys resolve to defaults, not to leftover state
{
  const sparse = { v: 1, s: { camDist: 9 }, k: [] };
  const r = apply(sparse, defaults, OPS);
  ok('omitted key falls back to default', r.state.iters === defaults.iters);
  ok('stated key applied', r.state.camDist === 9);
  ok('loading twice is deterministic',
     JSON.stringify(apply(sparse, defaults, OPS).state) === JSON.stringify(r.state));
}

// 3. only non-defaults are stored (this is what keeps a preset URL-sized)
{
  const st = mkState();
  const p = capture(st, defaults, OPS);
  ok('defaults are omitted from the payload', !('fov' in p.s) && !('palette' in p.s));
  ok('changed values are kept', p.s.camDist === 3.4 && p.s.feedback === 1);
  const bytes = encode(p).length;
  ok('encodes small enough for a URL (' + bytes + ' chars)', bytes < 1500, bytes + ' chars');
}

// 4. url encoding survives a round trip, including unicode names
{
  const p = capture(mkState(), defaults, OPS, 'caf\u00e9 \u2014 mirror \u2603');
  const back = decode(encode(p));
  ok('base64url round-trips', JSON.stringify(back) === JSON.stringify(p));
  ok('unicode name survives', back.name === 'caf\u00e9 \u2014 mirror \u2603');
  ok('encoding is URL-safe', !/[+/=]/.test(encode(p)));
}

// 5. operator identity — the one that protects old files from a reordered OPS list
{
  const p = capture(mkState(), defaults, OPS);
  ok('operator name is recorded', p.k[0].n === OPS[13].name);

  // simulate inserting an operator earlier in the list: every index shifts by one
  const SHIFTED = [{ name: '__inserted__', params: [], fn: 'x', glsl: '' }, ...OPS];
  const r = apply(p, defaults, SHIFTED);
  ok('name lookup survives a reordered OPS list',
     SHIFTED[r.stack[0].type].name === OPS[13].name,
     'got ' + SHIFTED[r.stack[0].type].name);

  // a name that no longer exists, with a valid index: recover, but say so
  const renamed = JSON.parse(JSON.stringify(p));
  renamed.k[0].n = 'Operator That Was Deleted';
  const r2 = apply(renamed, defaults, OPS);
  ok('missing name falls back to index with a warning',
     r2.stack.length === 2 && r2.warnings.some(w => w.includes('not found')));

  // neither name nor index resolvable: drop the slot rather than substitute
  const broken = JSON.parse(JSON.stringify(p));
  broken.k[0].n = 'Nope'; broken.k[0].t = 9999;
  const r3 = apply(broken, defaults, OPS);
  ok('unresolvable operator is dropped, not substituted',
     r3.stack.length === 1 && r3.warnings.some(w => w.includes('dropped')));
}

// 6. hostile / damaged input must not throw
{
  const cases = [
    ['empty stack', { v: 1, s: {}, k: [] }],
    ['missing fields', { v: 1 }],
    ['param count mismatch', { v: 1, s: {}, k: [{ t: 13, n: OPS[13].name, p: [1] }] }],
    ['params out of range', { v: 1, s: {}, k: [{ t: 13, n: OPS[13].name, p: [1e9, -1e9, NaN] }] }],
    ['unknown setting', { v: 1, s: { notAThing: 5 }, k: [] }],
    ['future version', { v: 99, s: { camDist: 4 }, k: [] }]
  ];
  cases.forEach(([label, obj]) => {
    let threw = null;
    try { apply(obj, defaults, OPS); } catch(e){ threw = e; }
    ok('survives: ' + label, !threw, threw ? String(threw.message) : '');
  });
  const r = apply(cases[3][1], defaults, OPS);
  const spec = OPS[13].params;
  const inRange = r.stack[0].p.every((v, i) => isFinite(v) && v >= spec[i][1] && v <= spec[i][2]);
  ok('out-of-range params are clamped into the slider range', inRange,
     JSON.stringify(r.stack[0].p));
  ok('short param list is filled with that op\u2019s defaults',
     apply(cases[2][1], defaults, OPS).stack[0].p.length === spec.length);
}

// 7. migration hook is wired
{
  ok('migrate stamps the current version', migrate({ v: 1, s: {}, k: [] }).v === PRESET_VERSION);
  ok('migrate rejects non-objects', (() => { try { migrate(null); return false; }
                                             catch(e){ return true; } })());
}

// 8. END TO END against the REAL app state: a link must reproduce the identical shader.
//    Reads the state literal straight out of main.js rather than a stand-in, so this fails if
//    someone adds a state key and forgets that presets exist.
{
  const src = readFileSync(new URL('../main.js', import.meta.url), 'utf8');
  const a = src.indexOf('const state = {');
  const lit = src.slice(a, src.indexOf('\n};', a) + 3);
  const realDefaults = (new Function(lit + '\nreturn state;'))();
  delete realDefaults.stack;

  const session = { ...realDefaults, stack: [
    { type: 5,  p: [1.0],      o: [0, 0, 0],       r: [0, 0, 0] },
    { type: 6,  p: [0.5, 1.0], o: [0.2, 0, -0.1],  r: [0, 15, 0] }
  ]};
  session.iters = 12; session.ifsScale = 2.0; session.feedback = 1; session.bailout = 20;
  session.prim = 2; session.bounces = 3; session.reflect = 0.85; session.steps = 512;

  const link = encode(capture(session, realDefaults, OPS, 'round trip'));
  const r = apply(decode(link), realDefaults, OPS);
  const restored = { ...r.state, stack: r.stack };

  const keys = Object.keys(realDefaults);
  const drift = keys.filter(k => restored[k] !== session[k]);
  ok('every real state key survives a link (' + keys.length + ' keys)', drift.length === 0,
     'drifted: ' + drift.join(', '));

  const cfg = st => ({
    stack: st.stack.map(sl => ({ type: sl.type, p: sl.p })), prim: st.prim,
    iters: Math.round(st.iters), steps: Math.round(st.steps),
    ao: st.ao > 0.001, shadow: st.shadow > 0.001, glow: st.glow > 0.001,
    seamSurf: st.seamSurf > 0.5, feedback: Math.round(st.feedback),
    env: false, tex: false, bounces: Math.round(st.bounces)
  });
  ok('shader signature is identical',
     signature(cfg(session)) === signature(cfg(restored)),
     signature(cfg(session)) + '  vs  ' + signature(cfg(restored)));
  ok('assembled GLSL is byte-identical',
     assemble(cfg(session)) === assemble(cfg(restored)));
  ok('link stays URL-sized with a real state (' + link.length + ' chars)', link.length < 2000);
}

console.log('\n' + '='.repeat(52));
console.log(fail ? `${fail} FAILED, ${pass} passed` : `ALL ${pass} PRESET TESTS PASS`);
process.exit(fail ? 1 : 0);
