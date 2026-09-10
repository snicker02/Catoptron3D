/* Factory presets — generated from the former Starters table by tools/gen-factory.mjs.
   They are ordinary presets in the ordinary format: the same loader, the same list, the same
   import/export. They differ only in being read-only.

   Two regimes are represented deliberately, because they need opposite settings and a preset
   layer that only covered one of them would be useless for the other:
     FRACTAL  — IFS contraction around 1.9, camera outside, the fold stack shrinks space.
     MIRROR   — contraction 1.0 so space is not shrunk at all, camera INSIDE the shell spacing,
                primitive translated off the fold axis so the reflections have something to
                catch. A mirror preset with the camera outside shows a dead box.
*/
export const PRESET_VERSION_FACTORY = 1;
export const FACTORY = [
 {
  "v": 1,
  "name": "Folded frames",
  "s": {
   "ao": 1
  },
  "f": null,
  "k": [
   {
    "t": 8,
    "n": "Octahedral fold",
    "p": [
     0.42
    ],
    "o": [
     0,
     0,
     0
    ],
    "r": [
     0,
     0,
     0
    ]
   },
   {
    "t": 5,
    "n": "Box fold",
    "p": [
     1
    ],
    "o": [
     0,
     0,
     0
    ],
    "r": [
     0,
     0,
     0
    ]
   }
  ]
 },
 {
  "v": 1,
  "name": "Mirror room",
  "s": {
   "camDist": 3.4,
   "fov": 1.5,
   "primSize": 0.62,
   "primRound": 0.05,
   "iters": 2,
   "ifsScale": 1,
   "steps": 192,
   "ao": 0.8,
   "fog": 0.18,
   "reflect": 0.62,
   "bounces": 2,
   "palette": 2,
   "trapScale": 0.5,
   "exposure": 1.35
  },
  "f": null,
  "k": [
   {
    "t": 13,
    "n": "Mirror room",
    "p": [
     2,
     2,
     2
    ],
    "o": [
     0,
     0,
     0
    ],
    "r": [
     0,
     0,
     0
    ]
   },
   {
    "t": 14,
    "n": "Corner mirror",
    "p": [
     0.9,
     0.9,
     0.9
    ],
    "o": [
     0,
     0,
     0
    ],
    "r": [
     0,
     0,
     0
    ]
   }
  ]
 },
 {
  "v": 1,
  "name": "Kaleidoscope tube",
  "s": {
   "camDist": 2.6,
   "camAzim": 1.5708,
   "camElev": 0.02,
   "fov": 1.7,
   "prim": 4,
   "primSize": 0.42,
   "primRound": 0.1,
   "primAux": 0.13,
   "iters": 2,
   "ifsScale": 1,
   "steps": 192,
   "ao": 0.9,
   "fog": 0.16,
   "bounces": 2,
   "palette": 1,
   "trapScale": 0.8,
   "exposure": 1.35
  },
  "f": null,
  "k": [
   {
    "t": 4,
    "n": "Sector fold",
    "p": [
     6,
     0,
     2
    ],
    "o": [
     0,
     0,
     0
    ],
    "r": [
     0,
     0,
     0
    ]
   },
   {
    "t": 12,
    "n": "Mirror corridor",
    "p": [
     2,
     1.5,
     0
    ],
    "o": [
     0,
     0,
     0
    ],
    "r": [
     0,
     0,
     0
    ]
   },
   {
    "t": 0,
    "n": "Translate",
    "p": [
     0.95,
     0,
     0
    ],
    "o": [
     0,
     0,
     0
    ],
    "r": [
     0,
     0,
     0
    ]
   }
  ]
 },
 {
  "v": 1,
  "name": "Hex mirror hall",
  "s": {
   "camDist": 2.4,
   "camElev": 0.02,
   "fov": 1.6,
   "primSize": 0.45,
   "primRound": 0.05,
   "iters": 3,
   "ifsScale": 1,
   "steps": 256,
   "ao": 0.7,
   "fog": 0.16,
   "reflect": 0.72,
   "bounces": 2,
   "exposure": 1.45
  },
  "f": null,
  "k": [
   {
    "t": 16,
    "n": "Kaleidoscope tile",
    "p": [
     0,
     1.1,
     1
    ],
    "o": [
     0,
     0,
     0
    ],
    "r": [
     0,
     0,
     0
    ]
   },
   {
    "t": 12,
    "n": "Mirror corridor",
    "p": [
     1,
     1.8,
     0
    ],
    "o": [
     0,
     0,
     0
    ],
    "r": [
     0,
     0,
     0
    ]
   }
  ]
 },
 {
  "v": 1,
  "name": "Mirror shells",
  "s": {
   "camDist": 6,
   "camElev": 0.24,
   "fov": 1.2,
   "primSize": 0.9,
   "primRound": 0.05,
   "iters": 2,
   "ifsScale": 1,
   "steps": 256,
   "ao": 0.9,
   "fog": 0.18,
   "reflect": 0.6,
   "bounces": 2,
   "palette": 3,
   "exposure": 1.35
  },
  "f": null,
  "k": [
   {
    "t": 15,
    "n": "Mirror shells",
    "p": [
     2,
     0
    ],
    "o": [
     0,
     0,
     0
    ],
    "r": [
     0,
     0,
     0
    ]
   },
   {
    "t": 13,
    "n": "Mirror room",
    "p": [
     2.6,
     2.6,
     2.6
    ],
    "o": [
     0,
     0,
     0
    ],
    "r": [
     0,
     0,
     0
    ]
   }
  ]
 },
 {
  "v": 1,
  "name": "Folded city",
  "s": {
   "camDist": 27,
   "camAzim": -1.5708,
   "camElev": 0.26,
   "fov": 1.15,
   "prim": 5,
   "primSize": 0.42,
   "primRound": 0.03,
   "iters": 1,
   "ifsScale": 1,
   "steps": 192,
   "ambient": 0.42,
   "ao": 1,
   "spec": 0.2,
   "rim": 0.3,
   "fog": 0.055,
   "reflect": 0,
   "cityStreet": 0.34,
   "cityHeight": 2.6,
   "cityVar": 0.9,
   "sun": 1,
   "haze": 0.45,
   "palette": 7,
   "trapScale": 0.4,
   "trapShift": 0.25,
   "exposure": 1.12,
   "sat": 0.8,
   "renderScale": 0.6
  },
  "f": null,
  "k": [
   {
    "t": 17,
    "n": "Hinge fold",
    "p": [
     90,
     -90,
     0
    ],
    "o": [
     0,
     0,
     0
    ],
    "r": [
     0,
     0,
     0
    ]
   }
  ]
 },
 {
  "v": 1,
  "name": "Wire city",
  "s": {
   "camDist": 24,
   "camAzim": -1.5708,
   "camElev": 0.24,
   "fov": 1.15,
   "prim": 5,
   "primStyle": 2,
   "primSize": 0.42,
   "primThick": 0.022,
   "iters": 1,
   "ifsScale": 1,
   "steps": 256,
   "ambient": 0.42,
   "ao": 1,
   "spec": 0.25,
   "rim": 0.35,
   "fog": 0.05,
   "reflect": 0,
   "cityStreet": 0.34,
   "cityHeight": 2.6,
   "cityVar": 0.9,
   "sun": 1,
   "haze": 0.35,
   "palette": 6,
   "trapScale": 0.4,
   "trapShift": 0.25,
   "exposure": 1.15,
   "sat": 0.8,
   "renderScale": 0.6
  },
  "f": null,
  "k": [
   {
    "t": 17,
    "n": "Hinge fold",
    "p": [
     90,
     -90,
     0
    ],
    "o": [
     0,
     0,
     0
    ],
    "r": [
     0,
     0,
     0
    ]
   }
  ]
 },
 {
  "v": 1,
  "name": "Clay corner",
  "s": {
   "camDist": 26,
   "camAzim": -2.356,
   "fov": 1.25,
   "prim": 5,
   "primSize": 0.42,
   "primRound": 0.03,
   "iters": 1,
   "ifsScale": 1,
   "steps": 192,
   "ambient": 0.42,
   "ao": 1,
   "spec": 0.2,
   "rim": 0.3,
   "fog": 0.055,
   "reflect": 0,
   "cityStreet": 0.34,
   "cityHeight": 2.4,
   "cityVar": 0.9,
   "sun": 1,
   "haze": 0.35,
   "palette": 6,
   "trapScale": 0.4,
   "trapShift": 0.25,
   "exposure": 1.12,
   "sat": 0.8,
   "renderScale": 0.6
  },
  "f": null,
  "k": [
   {
    "t": 17,
    "n": "Hinge fold",
    "p": [
     90,
     -90,
     0
    ],
    "o": [
     0,
     0,
     0
    ],
    "r": [
     0,
     0,
     0
    ]
   },
   {
    "t": 17,
    "n": "Hinge fold",
    "p": [
     0,
     -90,
     2
    ],
    "o": [
     0,
     0,
     0
    ],
    "r": [
     0,
     0,
     0
    ]
   }
  ]
 },
 {
  "v": 1,
  "name": "City vortex",
  "s": {
   "camDist": 20,
   "camAzim": -1.5708,
   "camElev": 0.78,
   "fov": 1.25,
   "prim": 5,
   "primSize": 0.6,
   "primRound": 0.03,
   "iters": 2,
   "ifsScale": 1,
   "steps": 192,
   "ambient": 0.42,
   "ao": 1,
   "spec": 0.2,
   "rim": 0.3,
   "fog": 0.09,
   "reflect": 0,
   "cityStreet": 0.34,
   "cityHeight": 1.4,
   "cityVar": 0.9,
   "sun": 1,
   "haze": 0.4,
   "palette": 7,
   "trapScale": 0.4,
   "trapShift": 0.25,
   "exposure": 1.12,
   "sat": 0.8,
   "renderScale": 0.6
  },
  "f": null,
  "k": [
   {
    "t": 18,
    "n": "Spiral vortex",
    "p": [
     0.55,
     1
    ],
    "o": [
     0,
     0,
     0
    ],
    "r": [
     0,
     0,
     0
    ]
   }
  ]
 },
 {
  "v": 1,
  "name": "Crystal cluster",
  "s": {
   "camDist": 2.8,
   "camElev": 0.2,
   "fov": 1.2,
   "prim": 6,
   "iters": 3,
   "ifsScale": 0.8,
   "ifsCx": 0,
   "ifsCy": 0,
   "ifsCz": 0,
   "steps": 256,
   "eps": 0.00035,
   "ambient": 0.14,
   "ao": 1.1,
   "spec": 1.3,
   "rim": 1.8,
   "fog": 0.08,
   "reflect": 0.6,
   "fresnel": 0.9,
   "bounces": 1,
   "xShards": 10,
   "xLen": 1,
   "xRad": 0.035,
   "xTip": 1.25,
   "xSpread": 0.75,
   "palette": 2,
   "trapScale": 0.9,
   "trapShift": 0.1,
   "exposure": 1.6,
   "renderScale": 0.7
  },
  "f": null,
  "k": [
   {
    "t": 8,
    "n": "Octahedral fold",
    "p": [
     0
    ],
    "o": [
     0,
     0,
     0
    ],
    "r": [
     0,
     0,
     0
    ]
   }
  ]
 },
 {
  "v": 1,
  "name": "Crystal glass",
  "s": {
   "camDist": 2.8,
   "camElev": 0.2,
   "fov": 1.2,
   "prim": 6,
   "iters": 3,
   "ifsScale": 0.8,
   "ifsCx": 0,
   "ifsCy": 0,
   "ifsCz": 0,
   "steps": 256,
   "eps": 0.00035,
   "ambient": 0.16,
   "ao": 1,
   "spec": 1.4,
   "rim": 1.6,
   "fog": 0.05,
   "fresnel": 0.9,
   "bounces": 4,
   "transp": 0.95,
   "absorb": 1.2,
   "xShards": 10,
   "xLen": 1,
   "xRad": 0.035,
   "xTip": 1.25,
   "xSpread": 0.75,
   "palette": 8,
   "trapScale": 0.9,
   "trapShift": 0.1,
   "glow": 1.4,
   "exposure": 1.6,
   "renderScale": 0.55
  },
  "f": null,
  "k": [
   {
    "t": 8,
    "n": "Octahedral fold",
    "p": [
     0
    ],
    "o": [
     0,
     0,
     0
    ],
    "r": [
     0,
     0,
     0
    ]
   }
  ]
 },
 {
  "v": 1,
  "name": "Crystal field",
  "s": {
   "camDist": 5.5,
   "camElev": 0.14,
   "fov": 1.2,
   "prim": 6,
   "iters": 1,
   "ifsScale": 1,
   "steps": 256,
   "eps": 0.00035,
   "ambient": 0.14,
   "ao": 1.1,
   "spec": 1.3,
   "rim": 1.8,
   "fog": 0.08,
   "reflect": 0.6,
   "fresnel": 0.9,
   "bounces": 1,
   "xShards": 12,
   "xLen": 1.1,
   "xRad": 0.03,
   "xTip": 1.25,
   "palette": 2,
   "trapScale": 0.9,
   "trapShift": 0.1,
   "exposure": 1.6,
   "renderScale": 0.6
  },
  "f": null,
  "k": [
   {
    "t": 11,
    "n": "Domain repeat",
    "p": [
     2.6,
     2.6,
     2.6
    ],
    "o": [
     0,
     0,
     0
    ],
    "r": [
     0,
     0,
     0
    ]
   }
  ]
 },
 {
  "v": 1,
  "name": "Crystal lattice",
  "s": {
   "camDist": 13,
   "camAzim": 0.85,
   "camElev": 0.55,
   "fov": 0.95,
   "prim": 4,
   "primSize": 0.24,
   "primRound": 0.04,
   "primAux": 0.075,
   "iters": 1,
   "ifsScale": 1,
   "steps": 256,
   "ambient": 0.32,
   "ao": 1,
   "spec": 0.5,
   "rim": 0.6,
   "fog": 0.1,
   "reflect": 0,
   "palette": 5,
   "trapScale": 0.6,
   "trapShift": 0.15,
   "exposure": 1.3,
   "renderScale": 0.7
  },
  "f": null,
  "k": [
   {
    "t": 19,
    "n": "Space group",
    "p": [
     7,
     1.2
    ],
    "o": [
     0,
     0,
     0
    ],
    "r": [
     0,
     0,
     0
    ]
   }
  ]
 },
 {
  "v": 1,
  "name": "Icosahedral",
  "s": {
   "camDist": 3.4,
   "camElev": 0.28,
   "prim": 2,
   "primSize": 0.3,
   "primRound": 0.05,
   "iters": 3,
   "ifsScale": 1,
   "steps": 256,
   "ambient": 0.32,
   "ao": 1,
   "spec": 0.5,
   "rim": 0.6,
   "fog": 0.15,
   "fresnel": 0.45,
   "bounces": 1,
   "palette": 2,
   "trapScale": 0.7,
   "trapShift": 0.15,
   "exposure": 1.3,
   "renderScale": 0.7
  },
  "f": null,
  "k": [
   {
    "t": 20,
    "n": "Polyhedral mirror",
    "p": [
     2,
     0
    ],
    "o": [
     0,
     0,
     0
    ],
    "r": [
     0,
     0,
     0
    ]
   },
   {
    "t": 0,
    "n": "Translate",
    "p": [
     0,
     0,
     -1
    ],
    "o": [
     0,
     0,
     0
    ],
    "r": [
     0,
     0,
     0
    ]
   }
  ]
 },
 {
  "v": 1,
  "name": "Hyperbolic",
  "s": {
   "camDist": 2.8,
   "camElev": 0.26,
   "prim": 2,
   "primSize": 0.22,
   "primRound": 0.05,
   "iters": 2,
   "ifsScale": 1,
   "steps": 256,
   "ambient": 0.32,
   "ao": 1,
   "spec": 0.5,
   "rim": 0.6,
   "fog": 0.15,
   "fresnel": 0.45,
   "bounces": 1,
   "palette": 2,
   "trapScale": 0.7,
   "trapShift": 0.15,
   "exposure": 1.3,
   "renderScale": 0.7
  },
  "f": null,
  "k": [
   {
    "t": 21,
    "n": "Hyperbolic mirror",
    "p": [
     2,
     1.35
    ],
    "o": [
     0,
     0,
     0
    ],
    "r": [
     0,
     0,
     0
    ]
   },
   {
    "t": 0,
    "n": "Translate",
    "p": [
     0,
     0,
     -0.8
    ],
    "o": [
     0,
     0,
     0
    ],
    "r": [
     0,
     0,
     0
    ]
   }
  ]
 },
 {
  "v": 1,
  "name": "Mandelbox",
  "s": {
   "camDist": 22,
   "camElev": 0.28,
   "fov": 1.1,
   "prim": 2,
   "primSize": 0,
   "iters": 12,
   "ifsScale": 2,
   "ifsCx": 0,
   "ifsCy": 0,
   "ifsCz": 0,
   "feedback": 1,
   "bailout": 20,
   "steps": 768,
   "maxDist": 120,
   "eps": 0.00006,
   "ao": 1,
   "spec": 0.5,
   "rim": 0.5,
   "fog": 0.02,
   "reflect": 0,
   "palette": 4,
   "trapScale": 0.1,
   "trapShift": 0.15,
   "exposure": 1.3,
   "renderScale": 0.55
  },
  "f": null,
  "k": [
   {
    "t": 5,
    "n": "Box fold",
    "p": [
     1
    ],
    "o": [
     0,
     0,
     0
    ],
    "r": [
     0,
     0,
     0
    ]
   },
   {
    "t": 6,
    "n": "Sphere fold",
    "p": [
     0.5,
     1
    ],
    "o": [
     0,
     0,
     0
    ],
    "r": [
     0,
     0,
     0
    ]
   }
  ]
 },
 {
  "v": 1,
  "name": "Mandelbulb",
  "s": {
   "camDist": 2.5,
   "camElev": 0.3,
   "fov": 1.2,
   "prim": 2,
   "primSize": 0,
   "iters": 10,
   "ifsScale": 1,
   "ifsCx": 0,
   "ifsCy": 0,
   "ifsCz": 0,
   "feedback": 1,
   "bailout": 4,
   "steps": 512,
   "eps": 0.00018,
   "ao": 1,
   "spec": 0.5,
   "rim": 0.5,
   "fog": 0.1,
   "reflect": 0,
   "palette": 5,
   "trapScale": 1.1,
   "trapShift": 0.15,
   "exposure": 1.3,
   "renderScale": 0.6
  },
  "f": null,
  "k": [
   {
    "t": 25,
    "n": "Triplex power",
    "p": [
     8
    ],
    "o": [
     0,
     0,
     0
    ],
    "r": [
     0,
     0,
     0
    ]
   }
  ]
 },
 {
  "v": 1,
  "name": "Menger sponge",
  "s": {
   "camDist": 4.2,
   "camElev": 0.3,
   "fov": 1.2,
   "prim": 1,
   "primRound": 0.02,
   "iters": 4,
   "ifsScale": 1,
   "ifsCx": 0,
   "ifsCy": 0,
   "ifsCz": 0,
   "steps": 256,
   "eps": 0.0005,
   "ao": 1,
   "spec": 0.5,
   "rim": 0.5,
   "fog": 0.1,
   "reflect": 0,
   "palette": 5,
   "trapScale": 0.4,
   "trapShift": 0.15,
   "exposure": 1.3,
   "renderScale": 0.7
  },
  "f": null,
  "k": [
   {
    "t": 24,
    "n": "Menger fold",
    "p": [
     3,
     2
    ],
    "o": [
     0,
     0,
     0
    ],
    "r": [
     0,
     0,
     0
    ]
   }
  ]
 }
];
