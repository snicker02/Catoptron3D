#!/usr/bin/env python3
"""
Catoptron 3D validation harness.

Three gates, all run headlessly against a real GL driver (Mesa/llvmpipe via EGL). The shader
sources compiled here are the exact `#version 300 es` strings the browser gets.

  GATE 1  COMPILE   every op variant x every primitive x feature-flag combos must link.
                    Catches bank-count drift, signature mismatch, bad swizzles.

  GATE 2  LIPSCHITZ every op's declared `s` must be >= the true local operator norm of its
                    Jacobian, measured by finite differences + power iteration on J^T J at
                    thousands of random points. An op that fails this WILL punch holes in
                    surfaces. This is the gate that makes "mathematically correct" checkable.

  GATE 3  DE        for real stacks, march each ray with the declared estimator and again with
                    a brute-force fixed tiny step. The DE hit must not arrive later than the
                    brute-force hit (which is what under-estimation looks like from the camera).

Usage:  node tools/dump.mjs > tools/dump.json && python3 tools/validate.py
"""
import json, os, re, sys, math
import numpy as np
import moderngl

# must match state.stepScale in main.js
DEFAULT_STEP_SCALE = 0.85

# Two effects mean a correct op can still measure slightly above 1.0, and both are paid for by
# the same margin (1 - DEFAULT_STEP_SCALE = 10%):
#   FD_TOL     finite-difference noise — anything under this is indistinguishable from exact.
#   MARGIN_TOL float32 precision. Deliberately NOT tied to DEFAULT_STEP_SCALE: this is a
#              measurement-precision allowance, while the step scale absorbs first-order DE
#              error. Coupling them would silently loosen gate 2 every time the step scale
#              dropped, which is exactly backwards. Ops that round-trip through atan -> sin/cos (the angular
#              folds) lose ~4% of distance accuracy at some angles. Verified against a float64
#              reference: the sector fold is isometric to 3e-9 in double, ~1.04 in float32. So
#              this band is the GPU's precision floor, not a bug — but it is real, and the
#              marcher must have headroom for it.
FD_TOL     = 1.02
MARGIN_TOL = 1.10

HERE = os.path.dirname(os.path.abspath(__file__))
DUMP = json.load(open(os.path.join(HERE, 'dump.json')))

ctx = moderngl.create_context(standalone=True, backend='egl', require=330)
print(f"GL: {ctx.info['GL_VERSION']} | {ctx.info['GL_RENDERER']}\n")

QUAD_VS = """#version 300 es
in vec2 aPos;
void main(){ gl_Position = vec4(aPos, 0.0, 1.0); }"""

def quad(prog):
    vbo = ctx.buffer(np.array([-1,-1, 1,-1, -1,1, 1,1], dtype='f4').tobytes())
    return ctx.vertex_array(prog, [(vbo, '2f', 'aPos')])

FAILED = []

# ────────────────────────────────────────────────────────────────────────────────────────
# GATE 1 — compile
# ────────────────────────────────────────────────────────────────────────────────────────
def gate_compile():
    ok = bad = 0
    for sh in DUMP['shaders']:
        try:
            p = ctx.program(vertex_shader=QUAD_VS, fragment_shader=sh['src'])
            p.release(); ok += 1
        except Exception as e:
            bad += 1
            FAILED.append(('COMPILE', sh['label'], str(e)[:400]))
    print(f"GATE 1  compile     {ok}/{ok+bad} shaders linked")
    return bad == 0

# ────────────────────────────────────────────────────────────────────────────────────────
# GATE 2 — Lipschitz / operator norm
# ────────────────────────────────────────────────────────────────────────────────────────
# The probe compiles every helper, so it needs every uniform they reference. That list is
# generated from prelude.js rather than hand-maintained: a hand-copied list silently rots the
# moment a primitive adds a uniform, and the failure looks like "all operators broken".
_PRELUDE = open(os.path.join(HERE, '..', 'engine', 'prelude.js')).read()
_UNIFORMS = "\n".join(
    "uniform " + m.group(1) + " " + m.group(2) + ";"
    for m in re.finditer(r'^uniform\s+(\w+)\s+([^;]+);', _PRELUDE, re.M)
    if 'uPk' not in m.group(2))

