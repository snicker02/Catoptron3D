# Variation code generator.
#
# The 2D core of each variation is written down once from the classic Apophysis / JWildfire
# definition; sympy differentiates it and emits the GLSL that ships in engine/ops.js, so the map
# and its Jacobian come from the SAME source and cannot disagree. Hand-deriving eleven Jacobians
# would have been eleven chances to be quietly wrong, and a wrong norm does not throw — it
# punches holes in surfaces.
#
# Run:  python3 tools/gen-variations.py
# Then paste the emitted bodies into the symbolic batch in engine/ops.js.
#
# Two things this generator has to get right and did not at first:
#   - the GLSL printer emits a `float pi = ...` declaration mid-expression, so pi is substituted
#     with a literal before printing
#   - GLSL ES 300 will not implicitly convert int to float, so every bare integer literal is
#     floatified after printing (exp(x - 1), 6*atan(...), juy = 0 all failed to compile)
#
import sympy as sp, json, re
from sympy.printing.glsl import glsl_code
x, y = sp.symbols('x y', real=True)
r  = sp.sqrt(x*x + y*y); th = sp.atan2(y, x)
V = {
 'polar':        (th/sp.pi, r - 1),
 'disc':         ((th/sp.pi)*sp.sin(sp.pi*r), (th/sp.pi)*sp.cos(sp.pi*r)),
 'diamond':      (sp.sin(th)*sp.cos(r), sp.cos(th)*sp.sin(r)),
 'handkerchief': (r*sp.sin(th + r), r*sp.cos(th - r)),
 'heart':        (r*sp.sin(th*r), -r*sp.cos(th*r)),
 'spiral':       ((sp.cos(th) + sp.sin(r))/r, (sp.sin(th) - sp.cos(r))/r),
 'exponential':  (sp.exp(x - 1)*sp.cos(sp.pi*y), sp.exp(x - 1)*sp.sin(sp.pi*y)),
 'cosine':       (sp.cos(sp.pi*x)*sp.cosh(y), -sp.sin(sp.pi*x)*sp.sinh(y)),
 'eyefish':      (2*x/(r + 1), 2*y/(r + 1)),
 'blob':         (r*(sp.Rational(1,2) + sp.Rational(1,2)*sp.sin(6*th))*sp.cos(th),
                  r*(sp.Rational(1,2) + sp.Rational(1,2)*sp.sin(6*th))*sp.sin(th)),
 'secant':       (x, 1/sp.cos(r)),
}
out={}
for n,(u,v) in V.items():
    exprs=[sp.simplify(u), sp.simplify(v),
           sp.simplify(sp.diff(u,x)), sp.simplify(sp.diff(u,y)),
           sp.simplify(sp.diff(v,x)), sp.simplify(sp.diff(v,y))]
    # substitute pi and floatify every literal: the GLSL printer otherwise emits a `float pi = ..`
    # declaration mid-expression, and bare integers are ints in GLSL ES 300, not floats
    exprs=[sp.N(e.subs(sp.pi, sp.Float(3.14159265358979))) for e in exprs]
    repl, red = sp.cse(exprs, optimizations='basic')
    lines=[]
    for s_,e_ in repl:
        lines.append("  float %s = %s;" % (s_, glsl_code(e_, assign_to=None, strict=False)))
    names=['ou','ov','jux','juy','jvx','jvy']
    for nm,e_ in zip(names, red):
        lines.append("  float %s = %s;" % (nm, glsl_code(e_, assign_to=None, strict=False)))
    body="\n".join(lines)
    # GLSL ES 300 will not implicitly convert int to float, and the printer still emits bare
    # integers (exp(x - 1), 6*atan(...), juy = 0). Append .0 to any literal that is not already
    # a float and is not part of an identifier such as x0.
    body = re.sub(r'(?<![\w.])(\d+)(?![\w.])', r'\1.0', body)
    out[n]=body
    print("%-14s %4d chars, %2d temps" % (n, len(body), len(repl)))
json.dump(out, open('glslbodies.json','w'))
print("\n--- polar ---"); print(out['polar'])
