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

  // Crystallographic utilities.
  sgUtil: { deps: [], src: `
// Mirrored unit lattice — a triangle wave IS the reflection sequence of a mirror pair, so this
// is continuous and 1-Lipschitz. Every reflection-generated space group is built from it.
vec3 tri3(vec3 p){ return abs(mod(p, 2.0) - 1.0); }

// Sort components descending with explicit temps (never swizzle-write from a swizzle read).
// Three diagonal mirror planes; together with tri3 this is the m-3m point group.
vec3 sortDesc3(vec3 q){
  if(q.x < q.y){ float t = q.x; q.x = q.y; q.y = t; }
  if(q.x < q.z){ float t = q.x; q.x = q.z; q.z = t; }
  if(q.y < q.z){ float t = q.y; q.y = q.z; q.z = t; }
  return q;
}

// Distance from p to the perpendicular bisector of two lattice centres — the wall of the
// Voronoi cell. This is the seam for any centred (I, F) lattice fold.
float bisectDist(vec3 p, vec3 c1, vec3 c2){
  vec3 d = c2 - c1;
  float L = length(d);
  if(L < 1e-6) return 1e9;
  return abs(dot(p - 0.5 * (c1 + c2), d / L));
}` },

  // ── crystal ──
  sdShard: { deps: [], src: `
// One crystal shard: a regular n-gonal prism with a pyramidal termination, growing along +z.
//
// Built as an intersection of half-spaces, which for a convex solid is both simple and SAFE:
// max() of plane distances underestimates the true distance outside the body, and an
// underestimate is the harmless direction for a distance estimator.
//   side — the prism wall, exact for a regular n-gon via the apothem coordinate r*cos(a)
//   base — the z = 0 cut
//   cap  — a single tilted plane in the folded wedge, which becomes the n faces of the point
//
// The termination length is R*tan(tip), so a tip near zero is a FLAT top and values approaching
// pi/2 give a long needle. Worth knowing, because the intuition runs the other way.
float sdShard(vec3 p, float R, float H, float n, float tip){
  float seg = TAU / max(n, 3.0);
  float a = atan(p.y, p.x);
  a = abs(mod(a, seg) - seg * 0.5);
  float u = length(vec2(p.x, p.y)) * cos(a);     // distance to the prism axis, along a facet normal
  float side = u - R;
  float base = -p.z;
  float ct = cos(tip), st = sin(tip);
  float cap = u * st + (p.z - H) * ct;
  return max(max(side, base), cap);
}` },

  sdCrystal: { deps: ['hash13', 'sdShard'], src: `
// A cluster of shards radiating from the origin. The union of exact shards is exact, and each
// shard is placed by a rotation, which is an isometry — so the whole primitive is distance-safe.
//
// Directions, lengths and radii are hashed per shard, because a perfectly symmetric cluster
// reads as synthetic. For a SYMMETRIC cluster, set Spread to 0 and put a Polyhedral mirror or
// Sector fold in the stack instead — that is the idiomatic way to get order here.
float sdCrystal(vec3 p){
  float d = 1e9;
  float N = clamp(floor(uXShards + 0.5), 1.0, 14.0);
  for(int i = 0; i < 14; i++){
    if(float(i) >= N) break;
    float fi = float(i);
    float h1 = hash13(vec3(fi, uSeed * 0.017, 1.3));
    float h2 = hash13(vec3(fi, uSeed * 0.017, 7.1));
    float h3 = hash13(vec3(fi, uSeed * 0.017, 3.7));
    float h4 = hash13(vec3(fi, uSeed * 0.017, 11.9));

    // a direction on the sphere, blended from +y toward random by Spread
    float z0 = h1 * 2.0 - 1.0;
    float ph = h2 * TAU;
    float rr = sqrt(max(0.0, 1.0 - z0 * z0));
    vec3 rnd = vec3(rr * cos(ph), z0, rr * sin(ph));
    vec3 dir = normalize(mix(vec3(0.0, 1.0, 0.0), rnd, clamp(uXSpread, 0.0, 1.0)) + 1e-4);

    // orthonormal frame with dir as the growth axis
    vec3 up = abs(dir.y) > 0.95 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
    vec3 t1 = normalize(cross(up, dir));
    vec3 t2 = cross(dir, t1);
    vec3 q = vec3(dot(p, t1), dot(p, t2), dot(p, dir));

    float v = clamp(uXVary, 0.0, 1.0);
    float L = uXLen * mix(1.0, 0.25 + 1.5 * h3, v);
    float R = uXRad * mix(1.0, 0.35 + 1.3 * h4, v);
    d = min(d, sdShard(q, R, L, uXFacets, uXTip));
  }
  return d;
}` },

  // ── frames ──
  // A "frame" keeps only the edges of a solid. There is no universal formula for it — edges are
  // a feature of the specific shape — so each one is written by hand. Shell (abs(d) - t) IS
  // universal and is applied by the assembler instead, for primitives with no natural edges.

  sdBoxFrame3: { deps: [], src: `
// Edge bars of an arbitrary box: three axis-aligned bars, unioned.
float sdBoxFrame3(vec3 p, vec3 b, float e){
  vec3 q = abs(p) - b;
  vec3 w = abs(vec3(q.x + e, q.y + e, q.z + e)) - e;
  float a1 = length(max(vec3(q.x, w.y, w.z), 0.0)) + min(max(q.x, max(w.y, w.z)), 0.0);
  float a2 = length(max(vec3(w.x, q.y, w.z), 0.0)) + min(max(w.x, max(q.y, w.z)), 0.0);
  float a3 = length(max(vec3(w.x, w.y, q.z), 0.0)) + min(max(w.x, max(w.y, q.z)), 0.0);
  return min(a1, min(a2, a3));
}` },

  sdBoxFrame: { deps: ['sdBoxFrame3'], src: `
float sdBoxFrame(vec3 p){
  return sdBoxFrame3(p, vec3(uPrimSize), max(uPrimThick, 1e-4));
}` },

  sdSeg: { deps: [], src: `
float sdSeg(vec3 p, vec3 a, vec3 b){
  vec3 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-9), 0.0, 1.0);
  return length(pa - ba * h);
}` },

  sdOctaFrame: { deps: ['sdSeg'], src: `
// Octahedron edges, EXACTLY: distance to three line segments in the folded octant.
//
// A first version combined (distance to the face plane) and (distance to the nearest coordinate
// plane) as a 2D hypotenuse. That reads plausibly and is wrong — gate 3 measured it overshooting
// by 18.7%, because the two measures are not orthogonal. abs() folding is a reflection and the
// edge set is symmetric under it, so folding to the positive octant and measuring the three
// segments that bound its face gives the true distance to all twelve edges.
float sdOctaFrame(vec3 p){
  vec3 q = abs(p);
  float S = uPrimSize;
  float d = sdSeg(q, vec3(S, 0.0, 0.0), vec3(0.0, S, 0.0));
  d = min(d, sdSeg(q, vec3(0.0, S, 0.0), vec3(0.0, 0.0, S)));
  d = min(d, sdSeg(q, vec3(0.0, 0.0, S), vec3(S, 0.0, 0.0)));
  return d - max(uPrimThick, 1e-4);
}` },

  sdSphereFrame: { deps: [], src: `
// Latitude / longitude wireframe. A sphere has no edges, so its frame is a grid on the surface:
// arc distance to the nearest grid line, combined with radial distance to the shell.
float sdSphereFrame(vec3 p){
  float R = uPrimSize;
  float r = max(length(p), 1e-5);
  vec3 n = p / r;
  float lat = asin(clamp(n.y, -1.0, 1.0));
  float lon = atan(n.z, n.x);
  float N = max(floor(uPrimAux * 24.0 + 0.5), 2.0);
  float dLat = abs(fract(lat * N / PI + 0.5) - 0.5) * (PI / N) * R;
  float cl = max(cos(lat), 1e-3);
  float dLon = abs(fract(lon * N / TAU + 0.5) - 0.5) * (TAU / N) * R * cl;
  return length(vec2(min(dLat, dLon), r - R)) - max(uPrimThick, 1e-4);
}` },

  sdTorusFrame: { deps: [], src: `
// Torus wireframe: meridian circles around the tube plus rail circles along it.
//
// Each wire is a genuine circle, so its distance is computed exactly rather than as a 2D
// hypotenuse of angular and radial terms — that approximation overshot by 64% under gate 3.
// The folded angle is evaluated at BOTH neighbouring wires, since rounding to the nearest one
// can miss the truly nearest and an overestimate is the unsafe direction.
float sdTorusFrame(vec3 p){
  float R = uPrimSize, r = max(uPrimAux, 1e-4);
  float N = max(floor(uPrimRound * 60.0 + 0.5), 3.0);
  float seg = TAU / N;
  float rad = length(vec2(p.x, p.z));
  float d = 1e9;

  // meridians: circles of radius r in a plane through the y axis
  float a = atan(p.z, p.x) / seg;
  for(int i = 0; i < 2; i++){
    float ak = (floor(a) + float(i)) * seg;
    vec3 u = vec3(cos(ak), 0.0, sin(ak));
    float x = dot(p, u);
    float w = p.x * -sin(ak) + p.z * cos(ak);
    d = min(d, length(vec2(length(vec2(x - R, p.y)) - r, w)));
  }
  // rails: circles concentric with the torus axis
  float b = atan(p.y, rad - R) / seg;
  for(int i = 0; i < 2; i++){
    float bk = (floor(b) + float(i)) * seg;
    float Rk = R + r * cos(bk);
    float yk = r * sin(bk);
    d = min(d, length(vec2(rad - Rk, p.y - yk)));
  }
  return d - max(uPrimThick, 1e-4);
}` },

  // City with every building rendered as a frame instead of a solid — the reference look.
  sdCityFrame: { deps: ['hash13', 'sdBox3', 'sdBoxFrame3'], src: `
float cityBlockF(vec2 id, vec3 p, float cell, float hw){
  float r1 = hash13(vec3(id, 1.7));
  float r2 = hash13(vec3(id.x + 3.7, id.y + 5.1, 2.3));
  float h  = uCityHeight * mix(1.0, r1, uCityVar) + 0.06;
  if(r2 < 0.13) return 1e9;
  vec2 c = (id + 0.5) * cell;
  vec3 lp = vec3(p.x - c.x, p.y - h * 0.5, p.z - c.y);
  return sdBoxFrame3(lp, vec3(hw, h * 0.5, hw), max(uPrimThick, 1e-3));
}
float sdCityFrame(vec3 p){
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
      d = min(d, cityBlockF(id + vec2(float(i), float(j)), p, cell, hw));
    }
  }
  return min(ground, d);
}` },

  // ── colour ──
  palette: { deps: [], src: `
vec3 palette(float t){ return uPal0 + uPal1 * cos(TAU * (uPal2 * t + uPal3)); }` }
};
