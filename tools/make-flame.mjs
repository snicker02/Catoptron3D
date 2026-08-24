// Writes a .flame from a list of axis-aligned affine maps.
//
// Composition order is ZX -> XY -> YZ (see engine/flame.js), and for a per-axis scale (sx,sy,sz)
// with translation (tx,ty,tz) the blocks work out as:
//   zxCoefs  scales z by 1 and x by sx
//   coefs    scales x by 1 and y by sy, and carries the x,y translation
//   yzCoefs  scales y by 1 and z by sz, and carries the z translation
// so the net map is p -> (sx*x + tx, sy*y + ty, sz*z + tz). Verified by re-parsing the output.
import { writeFileSync } from 'node:fs';
const f = v => Number(v.toFixed(9));
export function writeFlame(path, name, maps, opts = {}){
  const n = maps.length;
  const rows = maps.map(m => {
    const [sx, sy, sz] = m.s.length ? m.s : [m.s, m.s, m.s];
    const [tx, ty, tz] = m.t;
    const chaos = m.chaos || Array.from({ length: n }, () => 1);
    return '  <xform weight="' + (m.w === undefined ? 0.5 : m.w) + '" color="' +
      (m.c === undefined ? 0 : m.c) + '" linear3D="1.0"' +
      ' coefs="1.0 0.0 0.0 ' + f(sy) + ' ' + f(tx) + ' ' + f(ty) + '"' +
      ' zxCoefs="1.0 0.0 0.0 ' + f(sx) + ' 0.0 0.0"' +
      ' yzCoefs="1.0 0.0 0.0 ' + f(sz) + ' 0.0 ' + f(tz) + '"' +
      ' chaos="' + chaos.join(' ') + '"/>';
  });
  writeFileSync(path,
    '<flame name="' + name + '" version="Catoptron 3D" size="800 800"' +
    (opts.preserveZ === false ? '' : ' preserve_z="1"') + '>\n' +
    rows.join('\n') + '\n</flame>\n');
}
