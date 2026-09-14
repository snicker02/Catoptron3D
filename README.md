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

A top bar and two rails.

**Top bar:** New, quick render (R), pause (Space), undo / redo (Ctrl+Z / Ctrl+Shift+Z), hide
panels (H), fullscreen (F), help (?), and a Dark / Grey / Light theme that persists.

**Anti-aliasing.** A distance-estimated fractal carries detail far below one pixel, so a single
ray per pixel does not just give hard edges — it **sparkles**, because which side of a feature the
ray lands on flips with any tiny shift. Supersampling is the only cure; no post filter recovers
detail a ray never sampled. Measured on Corner shell, with an isolated-pixel metric:

| samples | sparkle | cost |
|---|---|---|
| 1x1 | 7.93 | 1.0x |
| 2x2 | 5.25 (-34%) | 2.8x |
| 3x3 | 4.48 (-43%) | 5.9x |

It is compile-time, so at 1 it emits nothing and costs nothing. The **viewport stays at 1** and
**Export samples** in the Quality group drives saves and quick renders — paying 4x while orbiting would be
miserable, paying it once for a saved image is free. The average is taken in LINEAR light before
exposure and tonemapping, which stops one bright sub-sample dominating its neighbours.

Diminishing returns are steep: 2x2 buys most of the improvement at under 3x the cost, 3x3 buys
another 9 points for twice that again. 2x2 is the default.

**Quick render** answers "what will the save actually look like?". The viewport is deliberately
undersampled — Resolution defaults below 1 and drops to 55% of that while you drag — so the live
image is softer and noisier than a file. Measured on the default scene, mean neighbour detail runs
14.1 while dragging, 18.0 idle, and 21.8 at export size: the viewport shows roughly two thirds of
the detail a save contains.

The button renders ONE frame at exactly the dimensions the exporter would use and holds it on
screen, scaled to fit. It is the export path minus the encode — the same `renderScene` call
produces both — so if the preview looks right the file will too. Any change drops the hold and
live rendering resumes, so a stale preview cannot be mistaken for the current scene.

The app opens on **Folded frames** — the recursive box-frame lattice — which is the first entry
in Starters. Startup and **New** both apply that starter rather than building the state inline,
so the thing the app opens with is always reachable again.

The side panels carry only their own section title; the app name, subtitle and control hint live
once, in the top bar. They used to be repeated at the head of the left rail, which cost vertical
space and said the same thing twice.

One consequence: the top bar is now the ONLY place the control hint appears, so it is held on to
much longer at narrow widths — the subtitle drops below 1100px and the hint only below 820px.

The right rail opens on **Fold stack**. Opening the **Flame IFS** tab with nothing loaded pulls
in the default example, once per session — an empty transform editor reads as broken. Clearing
the flame deliberately is remembered, so coming back to the tab leaves it cleared.

Undo history stores captured **presets** — the same pure snapshot the preset system produces —
so undo can never drift from what a save would record. One entry per gesture rather than per
frame: sliders push on release, not while dragging.

The **?** button renders `README.md` itself rather than a separately-maintained copy that would
go stale, using a small dependency-free Markdown renderer in `engine/markdown.js`. That means
**README.md has to be deployed alongside index.html** — it is at the repo root, so a normal
deploy covers it, but a build step that ships only the app would silently break the help panel.

Two rails, split by what they answer:

- **Right — Structure.** What you are building: Fold stack, Renderer (primitive, membrane,
  mirror bounces and material), IFS recursion, Primitive dimensions, City.
- **Left — Look and output.** How it is presented: Image & export, Starters, Camera, Lighting,
  Sky, Image placement, Colour, Quality.

Either rail toggles independently. Above 1180px they reserve width and the canvas is centred in
what is left; below that they overlay, because two 300px rails plus a usable viewport does not
fit on a tablet — at 1024px reserving both would leave a 424px slot to work in.

## Artifacts: what each one actually was

Several rounds of reported artifacts were chased here, with a lot of wrong turns. The wrong turns
are kept deliberately — most were reasonable and all of them were wrong in the same *way*.

**The method that finally worked, and should be first every time:** render the raw depth and the
raw normal with no shading and no colour. On the frame in question both were clean — depth smooth
across the flat panels, normals a uniform constant. That eliminated the estimator, the marcher and
the normal calculation in a single render and left only shading terms. Guessing at colour,
precision and step scale in turn had cost several rounds before that.

## Why the flame path is harder than the fold stack, and the voxel mode

A fold is a deterministic function of `p` with a known Lipschitz bound, so `prim(p) / s` is a
genuine distance estimate and the gates can verify it. **A general affine IFS has no such form.**
The backward walk has to GUESS which map's image a point came from, and when the image boxes
overlap — one rotated transform is enough — the guess is arbitrary. Every flame artifact in this
document traces back to that.

Giving the flame its own program would not change it. The problem is mathematical, not
architectural.

### The export must not busy-wait

Saving a PNG froze the browser and produced no file. The export waited for the supersampled
program to link by spinning on `cache.request` in a `while` loop, up to eight seconds.

That cannot work, and the reason is worth keeping: a parallel shader compile reports completion
through the GL driver, and the driver generally needs the main thread to **return to the event
loop** before it will. Busy-waiting blocks the very thing it is waiting for. So the loop ran its
full timeout with the tab frozen, gave up, and silently fell back to 1x1 — or the encode failed
outright.

The wait now yields through `requestAnimationFrame`, and both `savePNG` and `quickRender` are
async. Blocking was defended in a comment at the time as acceptable "because an explicit export
expects a wait". It was not: an explicit export expects a WAIT, not a frozen tab, and the wait was
being spent preventing the work from finishing.

Two things fall out of making it async. The export claims the canvas **before** its first await,
because the frame loop keeps running and would otherwise resize the canvas back mid-export. And
the restore is idempotent with a watchdog behind it: if `toBlob` never calls back, which a large
enough canvas can cause, the lock would stay held and the viewport would never draw again —
indistinguishable from a frozen program.

### Redraw on demand

The loop called `renderScene` on **every animation frame whether or not anything had changed**, so
a completely static image held the GPU at full load indefinitely. On a heavy IFS that is the
difference between a card idling and a card pinned at 94% forever, for a picture that is not
moving. Reported on a 4090, with the CPU at 10% — GPU-bound on a still frame.

The frame is now drawn only when the state that reaches the shader has moved.

The mechanism is deliberately not a dirty flag threaded through every control: that is exactly the
bookkeeping that rots, because the one place that forgets to set it renders a stale frame and the
bug is invisible until someone notices the image is wrong. Instead a hash is taken of everything
that reaches the shader — all numeric state, the fold stack, the resolved flame, the canvas size,
the compiled program signature — and the frame is drawn when the hash moves. Hashing about ninety
numbers costs microseconds against a frame that costs milliseconds, and the flame resolve behind it
is memoised.

