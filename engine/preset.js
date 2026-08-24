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
  // `stack` and `flame` are structured; everything else in state is a number. Letting the
  // flame fall through here wrote the entire transform list into the numeric block as well as
  // into `f`, roughly doubling every preset that had one.
  const s = {};
  Object.keys(defaults).forEach(k => {
    if(k === 'stack' || k === 'flame') return;
    if(round(state[k]) !== round(defaults[k])) s[k] = round(state[k]);
  });
  return {
    v: PRESET_VERSION,
    name,
    s,
    // A flame stores each xform's IMPORTED affine plus the editor's offsets, so a preset
    // records what you changed rather than a flattened matrix — and stays re-editable.
    f: state.flame ? {
      name: state.flame.name,
      select: (state.flame.select | 0),
      maps: state.flame.maps.map(x => ({
        M: x.M.map(v => round(v, 9)), T: x.T.map(v => round(v, 9)),
        scale: round(x.scale, 6), rot: x.rot.map(v => round(v, 4)),
        tr: x.tr.map(v => round(v, 6)),
        vari: x.vari | 0, vamt: round(x.vamt, 6),
        vp: (x.vp || []).slice(0, 12).map(v => round(v, 6)),
        chaos: x.chaos ? x.chaos.map(v => (v ? 1 : 0)) : null,
        on: x.on !== false, weight: round(x.weight || 1, 6)
      }))
    } : null,
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
  Object.keys(defaults).forEach(k => { if(k !== 'stack' && k !== 'flame') state[k] = defaults[k]; });
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

  // A flame is baked geometry, not a slider — carry it verbatim so a saved look keeps its shape.
  let flame = null;
  if(p.f && Array.isArray(p.f.maps) && p.f.maps.length){
    const n3 = (a, d) => [0, 1, 2].map(i => (Array.isArray(a) && isFinite(a[i])) ? a[i] : d);
    flame = {
      name: p.f.name || 'flame',
      select: (p.f.select | 0),
      maps: p.f.maps.filter(x => Array.isArray(x.M) && x.M.length === 9).map(x => ({
        M: x.M.slice(), T: n3(x.T, 0),
        scale: isFinite(x.scale) ? x.scale : 1,
        rot: n3(x.rot, 0), tr: n3(x.tr, 0),
        vari: (x.vari | 0) || 0,
        vamt: isFinite(x.vamt) ? x.vamt : 1,
        vp: Array.isArray(x.vp) ? x.vp.slice(0, 12) : [],
        chaos: Array.isArray(x.chaos) ? x.chaos.map(v => (v ? 1 : 0)) : null,
        on: x.on !== false, weight: isFinite(x.weight) ? x.weight : 1
      }))
    };
    if(!flame.maps.length){ flame = null; warnings.push('preset flame had no usable transforms'); }
  } else if(p.f){
    warnings.push('preset carried an unusable flame; ignored');
  }

  return { state, stack, warnings, flame };
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
