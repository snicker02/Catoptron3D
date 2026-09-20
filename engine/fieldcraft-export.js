// host/fieldcraft-export.js
// Drop this one file into a host raymarcher and wire the button. It has no
// imports, knows nothing about blocks, voxels or Minecraft, and never has to:
// it only describes the host's own distance estimator.
//
// Two ways in.
//
// 1. makeFieldBundle(spec) — hand it the pieces directly, when the host keeps
//    its field source separate from its rendering source.
//
// 2. bundleFromProgram(spec) — when the host assembles one big fragment shader
//    and the field half is simply everything above main(). The slice is a
//    string operation, and the uniform values are read back off the live GL
//    program, so the host does not have to maintain a second description of
//    its own state.
//
// See BUNDLE-FORMAT.md for the format itself.

export const FIELD_BUNDLE_FORMAT = 'fieldcraft.field-bundle';
export const FIELD_BUNDLE_VERSION = 1;

/** Types a bundle can carry. Samplers cannot cross a JSON file and are dropped. */
const TRANSPORTABLE = new Set([
  'bool', 'int', 'float',
  'vec2', 'vec3', 'vec4',
  'ivec2', 'ivec3', 'ivec4',
  'bvec2', 'bvec3', 'bvec4',
  'mat2', 'mat3', 'mat4',
]);

const ARITY = {
  bool: 1, int: 1, float: 1,
  vec2: 2, vec3: 3, vec4: 4,
  ivec2: 2, ivec3: 3, ivec4: 4,
  bvec2: 2, bvec3: 3, bvec4: 4,
  mat2: 4, mat3: 9, mat4: 16,
};

/**
 * @returns {object} a plain JSON-serialisable bundle
 */
export function makeFieldBundle(spec) {
  if (!spec || !spec.deSource) throw new Error('makeFieldBundle needs deSource');
  if (!spec.deSignature) throw new Error('makeFieldBundle needs deSignature');
  if (!spec.bounds || !spec.bounds.min || !spec.bounds.max) throw new Error('makeFieldBundle needs bounds');

  const bundle = {
    format: FIELD_BUNDLE_FORMAT,
    version: FIELD_BUNDLE_VERSION,
    name: spec.name || 'Untitled field',
    source: spec.source || undefined,
    glsl: {
      version: '300 es',
      prelude: spec.prelude || undefined,
      de: {
        name: functionNameOf(spec.deSignature),
        signature: spec.deSignature,
        source: spec.deSource,
        paramDefaults: spec.paramDefaults || undefined,
        scaleParam: spec.scaleParam || undefined,
        trapParam: spec.trapParam || undefined,
      },
      material: spec.materialSource ? {
        name: functionNameOf(spec.materialSignature || 'int material(vec3 p, vec3 n)'),
        signature: spec.materialSignature || 'int material(vec3 p, vec3 n)',
        source: spec.materialSource,
      } : undefined,
    },
    uniforms: (spec.uniforms || []).map(u => ({
      name: u.name,
      type: u.type,
      count: u.count || undefined,
      value: u.value,
      label: u.label,
      min: u.min,
      max: u.max,
      step: u.step,
    })),
    bounds: { min: [...spec.bounds.min], max: [...spec.bounds.max] },
    isoOffset: spec.isoOffset || 0,
    hints: spec.hints || undefined,
  };

  return JSON.parse(JSON.stringify(bundle));
}

function functionNameOf(signature) {
  const m = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(String(signature));
  if (!m) throw new Error(`Cannot read a function name out of "${signature}"`);
  return m[1];
}

/**
 * Split an assembled fragment shader into the half that describes the field
 * and the list of uniforms it declares.
 *
 * Everything above the cut is kept, minus the lines that belong to the
 * rendering stage — Fieldcraft emits its own version directive, precision
 * statement and stage outputs, and re-emits the uniform block from the list,
 * so leaving either in place would be a duplicate declaration.
 *
 * @param {string} source  the full fragment shader
 * @param {object} opts
 *   cutAt   marker the field half ends at (default 'void main(')
 *   values  (name, type, count) => value, or a plain object keyed by name.
 *           Anything missing comes back as zeros, which compiles but renders
 *           nothing useful, so wire harvestUniforms unless you know better.
 * @returns {{source, uniforms, droppedSamplers, cutAtIndex}}
 */