The hash has to cover things that do NOT move the shader signature, and that is where the first
version was wrong: it included each transform's matrix and amount but not its VARIATION index or
its parameter slots. Those are uniforms, so the signature does not move either — and turning a
variation's dial changed nothing on screen, with the frame correctly judged identical because
nothing the hash could see had moved. The most confusing shape of bug: everything works, and
nothing happens. The per-map image boxes and fixed points had the same gap.

Anything NOT in state carries an explicit counter instead: the loaded image, the voxel field, the
held preview. Elapsed time is included only while auto-spin is running, so a still frame does not
redraw itself forever just because the clock advanced.

Nine assertions cover it — camera, stack parameters, canvas size, the epoch, the program,
time-while-static, time-while-spinning, stability when nothing changes, and that the loop actually
guards the draw call.

### The frame budget was going on a fixed point

`currentCfg()` builds the shader signature every frame, and it called `resolveFlame` to do it.
`resolveFlame` runs a 400-iteration fixed point over every transform's eight corners plus a
pairwise box-overlap scan: **5 ms for an 8-transform flame, 16 ms for a 20-transform one, twice a
frame.** At 60 fps that is several times the entire budget, spent recomputing something that only
changes when a transform is edited. It made the flame path feel broken regardless of GPU load.

It is now memoised on a hash of exactly the inputs that affect the result: **5.4 ms to 0.0055 ms,
about a thousandfold.**

Getting the hash right was not free. The first version mixed each value as `v * 2^32 | 0`, which
maps **every integer to zero** — a rotation of 13 degrees, a scale of 1 and a weight of 1 all
hashed identically, and edits between them were invisible. A soak of 400 random edits caught 14
stale results. Hashing the float's BITS through an `Int32Array` view catches none in 600, and the
test suite runs that soak with integer-valued edits deliberately included.

### The containers ignored the variations

The estimator only ever needed each variation's INVERSE, so nothing on the CPU knew what a
transform actually did — `resolveXform` built every map's matrix from the **affine part alone**.

That is fine for linear3D and wrong for the other twenty-two. The hull, the per-map image boxes
and every containment test come off those matrices. On a reported flame using `exp` at amount
0.015, the affine part is tiny while the real image is not: **the hull collapsed to a box 0.003
units across for an attractor spanning 0.028**, so there was no container worth the name and the
frame filled with false surface.

`engine/varfwd.js` now implements the FORWARD map of all 23 variations, and a flame carrying any
of them has its hull and boxes **measured by chaos game** instead of derived. Affine flames keep
the exact corner fixed point, which is cheaper and exact for them — verified unchanged.

The forwards are checked by round trip against the shader's own inverses, not by reading them:
`tools/varfwd-probe.mjs` extracts each inverse from the assembled GLSL, runs it on the GPU over a
point grid, and the suite applies the JS forward to the result and requires `V(V^-1(q)) = q`.
That caught four wrong on the first pass — `unpolar`, `polar`, `zscale` and `zcone`, where I had
guessed the formula from the name. All 23 now agree to float32 precision.

### Crop box

Intersects the attractor with a world-space box: the maximum of two distance functions, which is
still a valid bound because both sides are.

It is applied in ONE wrapper around every estimator variant rather than inside each of them. There
are three — greedy, beam, voxel — and the shadow, ambient-occlusion and reflection paths all call
`map()`. Cropping inside a single estimator would have produced a cropped shape casting an
uncropped shadow.

Useful for cutting a section out of a structure that is more interesting inside than from outside.

### Notes fold away

Every explanatory note in the panels now sits behind a disclosure arrow, closed by default. They
earn their keep when something is wrong and are clutter the rest of the time.

Done by walking the finished panel for `p.note` and wrapping each one, rather than by editing each
note in place — so notes added later are covered without anyone remembering to. The pass is
idempotent, and a WARNING keeps its first sentence on the summary line, because a warning that is
hidden by being tidied away is worse than no warning.

### Restraining a runaway flame

Every flame failure in this project has the same shape. Each pass multiplies the accumulated
expansion `s`, and most variation inverses divide by the amount somewhere — so a **small amount
carries a floor of 1/|amount| per pass** however harmless the geometry looks. Past about 1e12,
`prim(q)/s` is zero for every point in the frame and everything reads as solid.

That floor is predictable, so the Flame tab now reports it instead of leaving it to be found by
sliding things at random:

| flame | floor per pass | projected s |
|---|---|---|
| exp at amount 0.015, 8 iterations | **66.7** | **2.6e19** |
| log at amount 0.10, 9 iterations | 10.0 | 2.2e11 |
| log at amount 0.70, 9 iterations | 1.7 | 5.4e3 |
| plain affine, 12 iterations | 2.0 | 4.1e3 |

Above 1e9 the panel names the worst transform and its per-pass figure.

**Scale ceiling** (Quality) is the restraint itself: the walk stops once `s` passes the ceiling,
keeping the estimate at the last depth where it still meant something. On the exp flame that
nothing else recovered, a ceiling of 1e5 took visible structure from 0.02 to **2.64** — a coarse
picture of the right object instead of a fine wash of noise, which is the trade it makes.

The right value is flame-dependent, which is why it is off by default and why the projection is
reported: 1e8 was too loose on that flame and 1e3 too tight.

### When the accumulated scale runs away

A separate problem on the same flame, and one that is NOT fixed. `exp` at amount 0.015 has an
inverse whose Lipschitz factor is `max(1/r, 1/|A|)` — at least 67 per iteration and up to 1e6 near
the origin. After eight passes `s` is around 1e25, and `prim(q)/s` is zero for every point in the
frame, so everything reads as a hit.

**Estimate depth** (Quality) offers the tightest bound over all depths rather than the last one,
since `prim(q_n)/s_n` is valid at every n and the early ones are not crushed. It is sound and it
costs one primitive evaluation per iteration — but on the flame that motivated it, it did not
recover the image, so it is off by default and offered rather than recommended.

For a flame like that the practical levers are a variation amount further from zero, and framing
the camera to the attractor's actual span, which the panel now reports.

### Search width: stop the walk guessing

The default walk commits to ONE branch per level. When the image boxes overlap that commitment is
a guess, and a wrong guess returns an estimate that is too LARGE — the marcher steps past the
surface and the detail is simply missing. Holes, not noise.

**Search width** follows the best 2 or 4 branches instead and takes the smallest estimate, which
is the distance to the union of those cells rather than to one guessed cell. Measured against a
**22.8-million-point** chaos-game ground truth at 20 iterations:

| width | agreement | cells wrongly EMPTY | phantom | rendered coverage | cost |
|---|---|---|---|---|---|
| 1 (greedy) | 94.6% | **313** | 120 | 89.2% | 1x |
| 2 | 96.3% | 81 | 216 | 93.0% | **4.5x** |
| 4 | 96.4% | **9** | 280 | 94.2% | **30x** |

Two notes on measuring this. An earlier version of the same comparison used a 400,000-point
ground truth and made the beam look WORSE, because cells the chaos game had simply not reached
yet were being counted as phantom. And the cost grows faster than the width: the insertion into
the running best-K is branchy, and the shader's register pressure rises with it.

