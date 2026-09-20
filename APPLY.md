# Fieldcraft export hook for Catoptron 3D

Three changes against build 0.57.3. The patched `main.js` and `index.html` in
this folder are the whole files with the change already in, so they can be
dropped straight over the originals; `APPLY.md` records what changed in case
you would rather do it by hand.

## 1. New file

`engine/fieldcraft-export.js` — the drop-in hook, unchanged from Fieldcraft's
`host/` copy. No imports, no knowledge of blocks.

## 2. index.html

One button, next to `export PNG` in the Image & export group:

```html
<button id="fieldBtn" title="Write a Fieldcraft field bundle: the current distance estimator plus its uniforms">export field</button>
```

## 3. main.js

An import beside the BUILD import:

```js
import { bundleFromProgram, downloadFieldBundle } from './engine/fieldcraft-export.js';
```

`FIELD_MATERIAL` and `exportField()` added just above `function section(title)`,
and one line of wiring beside the PNG button:

```js
$('fieldBtn').onclick = exportField;
```

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
  export, with a message saying why, since in that mode the field *is* the
  texture and there is no GLSL to hand over.

## Export volume

The crop box when crop is on, since that is your own statement of what the
object is. Otherwise ±2 on every axis. Change the `bounds` block in
`exportField()` if a different default suits you better.