export function fieldFromShaderSource(source, opts = {}) {
  const cutAt = opts.cutAt || 'void main(';
  const cut = source.indexOf(cutAt);
  if (cut < 0) throw new Error(`Cannot find "${cutAt}" in the shader source`);
  let head = source.slice(0, cut);

  const lookup = typeof opts.values === 'function'
    ? opts.values
    : (name) => (opts.values ? opts.values[name] : undefined);

  const uniforms = [];
  const droppedSamplers = [];

  // uniform <type> <name>[count]?, <name2>...;  — the comma form is common in
  // hand-written preludes and would otherwise be silently half-read.
  head = head.replace(
    /^[ \t]*uniform\s+(?:(?:lowp|mediump|highp)\s+)?(\w+)\s+([^;]+);[ \t]*(?:\/\/[^\n]*)?$/gm,
    (line, type, namesPart) => {
      if (!TRANSPORTABLE.has(type)) {
        namesPart.split(',').forEach(n => droppedSamplers.push(`${type} ${n.trim()}`));
        return '';
      }
      for (const raw of namesPart.split(',')) {
        const m = /^\s*([A-Za-z_]\w*)\s*(?:\[\s*(\d+)\s*\])?\s*$/.exec(raw);
        if (!m) throw new Error(`Cannot parse uniform declaration "${line.trim()}"`);
        const name = m[1];
        const count = m[2] ? parseInt(m[2], 10) : undefined;
        const want = ARITY[type] * (count || 1);
        const value = normaliseValue(lookup(name, type, count), want, type);
        uniforms.push(count ? { name, type, count, value } : { name, type, value });
      }
      return '';
    });

  // Stage-level declarations Fieldcraft supplies itself.
  head = head
    .replace(/^[ \t]*#version[^\n]*$/gm, '')
    .replace(/^[ \t]*precision\s+(?:lowp|mediump|highp)\s+\w+\s*;[ \t]*$/gm, '')
    .replace(/^[ \t]*(?:out|in)\s+(?:(?:lowp|mediump|highp|flat|smooth)\s+)*\w+\s+[A-Za-z_]\w*\s*;[ \t]*$/gm, '')
    .replace(/\n{3,}/g, '\n\n');

  // A uniform declaration the parser did not recognise would stay in the
  // source, compile perfectly, and read as zero forever — the worst kind of
  // failure, because the picture is merely wrong rather than missing. Refuse
  // instead, naming the line.
  const leftover = head.match(/^[ \t]*uniform\b[^\n]*$/gm);
  if (leftover) {
    throw new Error(
      `These uniform declarations were not understood, so their values would be lost:\n  ${leftover.map(l => l.trim()).join('\n  ')}`);
  }

  return { source: head.trim(), uniforms, droppedSamplers, cutAtIndex: cut };
}

function normaliseValue(value, want, type) {
  if (value === undefined || value === null) {
    return want === 1 ? (type === 'bool' ? false : 0) : new Array(want).fill(0);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return want === 1 ? value : new Array(want).fill(Number(value));
  }
  const flat = Array.from(value, Number);
  if (flat.length === want) return want === 1 ? flat[0] : flat;
  if (flat.length > want) return flat.slice(0, want);
  return flat.concat(new Array(want - flat.length).fill(0));
}

/**
 * Read current uniform values straight off a live, linked GL program.
 *
 * This is the reason the host does not need a second description of its own
 * state: whatever it last pushed is what the bundle records, arrays included.
 * A uniform the driver optimised away has no location and is skipped, which is
 * correct — the field does not reference it.
 *
 * @param {WebGL2RenderingContext} gl
 * @param {WebGLProgram} program
 * @param {Array} declarations  the uniforms array from fieldFromShaderSource
 * @returns {object} name -> value, ready to pass back in as opts.values
 */
export function harvestUniforms(gl, program, declarations) {
  const out = {};
  for (const u of declarations) {
    if (u.count) {
      const arity = ARITY[u.type];
      const flat = [];
      for (let i = 0; i < u.count; i++) {
        const loc = gl.getUniformLocation(program, `${u.name}[${i}]`);
        const v = loc ? gl.getUniform(program, loc) : null;
        if (v === null || v === undefined) flat.push(...new Array(arity).fill(0));
        else if (typeof v === 'number' || typeof v === 'boolean') flat.push(Number(v));
        else flat.push(...Array.from(v, Number));
      }
      out[u.name] = flat;
      continue;
    }
    const loc = gl.getUniformLocation(program, u.name);
    if (!loc) continue;
    const v = gl.getUniform(program, loc);
    out[u.name] = (typeof v === 'number' || typeof v === 'boolean') ? v : Array.from(v, Number);
  }
  return out;
}

/**
 * The whole export in one call, for a host that assembles a single fragment
 * shader and has the linked program to hand.
 *
 * @param {object} spec  everything makeFieldBundle takes, plus:
 *   shaderSource   the full fragment shader
 *   gl, program    the live context and linked program to read values from
 *   cutAt          optional marker, default 'void main('
 * @returns {{bundle, droppedSamplers, uniformCount}}
 */
export function bundleFromProgram(spec) {
  const first = fieldFromShaderSource(spec.shaderSource, { cutAt: spec.cutAt });
  const values = (spec.gl && spec.program)
    ? harvestUniforms(spec.gl, spec.program, first.uniforms)
    : (spec.values || {});
  const filled = fieldFromShaderSource(spec.shaderSource, { cutAt: spec.cutAt, values });
  const bundle = makeFieldBundle({
    ...spec,
    prelude: undefined,
    deSource: filled.source,
    uniforms: filled.uniforms,
  });
  return {
    bundle,
    droppedSamplers: filled.droppedSamplers,
    uniformCount: filled.uniforms.length,
  };
}

export function downloadFieldBundle(bundle, filename) {
  const name = filename || `${String(bundle.name || 'field').toLowerCase().replace(/[^a-z0-9_-]+/g, '-')}.fieldbundle.json`;
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/**
 * Adds the small "Export field" button.
 * @param {HTMLElement} container
 * @param {function} getBundle  called on click, returns a bundle object
 */
export function addExportFieldButton(container, getBundle, label = 'Export field') {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = label;
  btn.addEventListener('click', () => {
    try {
      downloadFieldBundle(getBundle());
    } catch (e) {
      console.error('[fieldcraft] export failed', e);
      btn.textContent = 'Export failed — see console';
      setTimeout(() => { btn.textContent = label; }, 2500);
    }
  });
  container.appendChild(btn);
  return btn;
}