The beam **unrolls per transform**, exactly as the greedy walk does, so each transform gets its
own variation inverse. The first version looped over the transforms dynamically with the linear3D
inverse written in by hand, which meant that at any search width above 1 every variation silently
rendered as linear3D: wrong geometry, no error, and only visible if you happened to switch a
variation while the width was raised. The test suite now asserts that all 23 variations produce a
distinct shader at each of the three widths.

Navigate at width 1 and raise it for the save. It only applies to a stack that is exactly one
Flame IFS op — anything else interleaves operators between the levels, so there are no branches
to carry.

### Render mode: voxel field

`Render mode` in the Flame tab switches the flame from estimating to **sampling**. The attractor is
built by CHAOS GAME — which is its definition, so nothing is guessed — turned into a signed
distance field by an exact euclidean distance transform, and uploaded as a 3D texture. `map()`
samples it.

Doing it as an SDF rather than as occupancy is the point: the field is a real distance function,
so the marcher, normals, ambient occlusion, reflections and the Lipschitz reasoning all work
unchanged. The test suite verifies it is 1-Lipschitz rather than assuming it.

Implementation notes worth keeping:

- **Felzenszwalb–Huttenlocher** distance transform, three separable 1D passes, linear in voxels. A
  naive nearest-search would be O(n²) and unusable at 128³.
- Encoded to **R8**, not float. 8-bit 3D linear filtering is core in WebGL2 while float and
  half-float filtering are extensions, and the quantisation is FINER than the grid it encodes:
  the near field resolves to voxel/16 and the far field saturates at 8 voxels, still a large step.
- `sampler3D` needs an explicit `highp` — GLSL ES gives it no default precision, unlike `sampler2D`.
- The chaos game uses a fixed xorshift seed, so a given flame always builds the same field.
  Otherwise the image would shimmer between rebuilds.
- Bounds come from the attractor's own extent, not the hull: the hull is a loose box for a rotated
  attractor and spending grid resolution on empty space is exactly what to avoid.

Measured at 128³ on a 5-xform flame: **540 ms to build**, 8.8% occupancy, voxel 0.033 units, 2 MB.

| | distance estimator | voxel field |
|---|---|---|
| detail | unlimited, zoom forever | capped at one voxel |
| correctness | approximate for a general IFS | exact to the grid |
| artifacts | containers, terraces, phantoms | the grid itself, close up |
| rebuild | none | ~0.5 s at 128³, seconds at 256³ |

**Close in, the grid becomes visible.** That is the trade, not a defect — and it is why this is a
mode rather than a replacement.

One honest gap: gates 2 and 3 cannot meaningfully test the voxel shader, because the headless
harness has no 3D texture bound and the sampler reads zero. The path is covered for COMPILATION by
gate 1, and the field's distance property is verified in `tools/test-presets.mjs` instead.

### Missing chunks and flat slabs: rays running out of budget

The most damaging setting in this tool is a **step scale too small to cross the scene**, and
nothing used to say so.

A ray advances `stepScale` times the safe distance. Set that low and the ray creeps: it never
arrives, the pixel falls back to background, and whole regions of geometry vanish. It does not
look like noise — it looks like missing chunks and flat slabs, which is easy to read as an
estimator fault.

Measured on a reported flame at a 384-step budget:

| step scale | ray hits | STARVED | mean steps used |
|---|---|---|---|
| **0.07** | 79.5% | **20.5%** | 220.9 |
| 0.15 | 97.3% | 0.6% | 138.9 |
| 0.30 | 97.4% | **0%** | 73.4 |
| 0.85 | 97.2% | 0% | 25.3 |

One pixel in five was starving. The Quality panel now estimates whether the budget can reach
across the scene and says so when it cannot.

Note the direction, because it is counterintuitive: a LARGER step scale rendered MORE geometry
here, not less. Small steps feel safer — they tunnel through thin structure less — but only if
the ray survives long enough to arrive.

### Flat planes and staircases: the estimate draws the CONTAINER

This is the single most useful thing to know about the flame estimator.

`dist(q, container) / s` is a lower bound on the distance to the attractor, so it is SAFE — but the
surface it draws, where the estimate reaches zero, is the **container's** surface, not the
attractor's. Each iteration replaces the container with a smaller one, so the drawn shape
converges to the attractor as levels are added. Stop early and you are looking at boxes.

That is exactly what large smooth planes with staircase edges are. Measured on a reported flame,
the fraction of frame that is flat plane:

| iterations | flat-plane area |
|---|---|
| 7 | **74.3%** |
| 11 | 39.2% |
| 15 | **10.9%** |
| 19 | 8.7% |

**The fix is more iterations**, and rotated flames need noticeably more than axis-aligned ones: a
rotated map's axis-aligned container is much larger than its image, so each level shrinks it by
less than the contraction does.

A tighter container was tried instead — the union of the per-map image boxes rather than the hull,
which is a strictly larger and still valid lower bound. On a cell-classification metric it looked
like an improvement (phantom cells 534 to 458, agreement 91.0 to 91.7), and the render was clearly
WORSE: coverage rose from 73% to 90% and boxy slabs appeared, because a boxier container draws
boxier geometry. Reverted. That is the fourth time in this project a metric and a picture have
disagreed and the picture has been right.

### "Image box" is exact only while the boxes are DISJOINT

The rule is exact for an affine IFS because the image of the hull under an axis-aligned map is a
box. **Rotate a transform and that stops being true**: the image is no longer axis-aligned, so its
AABB is much larger than the image itself, and with enough rotation every box overlaps every
other. Inside an overlap the rule has nothing to discriminate on and the choice is arbitrary —
which paints phantom surface, and terraces across it.

A reported flame had **all 10 image-box pairs overlapping** from a single 131/-91 degree
transform. Measured against a 400,000-point chaos-game ground truth, agreement was 91.0% with 534
phantom cells: about a third of the drawn surface was false. Switching selection rules did not fix
it — the four rules produced visibly DIFFERENT objects rather than cleaner versions of one, which
is exactly what an arbitrary choice inside an overlap looks like.

The flame layer now reports this, and the panel says which case a flame is in. That matters
because the selector calls the rule "exact for affine" and for a rotated flame it simply is not.

Three alternative rules were tried on that flame and none shipped:

| rule | agreement | missed | phantom |
|---|---|---|---|
| image box (AABB) | **91.0%** | 189 | 534 |
| exact inverse test — `f_i^-1(p)` in hull, exact for ANY affine map | 91.1% | 176 | 538 |
| bounding sphere — exact for similarities, rotation-invariant | 88.0% | 815 | 149 |
| nearest image | 89.8% | 747 | 68 |

The inverse test is theoretically the right one and gained 0.1%, which is noise; the limit is not
the box test but the HULL, which is a loose container for a rotated attractor. The sphere is
rotation-invariant and exact under a similarity, and still lost, because for this attractor the
sphere encloses 106 volume units against the AABB's 29. A tighter container is the real fix and
none of these is one.

### Blending the two selection rules

The two rules are both LENGTHS on the same scale — the distance from p to a map's image box, and
the size of the preimage q — so they interpolate directly:

    d = mix(sdBox(p, box_i), length(q_i), blend)

