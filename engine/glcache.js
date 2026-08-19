// Assembled-program cache, keyed by config signature. Param tweaks reuse; only a new
// type/order/discrete/feature signature compiles.
//
// Two behaviours inherited deliberately:
//  - from 2D Catoptron: the FIRST program links synchronously, so startup never shows a blank
//    frame; later ones link async via KHR_parallel_shader_compile and the caller keeps drawing
//    the previous program until the new one is ready.
//  - from Hypnagogia: an LRU cap. 3D programs are large enough that an unbounded cache is a
//    real memory problem, which it never was in 2D.

import { assemble, signature, VS } from './assemble.js';

export function createProgramCache(gl, opts = {}){
  const MAX = opts.max || 24;
  const ext = gl.getExtension('KHR_parallel_shader_compile');
  const cache = new Map();          // sig -> entry (Map preserves insertion order = LRU order)
  let seeded = false;
  let vs = null;

  function vshader(){
    if(vs) return vs;
    vs = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vs, VS);
    gl.compileShader(vs);
    if(!gl.getShaderParameter(vs, gl.COMPILE_STATUS))
      throw new Error('vertex shader: ' + gl.getShaderInfoLog(vs));
    return vs;
  }

  function build(cfg, sig){
    const src = assemble(cfg);
    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fs, src);
    gl.compileShader(fs);
    const prog = gl.createProgram();
    gl.attachShader(prog, vshader());
    gl.attachShader(prog, fs);
    gl.bindAttribLocation(prog, 0, 'aPos');
    gl.linkProgram(prog);
    return { prog, fs, src, sig, ready: false, error: null, locs: null, t0: performance.now(), ms: 0 };
  }

  function linked(e){
    if(ext) return !!gl.getProgramParameter(e.prog, ext.COMPLETION_STATUS_KHR);
    return true;                    // no extension: link was synchronous
  }

  function finalize(e){
    if(e.ready) return;
    e.ms = performance.now() - e.t0;
    if(!gl.getShaderParameter(e.fs, gl.COMPILE_STATUS)){
      e.error = 'compile: ' + gl.getShaderInfoLog(e.fs);
    } else if(!gl.getProgramParameter(e.prog, gl.LINK_STATUS)){
      e.error = 'link: ' + gl.getProgramInfoLog(e.prog);
    } else {
      e.locs = {};
      const n = gl.getProgramParameter(e.prog, gl.ACTIVE_UNIFORMS);
      for(let i = 0; i < n; i++){
        const info = gl.getActiveUniform(e.prog, i);
        if(info) e.locs[info.name] = gl.getUniformLocation(e.prog, info.name);
      }
      gl.deleteShader(e.fs);
      e.fs = null;
    }
    e.ready = true;
  }

  function trim(currentSig){
    while(cache.size > MAX){
      const oldest = cache.keys().next().value;
      if(oldest === currentSig){                      // keep the live one: rotate to newest
        const v = cache.get(oldest);
        cache.delete(oldest); cache.set(oldest, v);
        continue;
      }
      const e = cache.get(oldest);
      cache.delete(oldest);
      if(e && e.prog && !e.error) gl.deleteProgram(e.prog);
    }
  }

  return {
    // -> { entry, ready, error, hit }. When not ready the caller keeps the previous program.
    request(cfg){
      const sig = signature(cfg);
      let entry = cache.get(sig), hit = true;
      if(!entry){
        hit = false;
        entry = build(cfg, sig);
        cache.set(sig, entry);
        if(!seeded){ finalize(entry); seeded = true; }    // first ever: block, never show blank
      } else {
        cache.delete(sig); cache.set(sig, entry);         // touch for LRU
      }
      if(!entry.ready && linked(entry)) finalize(entry);
      if(entry.ready) trim(sig);
      return { entry, ready: entry.ready && !entry.error, error: entry.error, hit };
    },
    has(cfg){ return cache.has(signature(cfg)); },
    prewarm(cfg){ this.request(cfg); },
    size(){ return cache.size; },
    parallel: !!ext
  };
}
