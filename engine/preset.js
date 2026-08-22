// Preset serialisation. Deliberately PURE — no DOM, no localStorage, no globals — so the whole
// format is testable headlessly (tools/test-presets.mjs). main.js owns storage and UI.
//
// Two decisions worth knowing:
//
// 1. OPERATORS ARE STORED BY NAME, not only by index. Index is the fast path, name is the
//    authority. The op list has grown every session and will keep growing; the day someone
//    inserts an op in the middle, every index-only preset silently becomes a different artwork.
//    A name mismatch is recoverable, a silent wrong-op is not.
//
// 2. ONLY NON-DEFAULT VALUES ARE STORED. Applying a preset resets to defaults first, so an
//    omitted key is deterministic rather than "whatever was there before". That makes presets
//    small enough to live in a URL, and makes loading two presets in a row reproducible.

export const PRESET_VERSION = 1;

const round = (v, dp = 6) => {
  if(typeof v !== 'number' || !isFinite(v)) return v;
  const k = Math.pow(10, dp);
  return Math.round(v * k) / k;
};

// ── capture ────────────────────────────────────────────────────────────────────────────────
export function capture(state, defaults, OPS, name = ''){
  const s = {};
  Object.keys(defaults).forEach(k => {
    if(k === 'stack') return;
    if(round(state[k]) !== round(defaults[k])) s[k] = round(state[k]);
  });
  return {
    v: PRESET_VERSION,
    name,
    s,
    k: (state.stack || []).map(sl => ({
      t: sl.type,
      n: OPS[sl.type] ? OPS[sl.type].name : '',
      p: sl.p.map(x => round(x)),
      o: sl.o.map(x => round(x)),
      r: sl.r.map(x => round(x))
    }))
  };
}

// ── migrate ────────────────────────────────────────────────────────────────────────────────
// A no-op today. It exists from version 1 on purpose: the moment a format change is needed,
// there has to be somewhere to put it that old files already route through.
export function migrate(p){
  if(!p || typeof p !== 'object') throw new Error('not a preset');
  const v = p.v | 0;
  if(v > PRESET_VERSION){
    // forward-compatible read: newer files may carry keys we ignore
    return { ...p, v: PRESET_VERSION, _future: true };
  }
  switch(v){
    case 0:                                  // pre-versioned drafts, if any escaped
    case 1:
    default:
      return { ...p, v: PRESET_VERSION };
  }
}

// ── apply ──────────────────────────────────────────────────────────────────────────────────
// Returns { state, stack, warnings }. Never throws on a recoverable problem; unknown operators
// are dropped with a warning rather than silently substituted.
export function apply(preset, defaults, OPS){
  const p = migrate(preset);
  const warnings = [];

  const state = {};
  Object.keys(defaults).forEach(k => { if(k !== 'stack') state[k] = defaults[k]; });
  Object.keys(p.s || {}).forEach(k => {
    if(k in state) state[k] = p.s[k];
    else warnings.push('unknown setting "' + k + '" ignored');
  });

  const byName = new Map(OPS.map((o, i) => [o.name, i]));
  const stack = [];
  (p.k || []).forEach((e, i) => {
    let type = -1;
    if(e.n && byName.has(e.n)) type = byName.get(e.n);          // name wins
    else if(typeof e.t === 'number' && OPS[e.t]) {
      type = e.t;
      if(e.n) warnings.push('operator "' + e.n + '" not found; fell back to index ' + e.t +
                            ' ("' + OPS[e.t].name + '")');
    }
    if(type < 0){ warnings.push('slot ' + (i + 1) + ' dropped: unknown operator'); return; }
    const op = OPS[type];
    const p3 = a => [0, 1, 2].map(j => (Array.isArray(a) && isFinite(a[j])) ? a[j] : 0);
    stack.push({
      type,
      p: op.params.map((spec, j) => {
        const v = Array.isArray(e.p) ? e.p[j] : undefined;
        return isFinite(v) ? Math.min(spec[2], Math.max(spec[1], v)) : spec[4];
      }),
      o: p3(e.o),
      r: p3(e.r)
    });
  });

  return { state, stack, warnings };
}

// ── url encoding ───────────────────────────────────────────────────────────────────────────
function b64url(str){
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for(let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64url(s){
  let b = s.replace(/-/g, '+').replace(/_/g, '/');
  while(b.length % 4) b += '=';
  const bin = atob(b);
  const bytes = new Uint8Array(bin.length);
  for(let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export function encode(preset){ return b64url(JSON.stringify(preset)); }
export function decode(str){ return JSON.parse(unb64url(str)); }
