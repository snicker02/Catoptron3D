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
    return g.includes('mix(sdBoxLoHi') ? 'blend'
         : g.includes('sdBoxLoHi(p, uFlameBLo') ? 'box'
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
    const builders = js.slice(js.indexOf('function buildGlobals()'), js.indexOf('function section('));
    const missing = Object.keys(st).filter(k =>
      !NO_WIDGET.has(k) && !groups.includes("'" + k + "'") &&
      !builders.includes('state.' + k + ' ='));
    ok('every tunable state key has a control', missing.length === 0, missing.join(', '));

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
    ok('withSamples waits for a parallel compile', ws.includes('while(!r.ready'));
    ok('and falls back to 1x1 rather than the wrong program', ws.includes('renderAA = 1;'));

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
