#!/bin/sh
# Proves engine/mp4.js writes a REAL mp4, not merely a parseable one.
#
# A container with wrong offsets or sizes still parses — ffprobe will happily report the codec and
# the frame count — and then decodes to garbage. So this takes genuine H.264 out of a reference
# file, muxes it with our writer, DECODES both, and compares the frames pixel for pixel.
#
# Needs ffmpeg. Run from the repo root:  sh tools/mux-check.sh
set -e
D=$(mktemp -d)
trap 'rm -rf "$D"' EXIT
ffmpeg -hide_banner -loglevel error -f lavfi -i "testsrc2=size=320x240:rate=25:duration=2" \
       -c:v libx264 -preset ultrafast -g 25 -pix_fmt yuv420p "$D/ref.mp4"
python3 - "$D" <<'PY'
import struct, json, subprocess, sys
D=sys.argv[1]
data=open(D+'/ref.mp4','rb').read()
SKIP={'moov':0,'trak':0,'mdia':0,'minf':0,'stbl':0,'dinf':0,'stsd':8,'avc1':78}
def walk(buf,start,end):
    o=start
    while o+8<=end:
        sz=struct.unpack('>I',buf[o:o+4])[0]; typ=buf[o+4:o+8].decode('latin1','replace')
        if sz<8 or o+sz>end: break
        yield typ,o,sz
        if typ in SKIP: yield from walk(buf,o+8+SKIP[typ],o+sz)
        o+=sz
f={}
for t,o,sz in walk(data,0,len(data)): f.setdefault(t,(o,sz))
o,sz=f['avcC']; open(D+'/desc.bin','wb').write(data[o+8:o+sz])
ts=struct.unpack('>I',data[f['mdhd'][0]+8+12:f['mdhd'][0]+8+16])[0]
pk=json.loads(subprocess.run(['ffprobe','-v','error','-select_streams','v:0','-show_packets',
  '-show_entries','packet=pos,size,flags,duration','-of','json',D+'/ref.mp4'],
  capture_output=True,text=True).stdout)['packets']
json.dump({'ts':ts,'samples':[{'pos':int(p['pos']),'size':int(p['size']),
  'key':'K' in p['flags'],'dur':int(p['duration'])} for p in pk]}, open(D+'/samples.json','w'))
PY
cat > "$D/mux.mjs" <<'JS'
import { muxMP4 } from '../engine/mp4.js';
import { readFileSync, writeFileSync } from 'node:fs';
const D = process.argv[2];
const meta = JSON.parse(readFileSync(D + '/samples.json', 'utf8'));
const ref = readFileSync(D + '/ref.mp4');
const samples = meta.samples.map(s => ({
  data: new Uint8Array(ref.subarray(s.pos, s.pos + s.size)), duration: s.dur, key: s.key }));
writeFileSync(D + '/mine.mp4', Buffer.from(muxMP4({ width: 320, height: 240,
  timescale: meta.ts, samples, description: new Uint8Array(readFileSync(D + '/desc.bin')) })));
JS
cp "$D/mux.mjs" tools/.mux-tmp.mjs
node tools/.mux-tmp.mjs "$D"
rm -f tools/.mux-tmp.mjs
ffmpeg -hide_banner -loglevel error -i "$D/mine.mp4" -f image2 -vsync 0 "$D/a_%03d.png"
ffmpeg -hide_banner -loglevel error -i "$D/ref.mp4"  -f image2 -vsync 0 "$D/b_%03d.png"
python3 - "$D" <<'PY'
import glob, sys
import numpy as np
from PIL import Image
D=sys.argv[1]
a=sorted(glob.glob(D+'/a_*.png')); b=sorted(glob.glob(D+'/b_*.png'))
assert len(a)==len(b) and a, "frame count mismatch: %d vs %d" % (len(a),len(b))
worst=max(int(np.abs(np.array(Image.open(x),dtype=int)-np.array(Image.open(y),dtype=int)).max())
          for x,y in zip(a,b))
print("frames: %d   worst channel difference: %d" % (len(a), worst))
print("PASS - the muxed file decodes identically" if worst==0 else "FAIL - decoded output differs")
raise SystemExit(0 if worst==0 else 1)
PY
