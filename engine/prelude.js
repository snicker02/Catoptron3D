// Shared GLSL header. Uniforms only — no logic. Every assembled program starts with this,
// so uniform names are stable across permutations and main.js can push them blind.
//
// THE DE CONTRACT (read this before adding an operator):
//   A 3D fold is a map R3 -> R3 applied INSIDE a distance estimator. The marcher trusts the
//   returned number as a guaranteed-safe step, so a fold must also report how much it locally
//   stretched space. Every op therefore carries `inout float s` and multiplies into it the
//   operator norm of its Jacobian at p. The estimator finishes with prim(p) / s.
//   Under-report s and the ray punches through surfaces. Over-report and you only lose speed.

export const BUILD = '0.40.0-normal-floors';

export const VS = `#version 300 es
in vec2 aPos;
void main(){ gl_Position = vec4(aPos, 0.0, 1.0); }`;

export const PRELUDE = `#version 300 es
precision highp float;
out vec4 fragColor;

#define PI  3.14159265359
#define TAU 6.28318530718
#define DEG 0.01745329252

uniform vec2  uRes;
uniform float uTime;

// camera
uniform vec3  uCamPos;
uniform vec3  uCamTgt;
uniform float uFov;

// march
uniform float uMinDist;
uniform float uMaxDist;
uniform float uStepScale;   // safety multiplier — lower it when a 'bound' op misbehaves
uniform float uEps;
uniform float uNormEps;
uniform float uNormMode;    // 0 = estimator gradient, 1 = screen-space derivative
                            // is no longer decidable in float32     // normal-probe offset, as a multiple of the hit epsilon

// IFS recursion (the fold stack is the map; this is the per-pass contraction)
uniform vec3  uIfsCenter;
uniform float uIfsScale;
uniform vec3  uIfsRot;      // degrees per pass
uniform vec3  uJuliaC;      // constant added per pass in Julia feedback mode
uniform float uBailout;     // escape radius; the orbit stops iterating past it

// primitive
uniform float uPrimSize;
uniform float uPrimRound;
uniform float uPrimAux;
uniform float uPrimThick;   // shell / frame bar thickness

// lighting
uniform vec3  uLightDir;
uniform float uAmbient;
uniform float uAoStr;
uniform float uAoRadius;    // AO probe reach, in world units
uniform float uSpec;
uniform float uReflect;
uniform float uFresnel;
uniform float uMetal;
uniform float uTransp;      // 0 opaque, 1 fully transmissive
uniform float uIOR;
uniform float uAbsorb;      // Beer-Lambert density inside the medium
uniform float uDisp;        // per-channel IOR spread
uniform float uRim;
uniform float uFog;

// colour
uniform vec3  uPal0, uPal1, uPal2, uPal3;   // cosine palette: a + b*cos(TAU*(c*t + d))
uniform vec3  uBgTop, uBgBot;
uniform float uSun;
uniform float uHaze;

// user image: environment map (equirectangular) and/or triplanar surface texture
uniform sampler2D uImg;
uniform float uEnvAmt;
uniform float uEnvGain;
uniform float uEnvRot;
uniform float uTexAmt;
uniform float uTexScale;

// Global seed. Currently read only by the crystal cluster; the city hash is deliberately left
// unseeded so that existing presets keep rendering the same city.
uniform float uSeed;

// Flame IFS transforms. Uniform arrays rather than baked constants, so editing a transform in
// the panel is instant instead of a recompile. Only the COUNT is compiled in.
uniform mat3  uFlameMi[24];
uniform vec3  uFlameTi[24];
uniform vec3  uFlameFp[24];
uniform float uFlameEx[24];
uniform float uFlameVAmt[24];
uniform vec4  uFlameVP[24];
uniform vec4  uFlameVQ[24];
uniform vec4  uFlameVR[24];
uniform vec3  uFlameBLo[24];   // per-map image box: the region that map is responsible for
uniform vec3  uFlameBHi[24];
uniform vec3  uHullLo;         // the attractor's own bounding box
uniform vec3  uHullHi;

// crystal cluster primitive
uniform float uXShards;
uniform float uXFacets;
uniform float uXLen;
uniform float uXRad;
uniform float uXTip;
uniform float uXSpread;
uniform float uXVary;

// city primitive
uniform float uCityStreet;
uniform float uCityHeight;
uniform float uCityVar;
uniform float uCityDetail;
uniform float uTrapScale;
uniform float uTrapChan;    // which orbit-trap component drives colour
uniform float uTrapShift;
uniform float uGlow;
uniform float uExposure;
uniform float uSat;
`;