At 0 this is exactly `image box`. At 1 it orders identically to `nearest image`, since argmin |q|
and argmin |q|^2 agree. **Blend (box <-> image)** is the fourth Map selection mode, with a slider.

The interesting part is that the middle is not merely a compromise. Measured against a
400,000-point chaos-game ground truth on a five-xform flame:

| blend | agreement | attractor cells missed | phantom |
|---|---|---|---|
| 0.00 (image box) | **96.1%** | 5 | **309** |
| 0.15 | 94.9% | 1 | 406 |
| 0.35 | 94.7% | 1 | 420 |
| 0.70 | 94.2% | **0** | 462 |
| 1.00 (nearest image) | 93.1% | 84 | 465 |

A little blend **recalls more real structure than pure image box** — misses fall from 5 to 0 — at
the cost of more phantom surface. It is past about 0.8 that it stops filling gaps and starts
burying detail, which is where the smooth-but-wrong look comes from. Default 0.35.

### Why `nearest image` looks cleaner, and what it costs

Switching Map selection from `image box` to `nearest image` makes the crust disappear. It is worth
being precise about what that does, because the cleaner picture is the less accurate one.

Measured against a 400,000-point chaos-game ground truth on a five-xform flame, classifying cells
on a 40^3 grid:

| rule | agreement | attractor cells missed | phantom cells | rendered coverage |
|---|---|---|---|---|
| image box | **96.1%** | **5** of 1388 | **309** | 57.2% |
| nearest image | 93.1% | 84 | 465 | **98.3%** |

`nearest image` is worse on BOTH counts — it misses seventeen times as many real cells and invents
fifty per cent more phantom ones — and it paints 98% of the frame solid against 57%. The extra
false surface is smooth, so it does not remove the fine structure, it **covers** it. The crust is
still there underneath; a blanket has been thrown over it.

That makes it a legitimate choice for the look, and it should be chosen with open eyes: it is a
smoothed and inflated version of the attractor, not a better picture of it. The panel says so.

### The crust on fractal faces is the geometry

On the preset that prompted this, the isolation was: depth is smooth where the surface is smooth
and textured only where the crust is; the estimator sampled across the surface at the hit gives
transverse slopes of 0.3 to 0.8, which is what a distance function should give; and supersampling
resolves the crust into coherent structure rather than erasing it, 24.1 to 17.0 pixel-to-pixel
at 4x4. So on that preset the crust is real detail at or below one pixel.

**Two attempted fixes were reverted, and the reason matters more than the fixes.**

Reasoning from the confetti-normal buffer, the probe was floored at one pixel footprint and then
also at the estimator's cell size `1/s`. Both were plausible. Both were shipped after measuring
**no benefit** on the very case that motivated them — the roughness metric went 20.66 to 21.46,
slightly WORSE — and both then degraded every other scene: a visible moiré ripple across surfaces
that had been clean, mean image difference 13.7 and 14.0 against the previous build. The cell
floor was worse still, because `1/s` is a world-space length and a scene with a small accumulated
scale gets a probe of a large fraction of a unit.

A screen-space derivative normal was added at the same time on the same reasoning, also measured
as no change, also shipped, also removed.

`calcNormal` is now byte-for-byte what it was before, and the render is pixel-identical to the
pre-0.40.0 reference. The rule this cost three regressions to learn: **a change that measures no
improvement on its own motivating case does not ship**, whatever the reasoning behind it says.

### Blocky static while navigating — the viewport, not the render

A video of the live viewport shows flat panels covered in hard-edged, axis-aligned blocks at
several scales, with black holes, flickering as the camera moves. That is not noise and not
shading: it is the IFS **cell structure landing below one pixel**, so neighbouring pixels sample
different cells and classify them differently.

Measured on one such flame, pixel-to-pixel variation: **8.2 at one ray per pixel, 4.2 at 2x2,
3.0 at 4x4.** It is sampling, and supersampling fixes it.

The problem was that supersampling only ever applied to **Save** and **Render** — the viewport
deliberately draws one ray per pixel, below full resolution, and drops further while dragging.
That is correct for interactivity and badly misleading for judging an image: the thing on screen
looks broken while the saved file is clean, and there was no way to see a good image without
explicitly pressing Render.

**Refine when still** (Quality, **off** by default) redraws the settled frame at the Export
samples count once the view has been still for a moment. Any interaction drops straight back to
the live path; auto-spin disables it.

It defaults off because it costs interactivity. A supersampled pass is several times a normal
frame AND needs its own compiled program, since the sample count is part of the shader signature
— so every parameter change means a fresh program for both the live and the refined pass. Pressing
**R** gives the same picture on demand without the cost.

The first version also **blocked the main thread** waiting for that program to link, which is
right for an explicit export and completely wrong for something automatic: the interface stalled
for the whole link time every time the view settled, after every change. The idle path is now
non-blocking — it asks for the program, gives up for that frame if it is not linked, and asks
again next idle frame.

If a viewport looks like static, that is the first thing to check — and the second is to press
**R** and compare.

### Mottled flat faces — ambient occlusion

Switching shading terms off one at a time on a flat panel: **AO 16.5 to 10.1**, reflections 16.5
to 17.1. Almost entirely AO. No radius removes it — 16.5 at 0.5, 16.3 at 0.1, 17.7 at 0.02 — so
an AO radius control added earlier was treating a symptom.

The reason is structural: AO samples the distance ESTIMATE along the normal, and on a deep IFS
that estimate is a weak, non-smooth bound at every offset, so each probe lands on structure and
the occlusion varies across a face that is genuinely flat.

Each sample is now normalised by its own offset and clamped to at most 1, so one bad estimate
cannot dominate, and the sum is divided by the total weight. Panel ripple 16.5 to 13.9.
**An improvement, not a cure** — AO off gives 10.1. On such flames, turn AO down or off.

### Smooth fan-shaped arcs — real fins, smeared

Thin fins thrown off by a flip map, averaged away by **Normal smoothing**. At 16 the probe reaches
about 0.15 world units, comparable to the structure, so the normal averages across many fins and
they collapse into arcs. At 1 they resolve into the fins they always were. Normal smoothing is
capped at 4 for this reason.

### Concentric contour rings — the trap channel

Distinct from the arcs above, and this one IS colour. The trap component driving colour defaulted
to `trap.w`, the squared orbit radius — a radial quantity, so its level sets on a flat panel are
rings, and a cosine palette turns them into contour bands. **Trap channel** (Colour) now offers
the radius, any single axis, or the minimum of X/Y/Z, which band along the structure instead.
Trap scale above about 1 wraps the palette more than once across one face.

### Specks in empty space — a precision guard, since removed

A guard that froze the backward walk when the best and second-best candidate were within a
tolerance. Image boxes tie EXACTLY on their shared boundary planes, so it froze at the first step
and returned an unrefined negative estimate that reads as a hit — false surface along those
planes. Isolated specks 648 to 1006. Removed in 0.36.0.

### Filled sheets are not a fault

