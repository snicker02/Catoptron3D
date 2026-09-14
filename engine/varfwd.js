/* FORWARD variations, in JavaScript.
   ─────────────────────────────────
   The renderer only ever needed the INVERSE of each variation, because the estimator walks
   backwards. So nothing on the CPU knew what a transform actually did — and `resolveXform` built
   each map's matrix from the AFFINE part alone.

   That is fine for linear3D and wrong for everything else. The hull, the per-map image boxes and
   the containment test are all derived from those matrices, so on a flame with, say, `exp` at
   amount 0.015 the hull collapsed to a box 0.003 units across while the real attractor spanned a
   normal range. The estimate then had no container worth the name and the render was a wash.

   These are the forward maps, so the hull can be measured from the transform that is actually
   being drawn. They are verified against the shader's own inverses by round trip, not by
   inspection: tools/check-varfwd.mjs runs V(V^-1(q)) on the GPU and compares.                  */

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const amt = a => (Math.abs(a) < 1e-5 ? 1e-5 : a);

// complex helpers, matching the GLSL ones
const cexp = (x, y) => { const e = Math.exp(x); return [e * Math.cos(y), e * Math.sin(y)]; };
const clog = (x, y) => [Math.log(Math.max(Math.hypot(x, y), 1e-12)), Math.atan2(y, x)];
const csin = (x, y) => [Math.sin(x) * Math.cosh(y), Math.cos(x) * Math.sinh(y)];
const ccos = (x, y) => [Math.cos(x) * Math.cosh(y), -Math.sin(x) * Math.sinh(y)];
const csinh = (x, y) => [Math.sinh(x) * Math.cos(y), Math.cosh(x) * Math.sin(y)];
const ccosh = (x, y) => [Math.cosh(x) * Math.cos(y), Math.sinh(x) * Math.sin(y)];
const cdiv = (a, b, c, d) => { const den = Math.max(c*c + d*d, 1e-20);
                               return [(a*c + b*d) / den, (b*c - a*d) / den]; };
const ctan = (x, y) => { const s = csin(x, y), c = ccos(x, y); return cdiv(s[0], s[1], c[0], c[1]); };
const ctanh = (x, y) => { const s = csinh(x, y), c = ccosh(x, y); return cdiv(s[0], s[1], c[0], c[1]); };
const cinv = (x, y) => cdiv(1, 0, x, y);

function rotM(r){
  const d = Math.PI / 180, a = r[0]*d, b = r[1]*d, c = r[2]*d;
  const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b),
        cc = Math.cos(c), sc = Math.sin(c);
  return [ cc*cb, cc*sb*sa - sc*ca, cc*sb*ca + sc*sa,
           sc*cb, sc*sb*sa + cc*ca, sc*sb*ca - cc*sa,
           -sb,   cb*sa,            cb*ca ];
}

// V(p) for each variation id, matching the inverses in engine/assemble.js
export function applyVariation(vari, p, A, vp){
  const x = p[0], y = p[1], z = p[2];
  switch(vari){
    case 0: return [A*x, A*y, A*z];                                   // linear3D
    case 1: { const r2 = Math.max(x*x + y*y + z*z, 1e-9);             // spherical3D
              return [A*x/r2, A*y/r2, A*z/r2]; }
    case 2: { const k = vp[0], r2 = x*x + y*y, th = -k*r2;            // swirl
              const c = Math.cos(th), s = Math.sin(th);
              return [A*(c*x - s*y), A*(s*x + c*y), A*z]; }
    case 3: { let n = vp[1]; if(Math.abs(n) < 0.05) n = n < 0 ? -0.05 : 0.05;
              const r = Math.max(Math.hypot(x, y, z), 1e-9);          // radial power
              const rn = A * Math.pow(r, n);
              return [x*rn/r, y*rn/r, z*rn/r]; }
    case 4: { const e = cexp(x, y); return [A*e[0], A*e[1], A*z]; }   // exp
    case 5: { const l = clog(x, y); return [A*l[0], A*l[1], A*z]; }   // log
    // unpolar. The inverse is (atan(x,y), log(r/|A|), z/A), so the forward is the exponential
    // in the SECOND component with the angle taken from the FIRST — note atan(x,y), not the
    // usual atan(y,x). Guessing this as a plain log was wrong by a factor and an axis swap.
    case 6: { const r = A * Math.exp(y);
              return [r * Math.sin(x), r * Math.cos(x), A*z]; }
    // polar. Inverse: theta = PI*x/A, rr = y/A + 1, giving (rr cos, rr sin). Forward is the
    // reverse: angle over PI, radius minus one, both scaled by A.
    case 7: { const r = Math.hypot(x, y);
              return [A * Math.atan2(y, x) / Math.PI, A * (r - 1), A*z]; }
    case 8: return [x, y, A*z];                                       // zscale: z only
    case 9: { const r = Math.hypot(x, y); return [x, y, z + A*r]; }   // zcone: x,y untouched
    default: break;
  }
  // the complex-analytic family, ids 10..21
  const CX = { 10: csin, 11: ccos, 12: ctan, 13: csinh, 14: ccosh, 15: ctanh };
  if(CX[vari]){ const w = CX[vari](x, y); return [A*w[0], A*w[1], A*z]; }
  const RECIP = { 16: ccos, 17: csin, 18: ctan, 19: ccosh, 20: csinh, 21: ctanh };
  if(RECIP[vari]){ const w = RECIP[vari](x, y), r = cinv(w[0], w[1]);
                   return [A*r[0], A*r[1], A*z]; }
  if(vari === 22){                                                     // mobius3D
    const ctr = [vp[2], vp[3], vp[4]], mv = [vp[5], vp[6], vp[7]];
    const lam = Math.abs(vp[8]) < 1e-4 ? 1e-4 : vp[8];
    const R = rotM([vp[9], vp[10], vp[11]]);
    const d = [x - ctr[0], y - ctr[1], z - ctr[2]];
    const dd = Math.max(d[0]*d[0] + d[1]*d[1] + d[2]*d[2], 1e-12);
    const u = [d[0]/dd, d[1]/dd, d[2]/dd];
    const ru = [R[0]*u[0] + R[1]*u[1] + R[2]*u[2],
                R[3]*u[0] + R[4]*u[1] + R[5]*u[2],
                R[6]*u[0] + R[7]*u[1] + R[8]*u[2]];
    return [A*(mv[0] + lam*ru[0]), A*(mv[1] + lam*ru[1]), A*(mv[2] + lam*ru[2])];
  }
  return [A*x, A*y, A*z];
}

// The full forward transform of one resolved xform: affine first, then the variation, matching
// the order the shader inverts (variation inverse first, then affine inverse).
export function forwardMap(m, p){
  const A = m.Aff, T = m.Taf;
  const q = [A[0]*p[0] + A[1]*p[1] + A[2]*p[2] + T[0],
             A[3]*p[0] + A[4]*p[1] + A[5]*p[2] + T[1],
             A[6]*p[0] + A[7]*p[1] + A[8]*p[2] + T[2]];
  return applyVariation(m.vari | 0, q, amt(m.vamt), m.vp || []);
}

export const isAffine = m => (m.vari | 0) === 0;
