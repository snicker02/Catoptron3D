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

## Interface

Two rails, split by what they answer:

- **Right — Structure.** What you are building: Fold stack, Renderer (primitive, membrane,
  mirror bounces and material), IFS recursion, Primitive dimensions, City.
- **Left — Look and output.** How it is presented: Image & export, Starters, Camera, Lighting,
  Sky, Image placement, Colour, Quality.

Either rail toggles independently. Above 1180px they reserve width and the canvas is centred in
what is left; below that they overlay, because two 300px rails plus a usable viewport does not
fit on a tablet — at 1024px reserving both would leave a 424px slot to work in.

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

## Primitive style: solid, shell, frame

A **Style** control in the Renderer panel applies to every primitive.

**Shell** (`abs(d) - t`) hollows anything. It is the one hollowing operation that needs no
per-shape work and is exact for every primitive, because `|grad(|d| - t)| = |grad d| = 1`.
Note that a closed shell looks identical to a solid from outside — it only reads once you can
see into it, which folds and frames readily arrange.

**Frame** keeps only the edges, and has no universal formula: edges are a feature of the specific
shape, so each is written by hand.

| primitive | frame |
|---|---|
| Box | the twelve edge bars |
| Octahedron | exact distance to three edge segments in the folded octant |
| Sphere | latitude / longitude wireframe (a sphere has no edges, so its frame is a surface grid) |
| Torus | meridian circles plus rail circles |
| City | every building as a box frame — the reference look |

Primitives with no frame variant fall back to shell, so the control never does nothing.
Thickness is shared by both styles.

**Two of these were wrong before gate 3 saw them.** The octahedron frame combined "distance to
the face plane" and "distance to the nearest coordinate plane" as a 2D hypotenuse — plausible,
and overshooting by 18.7%, because the two measures are not orthogonal. The torus frame did the
same with angular and radial terms and overshot by 64%. Both are now computed as true distances
to the actual wires (segments and circles), and both measure 0.00000. The general lesson:
**combining two distance-like quantities with `length(vec2(a,b))` is only valid when they are
orthogonal**, and it is very easy to write something that looks right and renders plausibly
while quietly breaking the estimator.

The PRIMS order is part of the preset format — `state.prim` is an index — so new primitives are
appended and existing ones never move.

## Presets

Three routes out of the tool:

- **Named slots** in localStorage — fast, this browser only.
- **`.json` export / import** — portable and archivable.
- **`copy link`** — the whole look encodes into a URL hash. A real state (59 keys plus a fold
  stack) comes to about 350 characters, so a look is something you can paste to yourself.
  Opening a link applies it before the default stack is built.

The format lives in `engine/preset.js` and is deliberately **pure** — no DOM, no storage, no
globals — so it is unit-tested headlessly by `tools/test-presets.mjs` (32 tests) rather than only
being clickable. Two decisions in it are worth knowing:

**Operators are stored by NAME, not only index.** Index is the fast path, name is the authority.
The op list has grown every session and will keep growing; the day an op is inserted in the
middle, every index-only preset silently becomes a different artwork. A name mismatch is
recoverable and warns; a silent wrong-op is not. Unresolvable slots are dropped rather than
substituted.

**Only non-default values are stored, and loading resets to defaults first.** An omitted key is
therefore deterministic rather than "whatever happened to be there", which is what makes loading
two presets in a row reproducible — and what keeps a preset small enough to live in a URL.

The end-to-end test reads the state literal out of `main.js` rather than a stand-in, captures a
session, sends it through the URL encoder and back, and asserts the assembled GLSL is
**byte-identical**. It fails if a state key is added and presets are forgotten.

A loaded image is **not** part of a preset: a photo cannot go in a URL, and silently baking one
into a file would make presets unpredictably large. Reload the image after loading a preset.

## Validation