Four maps at scale exactly 0.5 translated to the four corners tile the square, so the attractor
genuinely contains **filled sheets**. They are real geometry. Dropping the corner scale to 0.47
makes them vanish because it changes the artwork, not because it fixes anything.

Exact tiling does have a real cost for the estimator: the image boxes leave no gap, so box
containment can never prove a point outside, and the surface resolves only to about
`hull / 2^iters`. At 10 iterations that is roughly one pixel at a close camera.

### The measurement trap, three times over

A ripple or speckle metric counts high-frequency variation, and **resolving real detail raises it
exactly as noise does**. On the fin region the score went UP from 8.4 to 34.0 when the smearing
came off and the picture improved. The trap-channel change moved it 7.27 to 6.93 while the image
changed completely.

Two shipped changes had to be reverted because a number said they were safe:

- **Precision guard** — a numeric model showed worst-case error dropping 138x to 2.4x. True, and
  irrelevant; it added 55% more specks.
- **Normal smoothing at high values** — offered against a grain metric, and it smears real
  geometry.

The **secant hit refinement** from the same period was checked the same way and kept: it slightly
REDUCES specks, 751 to 661.

### Hit refinement

The hit test fires as soon as the estimate drops below the epsilon, so the reported distance is
wherever the discrete steps landed rather than where the surface is. With a generous epsilon that
quantisation shows as banding. The previous sample and the current one bracket the crossing, so
the marcher interpolates to where the estimate would reach zero, at no extra `map()` call. It
changes the default scene by a mean of 23.3 levels at a large epsilon — but only when steps are
far apart; at a step scale of 0.145 it makes no measurable difference.

### What was ruled out

The estimator and the marcher were both suspected early and both cleared.

- **The flame estimator is sound.** Against a 400,000-point ground-truth sample of the Jerusalem
  cube, DE/true distance has a median of **0.994** — tight, not conservative — and exceeds 1.0 in
  0.01% of samples, which is consistent with finite-sample error in the ground truth rather than
  with a real overshoot. Iteration count made no difference to this.
- **Step starvation is minor.** Instrumenting the marcher to separate rays that HIT, rays that
  legitimately escaped to the background, and rays that ran out of budget mid-scene: starvation
  is 1.8% on Folded frames, 3.5% on Menger sponge, and 0% on the flame scenes.
- **All three gates still pass** on every operator and stack.

So there was no estimator or marcher fault to find. The real gaps were the shading terms above
and, separately, the complete absence of anti-aliasing.

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

## Crystal

A cluster of faceted shards radiating from the origin. Each shard is a regular n-gonal prism
with a pyramidal termination, built as an intersection of half-spaces — which for a convex solid
is both simple and safe, since `max()` of plane distances underestimates outside the body and an
underestimate is the harmless direction. The union of shards is exact and each is placed by a
rotation, so the whole primitive measures 0.00000 under gate 3.

**Point length is `R * tan(tip)`**, so a `Point length` near zero gives a FLAT top and values
approaching pi/2 give a needle. The intuition runs backwards, and the first version shipped at
0.55 rad — a point only 0.6x the radius, which read as a beam rather than a crystal.

Directions, lengths and radii are hashed per shard from the global **Seed**, because a perfectly
symmetric cluster reads as synthetic. For deliberate order, set **Spread** to 0 and put a
Polyhedral mirror, Sector fold or Octahedral fold in the stack instead — that is the idiomatic
way to get symmetry in this tool, and it composes with everything else. Domain repeat turns one
cluster into a field.

Transparency is in — see below.

## Transparency and refraction

Reflection bounces off a surface; **transmission goes through the medium**, and that needs the
marcher to walk the interior. `march` takes a side sign: +1 outside, -1 inside, negating the
estimate so the same routine finds the exit face. The path loop then tracks which side it is on
and bends at every interface.

- **Transparency** splits each hit: the opaque fraction shades normally, the rest is carried on.
- **Refractive index** drives Snell at both faces. Total internal reflection is detected (a
  degenerate `refract` result) and handled by reflecting instead of crossing.
- **Absorption** is Beer-Lambert over the distance actually travelled inside, and in the
  COMPLEMENT of the material colour — that is what makes thick glass saturate toward its own hue
  rather than merely darken.
- **Dispersion** traces three separate paths with the IOR spread per channel. Three full traces
  is the honest cost; there is no cheap version that bends the channels differently without
  following them. Compile-time, so it costs nothing at zero.

Reflection at each interface is approximated with the environment rather than traced, because
following both branches at every hit is exponential. Refraction is the branch that has to be
exact, since it is what carries the image through.

**Glass needs something to transmit.** Against a near-black sky, transparency reads as a dark
smudge — correct physics and a useless picture. The `Glacier glass` palette ships a lit sky for
this reason, and Glow supplies the internal luminosity that makes a crystal read as lit from
within. All three of Transparency, Reflectivity and Dispersion need **bounces > 0**.

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

## JWildfire variations

Variations ported from the Apophysis / JWildfire set live in the fold stack under a `V:` prefix.
They are **folds** — applied forward to p before the primitive — and that placement is the whole
reason most of them can come across at all.

**Two placements, very different requirements.** A fold needs only the Jacobian's operator norm.
Running a variation inside **Flame IFS** instead needs a closed-form **inverse**, because that
path runs the maps backwards. Of the current batch only `Spherical 3D` qualifies, and only
because it is an involution — `sinusoidal` is many-to-one and simply cannot be inverted.

**Every norm below is closed-form.** No finite-difference Jacobians: they cost four extra
evaluations inside an estimator already instantiated ten times, and the error is hard to bound.

| variation | 3D form | operator norm |
|---|---|---|
| Sinusoidal | componentwise `sin` | exact `a*max\|cos\|` — 1-Lipschitz at amount 1 |
| Spherical 3D | `a*p/\|p\|^2` | exact `a/r^2`; identical to Sphere inversion with R^2 = a |
| Bubble | radial, `r^2` over all three axes | exact `max(g, d(rg)/dr)` |
| Cylinder | wraps one axis onto a sine | exact `\|a\|` |
| Hyperbolic | 2D form extruded | Frobenius `a*sqrt(1/r^4 + 2)` |
| Swirl | rotate the plane by `r^2`, extruded | exact, same closed form as Twist |
| Curl | `w -> w/(1 + c1 w + c2 w^2)` | exact `\|1 - c2 w^2\|/\|D\|^2` |
| Waves 3D | cyclic sine displacement | Frobenius, closed-form |
| PDJ 3D | cyclic sin/cos | Frobenius, closed-form |

**Curl turned out to be conformal.** Written in complex form the 2D variation is exactly
`w -> w/D` with `D = 1 + c1*w + c2*w^2`, so its Jacobian is a similarity and the norm is
`|1 - c2*w^2| / |D|^2`. Verified against a finite-difference Jacobian to 5e-8. That is much
better than bounding it numerically.

**Two things worth knowing when using them.** `Spherical 3D` is an involution, so an even number
of iterations is the identity — two passes give you back an untouched primitive, which looks like
a bug and is not. And `Sinusoidal` is periodic, so it tiles space into an infinite lattice rather
than deforming a single object.