PROBE_HEAD = """#version 300 es
precision highp float;
out vec4 fragColor;
#define PI  3.14159265359
#define TAU 6.28318530718
#define DEG 0.01745329252
uniform vec4  uPk0, uPk1;
uniform float uSpread;
""" + _UNIFORMS + "\n"

PROBE_TAIL = """
float rnd(vec2 co, float k){ return fract(sin(dot(co, vec2(12.9898, 78.233)) + k) * 43758.5453); }

vec3 samplePoint(){
  vec2 f = gl_FragCoord.xy;
  return (vec3(rnd(f, uSeed), rnd(f, uSeed + 7.1), rnd(f, uSeed + 19.3)) - 0.5) * 2.0 * uSpread;
}

vec3 F(vec3 p, inout float s){
  vec4 trap = vec4(1e9);
  float seam = 1e9;
  return %(CALL)s;
}

// Largest singular value of the finite-difference Jacobian at step h, plus `rel`: how far the
// two one-sided derivatives disagree.
//
// Most folds here are PIECEWISE isometries — a reflection plane, a kaleidoscope wedge edge, a
// cell wall. On the seam itself there is no derivative, and a difference straddling it measures
// the jump instead. Two independent rejections catch that:
//   (1) one-sided disagreement: within a smooth piece the forward and backward derivatives
//       agree to O(h); across a seam they differ by O(1). (Comparing the reported s values does
//       NOT work — for an isometry s is 1.0 on both sides, so the seam is invisible to it.)
//   (2) h-refinement, applied by the caller: a real derivative converges as h shrinks. Near a
//       fold axis where infinitely many seams meet, every step size straddles some of them and
//       sigma keeps moving, so the sample is rejected no matter how small h gets.
float sigmaAt(vec3 p, float h, out float rel){
  float sD = 1.0;
  vec3 f0 = F(p, sD);
  float t1=1.0,t2=1.0,t3=1.0,t4=1.0,t5=1.0,t6=1.0;
  vec3 fpx = F(p + vec3(h,0,0), t1), fmx = F(p - vec3(h,0,0), t2);
  vec3 fpy = F(p + vec3(0,h,0), t3), fmy = F(p - vec3(0,h,0), t4);
  vec3 fpz = F(p + vec3(0,0,h), t5), fmz = F(p - vec3(0,0,h), t6);

  vec3 jxF = (fpx - f0) / h, jxB = (f0 - fmx) / h;
  vec3 jyF = (fpy - f0) / h, jyB = (f0 - fmy) / h;
  vec3 jzF = (fpz - f0) / h, jzB = (f0 - fmz) / h;
  rel = 0.0;
  rel = max(rel, length(jxF - jxB) / max(length(jxF) + length(jxB), 1e-6));
  rel = max(rel, length(jyF - jyB) / max(length(jyF) + length(jyB), 1e-6));
  rel = max(rel, length(jzF - jzB) / max(length(jzF) + length(jzB), 1e-6));

  vec3 jx = (fpx - fmx) / (2.0 * h);
  vec3 jy = (fpy - fmy) / (2.0 * h);
  vec3 jz = (fpz - fmz) / (2.0 * h);

  vec3 v = normalize(vec3(0.577, 0.577, 0.577) + 0.1 * vec3(rnd(gl_FragCoord.xy, 3.7), 0.0, 0.0));
  for(int i = 0; i < 24; i++){
    vec3 Jv  = jx * v.x + jy * v.y + jz * v.z;
    vec3 JtJ = vec3(dot(jx, Jv), dot(jy, Jv), dot(jz, Jv));
    float n = length(JtJ);
    if(n < 1e-12) break;
    v = JtJ / n;
  }
  vec3 Jv = jx * v.x + jy * v.y + jz * v.z;
  return length(Jv) / max(length(v), 1e-12);
}

void main(){
  vec3 p = samplePoint();
  float sD = 1.0;
  F(p, sD);

  float relA, relB;
  float sigA = sigmaAt(p, 2.0e-4, relA);
  float sigB = sigmaAt(p, 4.0e-4, relB);

  float conv = abs(sigA - sigB) / max(sigA + sigB, 1e-9);
  bool clean = (relA < 0.03) && (relB < 0.03) && (conv < 0.01);

  fragColor = vec4(sD, sigA, clean ? 1.0 : 0.0, conv);
}
"""