```
node tools/dump.mjs > tools/dump.json
python3 tools/validate.py            # add --canary to prove the gate still has teeth
node tools/test-presets.mjs          # preset format, pure functions, no browser needed
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
  count is a compile-time literal, so 0 costs nothing; 2 is the usual sweet spot, up to 6.

Three controls shape the reflection:

- **Reflectivity** is the base reflectance F0 — the value you get facing a surface head-on.
  0.85 is a strong mirror, 1.00 with Fresnel 0 is a perfect one (the surface then contributes
  nothing of its own; you see only the environment).
- **Fresnel edge** lifts grazing angles toward 1. At 0 it's a flat metal mirror, at 1 the
  reflection concentrates at silhouettes, which reads as glass.
- **Metal tint** tints the bounce by the surface hue. The tint is normalised so the brightest
  channel stays at 1 — multiplying by a shaded colour each bounce crushed everything to black by
  the third one, so gold came out as a dark smear instead of gold.

Enclosed mirror rooms blow out at high reflectivity: light never gets absorbed, so it is
genuinely that bright. Drop Exposure rather than Reflectivity.

`Kaleidoscope tile` deserves a note: a triangle whose angles are π/p, π/q, π/r with
1/p + 1/q + 1/r = 1 generates a wallpaper group by reflection alone, and there are exactly three
such triangles — (2,3,6), (2,4,4), (3,3,3). Those are the three modes. It folds in a plane and
extrudes along the axis you pick, so pairing it with Mirror corridor gives a tiled room.

One gotcha, learned by rendering it wrong: **the camera gets folded too.** With Mirror shells,
a camera further out than the shell spacing sits inside the folded region and sees structure
pressed against the lens. Spacing has to exceed your viewing distance. Same reasoning applies to
any fold with a bounded fundamental domain — if a starter looks like a wall of noise, pull the
camera in or open the spacing up.

## Architecture: the city primitive and the hinge fold

The reference look is **architecture**, not solids — window grids, ledges, setbacks. No amount
of folding turns a box frame into that, so `City` is a primitive: a block lattice with street
width, tower height, height variance and optional facade detail. It is the most expensive
primitive here, because a correct estimator has to scan the full 3x3 cell neighbourhood (a
building in a neighbouring cell can be nearer than the one in yours, and missing it makes the
estimate an over-estimate — the dangerous direction). Four cells left an 11.5% overshoot under
gate 3; nine is clean.

`Hinge fold` rotates one half-space about a hinge line by an arbitrary angle: at 90 degrees it
stands the far half of the world up on its edge. Stack two on different axes to box the world
into a corner.

### The seam channel — why a hinge fold is even possible

A rotation about a line **moves the points of the cut plane**, so the two halves are glued along
a tear. This is not an implementation flaw: it is the reason every distance-estimated fractal
in existence folds with `abs()`. Continuous space folding means reflection, full stop. Gate 3
caught the first version overshooting by 70x.

The fix is a third through-line channel alongside `s` and `trap`:

```glsl
vec3 opX(vec3 p, vec4 P0, inout float s, inout vec4 trap, inout float seam);
...
return min(prim(p) / s, seam);     // the estimator
```

An op that tears space reports its distance to the tear, in original space (so divide by the
current `s`). Away from the seam the fold is locally isometric and the estimate holds; near it
the marcher is bounded by the distance to the tear and can never step through. Hinge fold went
from -70.0 to **0.00000** overshoot. `Domain repeat` uses the same mechanism and is no longer a
second-class op — its `lip` is now `seam`, not `repeat`.

Continuous folds never touch `seam`, so it costs them nothing.

`Spiral vortex` is a logarithmic spiral — angle shifted by `k·ln(r)`. Distinct from `Twist`,
which shears along an axis; this shears in the plane, which is what drives a street grid into a
vortex. In an orthonormal polar frame the Jacobian is a constant shear, so unlike Twist its
operator norm doesn't grow with radius.

### Fold membrane — the seam as a visible surface

`min(prim/s, seam)` is the right number to ADVANCE by and the wrong number to hit-test against.
Returning it as a single value made the marcher stop on the cut plane and shade a phantom
surface — smooth contour bands that ignored iterations, IFS scale, palette, AO and step scale
but tracked the hit epsilon. That combination is the signature of a false hit rather than of
geometry, and it is worth remembering as a diagnostic: **if changing epsilon changes a feature
but changing step scale does not, you are looking at the hit test, not the surface.**

Gate 3 did not catch it, and could not have: it tests whether the estimator is a valid bound,
and the clamped value IS a valid bound. Being safe to step by and being a surface are different
properties.

The two are now separate outputs — hit-test against the true distance, advance by the clamped
one. The accidental look is kept as **Fold membrane** in the Renderer panel: it puts the old
behaviour back deliberately, so the fold's cut planes render as visible sheets. Off by default,
because a phantom surface is the wrong default, but it is a real effect and an on-brief one.

## Crystallographic space groups

`Space group` folds a point into the asymmetric unit of a crystallographic group. Twelve groups
covering all seven crystal systems, all three cubic lattice types, and two non-symmorphic
(screw) groups.

**Why twelve and not 230.** An instancing renderer and a distance estimator solve inverse
problems. Instancing applies symmetry operations FORWARD to place copies — cheap, general, and
table-drivable straight from spglib. A DE needs the BACKWARD map, sending an arbitrary point
into the asymmetric unit, and that has no general closed form. Each group is its own generator
recipe. Adding one is a row in `SG_BODY` plus its name; importing 230 is not a thing you can do.

The general escape hatch, if you ever want the full set: evaluate `min` over the orbit —
`min(prim(g_i * p))` across all operations of the group. That IS table-drivable from spglib and
exact, but it costs up to 192 primitive evaluations per estimator call, and the estimator is
instantiated ~10x and called hundreds of times per ray. Fine for stills, not for a live viewport.

**What decides difficulty:** reflection-generated groups fold continuously — a triangle wave is
exactly a mirror pair — so they are exact and free. Screws, glides, pure rotations and centred
(I, F) lattices glue space along a tear and report a `seam`. Before the seam channel existed,
half this table was impossible.

| group | system | mechanism |
|---|---|---|
| #1 P1, #2 P-1 | triclinic | lattice, inversion — seam |
| #10 P2/m | monoclinic | mirror (free) + 2-fold (seam) |
| #47 Pmmm | orthorhombic | three mirrors — continuous |
| #123 P4/mmm | tetragonal | + diagonal mirror — continuous |
| #191 P6/mmm | hexagonal | *632 triangle group — continuous |
| #164 P-3m1 | trigonal | *333 triangle group — continuous |
| #221 Pm-3m | cubic P | mirror lattice + axis sort — continuous |
| #229 Im-3m | cubic I | body-centred Voronoi — seam |
| #225 Fm-3m | cubic F | four sublattices — seam |
| #19 P2(1)2(1)2(1) | orthorhombic | three 2-fold screws — seam |
| #194 P6(3)/mmc | hexagonal | HCP, 6(3) screw — seam |

**Use an anisotropic primitive.** With a Sphere, Pmmm, P4/mmm and Pm-3m render *pixel-identical*
— the point group only shows up in how it orients the motif, and a sphere has no orientation.
Torus and Box frame reveal the differences; Sphere hides them.

## User images

A photo has no obvious job in a procedural 3D scene — there is no source plane to fold, which is
the whole basis of the 2D tool. It gets two placements instead:

- **Environment** — the image is treated as an equirectangular panorama and becomes the sky. It
  therefore appears in every reflection, which is what makes a mirror surface read as real glass
  rather than tinted plastic. This is the placement worth reaching for first.
- **Surface texture** — triplanar projection onto the folded geometry. An implicit surface has no
  UVs, so the photo is blended from three axis-aligned projections weighted by the normal.

Both are compile-time flags: with no image loaded, or both amounts at zero, the shader contains
no sampling code at all.

**An enclosed scene never sees the environment.** Mirror room, Kaleidoscope tube and the other
closed starters trap every ray, so nothing escapes to the background and the environment map has
no effect no matter how high you push it. Use it on open scenes — a solid in space, the folded
city, a Mandelbox. This is the same "the camera is inside the fold" family of surprise as the
rest of the tool.

## Export

**Aspect** letterboxes the canvas inside the window, so what you frame is what you export: free,
source image, 1:1, 4:5, 3:4, 2:3, 9:16, 4:3, 3:2, 16:9.

**Export size** is a multiple of the framed view (x1 / x2 / x4) or a fixed height (1080 / 1440 /
2160 / 2880 px), with the aspect preserved. Everything runs through the same blob-URL path as
before, so it stays iOS-safe, and the pixel clamp still applies — a 2880-tall 16:9 export lands
at 4096x2304 on iOS rather than failing.

## The mirror operators

| op | mechanism | cost |
|---|---|---|
| Mirror plane | one reflection | free |
| Mirror corridor | parallel pair — the infinite corridor | free |
| Mirror room | three orthogonal pairs — the infinity room | free |
| Corner mirror | three mirrors at a point (retroreflector) | free |
| Mirror shells | concentric SPHERICAL mirrors | exact, s = max(1, f(r)/r) |
| Mirror tubes | concentric CYLINDRICAL mirrors about an axis | exact, same form |
| Kaleidoscope tile | *632 / *442 / *333 planar groups, extruded | free |
| Polyhedral mirror | [3,3] 24, [4,3] 48, [5,3] 120 | free |
| Hyperbolic mirror | polyhedral fold + inversion in an orthogonal sphere | exact, conformal |
| Glide mirror | reflection plus a slide or a twist | seam |
| Space group | 12 crystallographic groups | mixed |

**Polyhedral mirror** is derived from the Coxeter relations for [p,3]: three mirrors with
n1.n2 = -cos(pi/p), n2.n3 = -1/2, n1.n3 = 0. Icosahedral is the only one of the three with
5-fold symmetry.

An earlier icosahedral fold used a single hand-picked golden-ratio plane alternated with abs().
It was a perfectly good isometry — which is why the Lipschitz gate passed it — but it folded to
a domain THREE TIMES LARGER than the octahedral one, so it was the wrong group entirely. **Being
an isometry and being the right group are separate properties**, and only a symmetry test catches
the second: fold(R p) must equal fold(p) for R in the group. The derived version is invariant
under its p-fold rotation to 6e-7, and correctly NOT invariant under a rotation outside the group.

**Hyperbolic mirror** works in the Poincare ball, where reflection in a sphere orthogonal to the
unit sphere is the exact analogue of a flat mirror. A sphere centred at distance d is orthogonal
when its radius is sqrt(d*d - 1), so Distance is the only parameter needed to keep it a true
mirror. Alternating that with a polyhedral fold tiles hyperbolic space: near 1 crowds the tiling
to the rim, larger relaxes toward the Euclidean fold.

**Polyhedral and hyperbolic folds fix the origin.** A primitive centred at the origin is
invariant under them and renders as a single untouched shape — the symmetry is real but invisible.
Put a Translate AFTER the fold (the primitive is evaluated on the FINAL coordinate, so an offset
placed before the fold does nothing useful), or use the fold's own Offset, which defaults to 0.7
for exactly this reason.

## KIFS and escape-time

The IFS loop already **is** a KIFS loop: `p = scale*(p - c) + c` with a per-pass rotation is the
classic `p = p*scale - offset` form, `s` accumulates `scale^N` so the DE convention matches, and
a pre-fold rotation is expressible by putting a Rotate op ahead of the fold in the stack.
Octahedral fold + scale 2 is a KIFS; box fold + sphere fold is Mandelbox geometry.

What was missing was the **escape-time** half, and it was architectural rather than a missing op.
Mandelbox, Mandelbulb and the Julias are not attractors — each pass re-adds a point,
`p = scale*p + c`, which turns the attractor into an escape-time set. Three things are needed:

1. **The original sample point must survive into the loop.** `mapT` now keeps `p0`.
2. **The derivative recurrence becomes additive:** `dr = dr*|scale| + 1`, because d(p0)/d(p0) is
   1. A purely multiplicative `s` cannot express that and gives a DE wrong by a growing factor.
   A fixed Julia constant contributes no derivative, so only the orbit mode adds the 1.
3. **A bailout.** Without one a power map runs to infinity in a few passes and the estimate is
   garbage. The orbit freezes at the escape point, which is where the classic `|p|/dr` is
   evaluated.

These are the **Feedback** control in the IFS panel (off / orbit / constant), plus Bailout and
Julia C. Two ops complete the set:

- **Menger fold** — the canonical sponge step. Self-contained rather than leaning on the IFS
  contraction, because its conditional shift has to happen *after* the scale and the loop applies
  folds *before* it, so it could not be assembled from existing ops.
- **Triplex power** — the Mandelbulb map. Pair it with orbit feedback for the Mandelbulb proper.

### The textbook Mandelbulb derivative is wrong, and by how much

Gate 2 rejected the standard running derivative `n*r^(n-1)` at **7.96x under-reported** for n = 8.
That is not noise: in an orthonormal spherical frame the three singular values are
`n*r^(n-1)`, `n*r^(n-1)`, and `n*r^(n-1) * |sin(n*theta)/sin(theta)|`. The textbook estimate drops
the third, and that factor tends to **n** at the poles — 8 for n = 8, matching the measurement.

So the classic Mandelbulb DE is not a valid lower bound near the poles, which is exactly where
Mandelbulb renders have always shown artifacts. Catoptron declares the full norm instead: correct
everywhere, at the cost of more march steps near the axis.

### Measured step-scale requirements

The default step scale is **0.85**, and that number is measured rather than chosen: the Mandelbox
with orbit feedback overshoots by 16.3% under gate 3, needing 0.86. Escape-time forms also need
far more march steps than mirror geometry — the Mandelbox starter ships at 768 steps with a hit
epsilon of 6e-5, and it renders as noise at anything much coarser.

**The camera gets folded here too.** A scale-2 Mandelbox has a bounding radius near 14-20, not 6.
At distance 7 you are inside it and every pixel reads as surface.

### A trap worth naming once

**The camera gets folded too.** It cost three bad renders. If a starter looks like an empty
gradient or a wall pressed against the lens, the camera is sitting inside the folded half-space
or inside the fundamental domain. Move the fold origin, or pull the camera to the near side.

## Current state — M0 + mirrors + city

Shipping: the DE contract and assembler, **19 operators** (17 exact, 2 seam-clamped) including a
five-op mirror group and the hinge/vortex architectural pair, **6 primitives** including City,
IFS recursion, orbit camera, specular reflection bounces, sky with sun and aerial perspective,
AO / soft shadows / rim / fog, orbit-trap palette colouring, eight starters, progressive
resolution, PNG export, and the validation harness (39 op variants, 243 shaders, 13 DE stacks).

Next, in order: camera modes and lens projections → materials and single-bounce reflection →
library expansion via the axis-lift wrapper → presets → the 2D post-fold stack → keyframes →
audio reactivity → HQ export with synced audio.

Four constraints are honoured from day one so those later milestones stay cheap: all state is
one flat JSON-serialisable object; `renderScene(w, h)` is the single draw entry point; every
slider declares its real min/max in the DOM; and the build stamp is logged at init.