**Faithfulness caveat.** Flame variations SUM inside an xform (`out = sum of amount_i * V_i`),
while a fold stack COMPOSES. A single-variation xform ports exactly; reproducing a
multi-variation xform would need a blend op that holds several variations with weights.

`Hyperbolic`, `Swirl`, `Curl`, `Waves` and `PDJ` are **my 3D lifts of the 2D formulas**, not ports
of JWildfire's own `*3D` variants — the 2D source is unambiguous, the 3D promotion is a choice.
Paste the Java for a specific `*3D` variation if you want its exact behaviour instead.

### The symbolic batch

Eleven more fold variations — polar, disc, diamond, handkerchief, heart, spiral, exponential,
cosine, eyefish, blob, secant — were **not hand-derived**. `tools/gen-variations.py` writes down
the 2D core of each once, sympy differentiates it, and the GLSL in `engine/ops.js` is emitted
from that: map and Jacobian from one source, so they cannot disagree. Each Frobenius bound was
then checked against a numerical Jacobian over a random cloud before shipping.

The gate confirms the bounds are tight rather than merely safe — the measured ratios sit between
0.93 and 1.00, so almost no march speed is given away. Hand-deriving eleven Jacobians would have
been eleven chances to be quietly wrong, and **a wrong norm does not throw; it punches holes in
surfaces**.

The generator also documents two things it got wrong first time: sympy's GLSL printer emits a
`float pi = ...` declaration mid-expression, and GLSL ES 300 refuses to implicitly convert int to
float, so bare literals like `exp(x - 1)` and `juy = 0` fail to compile.

## JWildfire flame import

`import .flame` reads a JWildfire / Apophysis flame and turns it into geometry — the **linear
subset only**, which is a hard boundary rather than a limitation of effort.

**What counts as linear.** The whole affine variation family is accepted — `linear`, `linear3D`,
`linearT3D` — and a variation's AMOUNT is free rather than having to be 1.0, because the amount
simply scales the affine result. Amounts within the family add. `post` / `yzPostCoefs` /
`zxPostCoefs` are composed rather than ignored, since silently dropping a post transform would
import geometry that is wrong without saying so.

`linear` only carries z when the flame sets `preserve_z`; `linear3D` always does. A 2D-only xform
would collapse z into a singular, uninvertible map, so z is passed through instead and the import
warns that the attractor is planar.

**Why affine only.** A flame renders by CHAOS GAME: push a point forward through randomly chosen
maps and accumulate a histogram. A distance estimator cannot do that at all. What it can do is
run a contractive affine IFS BACKWARDS — the attractor satisfies A = union of f_i(A), so a point
near A lies in some f_i(A) and f_i inverse carries it back. That works for affine maps and only
for affine maps. An xform carrying any nonlinear variation is skipped and listed in the console,
never approximated.

**The coordinate convention was reverse-engineered.** JWildfire stores a 3D xform as three 2D
affines — coefs (XY), yzCoefs (YZ), zxCoefs (ZX) — and the composition order is not in the file.
It was determined by requiring a known Sierpinski tetrahedron to come out as exact 0.5
similarities: of the six possible orders, two give singular values [1, 0.5, 0.25] and are
definitively wrong, and four give exact 0.5-similarities. XY then ZX then YZ is used. The four
survivors differ only for an xform with non-diagonal blocks in TWO planes at once; for the common
case they agree exactly. `PLANE_ORDER` in `engine/flame.js` is the single thing to change if an
import ever comes out visibly wrong.

**Camera target.** The orbit camera used to be pinned to the origin, which is fine for the fold
stack but wrong for imported flames — they are rarely centred there, and a Jerusalem cube occupies
[0,1]^3, so it sat off to one side and orbiting swung it out of frame. Target X/Y/Z live in the
Camera group and the orbit is around the target.

**Plane order, corrected.** JWildfire does not record how its three 2D affine blocks compose, so
the order has to be inferred — and **one reference object is not enough**. A Sierpinski tetrahedron
only requires every map to be a 0.5-similarity, which four of the six orders satisfy; the first
version of this parser picked `XY -> ZX -> YZ` from among them and was wrong. A Jerusalem cube is
the discriminating case because it must be **isotropic**, and under the old order it imported as
0.41 x 1.0 x 1.0 — squashed in x, because the XY block's translation was being scaled by a later
block. Requiring both properties leaves exactly one order, `ZX -> XY -> YZ`, which is now used and
asserted in the tests.

**Transform count.** The cap is 24. It was 8, which silently discarded everything past the
eighth and rendered a completely different attractor — a Jerusalem cube needs 20, and the eight
that survived happened to be the entire coarse-scale family, so the fine structure vanished
without any visible sign. A truncated or partly-skipped import now shows a warning count in the
panel rather than only in the console.

The ceiling is the fragment uniform budget rather than taste. Per xform the shader can reference
three vec4 slots for the inverse matrix plus one each for the inverse translation, expansion,
variation amount, fixed point and three parameter vec4s — but GLSL drops uniforms it never
references, so a flame of plain `linear3D` xforms costs about six slots each. Measured on the
Jerusalem cube: 20 xforms, 120 slots, with `uFlameFp`, `uFlameVP`, `uFlameVQ` and `uFlameVR` all
eliminated by the compiler. WebGL2 guarantees 224.

### Original flames

Five that ship with the tool, written for this renderer rather than ported. All are selections of
cells from a 3x3x3 subdivision, which is a deliberate constraint: axis-aligned maps keep the image
boxes **disjoint**, and disjoint boxes are what make the selection rule exact rather than merely
conservative. `tools/make-flame.mjs` writes the `.flame` from a list of maps.

| flame | cells | dimension | note |
|---|---|---|---|
| Corner shell | 19 | 2.68 | everything but the eight corners — dense, with a bite out of every scale |
| Checker sponge | 14 | 2.40 | cells whose coordinates sum to even; solids meet only at edges |
| Checker weave | 14 | 2.40 | the same maps under xaos, transitions allowed only between equal parities |
| Beam lattice | 12 | 2.26 | the twelve edge cells only, so it hollows into a cage of beams |
| Vicsek cross | 7 | 1.77 | centre plus the six faces — the 3D cross, connected through its own middle |

Two were designed, rendered, and thrown away: eight half-scale corners exactly TILE the cube, so
a "mirror cube" of reflected corners fills solid and is not a fractal at all; and an octahedral
flake at half scale has overlapping image boxes, which quietly downgrades the exact selection to
a conservative one. The octaflake constraint is worth stating — for arms at distance d and scale
s the boxes stay disjoint only when `d > 2s` and `d + s <= 1`, which forces `s < 1/3` and makes
the result too sparse to read. Dimension below about 2.2 renders as dust here.

**Checker weave** is the one to look at for xaos: identical maps to Checker sponge, restricted
grammar, and the solid mass opens into strands.