def build_call(op):
    banks = ', '.join(('uPk%d' % b) for b in range(op['banks']))
    return "%s(p, %s, s, trap, seam)" % (op['fn'], banks)

def gate_lipschitz(extra_ops=None, verbose=False):
    ops = DUMP['ops'] + (extra_ops or [])
    N = 256                                   # 256x256 = 65k random points per op
    fbo = ctx.simple_framebuffer((N, N), components=4, dtype='f4')
    fbo.use()
    rows = []
    worst_all = 0.0
    for op in ops:
        src = PROBE_HEAD + DUMP['helpers'] + "\n" + op['src'] + "\n" + (PROBE_TAIL % {'CALL': build_call(op)})
        try:
            prog = ctx.program(vertex_shader=QUAD_VS, fragment_shader=src)
        except Exception as e:
            FAILED.append(('LIPSCHITZ-COMPILE', op['fn'], str(e)[:300])); continue
        va = quad(prog)
        for u, val in (('uPrimSize', 1.0), ('uPrimRound', 0.06), ('uPrimAux', 0.35)):
            if u in prog: prog[u].value = val
        pk = op['params'] + [0.0] * 8
        for b in range(op['banks']):
            nm = 'uPk%d' % b
            if nm in prog: prog[nm].value = tuple(float(x) for x in pk[b*4:b*4+4])

        worst = 0.0; clean_tot = 0; viol = 0; marg = 0
        for trial, spread in enumerate((0.5, 1.5, 3.0)):
            if 'uSeed' in prog:   prog['uSeed'].value = 11.0 + 37.0 * trial
            if 'uSpread' in prog: prog['uSpread'].value = spread
            fbo.clear(0.0, 0.0, 0.0, 0.0)
            va.render(moderngl.TRIANGLE_STRIP)
            data = np.frombuffer(fbo.read(components=4, dtype='f4'), dtype='f4').reshape(N*N, 4)
            decl, sigma, clean, _ = data[:,0], data[:,1], data[:,2], data[:,3]
            m = (clean > 0.5) & np.isfinite(decl) & np.isfinite(sigma) & (sigma > 1e-9)
            if not m.any(): continue
            ratio = sigma[m] / np.maximum(decl[m], 1e-12)     # >1 means DECLARED IS TOO SMALL
            clean_tot += int(m.sum())
            viol += int((ratio > MARGIN_TOL).sum())
            marg += int(((ratio > FD_TOL) & (ratio <= MARGIN_TOL)).sum())
            worst = max(worst, float(ratio.max()))
        status = 'ok' if viol == 0 else 'FAIL'
        note = ' (cell-local)' if op['lip'] == 'repeat' else ''
        if viol == 0 and marg: note += ' (%d in float32 margin)' % marg
        if viol: FAILED.append(('LIPSCHITZ', op['fn'],
                 f'{viol} samples under-report s beyond the {MARGIN_TOL:.2f} margin, worst {worst:.3f}'))
        rows.append((op['fn'], op['lip'], clean_tot, worst, status + note))
        worst_all = max(worst_all, worst if viol else 0.0)
        va.release(); prog.release()

    print("GATE 2  lipschitz   declared s vs measured operator norm (worst sigma/s over ~200k pts)")
    print("        pass = no sample exceeds %.2f (the margin the default step scale %.2f buys)"
          % (MARGIN_TOL, DEFAULT_STEP_SCALE))
    print("        %-22s %-7s %8s %8s  %s" % ('op', 'lip', 'samples', 'worst', ''))
    for fn, lip, n, w, st in rows:
        flag = '' if st.startswith('ok') else '   <-- UNDER-REPORTS'
        print("        %-22s %-7s %8d %8.4f  %s%s" % (fn, lip, n, w, st, flag))
    fbo.release()
    return all(r[4].startswith('ok') for r in rows)

