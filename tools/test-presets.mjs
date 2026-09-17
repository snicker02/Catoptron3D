// Preset format tests. Run: node tools/test-presets.mjs
// These are pure-function tests, so they run headlessly and catch the failures that actually
// matter for presets: silent drift, lost values, and unrecoverable operator mismatches.

import { OPS } from '../engine/ops.js';
import { capture, apply, encode, decode, migrate, PRESET_VERSION } from '../engine/preset.js';
import { assemble, signature } from '../engine/assemble.js';
import { readFileSync } from 'node:fs';
import { parseFlame as parseFlameTop, resolveFlame as resolveFlameTop } from '../engine/flame.js';

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
  const restored = { ...r.state, stack: r.stack, flame: r.flame };

  const keys = Object.keys(realDefaults);
  const drift = keys.filter(k => k === 'flame'
    ? JSON.stringify(restored[k] ?? null) !== JSON.stringify(session[k] ?? null)
    : restored[k] !== session[k]);
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

// 9. SOURCE LINT: a backtick inside a GLSL template literal silently terminates the string and
//    the module stops parsing. It has bitten twice. Catch it as a test rather than at runtime.
{
  const files = ['../engine/assemble.js', '../engine/helpers.js', '../engine/ops.js',
                 '../engine/prelude.js', '../engine/preset.js', '../engine/glcache.js'];
  const bad = [];
  files.forEach(f => {
    readFileSync(new URL(f, import.meta.url), 'utf8').split('\n').forEach((ln, i) => {
      // a comment line carrying an odd number of backticks is either opening or closing one
      const t = ln.trim();
      if(!(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'))) return;
      const n = (ln.match(/`/g) || []).length;
      if(n % 2 === 1) bad.push(f.replace('../', '') + ':' + (i + 1) + '  ' + t.slice(0, 60));
    });
  });
  ok('no unbalanced backtick in a comment', bad.length === 0, bad.join('\n         '));

  let loaded = true;
  try { await Promise.all(files.map(f => import(new URL(f, import.meta.url).href))); }
  catch(e){ loaded = false; ok('every engine module parses', false, String(e.message)); }
  if(loaded) ok('every engine module parses', true);
}

// 10. MARKDOWN: the help panel renders README.md itself, so the renderer has to survive the
//     real document rather than a toy sample.
{
  const { renderMarkdown } = await import(new URL('../engine/markdown.js', import.meta.url).href);
  const md = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const html = renderMarkdown(md);

  const nH2 = (md.match(/^## /gm) || []).length;
  ok('renders every h2 (' + nH2 + ')', (html.match(/<h2>/g) || []).length === nH2);
  const nTables = (md.match(/^\|[\s:|-]+\|\s*$/gm) || []).length;
  ok('renders every table (' + nTables + ')', (html.match(/<table>/g) || []).length === nTables);
  const nFence = (md.match(/^```/gm) || []).length / 2;
  ok('renders every code block (' + nFence + ')', (html.match(/<pre>/g) || []).length === nFence);
  ok('no stray markdown headings leak through', !/(^|>)#{1,4}\s/.test(html));
  ok('tags are balanced', ['h2', 'table', 'pre', 'ul', 'ol', 'p', 'li', 'td'].every(t =>
     (html.match(new RegExp('<' + t + '[ >]', 'g')) || []).length ===
     (html.match(new RegExp('</' + t + '>', 'g')) || []).length));

  // escaping: README contains GLSL with < and & and must not become markup
  const inj = renderMarkdown('text <img src=x onerror=alert(1)> & `a < b` more');
  ok('html in the source is escaped, not executed',
     !inj.includes('<img') && inj.includes('&lt;img') && inj.includes('&amp;'));
  ok('inline code still formats', renderMarkdown('use `foo()` here').includes('<code>foo()</code>'));
  ok('bold still formats', renderMarkdown('a **b** c').includes('<strong>b</strong>'));
  ok('empty input does not throw', renderMarkdown('') === '');
}

// 11. FLAME IMPORT. The convention for JWildfire's three coefficient blocks is not documented
//     in the file; it was inferred by requiring a known Sierpinski tetrahedron to come out as
//     0.5-similarities. These tests pin that down so a future edit cannot quietly change it.
{
  const { parseFlame, inv3, opNorm, det3, flameKey, resolveFlame, resolveXform, identityXform } =
    await import(new URL('../engine/flame.js', import.meta.url).href);
  const src = readFileSync(new URL('../examples/sierpinski-tetrahedron.flame', import.meta.url), 'utf8');
  const f = parseFlame(src);

  ok('parses all four xforms', f.maps.length === 4);
  ok('imports cleanly', f.warnings.length === 0, f.warnings.join('; '));
  const R0 = resolveFlame(f);
  ok('every map is an exact 0.5 contraction',
     R0.every(m => Math.abs(m.scale - 0.5) < 1e-9), R0.map(m => m.scale.toFixed(6)).join(', '));
  ok('every inverse expands by exactly 2', R0.every(m => Math.abs(m.expand - 2) < 1e-9));
  ok('maps are contractive (bounded attractor)', R0.every(m => m.scale < 1));

  // the editor layers offsets on top without touching the imported affine
  const g = JSON.parse(JSON.stringify(f));
  g.maps[0].scale = 1.4; g.maps[0].rot = [0, 45, 0]; g.maps[0].tr = [0.2, 0, -0.1];
  const R1 = resolveFlame(g);
  ok('an edit changes the resolved map', Math.abs(R1[0].scale - 0.7) < 1e-6,
     'scale ' + R1[0].scale.toFixed(6));
  ok('an edit leaves the imported affine untouched',
     JSON.stringify(g.maps[0].M) === JSON.stringify(f.maps[0].M));
  ok('other transforms are unaffected', Math.abs(R1[1].scale - 0.5) < 1e-9);
  g.maps[0].scale = 1; g.maps[0].rot = [0, 0, 0]; g.maps[0].tr = [0, 0, 0];
  ok('resetting the offsets restores the original exactly',
     Math.abs(resolveFlame(g)[0].scale - 0.5) < 1e-12);
  g.maps[1].on = false;
  ok('a disabled transform drops out', resolveFlame(g).length === 3);
  // flameKey encodes everything that is COMPILED IN: active count, selection mode, and each
  // xform's variation type. It deliberately does not encode anything that is a uniform.
  ok('flameKey tracks the ACTIVE count (a rebuild trigger)', flameKey(g).startsWith('3:'));
  ok('a hand-built transform is a valid contraction',
     Math.abs(resolveXform(identityXform()).scale - 0.5) < 1e-9);
  ok('rotation alone does not change the contraction',
     (() => { const x = identityXform(); x.rot = [30, 40, 50];
              return Math.abs(resolveXform(x).scale - 0.5) < 1e-9; })());

  // M * Mi must be the identity
  const mul = (A, B) => { const C = new Array(9).fill(0);
    for(let i=0;i<3;i++)for(let j=0;j<3;j++){let s=0;for(let k=0;k<3;k++)s+=A[i*3+k]*B[k*3+j];C[i*3+j]=s;} return C; };
  ok('inverse is a true inverse', R0.every(m => {
    const I = mul(m.M, m.Mi);
    return [1,0,0,0,1,0,0,0,1].every((v, i) => Math.abs(I[i] - v) < 1e-9);
  }));

  // opNorm against hand-checkable cases
  ok('opNorm of the identity is 1', Math.abs(opNorm([1,0,0,0,1,0,0,0,1]) - 1) < 1e-6);
  ok('opNorm of a uniform scale is the scale', Math.abs(opNorm([3,0,0,0,3,0,0,0,3]) - 3) < 1e-6);
  ok('opNorm takes the LARGEST axis, not the average',
     Math.abs(opNorm([0.5,0,0,0,4,0,0,0,0.1]) - 4) < 1e-6);
  ok('opNorm of a shear exceeds 1', opNorm([1,2,0,0,1,0,0,0,1]) > 2.0);
  ok('det of a 0.5 similarity is 0.125',
     R0.every(m => Math.abs(Math.abs(det3(m.M)) - 0.125) < 1e-9));
  ok('singular matrix has no inverse', inv3([1,0,0,1,0,0,0,0,0]) === null);

  // the affine VARIATION FAMILY: linear and linear3D are both affine, and their AMOUNT scales
  // the result rather than having to be 1.0. Getting this wrong rejected a valid flame.
  const mk = a => '<flame><xform weight="1" ' + a + ' coefs="1.0 0.0 0.0 1.0 0.0 0.0"/></flame>';
  const sc = a => resolveFlame(parseFlame(mk(a)))[0].scale;
  ok('linear at amount 1 is affine', Math.abs(sc('linear="1.0"') - 1) < 1e-9);
  ok('linear3D is affine too', Math.abs(sc('linear3D="1.0"') - 1) < 1e-9);
  ok('a variation AMOUNT scales the map', Math.abs(sc('linear3D="0.5"') - 0.5) < 1e-9);
  ok('amounts in the family add', Math.abs(sc('linear="0.3" linear3D="0.4"') - 0.7) < 1e-9);
  ok('preserve_z is not mistaken for a variation',
     Math.abs(sc('linear="1.0" preserve_z="1"') - 1) < 1e-9);
  ok('a real linear3D flame imports', (() => {
      const g = parseFlame(readFileSync(
        new URL('../examples/square-corners-linear3d.flame', import.meta.url), 'utf8'));
      return g.maps.length === 4 && g.warnings.length === 0 &&
             resolveFlame(g).every(m => Math.abs(m.scale - 0.5) < 1e-9);
    })());

  // a post transform must be composed, not silently dropped
  const noPost = resolveFlame(parseFlame(mk('linear3D="1.0"')))[0];
  const withPost = resolveFlame(parseFlame(
    '<flame><xform weight="1" linear3D="1.0" coefs="0.5 0.0 0.0 0.5 0.0 0.0" post="1.0 0.0 0.0 1.0 0.7 0.0"/></flame>'))[0];
  ok('a post transform is applied, not ignored',
     Math.abs(withPost.T[0] - 0.7) < 1e-9, 'T = ' + withPost.T.map(v => v.toFixed(3)).join(','));
  ok('no post transform leaves the map alone', Math.abs(noPost.T[0]) < 1e-12);

  // per-xform VARIATIONS: the flame-editor swap. Type is compiled in, amount is a uniform.
  {
    const { FLAME_VARIATIONS } = await import(new URL('../engine/flame.js', import.meta.url).href);
    ok('the variation list is the invertible subset', FLAME_VARIATIONS.length === 23 &&
       FLAME_VARIATIONS[0].name === 'linear3D' && FLAME_VARIATIONS[1].name === 'spherical3D');
    ok('every variation has a distinct name',
       new Set(FLAME_VARIATIONS.map(v => v.name)).size === FLAME_VARIATIONS.length);
    // each variation type must produce its OWN signature, or two of them share inverse code
    const keys = FLAME_VARIATIONS.map((_, v) => {
      const t = JSON.parse(JSON.stringify(f));
      t.maps.forEach(x => { x.vari = v; });
      return flameKey(t);
    });
    ok('each variation compiles to a distinct signature',
       new Set(keys).size === FLAME_VARIATIONS.length);
    const h = JSON.parse(JSON.stringify(f));
    ok('an imported xform arrives as linear3D', h.maps.every(x => x.vari === 0));
    const k0 = flameKey(h);
    h.maps[1].vari = 1;
    ok('swapping a variation changes the signature key', flameKey(h) !== k0);
    const k1 = flameKey(h);
    h.maps[1].vamt = 2.3; h.maps[1].vp[0] = 1.1; h.maps[1].vp[8] = 1.4;
    ok('changing its amount or parameter does NOT', flameKey(h) === k1);
    ok('the resolved map carries the variation',
       resolveFlame(h)[1].vari === 1 && Math.abs(resolveFlame(h)[1].vamt - 2.3) < 1e-9);
    const rt = apply(capture({ ...defaults, flame: h, stack: [] },
                             { ...defaults, flame: null }, OPS, 'v'), { ...defaults, flame: null }, OPS);
    ok('a preset round-trips the variation choice',
       rt.flame.maps[1].vari === 1 && Math.abs(rt.flame.maps[1].vamt - 2.3) < 1e-9);
    ok('a preset round-trips all 12 parameter slots',
       rt.flame.maps[1].vp.length === 12 &&
       Math.abs(rt.flame.maps[1].vp[0] - 1.1) < 1e-9 &&
       Math.abs(rt.flame.maps[1].vp[8] - 1.4) < 1e-9);
    // slots are pinned per variation, so no two variations may claim the same one
    const claimed = new Map(); let clash = null;
    FLAME_VARIATIONS.forEach(v => (v.params || []).forEach(([i]) => {
      if(claimed.has(i) && claimed.get(i) !== v.name) clash = i;
      claimed.set(i, v.name);
    }));
    ok('no parameter slot is shared between variations', clash === null, 'slot ' + clash);
    h.select = 1;
    ok('selection mode belongs to the flame and joins the key', flameKey(h) !== k1);
  }

  // xform count: an 8-cap silently discarded 12 of a Jerusalem cube's 20 xforms and rendered a
  // different attractor with no visible sign. Pin the cap and the truncation warning.
  {
    const { MAX_XFORMS } = await import(new URL('../engine/flame.js', import.meta.url).href);
    ok('the xform cap is at least 20 (a Jerusalem cube needs 20)', MAX_XFORMS >= 20);
    const jc = parseFlame(readFileSync(
      new URL('../examples/jerusalem-cube.flame', import.meta.url), 'utf8'));
    ok('all 20 Jerusalem-cube xforms survive import', jc.maps.length === 20, jc.maps.length + '');
    ok('and it imports without warnings', jc.warnings.length === 0, jc.warnings.join('; '));
    const scales = new Set(resolveFlame(jc).map(m => m.scale.toFixed(4)));
    ok('both scale families are present (truncation dropped the fine one)',
       scales.size === 2, [...scales].join(', '));
    // over the cap, the loss must be reported rather than silent
    const many = '<flame name="x">' +
      Array.from({ length: MAX_XFORMS + 3 }, () =>
        '<xform weight="1" linear3D="0.5" coefs="1.0 0.0 0.0 1.0 0.1 0.1"/>').join('') + '</flame>';
    const over = parseFlame(many);
    ok('over the cap, xforms are capped', over.maps.length === MAX_XFORMS);
    ok('and the loss is warned about, not silent',
       over.warnings.some(w => /only the first/.test(w)));
  }

  // PLANE ORDER. JWildfire does not record how its three 2D affine blocks compose, so the order
  // is inferred — and one reference object is not enough. A Sierpinski only requires every map to
  // be a 0.5-similarity, which FOUR of the six orders satisfy, and the first version of this
  // parser picked a wrong one from among them. A Jerusalem cube must additionally be ISOTROPIC,
  // and that pins it uniquely. Both properties are asserted here so the order cannot drift back.
  {
    const jc2 = parseFlame(readFileSync(
      new URL('../examples/jerusalem-cube.flame', import.meta.url), 'utf8'));
    const maps = resolveFlame(jc2);
    // forward chaos game: the cheapest way to measure what the attractor actually occupies
    let p = [0, 0, 0];
    const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for(let i = 0; i < 40000; i++){
      const m = maps[Math.floor(rnd() * maps.length) % maps.length];
      const q = [0, 1, 2].map(r => m.M[r*3]*p[0] + m.M[r*3+1]*p[1] + m.M[r*3+2]*p[2] + m.T[r]);
      p = q;
      if(i > 400) for(let a = 0; a < 3; a++){
        if(p[a] < lo[a]) lo[a] = p[a];
        if(p[a] > hi[a]) hi[a] = p[a];
      }
    }
    const ext = [0, 1, 2].map(a => hi[a] - lo[a]);
    const iso = Math.max(...ext) - Math.min(...ext) < 0.02;
    ok('a Jerusalem cube imports ISOTROPIC (pins the plane order)', iso,
       ext.map(v => v.toFixed(3)).join(' x '));
    ok('and spans about one unit per axis', Math.abs(Math.max(...ext) - 1) < 0.02);

    // the Sierpinski constraint must still hold with the same order
    ok('the Sierpinski is still all 0.5-similarities',
       resolveFlame(f).every(m => Math.abs(m.scale - 0.5) < 1e-9));

    // IMAGE BOXES. For an affine IFS the exact selection rule is "whose image contains p", and
    // that is only meaningful if the boxes are computed and genuinely partition the hull.
    ok('the hull is the unit cube', maps.hull &&
       maps.hull.lo.every(v => Math.abs(v) < 1e-9) &&
       maps.hull.hi.every(v => Math.abs(v - 1) < 1e-9),
       maps.hull ? maps.hull.lo + ' .. ' + maps.hull.hi : 'no hull');
    ok('every map carries an image box', maps.every(m => m.blo && m.bhi));
    let overlaps = 0;
    for(let i = 0; i < maps.length; i++)
      for(let j = i + 1; j < maps.length; j++){
        const s3 = [0, 1, 2].every(a =>
          Math.min(maps[i].bhi[a], maps[j].bhi[a]) - Math.max(maps[i].blo[a], maps[j].blo[a]) > 1e-6);
        if(s3) overlaps++;
      }
    ok('the 20 image boxes are disjoint (so the rule is exact here)', overlaps === 0,
       overlaps + ' overlapping pairs');
    ok('every image box sits inside the hull', maps.every(m =>
       [0, 1, 2].every(a => m.blo[a] >= maps.hull.lo[a] - 1e-9 &&
                            m.bhi[a] <= maps.hull.hi[a] + 1e-9)));
  }

  // XAOS. Only the zero pattern is stored, and that is measured rather than assumed: over a
  // five-million-point chaos game, changing WEIGHTS leaves the attractor's support identical
  // (the difference shrinks to nothing as sampling improves) while a single xaos ZERO changes
  // it permanently. Weight shapes density; density is not geometry.
  {
    const { xaosMatrix, xaosIsTrivial, stateHulls } =
      await import(new URL('../engine/flame.js', import.meta.url).href);
    const jx = parseFlameTop(readFileSync(
      new URL('../examples/jerusalem-cube.flame', import.meta.url), 'utf8'));
    let r = resolveFlame(jx);
    ok('a flame with full chaos rows reads as trivial xaos', xaosIsTrivial(r.xaos));

    // per-state hulls must PARTITION, not all contain the origin. Seeding the fixed point from
    // a point instead of iterating down from a bound made every box contain (0,0,0).
    let ov = 0;
    for(let i = 0; i < r.length; i++)
      for(let j = i + 1; j < r.length; j++)
        if([0, 1, 2].every(a => Math.min(r[i].bhi[a], r[j].bhi[a]) -
                                Math.max(r[i].blo[a], r[j].blo[a]) > 1e-6)) ov++;
    ok('per-state hulls are disjoint', ov === 0, ov + ' overlapping pairs');
    ok('and they are not all anchored at the origin',
       r.some(m => m.blo.some(v => v > 1e-6)),
       r[0].blo.join(',') + ' | ' + r[3].blo.join(','));

    // forbidding every route into a transform must make its own set collapse
    const sq2 = parseFlameTop(readFileSync(
      new URL('../examples/square-corners-linear3d.flame', import.meta.url), 'utf8'));
    sq2.maps.forEach(x => { x.chaos = [1, 1, 1, 0]; });
    const r2 = resolveFlame(sq2);
    ok('xaos is no longer trivial', !xaosIsTrivial(r2.xaos));
    const dead = r2[3];
    ok('an unreachable transform collapses to a point',
       [0, 1, 2].every(a => Math.abs(dead.bhi[a] - dead.blo[a]) < 1e-9),
       dead.blo.join(',') + ' .. ' + dead.bhi.join(','));
    ok('xaos joins the shader signature', flameKey(sq2) !== flameKey(jx));

    // XAOS ROWS ARE INDEXED BY POSITION IN THE FILE. Once any xform is disabled, reading them
    // positionally points each row at the wrong column — disabling T2 turned "each may only
    // follow itself" into rows 100/001/000, silently killing the last transform.
    {
      const sq3 = parseFlameTop(readFileSync(
        new URL('../examples/square-corners-linear3d.flame', import.meta.url), 'utf8'));
      sq3.maps.forEach((x, i) => { x.chaos = [0, 0, 0, 0]; x.chaos[i] = 1; });
      const before = resolveFlame(sq3).xaos.map(r => r.join('')).join(' ');
      ok('identity xaos reads back as the identity', before === '1000 0100 0010 0001', before);
      sq3.maps[1].on = false;
      const after = resolveFlame(sq3).xaos.map(r => r.join('')).join(' ');
      ok('disabling an xform REMAPS the xaos rows rather than truncating them',
         after === '100 010 001', after);
    }

    // WEIGHT. Zero removes an xform from the attractor; above zero it is density, not shape.
    {
      const sq4 = parseFlameTop(readFileSync(
        new URL('../examples/square-corners-linear3d.flame', import.meta.url), 'utf8'));
      const full = resolveFlame(sq4);
      ok('the file\u2019s weight survives import',
         sq4.maps.every(x => Math.abs(x.weight - 0.5) < 1e-9),
         sq4.maps.map(x => x.weight).join(','));
      sq4.maps[2].weight = 2.5;
      const heavier = resolveFlame(sq4);
      ok('a non-zero weight change leaves the geometry alone',
         heavier.length === full.length &&
         heavier.every((m, i) => Math.abs(m.scale - full[i].scale) < 1e-12 &&
                                 m.T.every((v, a) => Math.abs(v - full[i].T[a]) < 1e-12)));
      sq4.maps[2].weight = 0;
      const dropped = resolveFlame(sq4);
      ok('zero weight removes the xform from the attractor',
         dropped.length === full.length - 1, dropped.length + ' of ' + full.length);
      ok('and the surviving xaos stays aligned',
         dropped.xaos.length === dropped.length &&
         dropped.xaos.every(r => r.length === dropped.length));
    }

    // and it survives a preset
    const rt2 = apply(capture({ ...defaults, flame: sq2, stack: [] },
                              { ...defaults, flame: null }, OPS, 'x'),
                      { ...defaults, flame: null }, OPS);
    ok('a preset round-trips the xaos matrix',
       JSON.stringify(rt2.flame.maps[0].chaos) === JSON.stringify([1, 1, 1, 0]));
  }

  // EXACTNESS REPORTING. "Image box" is exact only while the image boxes are disjoint. A rotated
  // map's AABB is much larger than its image, so enough rotation makes every box overlap and the
  // rule silently becomes a heuristic. The flame layer must be able to say which case it is in.
  {
    const axis = resolveFlame(parseFlameTop(readFileSync(
      new URL('../examples/jerusalem-cube.flame', import.meta.url), 'utf8')));
    ok('an axis-aligned flame reports the exact rule as applicable',
       axis.boxOverlap && axis.boxOverlap.exact && axis.boxOverlap.overlapping === 0,
       axis.boxOverlap ? axis.boxOverlap.overlapping + '/' + axis.boxOverlap.pairs : 'missing');

    // rotate one transform hard enough and the boxes must be reported as overlapping
    const rot = parseFlameTop(readFileSync(
      new URL('../examples/jerusalem-cube.flame', import.meta.url), 'utf8'));
    rot.maps[0].rot = [131, -91, 0];
    const rr = resolveFlame(rot);
    ok('a rotated transform is reported as NOT exact',
       rr.boxOverlap && !rr.boxOverlap.exact,
       rr.boxOverlap ? rr.boxOverlap.overlapping + '/' + rr.boxOverlap.pairs : 'missing');
    ok('and the pair count is the full pairwise count',
       rr.boxOverlap.pairs === rr.length * (rr.length - 1) / 2);
  }

  // VOXEL MODE. A separate estimator path, so it must be a separate program, and the field
  // itself must come out as a real signed distance function or every consumer of map() breaks.
  {
    const { assemble, signature } = await import(new URL('../engine/assemble.js', import.meta.url).href);
    const { buildField } = await import(new URL('../engine/voxel.js', import.meta.url).href);
    const base = { stack: [], prim: 0, iters: 4, steps: 96, ao: false, shadow: false,
                   glow: false, bounces: 0 };
    ok('voxel mode is a different program', signature(base) !== signature({ ...base, voxel: true }));
    const vs = assemble({ ...base, voxel: true });
    ok('voxel mode replaces the estimator',
       vs.includes('float sdfAt(vec3 p)') && !vs.includes('float s = 1.0;'));
    ok('and keeps map() for every consumer', vs.includes('float map(vec3 p){'));
    ok('sampler3D carries a precision qualifier', vs.includes('highp sampler3D uSdf'));

    // the field must behave like a distance function: negative inside, positive outside, and
    // never changing faster than 1 unit per unit of travel
    const maps = resolveFlame(parseFlameTop(readFileSync(
      new URL('../examples/vicsek-cross.flame', import.meta.url), 'utf8')));
    const f = buildField(maps, 48, 300000);
    ok('the field has interior and exterior',
       f.sdf.some(v => v < 0) && f.sdf.some(v => v > 0));
    let worst = 0;
    const G = f.G, at = (x, y, z) => f.sdf[(z*G + y)*G + x];
    for(let z = 1; z < G - 1; z += 3)
      for(let y = 1; y < G - 1; y += 3)
        for(let x = 1; x < G - 1; x += 3)
          worst = Math.max(worst, Math.abs(at(x+1,y,z) - at(x-1,y,z)) / (2 * f.voxel));
    ok('the field is 1-Lipschitz (a real distance function)', worst <= 1.02, worst.toFixed(4));
    ok('the R8 encoding round-trips the sign',
       [...f.bytes].some(b => b < 128) && [...f.bytes].some(b => b > 128));
  }

  // BEAM. A wider search must produce a DIFFERENT program, must replace the greedy estimator
  // rather than sit beside it, and must never apply to a stack it cannot carry branches through.
  {
    const { assemble, signature, PRIMS } = await import(new URL('../engine/assemble.js', import.meta.url).href);
    const HULL = PRIMS.findIndex(p => p.name === 'Flame hull');
    const fl2 = parseFlameTop(readFileSync(
      new URL('../examples/flame-ifs-base.flame', import.meta.url), 'utf8'));
    const mk = o => assemble({ stack: [{ type: 26, p: [0.2] }], prim: HULL, iters: 8, steps: 128,
                               ao: false, shadow: false, glow: false, bounces: 0, flame: fl2, ...o });
    const one = mk({}), two = mk({ flameBeam: 2 }), four = mk({ flameBeam: 4 });
    ok('beam width changes the program',
       signature({ stack: [{ type: 26, p: [0.2] }], prim: HULL, iters: 8, steps: 128, flame: fl2 }) !==
       signature({ stack: [{ type: 26, p: [0.2] }], prim: HULL, iters: 8, steps: 128, flame: fl2, flameBeam: 2 }));
    ok('width 1 stays greedy', !one.includes('#define BEAM'));
    ok('width 2 and 4 emit a beam',
       two.includes('#define BEAM 2') && four.includes('#define BEAM 4'));
    [['greedy', one], ['beam 2', two], ['beam 4', four]].forEach(([nm, src]) => {
      ok(nm + ' defines exactly one mapT', (src.match(/float mapT\(/g) || []).length === 1);
    });
    // a fold stack interleaves operators between levels, so there is nothing to carry
    const fold = assemble({ stack: [{ type: 8, p: [0.42] }, { type: 5, p: [1] }], prim: 0,
                            iters: 8, steps: 128, ao: false, shadow: false, glow: false,
                            bounces: 0, flameBeam: 4 });
    ok('a fold stack never gets a beam', !fold.includes('#define BEAM'));

    // EVERY variation must reach the beam. The first beam ran a dynamic loop over the transforms
    // with the linear3D inverse written in by hand, so at any search width above 1 every
    // variation silently rendered as linear3D — the geometry was wrong and nothing said so.
    const { FLAME_VARIATIONS } = await import(new URL('../engine/flame.js', import.meta.url).href);
    [1, 2, 4].forEach(width => {
      const seen = new Set();
      for(let v = 0; v < FLAME_VARIATIONS.length; v++){
        const g = parseFlameTop(readFileSync(
          new URL('../examples/flame-ifs-base.flame', import.meta.url), 'utf8'));
        g.select = 3;
        g.maps.forEach(x => { x.vari = v; });
        seen.add(assemble({ stack: [{ type: 26, p: [0.2] }], prim: HULL, iters: 6, steps: 128,
                            ao: false, shadow: false, glow: false, bounces: 0,
                            flame: g, flameBeam: width }));
      }
      ok('search width ' + width + ' emits a distinct shader for all ' +
         FLAME_VARIATIONS.length + ' variations',
         seen.size === FLAME_VARIATIONS.length, seen.size + ' distinct');
    });

    // and the beam must not carry a hand-written inverse of its own
    const bsrc = (() => {
      const g = parseFlameTop(readFileSync(
        new URL('../examples/flame-ifs-base.flame', import.meta.url), 'utf8'));
      g.select = 3; g.maps.forEach(x => { x.vari = 2; });   // swirl
      return assemble({ stack: [{ type: 26, p: [0.2] }], prim: HULL, iters: 6, steps: 128,
                        ao: false, shadow: false, glow: false, bounces: 0, flame: g, flameBeam: 2 });
    })();
    ok('the beam unrolls per transform rather than looping over them',
       !/for\(int i = 0; i < FLAME_N; i\+\+\)/.test(bsrc));
    ok('and a swirl in the beam really is a swirl', /float kk = uFlameVP\[0\]\.x;/.test(bsrc));
    // and the voxel path wins over both, since it has no walk at all
    const vox = mk({ flameBeam: 4, voxel: true });
    ok('voxel mode overrides the beam',
       !vox.includes('#define BEAM') && vox.includes('float sdfAt(vec3 p)'));
  }

  // RESOLVE CACHE. currentCfg() calls resolveFlame on every frame to build the shader signature,
  // and resolveFlame runs a 400-iteration fixed point over every map's corners: 5 ms for 8 maps,
  // 16 ms for 20, twice a frame. That is the entire frame budget spent recomputing something that
  // only changes when a transform is edited.
  //
  // The cache must never return a stale result, which is not free to get right: the first hash
  // used `v * 2^32 | 0`, mapping EVERY integer to zero, so rotations of 13 degrees and scales of
  // 1 were invisible to it.
  {
    const { invalidateFlameCache } = await import(new URL('../engine/flame.js', import.meta.url).href);
    const fc = parseFlameTop(readFileSync(
      new URL('../examples/flame-ifs-base.flame', import.meta.url), 'utf8'));
    const snap = () => JSON.stringify(resolveFlame(fc).map(m => [m.M, m.T, m.blo, m.bhi, m.scale]));

    let stale = 0;
    let seed = 987654321;
    const rnd = () => { seed ^= seed << 13; seed |= 0; seed ^= seed >>> 17;
                        seed ^= seed << 5; seed |= 0; return (seed >>> 0) / 4294967296; };
    for(let t = 0; t < 300; t++){
      const m = fc.maps[(rnd() * fc.maps.length) | 0];
      const pick = (rnd() * 6) | 0;
      // integer-valued edits included ON PURPOSE: they are what the broken hash missed
      if(pick === 0) m.rot[(rnd() * 3) | 0] += Math.round(rnd() * 20 - 10);
      else if(pick === 1) m.tr[(rnd() * 3) | 0] += rnd() * 0.4 - 0.2;
      else if(pick === 2) m.vamt = Math.max(0.05, m.vamt + rnd() * 0.3 - 0.15);
      else if(pick === 3) m.scale = Math.max(1, Math.round(m.scale + rnd() * 2));
      else if(pick === 4) m.T[(rnd() * 3) | 0] += Math.round(rnd() * 4 - 2);
      else m.on = rnd() < 0.85;
      const cached = snap();
      invalidateFlameCache();
      if(cached !== snap()) stale++;
    }
    ok('the resolve cache never returns a stale result', stale === 0, stale + ' of 300 edits');

    // and it must actually be a cache
    invalidateFlameCache();
    let t0 = Date.now(); for(let i = 0; i < 40; i++){ invalidateFlameCache(); resolveFlame(fc); }
    const cold = (Date.now() - t0) / 40;
    resolveFlame(fc);
    t0 = Date.now(); for(let i = 0; i < 4000; i++) resolveFlame(fc);
    const warm = (Date.now() - t0) / 4000;
    ok('a warm resolve is at least 50x faster than a cold one',
       warm * 50 < cold, 'cold ' + cold.toFixed(2) + ' ms, warm ' + warm.toFixed(4) + ' ms');
  }

  // REDRAW ON DEMAND. The loop used to call renderScene every animation frame regardless, so a
  // static image held the GPU at full load forever. The key must move for anything that reaches
  // the shader and must NOT move for a frame that is genuinely unchanged.
  {
    const src = readFileSync(new URL('../main.js', import.meta.url), 'utf8');
    const blk = src.slice(src.indexOf('let renderEpoch = 0;'), src.indexOf('function frame(now){'));
    const harness = blk + `
      ;globalThis.__probe = () => {
        const out = {};
        const a = renderKey();
        state.camDist += 0.01;            out.camera = renderKey() !== a; state.camDist -= 0.01;
        const b = renderKey();
        state.stack[0].p[0] += 0.5;       out.stackParam = renderKey() !== b; state.stack[0].p[0] -= 0.5;
        const c = renderKey();
        W += 1;                           out.canvasSize = renderKey() !== c; W -= 1;
        const d = renderKey();
        renderEpoch++;                    out.epoch = renderKey() !== d;
        const e = renderKey();
        curSig += 'x';                    out.program = renderKey() !== e;
        const f = renderKey();
        animTime += 5;                    out.staticIgnoresTime = renderKey() === f;
        state.autoSpin = 0.4;
        const g = renderKey();
        animTime += 5;                    out.spinFollowsTime = renderKey() !== g;
        state.autoSpin = 0;
        const h = renderKey();
        out.stableWhenNothingChanges = renderKey() === h;
        return out;
      };`;
    const state = { camDist: 5, fov: 1.3, iters: 8, autoSpin: 0,
                    stack: [{ type: 3, p: [1, 2], o: [0,0,0], r: [0,0,0] }], flame: null };
    let W = 800, H = 600, animTime = 0, cur = null, curSig = 'sig';
    const resolveFlame = () => [];
    const fn = new Function('state', 'W', 'H', 'animTime', 'cur', 'curSig', 'resolveFlame',
      harness + '\nreturn __probe();');
    const r = fn(state, W, H, animTime, cur, curSig, resolveFlame);
    ok('the redraw key follows the camera', r.camera);
    ok('...and fold-stack parameters', r.stackParam);
    ok('...and the canvas size', r.canvasSize);
    ok('...and things outside state, via the epoch', r.epoch);
    ok('...and the compiled program', r.program);
    ok('a static frame ignores elapsed time', r.staticIgnoresTime);
    ok('auto-spin makes it follow time again', r.spinFollowsTime);
    ok('and it is stable when nothing changes', r.stableWhenNothingChanges);

    // The variation index and its parameter SLOTS are uniforms, so they never move the shader
    // signature. If the redraw key ignores them, turning a variation's dial changes nothing on
    // screen and the frame is correctly judged identical — the most confusing kind of bug.
    const kb = src.slice(src.indexOf('function renderKey()'), src.indexOf('function usesTime()'));
    ok('the redraw key includes the variation index', /mix\(m\.vari\)/.test(kb));
    ok('...and its parameter slots', /m\.vp\.forEach\(mix\)/.test(kb));
    ok('...and the per-map image boxes', /m\.blo\.forEach\(mix\)/.test(kb));

    ok('the frame loop only draws when the key moves',
       /if\(key !== lastDrawKey\)\{[\s\S]{0,120}renderScene\(W, H\)/.test(src));
  }

  // EXPORT MUST NOT BLOCK. The export used to spin on cache.request waiting for the supersampled
  // program to link. That cannot work: a parallel compile reports completion through the driver,
  // which generally needs the main thread back in the event loop first, so the busy-wait blocked
  // the very thing it waited for — an 8-second frozen tab and then a silent fallback to 1x1.
  {
    const js2 = readFileSync(new URL('../main.js', import.meta.url), 'utf8');
    ok('nothing busy-waits on a program', !/while\s*\(\s*!r\.ready/.test(js2));
    ok('the program wait yields to the event loop',
       /function awaitProgram[\s\S]{0,400}requestAnimationFrame\(tick\)/.test(js2));
    ok('export and quick render are async', /async function savePNG\(/.test(js2) &&
       /async function quickRender\(/.test(js2));
    ok('and both await the program', (js2.match(/await withSamples\(/g) || []).length === 2);

    // the canvas lock must be released on EVERY path, including one that never calls back
    // slice FORWARD from savePNG. quickRender is defined earlier in the file, so slicing to it
    // runs backwards and yields nothing — the same mistake that once corrupted the README.
    // slice to the next TOP-LEVEL declaration, whatever kind it is. A fixed character budget was
    // used here before and quietly stopped reaching the end of the function once the tile loop
    // made savePNG longer — the assertions then passed on text they could no longer see.
    const spStart = js2.indexOf('async function savePNG(');
    const after = js2.slice(spStart + 10);
    const rel = after.search(/\n(?:async function|function|const|let) /);
    const sp = js2.slice(spStart, rel >= 0 ? spStart + 10 + rel : js2.length);
    ok('the savePNG slice is non-empty', sp.length > 500, sp.length + ' chars');
    ok('the frame loop stands off during an export', /if\(exporting\)\{/.test(js2));
    ok('restore runs at most once', /if\(restored\) return;/.test(sp));
    ok('a watchdog releases the lock if encoding never calls back',
       /setTimeout\([\s\S]{0,200}restore\(\)/.test(sp));
    ok('the watchdog is cancelled on success', /clearTimeout\(watchdog\)/.test(sp));
  }

  // NON-AFFINE FLAMES. resolveXform builds each map's matrix from the AFFINE part only, so a
  // transform carrying a variation is described by a matrix that is not the map being rendered.
  // The hull, the image boxes and every containment test come off those matrices. With `exp` at
  // amount 0.015 the affine part is tiny and the hull collapsed to 0.003 units across while the
  // real attractor spanned 0.028 — no container, and the render was a wash of false surface.
  {
    const { applyVariation, isAffine } = await import(new URL('../engine/varfwd.js', import.meta.url).href);
    const X = o => ({ M: [1,0,0,0,1,0,0,0,1], T: [0,0,0], scale: 1, rot: [0,0,0], tr: [0,0,0],
                      vari: 0, vamt: 1, vp: [0.8,2,0,0,0,0,0,0,1,0,0,0],
                      chaos: null, on: true, weight: 1, ...o });
    const expFlame = { name: 'x', select: 2, maps: [
      X({ T: [-1,-1,0], scale: 0.25, rot: [-72,67.5,-10], vari: 4, vamt: 0.015,
          vp: [0.8,0.425,0,0,0,0,0,0,1,0,0,0], weight: 0.5 }),
      X({ M: [0.5,0,0,0,0.5,0,0,0,0.5], vari: 0, vamt: -1.23, weight: 1 }) ] };
    const rr = resolveFlame(expFlame);
    ok('a flame with a variation is reported as non-affine', rr.affine === false);
    const span = Math.max(...[0,1,2].map(a => rr.hull.hi[a] - rr.hull.lo[a]));
    ok('and its hull is measured, not collapsed', span > 0.01, 'span ' + span.toFixed(4));

    // the sampled hull must actually contain the attractor it measured
    let seed = 7, inside = 0, total = 0;
    const rnd = () => { seed ^= seed << 13; seed |= 0; seed ^= seed >>> 17;
                        seed ^= seed << 5; seed |= 0; return (seed >>> 0) / 4294967296; };
    let pt = [0,0,0];
    for(let i = 0; i < 4000; i++){
      const m = rr[(rnd() * rr.length) | 0];
      const a = m.Aff, t = m.Taf;
      const q = [a[0]*pt[0]+a[1]*pt[1]+a[2]*pt[2]+t[0],
                 a[3]*pt[0]+a[4]*pt[1]+a[5]*pt[2]+t[1],
                 a[6]*pt[0]+a[7]*pt[1]+a[8]*pt[2]+t[2]];
      pt = applyVariation(m.vari | 0, q, m.vamt, m.vp);
      if(!pt.every(Number.isFinite)){ pt = [0,0,0]; continue; }
      if(i < 100) continue;
      total++;
      if([0,1,2].every(a2 => pt[a2] >= rr.hull.lo[a2] && pt[a2] <= rr.hull.hi[a2])) inside++;
    }
    ok('the measured hull contains the attractor it measured',
       total > 0 && inside / total > 0.995, (100 * inside / Math.max(total,1)).toFixed(1) + '%');

    // affine flames must be untouched: the fixed point is exact for them and cheaper
    const jc4 = resolveFlame(parseFlameTop(readFileSync(
      new URL('../examples/jerusalem-cube.flame', import.meta.url), 'utf8')));
    ok('an affine flame still uses the exact fixed point', jc4.affine === true);
    ok('and its hull is unchanged', jc4.hull.hi.every(v => Math.abs(v - 1) < 1e-6));
    ok('isAffine keys off the variation', isAffine({ vari: 0 }) && !isAffine({ vari: 4 }));
  }

  // RUNAWAY SCALE. Every flame failure in this project's history has the same shape: the
  // accumulated expansion grows past the point where prim(q)/s is representable and the frame
  // reads as solid. The floor is predictable from the amount alone, so it can be reported rather
  // than discovered by sliding things at random.
  {
    const { inverseFloor, projectedScale } = await import(new URL('../engine/flame.js', import.meta.url).href);
    const { assemble, signature } = await import(new URL('../engine/assemble.js', import.meta.url).href);
    const X = o => ({ M:[1,0,0,0,1,0,0,0,1], T:[0,0,0], scale:1, rot:[0,0,0], tr:[0,0,0],
                      vari:0, vamt:1, vp:[0.8,2,0,0,0,0,0,0,1,0,0,0],
                      chaos:null, on:true, weight:1, ...o });
    const mk = maps => resolveFlame({ name:'t', select:2, maps });

    ok('a small amount raises the inverse floor',
       inverseFloor({ vari:5, vamt:0.1 }) > 9 && inverseFloor({ vari:5, vamt:1.0 }) < 1.1);
    ok('spherical3D is an involution, so its amount cancels',
       Math.abs(inverseFloor({ vari:1, vamt:0.01 }) - 1) < 1e-9);

    const bad = mk([X({ vari:4, vamt:0.015, scale:0.25 }),
                    X({ M:[0.5,0,0,0,0.5,0,0,0,0.5], vamt:-1.23 })]);
    const good = mk([X({ vari:5, vamt:0.7, scale:0.55 }), X({ vamt:0.6 }), X({ vamt:-0.6 })]);
    ok('the pathological flame is projected as runaway', projectedScale(bad, 8) > 1e15,
       projectedScale(bad, 8).toExponential(1));
    ok('and a healthy one is not', projectedScale(good, 9) < 1e6,
       projectedScale(good, 9).toExponential(1));

    // the ceiling itself
    const base = { stack:[{type:8,p:[0.42]}], prim:0, iters:8, steps:128,
                   ao:false, shadow:false, glow:false, bounces:0 };
    ok('no ceiling by default', !assemble(base).includes('if(s >'));
    ok('a ceiling emits an early exit', assemble({ ...base, scaleCap: 1e5 }).includes('break;'));
    ok('and changes the program', signature(base) !== signature({ ...base, scaleCap: 1e5 }));
    ok('ceilings are distinct programs',
       signature({ ...base, scaleCap: 1e4 }) !== signature({ ...base, scaleCap: 1e8 }));
  }

  // CROP BOX. Applied in ONE wrapper around every estimator variant, so the greedy walk, the
  // beam, the voxel field, and the shadow / AO / reflection paths all see the same cropped
  // object. Cropping inside a single estimator would give a cropped shape with an uncropped
  // shadow.
  {
    const { assemble, signature } = await import(new URL('../engine/assemble.js', import.meta.url).href);
    const base = { stack: [{ type: 8, p: [0.42] }], prim: 0, iters: 6, steps: 128,
                   ao: true, shadow: true, glow: false, bounces: 1 };
    const off = assemble(base), on = assemble({ ...base, crop: true });
    ok('crop emits nothing when off', !off.includes('d = max(d, cb);'));
    ok('crop is an intersection when on',
       on.includes('d = max(d, cb);') && on.includes('safe = max(safe, cb);'));
    ok('and changes the program', signature(base) !== signature({ ...base, crop: true }));
    ok('there is exactly one mapT wrapper',
       (on.match(/float mapT\(vec3 p, out vec4 trap, out float safe\)\{/g) || []).length === 1);
    ok('the estimators became mapTinner', on.includes('float mapTinner('));
    // it must reach every variant, including the ones with their own estimator
    const fl5 = parseFlameTop(readFileSync(
      new URL('../examples/flame-ifs-base.flame', import.meta.url), 'utf8'));
    fl5.select = 3;
    const fb = { stack: [{ type: 26, p: [0.2] }], prim: 7, iters: 6, steps: 128,
                 ao: false, shadow: false, glow: false, bounces: 0, flame: fl5, crop: true };
    ok('the beam variant is cropped too',
       assemble({ ...fb, flameBeam: 2 }).includes('d = max(d, cb);'));
    ok('and the voxel variant', assemble({ ...fb, voxel: true }).includes('d = max(d, cb);'));
  }

  // COLLAPSED NOTES. Every explanatory note folds away behind a disclosure arrow, done by walking
  // the finished panel rather than by editing each note, so notes added later are covered.
  {
    const js3 = readFileSync(new URL('../main.js', import.meta.url), 'utf8');
    const html3 = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    ok('there is a single collapse pass', /function collapseNotes\(root\)/.test(js3));
    ok('it walks for p.note rather than naming each one', /querySelectorAll\('p\.note'\)/.test(js3));
    ok('it is idempotent', /classList\.contains\('notewrap'\)/.test(js3));
    ok('it runs after both panel builds',
       (js3.match(/collapseNotes\(document\.body\)/g) || []).length === 2);
    ok('a warning keeps its first words on the summary line', /warn \? txt\.split/.test(js3));
    ok('the disclosure arrow is styled', /details\.notewrap>summary::before/.test(html3));
  }

  // IMAGE AMBIGUITY. The pairwise box count measures AABBs, which inflate around a rotated image
  // and overstate the problem. What decides whether ANY selection rule can be exact is whether the
  // images themselves overlap — p is in image i exactly when f_i^-1(p) is in the hull.
  //
  // This was checked before building oriented bounding boxes, and it is why they were NOT built:
  // exact image containment moved ambiguity only 23.5% -> 21.2% on the flame that motivated them,
  // so AABB inflation was not the cause. The overlap is genuine.
  {
    for(const [nm, want] of [['jerusalem-cube', 0], ['vicsek-cross', 0], ['corner-shell', 0]]){
      const r = resolveFlame(parseFlameTop(readFileSync(
        new URL('../examples/' + nm + '.flame', import.meta.url), 'utf8')));
      ok(nm + ' has disjoint images', r.ambiguity < 0.01,
         (100 * r.ambiguity).toFixed(1) + '%');
    }
    const fb = resolveFlame(parseFlameTop(readFileSync(
      new URL('../examples/flame-ifs-base.flame', import.meta.url), 'utf8')));
    ok('the rotated default flame has genuinely overlapping images', fb.ambiguity > 0.2,
       (100 * fb.ambiguity).toFixed(1) + '%');
    ok('ambiguity is a fraction', fb.ambiguity >= 0 && fb.ambiguity <= 1);
    // deterministic: the same flame must not report a different figure each call
    const { invalidateFlameCache: inv2 } =
      await import(new URL('../engine/flame.js', import.meta.url).href);
    inv2();
    const a1 = resolveFlame(parseFlameTop(readFileSync(
      new URL('../examples/flame-ifs-base.flame', import.meta.url), 'utf8'))).ambiguity;
    ok('and it is deterministic', Math.abs(a1 - fb.ambiguity) < 1e-12);
  }

  // OVERLAP TRIM. Shrinks each transform's selection region toward its centre. It must reach the
  // box AND blend rules, and the beam, and must leave the flame itself alone — the maps, the
  // attractor and the hull are not touched, only which valid branch the walk commits to.
  {
    const { assemble, signature } = await import(new URL('../engine/assemble.js', import.meta.url).href);
    const ft = parseFlameTop(readFileSync(
      new URL('../examples/flame-ifs-base.flame', import.meta.url), 'utf8'));
    const base = { stack: [{ type: 26, p: [0.2] }], prim: 7, iters: 6, steps: 128,
                   ao: false, shadow: false, glow: false, bounces: 0 };
    const withSel = sel => { const f2 = { ...ft, select: sel, maps: ft.maps }; return assemble({ ...base, flame: f2 }); };
    ok('the box rule selects on trimmed regions', withSel(2).includes('sdBoxLoHi(p, trimLo('));
    ok('the blend rule does too', withSel(3).includes('mix(sdBoxLoHi(p, trimLo('));
    ok('nearest image is unaffected', !withSel(0).includes('trimLo('));
    ok('nearest fixed point is unaffected', !withSel(1).includes('trimLo('));
    const f3 = { ...ft, select: 2, maps: ft.maps };
    ok('the beam selects on trimmed regions too',
       assemble({ ...base, flame: f3, flameBeam: 2 }).includes('trimLo('));
    ok('the helper is declared before it is used', (src => {
      const a = src.indexOf('vec3 trimLo(int i)'), b = src.indexOf('sdBoxLoHi(p, trimLo(');
      return a >= 0 && b > a;
    })(withSel(2)));
    // the trim is a uniform, so it must NOT change the program
    ok('trimming does not force a recompile',
       signature({ ...base, flame: f3 }) === signature({ ...base, flame: f3 }));
    // and it must not disturb the resolved flame at all
    const before = JSON.stringify(resolveFlame(f3).map(m => [m.M, m.T, m.blo, m.bhi]));
    const after = JSON.stringify(resolveFlame(f3).map(m => [m.M, m.T, m.blo, m.bhi]));
    ok('the flame itself is untouched by the trim', before === after);
  }

  // FLY CAMERA. Orbit and flight are different parameterisations of the same view, and the whole
  // point of having both is composing in one and moving in the other — so the handover must not
  // move the picture. A jump on mode switch would make the mode useless for its purpose.
  {
    const js4 = readFileSync(new URL('../main.js', import.meta.url), 'utf8');
    const blk = js4.slice(js4.indexOf('function camPos(){'),
                          js4.indexOf('// Supersampling is compile-time'));
    const mk = () => {
      const state = { camMode: 0, camDist: 5.2, camAzim: 0.9, camElev: 0.35,
                      tgtX: 0.4, tgtY: -0.2, tgtZ: 1.1,
                      flyX: 0, flyY: 0, flyZ: 0, flyYaw: 0, flyPitch: 0, flySpeed: 1 };
      const fn = new Function('state', blk + `
        const norm = v => { const l = Math.hypot(...v) || 1; return v.map(x => x / l); };
        const dir = () => { const p = camPos(), t = camTgt();
                            return norm([t[0]-p[0], t[1]-p[1], t[2]-p[2]]); };
        return { camPos, camTgt, syncCameraMode, dir };`);
      return { state, api: fn(state) };
    };
    const { state, api } = mk();
    const eq = (a, b, t) => a.every((v, i) => Math.abs(v - b[i]) < t);

    const p0 = api.camPos(), d0 = api.dir();
    api.syncCameraMode(true); state.camMode = 1;
    ok('entering flight holds the position', eq(p0, api.camPos(), 1e-9));
    ok('entering flight holds the heading', eq(d0, api.dir(), 1e-6));
    const p1 = api.camPos(), d1 = api.dir();
    api.syncCameraMode(false); state.camMode = 0;
    ok('leaving flight holds the position', eq(p1, api.camPos(), 1e-6));
    ok('leaving flight holds the heading', eq(d1, api.dir(), 1e-6));

    let worst = 0;
    for(const [az, el, dd] of [[0.3,0.9,2],[2.9,-1.2,7],[-1.1,0,1.3],[5.0,1.4,20]]){
      state.camMode = 0; state.camAzim = az; state.camElev = el; state.camDist = dd;
      const a = api.camPos(), ad = api.dir();
      api.syncCameraMode(true);  state.camMode = 1;
      api.syncCameraMode(false); state.camMode = 0;
      const b = api.camPos(), bd = api.dir();
      worst = Math.max(worst, ...a.map((v, i) => Math.abs(v - b[i])),
                              ...ad.map((v, i) => Math.abs(v - bd[i])));
    }
    ok('a round trip through flight is lossless', worst < 1e-9, worst.toExponential(1));

    // pitch must stop short of vertical: at exactly +/-90 degrees the up vector is parallel to
    // the view direction and the frame spins on its own
    ok('pitch is clamped short of vertical', /Math\.min\(1\.55, state\.flyPitch/.test(js4));
    ok('flight rises along WORLD up, not camera up', /if\(keys\['e'\]\) \{ dy \+= 1; \}/.test(js4));
    ok('diagonal movement is normalised', /Math\.hypot\(dx, dy, dz\)/.test(js4));
    ok('the wheel sets speed in flight', /state\.flySpeed = Math\.max\(0\.002/.test(js4));
    ok('auto-spin applies to orbit only', /if\(!state\.camMode\) state\.camAzim \+= state\.autoSpin/.test(js4));
    ok('orbit-only sliders are hidden in flight', /if\(only === 'orbit' && state\.camMode\) return;/.test(js4));

    // "keep current camera" has to keep the WHOLE camera. Holding the orbit values while the mode
    // snaps back, or holding the mode while the position jumps, are both worse than keeping none.
    const camKeys = (js4.match(/const CAM_KEYS = \[([\s\S]*?)\];/) || [])[1] || '';
    for(const k of ['camMode', 'flyX', 'flyY', 'flyZ', 'flyYaw', 'flyPitch', 'flySpeed'])
      ok('keep-camera covers ' + k, camKeys.includes("'" + k + "'"));
  }

  // TILED EXPORT. The image is rendered in tiles and composited, so the WebGL drawing buffer is
  // never bigger than one tile. The tiles must line up EXACTLY: the shader has to cast the rays it
  // would have cast at full resolution, which means uRes reports the full image and uTileOrigin
  // says where the tile sits in it. Verified elsewhere as pixel-identical to a single pass.
  {
    const { assemble, signature } = await import(new URL('../engine/assemble.js', import.meta.url).href);
    const base = { stack: [{ type: 8, p: [0.42] }], prim: 0, iters: 6, steps: 128,
                   ao: false, shadow: false, glow: false, bounces: 0 };
    const a = assemble(base), b = assemble({ ...base, aa: 2 });
    ok('the primary ray takes the tile origin',
       a.includes('gl_FragCoord.xy + uTileOrigin - uRes * 0.5'));
    ok('and so do the supersampled rays',
       b.includes('+ off + uTileOrigin - uRes * 0.5'));
    ok('tiling is a uniform, not a program variant', signature(base) === signature(base));

    const js5 = readFileSync(new URL('../main.js', import.meta.url), 'utf8');
    ok('uRes reports the FULL image while tiling',
       /u2\(L, 'uRes', tileFullW \|\| w, tileFullH \|\| h\)/.test(js5));
    ok('the tile origin is uploaded', /u2\(L, 'uTileOrigin', tileOx, tileOy\)/.test(js5));
    // GL counts rows from the bottom, the 2D canvas from the top; get this wrong and the strips
    // come out in the wrong order, which looks like corruption rather than a flip
    ok('the tile origin is expressed in GL row order',
       /tileOy = sh - \(ty \* th \+ thA\)/.test(js5));
    ok('rows are flipped into canvas order', /const src = \(thA - 1 - y\) \* twA \* 4/.test(js5));
    ok('the loop yields between tiles', /await nextFrame\(\)/.test(js5));
    ok('tile state is cleared after the export',
       /tileFullW = 0; tileFullH = 0; tileOx = 0; tileOy = 0;/.test(js5));
    // withSamples must AWAIT its draw callback. The tiled export yields between tiles, so an
    // un-awaited callback lets withSamples resolve at the first await: the supersampled program
    // and the sample count get restored while tiles are still rendering, and the caller carries
    // on and encodes a half-drawn canvas. The export looked plausible and was simply wrong.
    const ws2 = js5.slice(js5.indexOf('async function withSamples('),
                          js5.indexOf('function renderScene('));
    ok('withSamples awaits its draw callback', /try \{ await draw\(used, ok\); \}/.test(ws2));
    ok('and restores only afterwards',
       ws2.indexOf('await draw(used, ok)') < ws2.indexOf('finally { renderAA = prevAA'));
    ok('the tiled export passes an async callback',
       /await withSamples\(state\.aaExport, async \(n, ok\) =>/.test(js5));

    ok('the composite canvas is size-checked before rendering',
       /out\.width !== sw \|\| out\.height !== sh/.test(js5));
    ok('encoding reads the composite, not the GL canvas', /out\.toBlob\(async blob/.test(js5));

    // PARTIAL TILES. The first version assumed the image divided evenly by the tile size. It
    // almost never does — 2528x1422 at 1024 leaves a 480-wide column and a 398-tall row — and the
    // bottom row got a NEGATIVE origin, so it rendered a band from outside the frame and pasted
    // it over the picture. The divides-evenly case passed the whole time.
    const tileCover = (sw, sh, T) => {
      let covered = 0, bad = 0;
      const cols = Math.ceil(sw / T), rows = Math.ceil(sh / T);
      for(let ty = 0; ty < rows; ty++) for(let tx = 0; tx < cols; tx++){
        const twA = Math.min(T, sw - tx * T), thA = Math.min(T, sh - ty * T);
        const oy = sh - (ty * T + thA);
        if(oy < 0 || tx * T + twA > sw || ty * T + thA > sh || twA <= 0 || thA <= 0) bad++;
        covered += twA * thA;
      }
      return { covered, bad, want: sw * sh };
    };
    for(const [sw, sh, T] of [[2528,1422,1024],[3840,2160,1024],[250,141,100],[1024,1024,1024],[1,1,1024]]){
      const r2 = tileCover(sw, sh, T);
      ok('tiles cover ' + sw + 'x' + sh + ' exactly, none out of bounds',
         r2.bad === 0 && r2.covered === r2.want,
         r2.bad + ' bad, ' + r2.covered + '/' + r2.want);
    }
    ok('the tile loop uses the tile\u2019s REAL size',
       /const twA = Math\.min\(tw, sw - tx \* tw\)/.test(js5) &&
       /const thA = Math\.min\(th, sh - ty \* th\)/.test(js5));
    ok('the origin is the bottom of the strip actually covered',
       /tileOy = sh - \(ty \* th \+ thA\)/.test(js5));
    ok('the viewport matches the tile, so it cannot overrun',
       /renderScene\(twA, thA\)/.test(js5));
    ok('readback and paste use the real size',
       /gl\.readPixels\(0, 0, twA, thA/.test(js5) &&
       /new ImageData\(flip, twA, thA\), tx \* tw, ty \* th/.test(js5));

    // the larger sizes only make sense because of tiling
    const sizes = (js5.match(/const EXPORT_SIZES = \[([\s\S]*?)\];/) || [])[1] || '';
    ok('the export list reaches 8640 px', sizes.includes('8640'));
  }

  // KEYFRAMES. The load-bearing rule is that BAKED parameters must STEP rather than blend.
  // Interpolating one asks for a different shader every frame, which is a recompile per frame —
  // a stutter, not an animation. Angles are the other special case: azimuth wraps, so a naive
  // lerp from +170 to -170 degrees takes the long way round and the camera spins backwards
  // through the whole scene.
  {
    const anim = await import(new URL('../engine/anim.js', import.meta.url).href);
    const { assemble, signature } = await import(new URL('../engine/assemble.js', import.meta.url).href);
    const mainSrc2 = readFileSync(new URL('../main.js', import.meta.url), 'utf8');
    const DEF2 = (new Function(
      mainSrc2.slice(mainSrc2.indexOf('const state = {'), mainSrc2.indexOf('\n};')) +
      '\n};\nreturn state;'))();
    const mk = over => capture({ ...DEF2, ...over,
      stack: [{ type: 8, p: [0.42], o: [0,0,0], r: [0,0,0] },
              { type: 5, p: [1.0], o: [0,0,0], r: [0,0,0] }], flame: null }, DEF2, OPS, 'k');

    // EVERY field that reaches the shader signature must be in STEP_KEYS, or it would be blended
    const sigSrc = readFileSync(new URL('../engine/assemble.js', import.meta.url), 'utf8');
    const sigBody = sigSrc.slice(sigSrc.indexOf('export function signature('),
                                 sigSrc.indexOf('export function assemble('));
    // Two kinds of baked parameter, and only one of them has to step.
    //
    //   VALUE gate:  `c.iters`        — the literal itself is compiled in. Blending it asks for a
    //                                   different program every frame, so it MUST step.
    //   BOOLEAN gate: `c.ao ? 1 : 0`  — only zero versus non-zero reaches the shader. Fading one
    //                                   crosses the threshold ONCE, which is a single swap, and
    //                                   fading it smoothly is the behaviour you want.
    //
    // Conflating the two would either churn programs or refuse to fade ambient occlusion.
    const gated = new Set((sigBody.match(/c\.([A-Za-z][A-Za-z0-9]*)\s*(\?|>)/g) || [])
      .map(x => x.slice(2).replace(/\s*(\?|>)$/, '')));
    const baked = [...new Set((sigBody.match(/c\.([A-Za-z][A-Za-z0-9]*)/g) || [])
      .map(x => x.slice(2)))]
      .filter(k => k in DEF2 && k !== 'stack' && !gated.has(k));
    const unstepped = baked.filter(k => !anim.STEP_KEYS.has(k));
    ok('every VALUE-baked parameter steps rather than blends',
       unstepped.length === 0, unstepped.join(', '));
    ok('and the boolean-gated ones are left free to fade',
       ['ao', 'glow', 'transp', 'disp'].every(k => !anim.STEP_KEYS.has(k)));

    // a fade of a gated parameter must cross its threshold once, not repeatedly
    const g0 = { t: 0, preset: mk({ ao: 0 }) }, g1 = { t: 1, preset: mk({ ao: 1 }) };
    let flips = 0, was = null;
    for(let i = 0; i <= 30; i++){
      const on = anim.sampleTimeline([g0, g1], i / 30, apply, DEF2, OPS, {}).ao > 0;
      if(was !== null && on !== was) flips++;
      was = on;
    }
    ok('fading a gated parameter swaps the program once at most', flips <= 1, flips + ' flips');

    // and prove it end to end: sampling a move that changes baked params must not churn programs
    const k0 = { t: 0, preset: mk({ camDist: 5, iters: 8,  prim: 0, exposure: 1.0, bounces: 0 }) };
    const k1 = { t: 1, preset: mk({ camDist: 9, iters: 16, prim: 3, exposure: 1.6, bounces: 2 }) };
    const sigOf = st => signature({ stack: st.stack, prim: st.prim, primStyle: st.primStyle,
      iters: st.iters, steps: st.steps, ao: st.ao > 0, shadow: st.shadow > 0, glow: st.glow > 0,
      bounces: st.bounces, seamSurf: st.seamSurf > 0.5, feedback: st.feedback, aa: 1, flameN: 0 });
    const seen = new Set();
    for(let i = 0; i <= 40; i++)
      seen.add(sigOf(anim.sampleTimeline([k0, k1], i / 40, apply, DEF2, OPS, { easing: 1 })));
    ok('a 41-frame sample uses only 2 programs', seen.size === 2, seen.size + '');

    const mid = anim.sampleTimeline([k0, k1], 0.5, apply, DEF2, OPS, {});
    ok('baked iterations hold at the outgoing value', mid.iters === 8, String(mid.iters));
    ok('continuous values do interpolate', Math.abs(mid.exposure - 1.3) < 1e-6,
       mid.exposure.toFixed(3));
    const end = anim.sampleTimeline([k0, k1], 1, apply, DEF2, OPS, {});
    ok('and the far key is reached exactly', end.iters === 16 && Math.abs(end.exposure - 1.6) < 1e-9);

    // angles take the short way: measure the SWEPT angle, ignoring 2pi representation wraps
    const wrap = d => { d %= 2 * Math.PI; if(d > Math.PI) d -= 2 * Math.PI;
                        if(d < -Math.PI) d += 2 * Math.PI; return d; };
    const swept = (a, b) => {
      const ks = [{ t: 0, preset: mk({ camAzim: a }) }, { t: 1, preset: mk({ camAzim: b }) }];
      let sum = 0, prev = a;
      for(let i = 1; i <= 120; i++){
        const v = anim.sampleTimeline(ks, i / 120, apply, DEF2, OPS, {}).camAzim;
        sum += Math.abs(wrap(v - prev)); prev = v;
      }
      return sum * 180 / Math.PI;
    };
    ok('a wrap-around turn takes the short way', Math.abs(swept(2.9671, -2.9671) - 20) < 1.5,
       swept(2.9671, -2.9671).toFixed(1) + ' deg, short way is 20');
    ok('an ordinary turn is unaffected', Math.abs(swept(0, Math.PI * 0.9) - 162) < 1.5);

    // easings are well behaved at the ends, or keys would not be hit exactly
    ok('every easing hits 0 and 1 exactly',
       anim.EASINGS.every((_, i) => anim.ease(i, 0) === 0 && anim.ease(i, 1) === 1));

    // structural changes step rather than producing nonsense
    const diffStack = { t: 1, preset: capture({ ...DEF2,
      stack: [{ type: 13, p: [2,2,2], o: [0,0,0], r: [0,0,0] }], flame: null }, DEF2, OPS, 'z') };
    const sm = anim.sampleTimeline([k0, diffStack], 0.5, apply, DEF2, OPS, {});
    ok('a stack of a different shape steps instead of blending',
       sm.stack.length === 2 && sm.stack[0].type === 8);

    ok('a single key samples as itself',
       anim.sampleTimeline([k0], 0.7, apply, DEF2, OPS, {}).iters === 8);
    ok('an empty timeline samples as nothing',
       anim.sampleTimeline([], 0.5, apply, DEF2, OPS, {}) === null);
  }

  // rejection paths
  const bad = '<flame name="x"><xform weight="1" linear="1.0" spherical="0.5" coefs="1 0 0 1 0 0"/></flame>';
  let threw = false;
  try { parseFlame(bad); } catch(e){ threw = true; }
  ok('nonlinear variations are rejected, not mangled', threw);
  let threw2 = false;
  try { parseFlame('<flame name="x"></flame>'); } catch(e){ threw2 = true; }
  ok('a flame with no xforms is rejected', threw2);

  // flameKey drives the shader signature, and it tracks the ACTIVE COUNT only. That is the
  // point of moving the matrices to uniforms: editing a transform must NOT force a rebuild,
  // while adding, removing or disabling one must.
  ok('flameKey is stable', flameKey(f) === flameKey(parseFlame(src)));
  const moved = JSON.parse(JSON.stringify(f));
  moved.maps[0].rot = [10, 20, 30]; moved.maps[0].tr = [0.4, 0, 0];
  ok('editing a transform does NOT trigger a rebuild', flameKey(moved) === flameKey(f));
  const dropped = JSON.parse(JSON.stringify(f));
  dropped.maps[0].on = false;
  ok('disabling a transform DOES trigger a rebuild', flameKey(dropped) !== flameKey(f));

  // presets must carry the flame
  const st = { ...defaults, flame: f, stack: [] };
  const back = apply(capture(st, { ...defaults, flame: null }, OPS, 'f'), { ...defaults, flame: null }, OPS);
  ok('a preset round-trips the flame', back.flame && back.flame.maps.length === 4);
  ok('restored maps resolve to the same geometry',
     resolveFlame(back.flame).every((m, i) => Math.abs(m.expand - R0[i].expand) < 1e-6));

  const edited = JSON.parse(JSON.stringify(f));
  edited.maps[2].rot = [12, 34, 56]; edited.maps[2].tr = [0.3, -0.2, 0.1];
  edited.maps[3].on = false;
  const b2 = apply(capture({ ...defaults, flame: edited, stack: [] },
                           { ...defaults, flame: null }, OPS, 'e'), { ...defaults, flame: null }, OPS);
  ok('a preset round-trips the EDITS, not a flattened matrix',
     JSON.stringify(b2.flame.maps[2].rot) === JSON.stringify([12, 34, 56]) &&
     b2.flame.maps[3].on === false);
  ok('a damaged flame in a preset is dropped, not crashed',
     (() => { const r = apply({ v: 1, s: {}, k: [], f: { maps: [{ M: [1, 2] }] } }, defaults, OPS);
              return r.flame === null && r.warnings.length > 0; })());
}

// 11a. THE PANEL MUST SHOW THE FILE'S OWN NUMBERS. The parser used to fold the variation amount
//      into the affine, so an xform the file gives as offset (1, -1) with amount 0.5 displayed
//      as translation 0 and amount 1 — arithmetically equivalent, and useless to edit from.
{
  const { resolveFlame } = await import(new URL('../engine/flame.js', import.meta.url).href);
  const sq = parseFlameTop(readFileSync(
    new URL('../examples/square-corners-linear3d.flame', import.meta.url), 'utf8'));
  ok('the file\u2019s variation amount survives import',
     sq.maps.every(x => Math.abs(x.vamt - 0.5) < 1e-9),
     sq.maps.map(x => x.vamt).join(','));
  ok('the file\u2019s translation survives import',
     Math.abs(sq.maps[0].T[0] - 1) < 1e-9 && Math.abs(sq.maps[0].T[1] + 1) < 1e-9,
     sq.maps[0].T.join(','));
  // and the geometry is unchanged by moving the amount out of the affine
  const rs = resolveFlame(sq);
  ok('the resolved contraction still includes the amount',
     rs.every(m => Math.abs(m.scale - 0.5) < 1e-9), rs.map(m => m.scale.toFixed(4)).join(','));
  ok('the resolved translation still includes the amount',
     Math.abs(rs[0].T[0] - 0.5) < 1e-9 && Math.abs(rs[0].T[1] + 0.5) < 1e-9,
     rs[0].T.join(','));
  // editing Move writes the offset; reset restores the file
  const t0 = resolveFlame(sq)[0].T.slice();
  sq.maps[0].tr[0] = 0.4 - sq.maps[0].T[0];
  ok('editing Move changes the resolved map',
     Math.abs(resolveFlame(sq)[0].T[0] - 0.2) < 1e-9);
  sq.maps[0].tr = [0, 0, 0];
  ok('reset edits restores the file exactly',
     resolveFlame(sq)[0].T.every((v, i) => Math.abs(v - t0[i]) < 1e-12));
}

// 11b. SELECTION MODE PLUMBING. `select` is a THREE-way mode and main.js was coercing it with a
//      ternary, so `image box` (2) silently arrived at the shader as `nearest fixed point` (1).
//      The render stayed plausible, which is why it survived a whole round of debugging.
{
  const src = readFileSync(new URL('../main.js', import.meta.url), 'utf8');
  const line = (src.match(/flameSelect:.*/) || [''])[0];
  ok('main.js does not coerce the selection mode to a boolean',
     !/\?\s*1\s*:\s*0/.test(line), line.trim());

  const { assemble } = await import(new URL('../engine/assemble.js', import.meta.url).href);
  const fl = parseFlameTop(readFileSync(
    new URL('../examples/jerusalem-cube.flame', import.meta.url), 'utf8'));
  const emitted = [0, 1, 2].map(sel => {
    fl.select = sel;
    const g = assemble({ stack: [{ type: 26, p: [1] }], prim: 7, iters: 4, steps: 96,
                         ao: false, shadow: false, glow: false, bounces: 0, flame: fl });
    // the box rule now selects on TRIMMED regions, so match the trim helper rather than the
    // raw uniform it used to read
    return g.includes('mix(sdBoxLoHi') ? 'blend'
         : g.includes('sdBoxLoHi(p, trimLo(') ? 'box'
         : g.includes('uFlameFp[0]') ? 'fixed' : 'image';
  });
  ok('each selection mode emits its own rule',
     emitted.join(',') === 'image,fixed,box', emitted.join(','));

  // the blend must be a true interpolation: identical to image box at 0 and to nearest image at 1
  fl.select = 3;
  const bsrc = assemble({ stack: [{ type: 26, p: [1] }], prim: 7, iters: 4, steps: 96,
                          ao: false, shadow: false, glow: false, bounces: 0, flame: fl });
  ok('the blend mode emits the mixed metric', bsrc.includes('mix(sdBoxLoHi'));
  ok('and still emits the box helper it needs', bsrc.includes('float sdBoxLoHi'));
  ok('and the trim helper', bsrc.includes('vec3 trimLo(int i)'));
}

// 11c. CLIPBOARD. A preset travels as JSON, as a bare payload, or inside a share URL, and a
//      person pasting one should not have to know which they are holding.
{
  const { parseAny } = await import(new URL('../engine/preset.js', import.meta.url).href);
  const p = { v: 1, name: 'clip', s: { camDist: 3.25 }, k: [] };
  const json = JSON.stringify(p, null, 1);
  const enc = encode(p);
  const url = 'https://snicker02.github.io/Catoptron3D/#p=' + enc;
  const good = (label, text) => ok('accepts ' + label, (() => {
    try { const r = parseAny(text); return r.name === 'clip' && Math.abs(r.s.camDist - 3.25) < 1e-9; }
    catch(e){ return false; }
  })());
  good('pretty JSON', json);
  good('compact JSON', JSON.stringify(p));
  good('a bare encoded payload', enc);
  good('a full share URL', url);
  good('a URL with surrounding whitespace', '\n  ' + url + '  \n');
  good('a URL carrying other params', 'https://x.io/a?b=1#p=' + enc);

  const bad = (label, text) => ok('rejects ' + label, (() => {
    try { parseAny(text); return false; } catch(e){ return true; }
  })());
  bad('an empty clipboard', '   ');
  bad('ordinary prose', 'have a look at this render');
  bad('malformed JSON', '{"v":1,');
  bad('a payload that is not a preset', encode('not an object').slice(0, 12) + '!!');

  // the message has to say what went wrong, since this is the one place a person pastes blind
  let msg = '';
  try { parseAny('hello'); } catch(e){ msg = e.message; }
  ok('and explains what it expected', /JSON|link|payload/.test(msg), msg);
}

// 11d. FACTORY PRESETS. The former Starters table is now engine/factory.js, generated from it.
//      These must be real presets in the real format, must reproduce the starters they replaced,
//      and must cover BOTH regimes — a preset layer that only handled fractals would be useless
//      for mirror scenes, which need contraction 1.0 and the camera inside the shell spacing.
{
  const { FACTORY } = await import(new URL('../engine/factory.js', import.meta.url).href);
  // Factory presets were captured against main.js's REAL default state, not the small synthetic
  // one this file uses elsewhere. Comparing them against the wrong baseline makes every preset
  // look unstable, because capture only records values that differ from the defaults it is given.
  const mainSrc = readFileSync(new URL('../main.js', import.meta.url), 'utf8');
  const realDefaults = (new Function(
    mainSrc.slice(mainSrc.indexOf('const state = {'), mainSrc.indexOf('\n};')) +
    '\n};\nreturn state;'))();
  ok('factory presets exist', FACTORY.length >= 15, FACTORY.length + '');
  ok('every factory preset is versioned and named',
     FACTORY.every(p => p.v === PRESET_VERSION && p.name && Array.isArray(p.k)));

  // round-trip: apply then re-capture must be stable
  let unstable = [];
  FACTORY.forEach(p => {
    const r = apply(p, realDefaults, OPS);
    const st = { ...realDefaults, ...r.state, stack: r.stack, flame: r.flame || null };
    const again = capture(st, realDefaults, OPS, p.name);
    if(JSON.stringify(again.s) !== JSON.stringify(p.s) ||
       JSON.stringify(again.k) !== JSON.stringify(p.k)) unstable.push(p.name);
  });
  ok('every factory preset survives state -> JSON -> state unchanged',
     unstable.length === 0, unstable.slice(0, 3).join(', '));

  // both regimes present
  const scales = FACTORY.map(p => apply(p, realDefaults, OPS).state.ifsScale);
  ok('the fractal regime is covered (contraction well above 1)',
     scales.some(v => v > 1.5), 'max ' + Math.max(...scales));
  ok('the mirror regime is covered (contraction 1.0)',
     scales.filter(v => Math.abs(v - 1) < 1e-9).length >= 5,
     scales.filter(v => Math.abs(v - 1) < 1e-9).length + ' presets');

  // a mirror preset must actually put the camera INSIDE the shell spacing, or it shows a dead box
  const mirror = FACTORY.filter(p => {
    const st = apply(p, realDefaults, OPS);
    // the mirror-HALL presets specifically. "Clay corner" also contains "corner" but is a
    // city-scale scene at camDist 26, and matching it made this assertion meaningless.
    return Math.abs(st.state.ifsScale - 1) < 1e-9 &&
           /^(mirror|kaleidoscope|hex mirror)/i.test(p.name);
  });
  ok('mirror presets put the camera inside the shell spacing',
     mirror.length >= 3 && mirror.every(p => apply(p, realDefaults, OPS).state.camDist < 8),
     mirror.map(p => p.name + ':' + apply(p, realDefaults, OPS).state.camDist).join(', '));

  // DISCRETE PARAMS are compile-time literals baked into the signature. A preset that restores
  // one must force a NEW program, never silently reuse the cached one.
  const { signature } = await import(new URL('../engine/assemble.js', import.meta.url).href);
  const discreteOp = OPS.findIndex(o => (o.disc || []).length);
  ok('an operator with a discrete parameter exists', discreteOp >= 0);
  if(discreteOp >= 0){
    const di = OPS[discreteOp].disc[0];
    const mk = v => {
      const sl = { type: discreteOp, p: OPS[discreteOp].params.map(q => q[4]), o: [0,0,0], r: [0,0,0] };
      sl.p[di] = v;
      return signature({ ...realDefaults, stack: [sl], flame: null });
    };
    const lim = OPS[discreteOp].params[di];
    ok('changing a discrete parameter changes the shader signature',
       mk(lim[1]) !== mk(lim[2]), 'op ' + OPS[discreteOp].name);
  }
}

// 12. DOM LINT. getElementById returns the FIRST match, so a duplicated id silently wires every
//     handler to the wrong element and the visible control does nothing. That is exactly what
//     happened when the flame panel moved rails and the old copy was left behind: the buttons
//     looked fine and were dead. Missing-id checks do not catch it; this does.
{
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const js = readFileSync(new URL('../main.js', import.meta.url), 'utf8');

  const ids = [...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]);
  const seen = new Map();
  ids.forEach(i => seen.set(i, (seen.get(i) || 0) + 1));
  const dupes = [...seen].filter(([, n]) => n > 1).map(([i, n]) => i + ' x' + n);
  ok('no duplicate element ids', dupes.length === 0, dupes.join(', '));

  const refs = new Set([...js.matchAll(/\$\('([^']+)'\)/g)].map(m => m[1]));
  const missing = [...refs].filter(r => !seen.has(r));
  ok('every id main.js reaches for exists', missing.length === 0, missing.join(', '));

  const unused = [...seen.keys()].filter(i =>
    !refs.has(i) && !['c', 'boot', 'panel', 'panelR', 'hud', 'topbar'].includes(i));
  ok('no orphaned ids left in the markup', unused.length === 0, unused.join(', '));

  // EVERY tunable state key needs a control. A string replace that silently fails to match adds
  // the state and the plumbing but no widget, and the feature then exists everywhere except the
  // UI — which has happened three times: the AA control, the flame buttons, the boot starter.
  {
    const a = js.indexOf('const state = {');
    const lit = js.slice(a, js.indexOf('\n};', a) + 3);
    const st = (new Function(lit + '\nreturn state;'))();

    // keys driven by direct interaction or by structure rather than by a widget
    const NO_WIDGET = new Set([
      'stack', 'flame',                 // structural
      'aa',                             // internal: the live viewport is always 1
      'camAzim', 'camElev',             // mouse drag and WASD
      'aspect', 'exportSize',           // built in buildPanel, not the group schema
      'seed'                            // lives in the Crystal group via schema (checked below)
    ]);
    // the panel-building region: group schema + every mkSelect/mkSlider call
    // A key is controllable if it is named in the GROUPS schema (those rows assign through
    // state[key] inside a loop, so there is no literal state.key = to search for), or if a
    // panel builder writes state.key directly.
    const groups = js.slice(js.indexOf('const GROUPS = ['), js.indexOf('const RIGHT_GROUPS'));
    const builders = js.slice(js.indexOf('function buildGlobals()'), js.indexOf('function section('))
      // the timeline builds its own controls outside the group panels, and they are still
      // controls — a key reachable from a widget anywhere counts
      + js.slice(js.indexOf('function buildTimelineOpts()'), js.indexOf('function refreshPresetList()'))
      + js.slice(js.indexOf('function addKey()'), js.indexOf('function renderTimeline()'));
    const missing = Object.keys(st).filter(k =>
      !NO_WIDGET.has(k) && !groups.includes("'" + k + "'") &&
      !builders.includes('state.' + k + ' ='));
    ok('every tunable state key has a control', missing.length === 0, missing.join(', '));

    // ...and the flame tab's controls specifically. A slice from one marker to another removed
    // ten widgets at once while leaving the file valid; the key check above caught it, but naming
    // the controls says WHICH went missing instead of listing orphaned state.
    const FLAME_CONTROLS = ['Map selection', 'Search width', 'Crop box', 'Render mode',
                            'Iterations', 'Primitive size'];
    const gone = FLAME_CONTROLS.filter(c => !js.includes("'" + c + "'"));
    ok('the flame tab still builds all of its controls', gone.length === 0, gone.join(', '));

    // ...and the converse: every state.<key> the renderer UPLOADS must EXIST in state. A missing
    // one is uploaded as undefined, which silently becomes 0 or NaN in the shader. Two shipped
    // that way (trapChan, selBlend) because the lint above only inspects keys that are present.
    const up = [...js.matchAll(/u[1234]\(L, '[^']+', state\.([A-Za-z0-9_]+)/g)].map(m => m[1]);
    const ghosts = [...new Set(up)].filter(k => !(k in st));
    ok('every uploaded state key exists in state', ghosts.length === 0, ghosts.join(', '));

    // EXPORT MUST BUILD ITS OWN PROGRAM. Setting the sample count alone did nothing: `cur` is
    // only swapped by syncProgram, which runs in the frame loop, so export and quick render kept
    // using the viewport's 1x1 program and every save came out unsampled whatever was selected.
    const exp = js.slice(js.indexOf('function savePNG()'));
    ok('savePNG requests a program for its sample count', exp.includes('withSamples('));
    const qr = js.slice(js.indexOf('function quickRender()'), js.indexOf('function releasePreview()'));
    ok('quick render does too', qr.includes('withSamples('));
    ok('neither sets renderAA without requesting a program',
       !/renderAA = Math\.max\([^)]*\);\s*\n\s*renderScene/.test(js));
    const ws = js.slice(js.indexOf('function withSamples('), js.indexOf('function renderScene('));
    ok('withSamples waits for the program without blocking', ws.includes('await awaitProgram('));
    ok('and falls back rather than using the wrong program', ws.includes('else ok = false;'));

    // and the one that was actually missing
    const build = js.slice(js.indexOf('function buildGlobals()'), js.indexOf('function buildPanel()'));
    ok('Export samples is reachable from the Quality panel', build.includes('aaExport'));
  }

  // README LINT. The help panel renders this file, so it is shipped documentation. It has been
  // corrupted once by an edit whose slice bounds were reversed — Python's replace('', x) inserts
  // x between EVERY character — which produced a 100 MB file with one section repeated 68,889
  // times. Cheap structural checks catch that class of damage and the stale-content class too.
  {
    const md = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    ok('README is a sane size', md.length > 20000 && md.length < 200000, md.length + ' chars');

    const heads = (md.match(/^#{1,3} .*$/gm) || []);
    const dupes = heads.filter((h, i) => heads.indexOf(h) !== i);
    ok('README has no duplicated headings', dupes.length === 0, [...new Set(dupes)].slice(0, 3).join(' | '));

    ok('README has no empty sections', !/^#{2,3} .*\n\n(?=#{2,3} )/m.test(md));

    // claims that later evidence overturned must not survive in the file
    const stale = [
      [/arcs are the PALETTE/i, 'the arcs were shown NOT to be the palette'],
      [/phantom geometry/i, 'the filled sheets were shown to be real'],
      [/\*\*Precision guard\*\* \(Quality\)/, 'the precision guard was removed']
    ].filter(([re]) => re.test(md));
    ok('README carries no superseded explanations', stale.length === 0,
       stale.map(x => x[1]).join('; '));
  }

  // HULL CONVERGENCE. The box iteration is not monotone when a map rotates: the AABB of a
  // rotated box inflates by up to |cos|+|sin|, and if that beats the contraction the hull runs
  // away. The default flame has a -126.5 degree map at scale 0.72 (inflation 1.008) and its hull
  // reached +/-45 before being clamped to the provable bound.
  {
    const base = parseFlameTop(readFileSync(
      new URL('../examples/flame-ifs-base.flame', import.meta.url), 'utf8'));
    const rb = resolveFlameTop(base);
    ok('the default flame has 8 xforms', rb.length === 8, rb.length + '');
    const span = Math.max(...[0, 1, 2].map(a => rb.hull.hi[a] - rb.hull.lo[a]));
    ok('its hull stays bounded despite a rotated map', span < 12, 'span ' + span.toFixed(2));
    ok('and every map is contractive', rb.every(m => m.scale < 0.999),
       rb.map(m => m.scale.toFixed(3)).join(','));
    // the clamp must not disturb flames that were already converging
    const jc3 = resolveFlameTop(parseFlameTop(readFileSync(
      new URL('../examples/jerusalem-cube.flame', import.meta.url), 'utf8')));
    ok('an axis-aligned flame is unaffected by the clamp',
       jc3.hull.hi.every(v => Math.abs(v - 1) < 1e-6) &&
       jc3.hull.lo.every(v => Math.abs(v) < 1e-6));
  }

  // the bundled example flames must actually exist at the paths the panel fetches
  const paths = [...js.matchAll(/'(examples\/[\w.-]+\.flame)'/g)].map(m => m[1]);
  ok('example flames are referenced', paths.length >= 2, paths.join(', '));
  const bad = paths.filter(pth => {
    try { readFileSync(new URL('../' + pth, import.meta.url)); return false; }
    catch(e){ return true; }
  });
  ok('every referenced example flame is present on disk', bad.length === 0, bad.join(', '));
  // the originals must stay well-formed: contractive, unit-cube hull, and — because they are all
  // axis-aligned 3x3x3 cell selections — DISJOINT image boxes, which is what keeps the exact
  // selection rule exact rather than merely conservative
  ['corner-shell', 'checker-sponge', 'checker-weave', 'beam-lattice', 'vicsek-cross']
    .forEach(nm => {
      const g = parseFlameTop(readFileSync(
        new URL('../examples/' + nm + '.flame', import.meta.url), 'utf8'));
      const rr = resolveFlameTop(g);
      let ov = 0;
      for(let i = 0; i < rr.length; i++)
        for(let j = i + 1; j < rr.length; j++)
          if([0, 1, 2].every(a => Math.min(rr[i].bhi[a], rr[j].bhi[a]) -
                                  Math.max(rr[i].blo[a], rr[j].blo[a]) > 1e-6)) ov++;
      const unit = rr.hull.lo.every(v => Math.abs(v + 1) < 1e-9) &&
                   rr.hull.hi.every(v => Math.abs(v - 1) < 1e-9);
      ok(nm + ': contractive, unit hull, ' + rr.length + ' disjoint boxes',
         rr.every(m => m.scale < 0.999) && unit && ov === 0 && g.warnings.length === 0,
         'overlaps ' + ov + ', warnings ' + g.warnings.length);
    });

  ok('every bundled example parses', paths.every(pth => {
    try {
      const g = parseFlameTop(readFileSync(new URL('../' + pth, import.meta.url), 'utf8'));
      return g.maps.length > 0;
    } catch(e){ return false; }
  }));
}

console.log('\n' + '='.repeat(52));
console.log(fail ? `${fail} FAILED, ${pass} passed` : `ALL ${pass} PRESET TESTS PASS`);
process.exit(fail ? 1 : 0);
