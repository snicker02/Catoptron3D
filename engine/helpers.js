// GLSL helpers, emitted only when an operator or primitive depends on them.
// deps are resolved transitively by assemble.js and emitted in dependency order.
//
// HOUSE RULE, learned the hard way in 2D: never write a swizzle from a swizzle read
// (p.xy = p.yx, p.yz = M*p.yz). Some drivers silently no-op it and the parameter looks dead.
// Use explicit temps or build a fresh vec3. Everything below follows that rule.

export const HELPERS = {

  rot3: { deps: [], src: `
vec3 rotX(vec3 p, float a){ float c = cos(a), s = sin(a); return vec3(p.x, c*p.y - s*p.z, s*p.y + c*p.z); }
vec3 rotY(vec3 p, float a){ float c = cos(a), s = sin(a); return vec3(c*p.x + s*p.z, p.y, -s*p.x + c*p.z); }
vec3 rotZ(vec3 p, float a){ float c = cos(a), s = sin(a); return vec3(c*p.x - s*p.y, s*p.x + c*p.y, p.z); }
// Euler ZYX, degrees in. rotE3inv is its exact inverse (order reversed, angles negated).
vec3 rotE3(vec3 p, vec3 d){ return rotZ(rotY(rotX(p, d.x*DEG), d.y*DEG), d.z*DEG); }
vec3 rotE3inv(vec3 p, vec3 d){ return rotX(rotY(rotZ(p, -d.z*DEG), -d.y*DEG), -d.x*DEG); }` },

  hash13: { deps: [], src: `
float hash13(vec3 p){
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, vec3(p.y, p.x, p.z) + 33.33);
  return fract((p.x + p.y) * p.z);
}` },

  // ── primitives ──
  sdSphere: { deps: [], src: `
float sdSphere(vec3 p){ return length(p) - uPrimSize; }` },

  sdBox: { deps: [], src: `
float sdBox(vec3 p){
  vec3 q = abs(p) - vec3(uPrimSize - uPrimRound);
  return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0) - uPrimRound;
}` },

  sdTorus: { deps: [], src: `
float sdTorus(vec3 p){
  vec2 q = vec2(length(vec2(p.x, p.z)) - uPrimSize, p.y);
  return length(q) - max(uPrimAux, 1e-4);
}` },

  sdOcta: { deps: [], src: `
float sdOcta(vec3 p){
  vec3 q = abs(p);
  return (q.x + q.y + q.z - uPrimSize) * 0.57735027;
}` },

  // Box frame — the Dr Strange primitive. Hollow cube edges; reads as architecture under folds.
  sdFrame: { deps: [], src: `
float sdFrame(vec3 p){
  float b = uPrimSize;
  float e = max(uPrimRound, 1e-3);
  vec3 q = abs(p) - vec3(b);
  vec3 w = abs(vec3(q.x + e, q.y + e, q.z + e)) - e;
  float a1 = length(max(vec3(q.x, w.y, w.z), 0.0)) + min(max(q.x, max(w.y, w.z)), 0.0);
  float a2 = length(max(vec3(w.x, q.y, w.z), 0.0)) + min(max(w.x, max(q.y, w.z)), 0.0);
  float a3 = length(max(vec3(w.x, w.y, q.z), 0.0)) + min(max(w.x, max(w.y, q.z)), 0.0);
  return min(a1, min(a2, a3));
}` },

  sdBox3: { deps: [], src: `
float sdBox3(vec3 p, vec3 b){
  vec3 q = abs(p) - b;
  return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0);
}` },

  // City block lattice. This is what makes a fold read as ARCHITECTURE instead of as a solid:
  // the references are all window grids, ledges and setbacks, and no amount of folding turns a
  // box frame into that.
  //
  // DE NOTE: this uses domain repetition on xz, so it measures the building in YOUR cell — but
  // a building in a neighbouring cell can be closer, which makes the estimate an OVER-estimate,
  // the dangerous direction. Testing only the 4 nearest cells still left an 11.5% overshoot
  // under gate 3, so it scans the full 3x3 neighbourhood. That is the cost of a correct
  // estimator here, and it is why City is the most expensive primitive.
  sdCity: { deps: ['hash13', 'sdBox3'], src: `
float cityBlock(vec2 id, vec3 p, float cell, float hw){
  float r1 = hash13(vec3(id, 1.7));
  float r2 = hash13(vec3(id.x + 3.7, id.y + 5.1, 2.3));
  float h  = uCityHeight * mix(1.0, r1, uCityVar) + 0.06;
  if(r2 < 0.13) return 1e9;                       // empty lot
  vec2 c = (id + 0.5) * cell;
  vec3 lp = vec3(p.x - c.x, p.y - h * 0.5, p.z - c.y);
  float d = sdBox3(lp, vec3(hw, h * 0.5, hw));
  if(uCityDetail > 0.001){
    float ledge = abs(mod(p.y, 0.16 + r1 * 0.06) - 0.05) - 0.014;
    float wx = abs(mod(lp.x, 0.11) - 0.055) - 0.026;
    float wz = abs(mod(lp.z, 0.11) - 0.055) - 0.026;
    float det = max(ledge, max(wx, wz) - 0.02 * uCityDetail);
    d = mix(d, max(d, -det * 0.4), uCityDetail * 0.55);
  }
  return d;
}
float sdCity(vec3 p){
  float cell = max(uPrimSize, 0.06);
  float street = clamp(uCityStreet, 0.02, 0.92) * cell;
  float hw = (cell - street) * 0.5;
  float ground = p.y;
  if(hw < 0.008) return ground;
  vec2 g  = vec2(p.x, p.z) / cell;
  vec2 id = floor(g);
  float d = 1e9;
  for(int j = -1; j <= 1; j++){
    for(int i = -1; i <= 1; i++){
      d = min(d, cityBlock(id + vec2(float(i), float(j)), p, cell, hw));
    }
  }
  return min(ground, d);
}` },

  // ── colour ──
  palette: { deps: [], src: `
vec3 palette(float t){ return uPal0 + uPal1 * cos(TAU * (uPal2 * t + uPal3)); }` }
};