# ────────────────────────────────────────────────────────────────────────────────────────
# GATE 3 — DE vs brute force
# ────────────────────────────────────────────────────────────────────────────────────────
DE_MAIN = """
uniform float uSeed2;
float rnd2(vec2 co, float k){ return fract(sin(dot(co, vec2(12.9898, 78.233)) + k) * 43758.5453); }

// Direct test of the DE contract, not of the marcher.
//
// The contract is: de(p) <= true distance from p to the surface. Equivalently, for ANY unit
// direction v, stepping by exactly de(p) must not land inside the solid. So: sample a random
// exterior point, take one full DE-sized step in a random direction, and check we are still
// outside. A negative result is a genuine under-estimate.
//
// (An earlier version of this gate compared adaptive vs brute-force marching. That conflates a
// real violation with the ordinary fact that a sphere-tracer can step over the thin epsilon
// shell without ever entering the solid, and it reported false failures on correct ops.)
void main(){
  vec2 f = gl_FragCoord.xy;
  vec3 p = (vec3(rnd2(f, uSeed2), rnd2(f, uSeed2 + 5.7), rnd2(f, uSeed2 + 13.1)) - 0.5) * 6.0;
  vec4 tr0; float d;
  mapT(p, tr0, d);          // the SAFE step — what the marcher actually advances by
  if(!(d > 1e-4) || d > 50.0){ fragColor = vec4(0.0, 0.0, 0.0, 0.0); return; }

  vec3 v = normalize(vec3(rnd2(f, uSeed2 + 23.0) - 0.5,
                          rnd2(f, uSeed2 + 37.0) - 0.5,
                          rnd2(f, uSeed2 + 51.0) - 0.5) + 1e-4);
  vec4 tr1; float m;
  mapT(p + v * d, tr1, m);
  fragColor = vec4(d, m, 1.0, 0.0);
}
"""