**Bundled examples.** The Flame tab has a picker for the flames in `examples/`, and opening the
tab for the first time loads the first of them — currently **Flame IFS base**. Each entry carries
the view settings that make it look right on load; without them an import lands on generic
defaults and a perfectly good flame can render as a speck. They are fetched the same way the help panel
reads `README.md`, so — like the README — **the `examples/` folder has to be deployed** for them
to load.

**The panel shows the file's own numbers.** The parser used to fold each xform's variation
amount into its affine — arithmetically equivalent, and useless to edit from: an xform the file
gives as offset (1, -1) with amount 0.5 appeared in the panel as translation 0 and amount 1. The
amount now stays with the variation, where the shader applies it anyway, and **Move** shows the
TOTAL translation, the file's own offset plus any edit. The edit is still stored separately, so
`reset edits` restores the file exactly.

One consequence worth knowing: contractivity is a property of the EFFECTIVE map, so the import
check multiplies the affine's norm by the amount. Testing the bare affine reported every xform of
a perfectly good 0.5 flame as non-contractive.

**Xaos, and why weight is absent.** These look like a pair and behave nothing alike, so it is
worth being precise. In a chaos game, **weight** sets how often a map is chosen and **xaos** sets
which map may follow which. Measured over a five-million-point run on the square-corners flame:

| change | difference in support at 0.2M / 1M / 5M points |
|---|---|
| weights 8,1,1,1 | 546 / 155 / **10** |
| weights 1,1,1,0.05 | 573 / 252 / **126** |
| xaos: nothing may lead to xform 4 | 1818 / 1818 / **1818** |

Weight differences shrink toward zero as sampling improves — same SET, different DENSITY, and the
apparent change was under-sampling of rare regions. Xaos differences do not move at all.

**Weight is still shown, per xform, with the file's value.** It was briefly left out on the
grounds that it changes nothing here, which was the wrong call twice over: it hides what the file
actually says, and **zero is a genuine geometric switch** — a zero-weight xform is never chosen
by the chaos game and drops out of the attractor entirely. Above zero it is honestly inert in
this renderer, and the panel says so rather than implying otherwise. A zero-weight or disabled
xform is greyed and reads `inactive`.

**Xaos rows are indexed by position in the FILE**, so once any xform is disabled or zero-weighted
the rows must be remapped through the survivor's original index rather than read positionally.
Reading them positionally pointed each row at the wrong column: with "each xform may only follow
itself", disabling the second turned `1000 0100 0010 0001` into `100 001 000` — every row aimed
at the wrong successor and the last transform left with none at all.

Because only the zero pattern reaches the estimator, the Xaos grid stores allowed/forbidden
rather than magnitudes, and the adjacency is baked into the shader.

With a restricted matrix this becomes a **graph-directed IFS**: the set a point occupies depends
on which map was applied last, so `A_j = f_j(union of A_i over i that may precede j)` and every
transform gets its OWN bounding box rather than sharing one. The backward walk carries the last
map it undid and only considers predecessors xaos permits.

The iteration is also **clamped to that bound every step**, because it is NOT monotone when a map
rotates: the AABB of a rotated box inflates by up to |cos|+|sin| per plane, and if that inflation
beats the contraction the hull runs away. The default flame has a -126.5 degree map at scale 0.72,
an inflation of 1.008, and its hull reached +/-45 for an attractor that fits inside a radius of
2.4. The clamp caps that and never binds on an axis-aligned flame.

Those per-state hulls are found by iterating DOWNWARD from a box that provably contains the
attractor (radius `t/(1-c)` for contractions bounded by c with translations bounded by t).
Iterating upward from a seed point is the obvious approach and is wrong in a way that looks fine:
the seed never leaves, so every state hull ends up containing the origin and the boxes all
overlap, which quietly destroys the exact selection rule.

**The transform editor.** Flame IFS has its own tab beside the fold stack, with a card per
transform: enable, duplicate, delete, and per-transform scale / rotate XYZ / move XYZ. Each card
shows its resolved contraction and flags any transform that has reached 1.0, because a
non-contractive map has no bounded attractor and renders as noise.

Edits are **non-destructive**: an xform keeps its imported affine and layers the offsets on top,
so *reset edits* restores the file exactly and a preset records what you changed rather than a
flattened matrix. You can also build an IFS by hand — *+ transform* starts from a plain 0.5
contraction, no file needed.

The matrices are **uniforms, not baked constants**, so dragging a transform slider costs nothing.
Only the transform COUNT is compiled in, which means adding, deleting or disabling one rebuilds
and everything else is live.

**Per-xform variations.** Each transform card has a variation selector, so you can swap
`linear3D` for `spherical3D` on one xform the way you would in a flame editor. An imported flame
arrives as `linear3D` at amount 1, because the parser folds the file's variation amount into the
affine; switching layers the new variation on top, which is flame semantics: `f(p) = V(affine(p))`.

**The list here is deliberately short, and the reason is structural.** This path runs the maps
BACKWARDS, so a variation needs a closed-form **inverse** — a far stricter requirement than the
fold stack, which only needs a Jacobian norm. Four qualify, all verified to round-trip exactly:

**Twenty-two qualify**, and the count was nearly a third of that until one observation changed
it: **a principal branch is a true right inverse even when the forward map is many-to-one.**
`sin(asin z) == z` identically. Since the backward path only ever needs `V(V^-1(q)) == q`, the
whole complex-analytic family JWildfire ships — the "complex vars by cothe" set named in
`ExpFunc` itself — is eligible.

Each inverse was checked numerically for exactly that property before any GLSL was written; all
round-trip to about 1e-14. And because these maps are conformal, `|g'| = 1/|f'(g(q))|`, verified
to 3e-8 — so each variation needs only its FORWARD derivative. Twelve hand-derived inverse
derivatives would have been twelve chances to be subtly wrong.

| variation | inverse | note |
|---|---|---|
| linear3D | `q/A` | |
| spherical3D | itself | an involution |
| swirl | unwind the amount, turn the angle back by the same r | radius is preserved |
| radial power | `(rho/A)^(1/n)` | |
| exp | principal log | exp is many-to-one FORWARD, but log is a true right inverse |
| log | exp | the mirror image of the above |
| unpolar | log | exp with the axes swapped |
| polar | inverse polar | needs `r > 0`; below that there is no preimage and the map reports a huge distance so another is chosen |
| zscale | `z/A` | JWildfire's zscale only writes z, so alone it would collapse a dimension — this is the standard `linear3D + zscale` pairing |
| zcone | subtract the cone | same pairing |
| sin, cos, tan | asin, acos, atan | principal branch |
| sinh, cosh, tanh | asinh, acosh, atanh | principal branch |
| sec, csc, cot | acos/asin/atan of the reciprocal | principal branch |
| sech, csch, coth | acosh/asinh/atanh of the reciprocal | principal branch |
| mobius3D | undo translate, scale and rotation, then invert about the centre again | a true 3D Mobius; 10 parameters |

**On the scale of this.** JWildfire ships several hundred variations. The fold stack could take
most of them — it needs only a Jacobian norm, so what limits that side is work per variation, not
mathematics. The xform level is the genuinely restricted one, and the table above is the honest
extent of it: affine-like maps, radial monotone maps, and conformal maps with principal inverses.

