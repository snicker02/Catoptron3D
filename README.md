# Catoptron 3D

The 3D counterpart to [Catoptron](https://github.com/snicker02/Catoptron). Same idea — a stack
of coordinate **folds**, assembled into a shader at runtime and cached by signature — but the
folds now bend *space* inside a raymarched distance estimator, so the fold library becomes
fractal geometry instead of image warps.

Single page, no build step, no dependencies. WebGL2.

---

## The one thing to understand first

In 2D a fold is a **backward map**: bend the coordinate, sample the photo there. Any map at all
is legal, because sampling a texture has no correctness requirement.

In 3D a fold is a **forward domain map** evaluated inside a distance estimator, and the marcher
trusts the returned number as a guaranteed-safe step. So a 3D fold is a map **plus a proof of
how much it stretched space**:

```glsl
vec3 opX(vec3 p, vec4 P0, inout float s, inout vec4 trap);
```

`s` accumulates the operator norm of each fold's Jacobian. The estimator finishes with
`prim(p) / s`. Under-report `s` and rays punch through surfaces; over-report and you only lose
march steps. Every operator declares which case it is:

| `lip` | meaning |
|---|---|
| `exact` | `s` is the true local operator norm, or the map is an isometry and `s` is untouched |
| `bound` | `s` is a proven upper bound but not tight — costs steps, never correctness |
| `repeat` | isometry *within* a cell, discontinuous across cells; valid only while the primitive fits in one cell |

Two consequences that invert the 2D intuition:

- **Many-to-one is still fine.** A kaleidoscope fold makes copies, and copies are free.
- **Expansion is the enemy, not chaos.** A hard-expanding stack made pretty noise in 2D. Here it
  thins the estimate below the true distance and the ray goes *through* the surface. Contraction
  is always safe, which is why the IFS contraction matters even more than it did in 2D.

---

## Layout

```
index.html          markup + CSS, loads main.js as a module
main.js             state, UI, camera, render loop, PNG export
engine/
  prelude.js        shared uniform block + the DE contract, written down
  helpers.js        GLSL helpers (rotations, primitives, palette)
  ops.js            operator registry — UI params + GLSL together. The file that grows.
  assemble.js       per-config shader assembly, primitives, signature
  glcache.js        program cache, async parallel compile, LRU
tools/
  dump.mjs          dumps op sources + assembled shaders to JSON
  validate.py       the three gates, run against real GL headlessly
```

## Running

ES modules don't load from `file://`, so serve the folder:

```
python3 -m http.server 8000     # then open http://localhost:8000
```

**GitHub Pages:** commit these files with `engine/` next to `index.html`, deploy from branch
root. Pages serves `.js` with the right MIME type.

**Deployment gotcha, carried over from 2D:** deploy `index.html` and the `engine/` modules as a
matched set and hard-refresh (Ctrl/Cmd+Shift+R). If new controls appear but behave like the old
build, that's a cached module, not a bug. The console logs `[catoptron3d] build <version>` at
startup — check that first before debugging anything.

---

## What recompiles and what doesn't

Continuous sliders are uniforms and **never** trigger a rebuild. Only the program signature
does:

```
prim | iters | steps | ao | shadow | glow | ops-with-their-discrete-values
```

A param marked **baked** in the UI is a compile-time literal, not a runtime branch. That matters
far more here than in 2D: the fold stack used to run once per pixel, but the estimator is
instantiated ~10× by the compiler (1 march + 4 normal taps + 5 AO taps) and called hundreds of
times per ray. A live branch inside a fold is paid for hundreds of thousands of times per frame.
Features that are off emit no code at all — AO at 0 removes five estimator taps per pixel.

## Adding an operator

One record in `engine/ops.js`: `name`, `fn` matching the GLSL function name, `lip`, `deps` from
`helpers.js`, `params`, and the `glsl`. Then:

- **Bank count must equal `ceil(params.length / 4)`.** Wrong count is a link error.
- **Report `s`.** If you can't derive the operator norm, use a provable upper bound and mark it
  `bound`.
- **No swizzle-write-from-swizzle-read** (`p.xy = p.yx`, `p.yz = M * p.yz`). Some drivers
  silently no-op these and the affected params look dead. Explicit temps only.
- A param with a `names` array is discrete: write `glsl` as a function of the baked values.
- Run the gates.

---

## Validation

```
node tools/dump.mjs > tools/dump.json
python3 tools/validate.py            # add --canary to prove the gate still has teeth
```

Three gates, all against a real GL driver (Mesa/llvmpipe via EGL), compiling the exact
`#version 300 es` strings the browser gets.

**Gate 1 — compile.** Every op variant × every primitive, plus feature-flag and max-stack
combinations. Catches bank-count drift and signature mismatch.

**Gate 2 — Lipschitz.** For each op, ~200k random points; finite-difference the Jacobian, take
its largest singular value by power iteration on JᵀJ, and assert the declared `s` is not smaller.
Samples that straddle a fold seam are rejected two ways: one-sided derivative disagreement, and
h-refinement convergence. (Comparing reported `s` values across the seam does *not* work — for
an isometry `s` is 1.0 on both sides, so the seam is invisible to that test.)

**Gate 3 — estimator.** The contract directly: from a random exterior point, one full `de(p)`-sized
step in a random direction must not land inside the solid. This is deliberately *not* a comparison
of adaptive vs brute-force marching — that conflates a real violation with the ordinary fact that
a sphere-tracer can step over the thin epsilon shell, and it reports false failures on correct ops.

`--canary` adds an operator that scales by 2.0 and forgets to report it. Gate 2 catches it at
ratio 2.0003. If the canary ever passes, the gate is broken.

### Two known, measured margins

Both are covered by the default step scale of `0.9`, and the gates are calibrated to it:

1. **First-order estimate.** A composition of conformal-but-not-similarity maps (sphere
   inversion, sphere fold) gives a first-order distance estimate, so a small overshoot is
   inherent. Measured worst case on the Mandelbox stack: **9.7%**, i.e. safe up to step scale
   0.912. This is *why* the default is 0.9, rather than a guess.
2. **float32 precision.** Angular folds round-trip through `atan` → `sin`/`cos`. Verified against
   a float64 reference: the sector fold is isometric to 3×10⁻⁹ in double, but loses up to **~4%**
   in float32. Real, not a bug, and it needs headroom.

If a stack ever crawls or shows holes, lower **Step scale** before suspecting anything else.

---

## Mirror geometry vs fractal geometry

The two op families work by opposite mechanisms, and it's worth knowing which one you're using:

| | fractal folds | mirror folds |
|---|---|---|
| scale | contract each pass | none — pure isometry |
| result | structure **nests** | space **tiles** at constant size |
| IFS contraction | < 1.0 (that's the point) | **1.0** — otherwise it collapses |
| iterations mean | recursion depth | how far the fold reaches |

Mirror folds are the safest ops in the library: reflection folding is continuous and globally
1-Lipschitz, so it can never over-report distance. (Domain repeat is the exception — it
teleports rather than reflects, which is why it's marked `repeat` and not `exact`.)

Because they need IFS contraction at 1.0 and the fractal default is 1.9, mirror mode is
undiscoverable without help — hence the **Starters** buttons at the top of the panel.

Two halves make a hall of mirrors, and you want both:

- **Mirror folds** build the mirror *geometry* — Mirror corridor, Mirror room, Corner mirror,
  Mirror shells, Kaleidoscope tile.
- **Mirror bounces** (Renderer panel) make the surfaces actually reflect *each other*. Bounce
  count is a compile-time literal, so 0 costs nothing; 2 is usually the sweet spot. Reflectivity
  is Schlick-weighted, so grazing angles reflect hardest — that's what makes a folded plane read
  as glass rather than painted metal.

`Kaleidoscope tile` deserves a note: a triangle whose angles are π/p, π/q, π/r with
1/p + 1/q + 1/r = 1 generates a wallpaper group by reflection alone, and there are exactly three
such triangles — (2,3,6), (2,4,4), (3,3,3). Those are the three modes. It folds in a plane and
extrudes along the axis you pick, so pairing it with Mirror corridor gives a tiled room.

One gotcha, learned by rendering it wrong: **the camera gets folded too.** With Mirror shells,
a camera further out than the shell spacing sits inside the folded region and sees structure
pressed against the lens. Spacing has to exceed your viewing distance. Same reasoning applies to
any fold with a bounded fundamental domain — if a starter looks like a wall of noise, pull the
camera in or open the spacing up.

## Current state — M0 + mirrors

Shipping: the DE contract and assembler, **17 operators** (16 exact, 1 cell-local) including a
five-op mirror group, 5 primitives, IFS recursion, orbit camera, specular reflection bounces,
AO / soft shadows / rim / fog, orbit-trap palette colouring, five starters, progressive
resolution, PNG export, and the validation harness (33 op variants, 174 shaders, 9 DE stacks).

Next, in order: camera modes and lens projections → materials and single-bounce reflection →
library expansion via the axis-lift wrapper → presets → the 2D post-fold stack → keyframes →
audio reactivity → HQ export with synced audio.

Four constraints are honoured from day one so those later milestones stay cheap: all state is
one flat JSON-serialisable object; `renderScene(w, h)` is the single draw entry point; every
slider declares its real min/max in the DOM; and the build stamp is logged at init.
