/* Voxel path for flame IFS.
   ────────────────────────
   The estimator has to GUESS which map's image a point came from, and once the image boxes
   overlap that guess is arbitrary — every flame artifact traces back to it. The chaos game does
   not guess: it IS the attractor's definition. So build the attractor directly, turn it into a
   signed distance field, and let map() sample that.

   The point of doing it as an SDF rather than as occupancy is that nothing else has to change.
   The existing marcher, normals, ambient occlusion, reflections and the headless gates all take
   map() at face value, and a sampled field is a genuine distance function, so the Lipschitz gate
   passes for free instead of being argued about.

   The trade is resolution: exact to the grid, blobby below it, against an estimator that is
   approximate but zooms forever. */

// Chaos game into an occupancy grid. Deterministic seed so a given flame always builds the same
// field — otherwise the image would shimmer between rebuilds.
export function chaosOccupancy(maps, G, samples, lo, hi){
  const occ = new Uint8Array(G * G * G);
  const n = maps.length;
  if(!n) return occ;
  const M = maps.map(m => m.M), T = maps.map(m => m.T);
  const sx = G / (hi[0] - lo[0]), sy = G / (hi[1] - lo[1]), sz = G / (hi[2] - lo[2]);

  let seed = 0x9e3779b9;
  const rnd = () => {                       // xorshift: same field every time, no Math.random
    seed ^= seed << 13; seed |= 0;
    seed ^= seed >>> 17;
    seed ^= seed << 5;  seed |= 0;
    return (seed >>> 0) / 4294967296;
  };
  let x = 0, y = 0, z = 0;
  const burn = 30;
  for(let i = 0; i < samples + burn; i++){
    const k = (rnd() * n) | 0;
    const m = M[k], t = T[k];
    const nx = m[0]*x + m[1]*y + m[2]*z + t[0];
    const ny = m[3]*x + m[4]*y + m[5]*z + t[1];
    const nz = m[6]*x + m[7]*y + m[8]*z + t[2];
    x = nx; y = ny; z = nz;
    if(i < burn) continue;
    const ix = ((x - lo[0]) * sx) | 0;
    if(ix < 0 || ix >= G) continue;
    const iy = ((y - lo[1]) * sy) | 0;
    if(iy < 0 || iy >= G) continue;
    const iz = ((z - lo[2]) * sz) | 0;
    if(iz < 0 || iz >= G) continue;
    occ[(iz * G + iy) * G + ix] = 1;
  }
  return occ;
}

// Exact squared euclidean distance transform, Felzenszwalb & Huttenlocher: three separable 1D
// passes, linear in the number of voxels. A naive search would be O(n^2) and unusable at 128^3.
function edt1d(f, d, v, zz, n){
  let k = 0;
  v[0] = 0; zz[0] = -Infinity; zz[1] = Infinity;
  for(let q = 1; q < n; q++){
    let s;
    while(true){
      const p = v[k];
      s = ((f[q] + q*q) - (f[p] + p*p)) / (2*q - 2*p);
      if(s <= zz[k]) k--; else break;
    }
    k++; v[k] = q; zz[k] = s; zz[k+1] = Infinity;
  }
  k = 0;
  for(let q = 0; q < n; q++){
    while(zz[k+1] < q) k++;
    const p = v[k];
    d[q] = (q - p) * (q - p) + f[p];
  }
}