**What was rejected, and why** — the reason is always structural:

| variation | why not |
|---|---|
| sinusoidal, cylinder, waves, pdj | many-to-one, no inverse |
| bubble, hemisphere | `hemisphere` ignores its z input entirely, so its Jacobian is singular; `bubble`'s image is bounded by its amount |
| hyperbolic, curl3D | inverse is a coupled quadratic with an ambiguous branch |
| julia3D | picks a branch at random — stochastic, not a map |
| mobius | invertible AND conformal, but needs 8 coefficients; an xform carries 2 |

**mobius3D, and why it is not `mobiq`.** Every orientation-preserving Mobius transformation of
R^3 that is not a similarity factors as `T(p) = b + lambda*R*(p - a)/|p - a|^2` — invert about a
centre, then rotate, scale and translate. Ten parameters, every step closed form, verified exact
both ways and conformal to 1e-8, with norm exactly `1/(lambda*|u|^2)`.

JWildfire's `mobiq` is a quaternion Mobius, and at first glance the better candidate. It is not:
it computes four components of `N*conj(D)` and **discards the k one** (measured mean magnitude
1.03, so it is not incidentally zero). That makes it a projection of R^4 onto R^3 rather than a
bijection of R^3 — inverting it would mean recovering the component it threw away, and there is
no closed form for that. Mobiq can only ever be a fold. mobius3D is invertible and is the better
map for this tool anyway.

**Inversive variations want `nearest fixed point`.** Under `nearest image`, an inversion collapses
distant points onto its centre, so the same map wins the selection every time and the parameters
stop having any visible effect — measured as literally identical frames across wildly different
settings. Switching selection mode makes the same parameters change the image completely. This
applies to `spherical3D` and `mobius3D`.

**Parameter storage.** Variations draw from a shared 12-slot store, with each variation's
parameters pinned to explicit slots that are never reused. Switching a variation therefore cannot
silently reinterpret a value set for a different one, and switching back finds it unchanged.

The variation TYPE is compiled in (each emits different inverse code) so swapping one rebuilds,
while its amount and parameter are uniforms and stay live. **Map selection** moved out of the
fold slot and into the flame, where it belongs.

**Map selection: the exact rule, and two heuristics.** For an affine IFS the correct backward
step applies the inverse of the map whose IMAGE contains p. That sounded like it had no closed
form, and for a long time this tool approximated it — which is why imported flames rendered as
sparse dust. It does have one: the attractor's bounding hull is found by iterating
`B -> union of f_i(B)` to a fixed point, and the image of a box under an axis-aligned affine map
IS a box, so "does p lie in image i" is an exact containment test.

On the Jerusalem cube the 20 image boxes come out **perfectly disjoint**, so the rule is exact
there, and it **misses zero attractor cells** against a chaos-game ground truth where
nearest-image missed 1478 of them. Every import now also **reconfigures and reframes**: the Flame hull primitive, a workable
iteration count and epsilon, and the camera aimed at the attractor's own centre and backed off to
fit its hull. This used to happen only on the FIRST import — loading a second flame kept the
previous primitive and iteration count, so the new attractor was rendered through settings meant
for the old one and looked broken.

`image box` is the default for imported flames; the two older
heuristics remain for flames whose maps are not axis-aligned.

Pair it with the **Flame hull** primitive — the attractor's own bounding box — and you get the
classic IFS estimator, distance to the hull over the accumulated expansion. That renders a solid
attractor rather than the dust a guessed sphere radius gives.

**The older heuristics are still heuristics.** The exact rule would be "the inverse of the
map whose image contains p", which has no closed form for a general affine IFS. `Select` offers
*nearest image* (apply every inverse, keep the one landing closest to the origin) and *nearest
fixed point* (each map contracts toward its own fixed point, so those points partition space).
Different flames favour different ones; the Sierpinski example is better under nearest-image.

**What it looks like.** An IFS attractor has measure zero, so it renders as a fine dust rather
than a solid — which is what the set actually is. `Primitive size` thickens it, and wants to
scale roughly with 2^-iterations because the estimator divides by the accumulated expansion. A
purpose-built fold (Tetrahedral fold plus a scale) gives a cleaner solid Sierpinski than the
imported general form; the import earns its place on flames you cannot express as a fold.

Inverse matrices and operator norms are computed in double precision at import time and baked
into the shader as constants, so the estimator divides by a true operator norm even when a map
is a shear rather than a similarity. Flames are carried inside presets.

## Presets

A preset is a full snapshot of everything that makes an image: the fold stack (operator types,
every parameter, discrete selections), the IFS settings, camera, lighting, material and bounces,
palette, step scale, and any imported flame. It carries a `version` integer, and the loader is
deliberately tolerant — unknown keys are reported and ignored, missing ones come from defaults,
unresolvable operators are dropped with a warning rather than silently substituted.

**Factory presets** ship in `engine/factory.js`, generated from the former Starters table by
`tools/gen-factory.mjs`. They are ordinary presets in the ordinary format — same loader, same
list, same export path — that happen to be read-only. The old Starters buttons are gone: they
were a stopgap for not having a preset layer, and having a second way to load a look, with its
own storage and its own UI and no export path, was the actual problem.

Both regimes are represented, because they need opposite settings:

- **Fractal** — IFS contraction around 1.9, camera outside, the stack shrinks space.
- **Mirror** — contraction 1.0 so space is not shrunk at all, camera INSIDE the shell spacing,
  primitive translated off the fold axis so the reflections have something to catch. A mirror
  preset with the camera outside shows a dead box.

**User presets** save, rename, overwrite and delete, persisted to `localStorage` under
`catoptron3dPresets`, every access wrapped. Slots written under the old `catoptron3d.presets` key
are migrated on first read, without deleting the original.

**Import and export** work at two levels. A single preset is one object; a library is
`{ v, presets: [...] }`, so a reader can tell them apart without guessing. Library import MERGES
rather than replaces and asks before overwriting a name. It also accepts a bare array or a single
preset, because those are things people will have.

**Keep current camera** loads a preset's geometry without moving you. The camera is the part you
are most likely to have set by hand, and reloading presets to compare two fold stacks is useless
if it teleports you each time.

### Format

    { v, name, s: { non-default numbers }, f: { flame } | null, k: [ { t, n, p, o, r } ] }

`s` holds only values that differ from the defaults, and `apply` resets to defaults first, so a
preset is deterministic rather than dependent on what was on screen. Operators are stored by NAME
as the authority with the index as a fast path, so a preset survives the operator list being
reordered. The flame records each xform's imported affine PLUS the editor's offsets, so it stays
re-editable rather than collapsing to a flattened matrix.

Discrete parameters are compile-time literals baked into the shader and part of the program cache
key, so restoring one forces a genuine recompile — asserted in the tests by checking the signature
actually changes.

A loaded image is not part of a preset: a photo cannot go in a URL, and silently baking one into
a file would make presets unpredictably large.

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