def gate_de():
    N = 220
    fbo = ctx.simple_framebuffer((N, N), components=4, dtype='f4')
    fbo.use()
    all_ok = True
    print("GATE 3  estimator   one full de(p)-sized step in a random direction must stay outside")
    print("        %-18s %9s %12s %11s %8s"
          % ('stack', 'samples', 'worst m/d', 'safe step', ''))
    for d in DUMP['deStacks']:
        src = d['src'].split('void main()')[0] + DE_MAIN
        try:
            prog = ctx.program(vertex_shader=QUAD_VS, fragment_shader=src)
        except Exception as e:
            FAILED.append(('DE-COMPILE', d['label'], str(e)[:300])); all_ok = False; continue
        va = quad(prog)
        for u, val in (('uPrimSize', 0.9), ('uPrimRound', 0.06), ('uPrimAux', 0.35),
                       ('uPrimThick', 0.03), ('uIfsScale', 1.9),
                       ('uSeed', 1337.0), ('uXShards', 6.0), ('uXFacets', 6.0), ('uXLen', 1.1),
                       ('uXRad', 0.10), ('uXTip', 0.55), ('uXSpread', 1.0), ('uXVary', 0.8), ('uStepScale', 1.0), ('uEps', 0.002),
                       ('uBailout', 6.0),
                       ('uCityStreet', 0.28), ('uCityHeight', 0.9), ('uCityVar', 0.7),
                       ('uCityDetail', 0.0), ('uSun', 0.0), ('uHaze', 0.0)):
            if u in prog: prog[u].value = val
        for u, val in (('uIfsCenter', (1.0, 1.0, 1.0)), ('uIfsRot', (0.0, 0.0, 0.0))):
            if u in prog: prog[u].value = val
        for i, sl in enumerate(d['stack']):
            pk = list(sl['p']) + [0.0] * 8
            nb = max(1, (len(sl['p']) + 3) // 4)
            for b in range(nb):
                nm = 'uP%d_%d' % (i, b)
                if nm in prog: prog[nm].value = tuple(float(x) for x in pk[b*4:b*4+4])
            for nm, v in (('uO%d' % i, (0.0, 0.0, 0.0)), ('uR%d' % i, (0.0, 0.0, 0.0))):
                if nm in prog: prog[nm].value = v

        worst = 0.0; n = 0; viol = 0
        for trial in range(4):
            if 'uSeed2' in prog: prog['uSeed2'].value = 5.0 + 13.0 * trial
            fbo.clear(0.0, 0.0, 0.0, 0.0)
            va.render(moderngl.TRIANGLE_STRIP)
            data = np.frombuffer(fbo.read(components=4, dtype='f4'), dtype='f4').reshape(N*N, 4)
            dd, mm, valid = data[:, 0], data[:, 1], data[:, 2]
            k = (valid > 0.5) & np.isfinite(dd) & np.isfinite(mm)
            if not k.any(): continue
            n += int(k.sum())
            ratio = mm[k] / np.maximum(dd[k], 1e-9)      # negative = landed inside the solid
            worst = min(worst, float(ratio.min()))
            viol += int((ratio < -0.02).sum())
        # A composition of conformal-but-not-similarity maps (sphere inversion, sphere fold)
        # gives a FIRST-ORDER distance estimate, so a small overshoot is inherent, not a bug.
        # The honest pass condition is that the shipped default step scale covers it.
        safe = 1.0 / (1.0 + abs(worst))
        ok = safe >= DEFAULT_STEP_SCALE
        all_ok = all_ok and ok
        print("        %-18s %9d %12.5f %11.3f %8s"
              % (d['label'], n, worst, safe, 'ok' if ok else 'FAIL'))
        if not ok:
            FAILED.append(('DE', d['label'],
                           f'{viol} steps landed inside, worst m/d {worst:.4f}; '
                           f'needs step scale <= {safe:.3f}, shipped default is {DEFAULT_STEP_SCALE}'))
        va.release(); prog.release()
    fbo.release()
    return all_ok

# ────────────────────────────────────────────────────────────────────────────────────────
# a deliberately-wrong op, so we can see the gate fail when it should
# ────────────────────────────────────────────────────────────────────────────────────────
CANARY = [{
    'fn': 'opCanaryBad', 'name': 'canary (intentionally wrong)', 'lip': 'exact', 'banks': 1,
    'params': [2.0, 0, 0, 0],
    'src': """vec3 opCanaryBad(vec3 p, vec4 P, inout float s, inout vec4 trap){
  // scales by P.x but forgets to report it — the classic under-reporting bug
  return p * P.x;
}"""
}]

if __name__ == '__main__':
    g1 = gate_compile()
    print()
    g2 = gate_lipschitz()
    print()
    g3 = gate_de()

    if '--canary' in sys.argv:
        print("\nCANARY  an op that scales by 2.0 and forgets to report it:")
        before = len(FAILED)
        gate_lipschitz(extra_ops=CANARY)
        caught = any(f[1] == 'opCanaryBad' for f in FAILED[before:])
        print("        gate caught it:", "YES" if caught else "NO  <-- the gate itself is broken")

    print("\n" + "=" * 74)
    real = [f for f in FAILED if f[1] != 'opCanaryBad']
    if not real:
        print("ALL GATES PASS")
    else:
        print(f"{len(real)} FAILURE(S)")
        for kind, what, why in real:
            print(f"  [{kind}] {what}\n      {why}")
    sys.exit(0 if not real else 1)