export function signedDistance(occ, G, voxel){
  const N = G * G * G;
  const BIG = 1e12;
  const out = new Float32Array(N);
  const f = new Float64Array(G), d = new Float64Array(G);
  const v = new Int32Array(G), zz = new Float64Array(G + 1);

  const pass = (buf, inside) => {
    for(let i = 0; i < N; i++) buf[i] = (occ[i] ? (inside ? BIG : 0) : (inside ? 0 : BIG));
    for(let z = 0; z < G; z++) for(let y = 0; y < G; y++){
      const base = (z*G + y)*G;
      for(let x = 0; x < G; x++) f[x] = buf[base + x];
      edt1d(f, d, v, zz, G);
      for(let x = 0; x < G; x++) buf[base + x] = d[x];
    }
    for(let z = 0; z < G; z++) for(let x = 0; x < G; x++){
      for(let y = 0; y < G; y++) f[y] = buf[(z*G + y)*G + x];
      edt1d(f, d, v, zz, G);
      for(let y = 0; y < G; y++) buf[(z*G + y)*G + x] = d[y];
    }
    for(let y = 0; y < G; y++) for(let x = 0; x < G; x++){
      for(let z = 0; z < G; z++) f[z] = buf[(z*G + y)*G + x];
      edt1d(f, d, v, zz, G);
      for(let z = 0; z < G; z++) buf[(z*G + y)*G + x] = d[z];
    }
  };

  const outside = new Float64Array(N);
  pass(outside, false);                       // distance to the nearest occupied voxel
  const inside = new Float64Array(N);
  pass(inside, true);                         // distance to the nearest empty voxel
  for(let i = 0; i < N; i++){
    out[i] = (Math.sqrt(outside[i]) - Math.sqrt(inside[i])) * voxel;
  }
  return out;
}

// Bounds from the attractor itself rather than from the hull: the hull is a loose box for a
// rotated attractor, and spending grid resolution on empty space is exactly what to avoid.
export function attractorBounds(maps, samples = 60000){
  const n = maps.length;
  if(!n) return { lo: [-1,-1,-1], hi: [1,1,1] };
  let seed = 12345;
  const rnd = () => { seed ^= seed<<13; seed|=0; seed ^= seed>>>17; seed ^= seed<<5; seed|=0;
                      return (seed>>>0)/4294967296; };
  let x=0,y=0,z=0;
  const lo=[1e30,1e30,1e30], hi=[-1e30,-1e30,-1e30];
  for(let i = 0; i < samples; i++){
    const m = maps[(rnd()*n)|0];
    const nx = m.M[0]*x+m.M[1]*y+m.M[2]*z+m.T[0];
    const ny = m.M[3]*x+m.M[4]*y+m.M[5]*z+m.T[1];
    const nz = m.M[6]*x+m.M[7]*y+m.M[8]*z+m.T[2];
    x=nx; y=ny; z=nz;
    if(i < 40) continue;
    if(x<lo[0])lo[0]=x; if(x>hi[0])hi[0]=x;
    if(y<lo[1])lo[1]=y; if(y>hi[1])hi[1]=y;
    if(z<lo[2])lo[2]=z; if(z>hi[2])hi[2]=z;
  }
  for(let a = 0; a < 3; a++){
    const pad = Math.max((hi[a]-lo[a]) * 0.04, 1e-3);
    lo[a] -= pad; hi[a] += pad;
  }
  return { lo, hi };
}

// Encode to R8. Not a compromise: 8-bit linear filtering is core everywhere, whereas float and
// half-float 3D filtering are extensions, and the quantisation is FINER than the grid it encodes.
// The near field is resolved to voxel/16 and the far field saturates at 8 voxels, which is still
// a large step for the marcher to take.
export const SDF_RANGE_VOXELS = 8;

export function encodeR8(sdf, voxel){
  const r = SDF_RANGE_VOXELS * voxel;
  const out = new Uint8Array(sdf.length);
  for(let i = 0; i < sdf.length; i++){
    const v = Math.max(-1, Math.min(1, sdf[i] / r));
    out[i] = Math.round((v * 0.5 + 0.5) * 255);
  }
  return out;
}

export function buildField(maps, G, samples){
  const b = attractorBounds(maps);
  const voxel = Math.max(b.hi[0]-b.lo[0], b.hi[1]-b.lo[1], b.hi[2]-b.lo[2]) / G;
  const occ = chaosOccupancy(maps, G, samples, b.lo, b.hi);
  let filled = 0;
  for(let i = 0; i < occ.length; i++) if(occ[i]) filled++;
  const sdf = signedDistance(occ, G, voxel);
  return { sdf, bytes: encodeR8(sdf, voxel), range: SDF_RANGE_VOXELS * voxel,
           G, lo: b.lo, hi: b.hi, voxel, filled, total: occ.length };
}
