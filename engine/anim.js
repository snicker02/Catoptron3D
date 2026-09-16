/* Keyframes.
   ─────────
   A keyframe is a full preset plus a time, so the whole format, loader and tolerance story is
   reused rather than reinvented. Sampling the timeline blends the two neighbouring keyframes.

   The central constraint is that NOT EVERYTHING CAN BE BLENDED. Discrete parameters are baked
   into the shader as compile-time literals and form the program cache key, so interpolating one
   would ask for a new program every frame — a recompile per frame, which is a stutter rather
   than an animation. Those STEP: they hold the outgoing keyframe's value until the next one is
   reached. Everything continuous lerps.

   Angles are the other special case. Azimuth and yaw wrap, so a move from +170 to -170 degrees is
   20 degrees the short way and 340 the long way; lerping the raw numbers takes the long way and
   the camera spins backwards through the whole scene. */

// VALUE-baked into the shader — see signature() in assemble.js. These compile in as literals, so
// blending one asks for a different program every frame: a recompile per frame, which is a
// stutter rather than an animation. They STEP.
//
// Note what is NOT here. Ambient occlusion, glow, transparency and dispersion reach the signature
// only as `c.ao ? 1 : 0` — a boolean GATE on a continuous slider. Fading one crosses its
// threshold once, which is a single program swap, and fading it smoothly is exactly what you
// want. Putting them in this list would refuse to fade ambient occlusion for no reason.
//
// A test asserts this list covers every value-baked field, so adding one and forgetting it fails
// loudly instead of quietly churning programs.
export const STEP_KEYS = new Set([
  'prim', 'primStyle', 'iters', 'steps', 'feedback', 'seamSurf', 'bounces',
  'aa', 'aaExport', 'voxelGrid', 'flameVoxel', 'flameBeam', 'scaleCap', 'bestDepth',
  'crop', 'camMode', 'palette', 'trapChan', 'aspect', 'exportSize', 'idleRefine'
]);

// Wrap to the shortest way round.
export const ANGLE_KEYS = new Set(['camAzim', 'flyYaw']);

export const EASINGS = ['linear', 'smooth', 'ease in', 'ease out'];

export function ease(mode, t){
  const x = Math.max(0, Math.min(1, t));
  switch(mode | 0){
    case 1: return x * x * (3 - 2 * x);
    case 2: return x * x;
    case 3: return 1 - (1 - x) * (1 - x);
    default: return x;
  }
}

const shortAngle = (a, b) => {
  let d = (b - a) % (Math.PI * 2);
  if(d > Math.PI) d -= Math.PI * 2;
  if(d < -Math.PI) d += Math.PI * 2;
  return d;
};

function lerpNum(key, a, b, t){
  if(STEP_KEYS.has(key)) return t >= 1 ? b : a;
  if(ANGLE_KEYS.has(key)) return a + shortAngle(a, b) * t;
  return a + (b - a) * t;
}

// Two fold stacks blend only if they have the same shape. Different operator types are different
// functions, and a blend between them is not a fold of anything — so the stack steps instead.
function sameStack(A, B){
  return Array.isArray(A) && Array.isArray(B) && A.length === B.length &&
         A.every((sl, i) => sl.type === B[i].type);
}

function blendStack(A, B, t, OPS){
  if(!sameStack(A, B)) return t >= 1 ? B : A;
  return A.map((sl, i) => {
    const other = B[i];
    const op = OPS[sl.type];
    const disc = new Set((op && op.disc) || []);
    return {
      type: sl.type,
      // a discrete PARAMETER inside an operator is baked exactly like a discrete setting is
      p: sl.p.map((v, k) => disc.has(k) ? (t >= 1 ? other.p[k] : v)
                                        : v + ((other.p[k] === undefined ? v : other.p[k]) - v) * t),
      o: sl.o.map((v, k) => v + ((other.o[k] ?? v) - v) * t),
      r: sl.r.map((v, k) => v + ((other.r[k] ?? v) - v) * t)
    };
  });
}

// Flames blend only when their structure matches: same transform count, same variations, same
// selection rule. Anything else changes the shader or the meaning of the parameters.
function sameFlame(A, B){
  if(!A || !B) return false;
  if((A.select | 0) !== (B.select | 0)) return false;
  if(!A.maps || !B.maps || A.maps.length !== B.maps.length) return false;
  return A.maps.every((m, i) => (m.vari | 0) === (B.maps[i].vari | 0) &&
                                (m.on !== false) === (B.maps[i].on !== false));
}

function blendFlame(A, B, t){
  if(!sameFlame(A, B)) return t >= 1 ? B : A;
  const mix = (x, y) => x + (y - x) * t;
  return {
    ...A,
    maps: A.maps.map((m, i) => {
      const n = B.maps[i];
      return {
        ...m,
        M: m.M.map((v, k) => mix(v, n.M[k])),
        T: m.T.map((v, k) => mix(v, n.T[k])),
        rot: m.rot.map((v, k) => mix(v, n.rot[k])),
        tr: m.tr.map((v, k) => mix(v, n.tr[k])),
        vp: (m.vp || []).map((v, k) => mix(v, (n.vp || [])[k] ?? v)),
        scale: mix(m.scale, n.scale),
        vamt: mix(m.vamt, n.vamt),
        weight: mix(m.weight === undefined ? 1 : m.weight,
                    n.weight === undefined ? 1 : n.weight)
      };
    })
  };
}

// Blend two already-applied states.
export function blendStates(A, B, t, OPS, opts){
  const out = {};
  for(const k in A){
    const a = A[k], b = B[k];
    if(typeof a === 'number' && typeof b === 'number') out[k] = lerpNum(k, a, b, t);
    else out[k] = t >= 1 ? b : a;
  }
  out.stack = blendStack(A.stack, B.stack, t, OPS);
  out.flame = (opts && opts.blendFlame === false)
    ? (t >= 1 ? B.flame : A.flame)
    : blendFlame(A.flame, B.flame, t);
  return out;
}

// Where the timeline is at a given time. Keys are [{ t, preset }], any order.
export function sampleTimeline(keys, time, apply, defaults, OPS, opts){
  if(!keys || !keys.length) return null;
  const ks = keys.slice().sort((x, y) => x.t - y.t);
  if(ks.length === 1 || time <= ks[0].t) return applyOne(ks[0], apply, defaults, OPS);
  if(time >= ks[ks.length - 1].t) return applyOne(ks[ks.length - 1], apply, defaults, OPS);
  let i = 0;
  while(i < ks.length - 2 && time > ks[i + 1].t) i++;
  const A = ks[i], B = ks[i + 1];
  const span = Math.max(B.t - A.t, 1e-9);
  const raw = (time - A.t) / span;
  const t = ease((opts && opts.easing) || 0, raw);
  const sa = applyOne(A, apply, defaults, OPS), sb = applyOne(B, apply, defaults, OPS);
  return blendStates(sa, sb, t, OPS, opts);
}

function applyOne(k, apply, defaults, OPS){
  const r = apply(k.preset, defaults, OPS);
  return { ...defaults, ...r.state, stack: r.stack, flame: r.flame || null };
}
