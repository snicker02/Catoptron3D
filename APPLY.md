# Fieldcraft export hook for Catoptron 3D — v1.1.0

Complete patched files against build 0.57.3. Drop `main.js` and `index.html`
over the originals and add `engine/fieldcraft-export.js`.

## What changed since v1.0.0

v1.0.0 reported every failure through `setStat`, and the render loop overwrites
that status line within a frame or two. A tripped guard and a caught exception
both looked identical to a dead button. Now:

* every path logs to the console, prefixed `[fieldcraft]`
* failures also raise an `alert`, because a silent failure on a button that
  produces a file is worse than an intrusive one
* `window.__fieldcraftExport()` calls the handler from the console
* the guards name the specific thing that was missing rather than returning
* the bank uniforms are printed and checked: if every `uP<slot>_<bank>` reads
  zero while the stack is non-empty, it warns, because that is the failure mode
  that produces an empty volume rather than an error

## The three changes

1. **New file** `engine/fieldcraft-export.js` — the drop-in hook, no imports.
2. **index.html** — one button next to `export PNG`:
   `<button id="fieldBtn">export field</button>`
3. **main.js** — an import beside the `BUILD` import, `FIELD_MATERIAL` and
   `exportField()` above `function section(title)`, and
   `$('fieldBtn').onclick = exportField;` in `buildPanel()` beside the PNG button.

## What the hook does

`bundleFromProgram` cuts `cur.src` at `void main(` — the same cut
`tools/validate.py` already makes for the DE gate — strips the version
directive, precision statement and stage outputs, pulls every `uniform`
declaration into a list, and reads each one's current value off `cur.prog` with
`getUniform`.

Reading values off the live program rather than out of `state` is deliberate:
the fold parameters live in the per-slot bank uniforms `uP0_0`, `uO0`, `uR0`
rather than in the baked source, so rebuilding that mapping here would be a
second description of the same thing, and would go stale the first time an op
gained a bank.

## Facts it depends on

* `float mapT(vec3 p, out vec4 trap, out float safe)` is the estimator.
* The division by the accumulated scale happens inside `mapTinner`, where `s`
  is a local, so no `scaleParam` is declared.
* `trap` carries the orbit trap, which drives material ids the same way it
  drives the palette on screen.
* `sampler2D uImg` and `sampler3D uSdf` cannot travel in a JSON bundle. The
  first is render-side only. The second means flame voxel mode refuses to
  export, with a message saying why.

## Export volume

The crop box when crop is on, otherwise ±2 on every axis. Change the `bounds`
block in `exportField()` if a different default suits you better.
