/* A minimal MP4 muxer.
   ───────────────────
   WebCodecs gives encoded H.264 samples and nothing to put them in: the browser has no MP4
   writer. Every other project reaches for mp4-muxer here, which is a dependency this one does
   not take, so the container is written by hand.

   This writes a PROGRESSIVE mp4 — ftyp, mdat, then moov with the full sample index — rather than
   a fragmented one. Fragmented is easier to write streaming, but progressive is what every player
   and every editor opens without argument, and since the whole render is finished before muxing
   there is nothing to gain from streaming.

   Layout:
     ftyp
     mdat   all sample data, back to back
     moov
       mvhd
       trak
         tkhd
         mdia
           mdhd, hdlr
           minf
             vmhd, dinf/dref
             stbl
               stsd/avc1/avcC     the decoder config from VideoEncoder
               stts               how long each sample lasts
               stss               which samples are keyframes
               stsc, stsz, stco   where each sample is
*/

const u8 = n => new Uint8Array([n & 255]);
const u16 = n => new Uint8Array([(n >> 8) & 255, n & 255]);
const u32 = n => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const str = s => new Uint8Array([...s].map(c => c.charCodeAt(0)));

function cat(parts){
  let n = 0;
  for(const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for(const p of parts){ out.set(p, o); o += p.length; }
  return out;
}

// every box is size + fourcc + payload
function box(type, ...payload){
  const body = cat(payload);
  return cat([u32(body.length + 8), str(type), body]);
}
const fullBox = (type, version, flags, ...payload) =>
  box(type, u8(version), new Uint8Array([(flags >> 16) & 255, (flags >> 8) & 255, flags & 255]),
      ...payload);

const UNITY = cat([u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0),
                   u32(0), u32(0), u32(0x40000000)]);

/* samples: [{ data: Uint8Array, duration: int (timescale units), key: bool }]
   description: the AVCDecoderConfigurationRecord from VideoEncoder's decoderConfig */
export function muxMP4({ width, height, timescale, samples, description }){
  if(!samples.length) throw new Error('no samples to mux');
  if(!description || !description.length) throw new Error('no decoder description');

  const total = samples.reduce((a, s) => a + s.duration, 0);
  const dataLen = samples.reduce((a, s) => a + s.data.length, 0);

  const ftyp = box('ftyp', str('isom'), u32(0x200), str('isom'), str('iso2'), str('avc1'), str('mp41'));

  // mdat comes before moov, so every chunk offset is known before the index is written
  const mdatHeader = cat([u32(dataLen + 8), str('mdat')]);
  const mdatOffset = ftyp.length + 8;            // first byte of sample data

  // stts: run-length encoded durations
  const runs = [];
  for(const s of samples){
    const last = runs[runs.length - 1];
    if(last && last.d === s.duration) last.n++;
    else runs.push({ n: 1, d: s.duration });
  }
  const stts = fullBox('stts', 0, 0, u32(runs.length), ...runs.map(r => cat([u32(r.n), u32(r.d)])));

  // stss: 1-based indices of the keyframes. Omitted entirely when every frame is one.
  const keys = [];
  samples.forEach((s, i) => { if(s.key) keys.push(i + 1); });
  const stss = keys.length === samples.length
    ? null
    : fullBox('stss', 0, 0, u32(keys.length), ...keys.map(u32));

  // one sample per chunk keeps stsc trivial and stco exact
  const stsc = fullBox('stsc', 0, 0, u32(1), cat([u32(1), u32(1), u32(1)]));
  const stsz = fullBox('stsz', 0, 0, u32(0), u32(samples.length),
                       ...samples.map(s => u32(s.data.length)));
  let off = mdatOffset;
  const offsets = samples.map(s => { const o = off; off += s.data.length; return u32(o); });
  const stco = fullBox('stco', 0, 0, u32(offsets.length), ...offsets);

  const avcC = box('avcC', description);
  const avc1 = box('avc1',
    new Uint8Array(6), u16(1),                    // reserved, data_reference_index
    u16(0), u16(0), u32(0), u32(0), u32(0),       // pre_defined / reserved
    u16(width), u16(height),
    u32(0x00480000), u32(0x00480000),             // 72 dpi
    u32(0), u16(1),
    new Uint8Array(32),                           // compressorname
    u16(0x0018), u16(0xFFFF),                     // depth, pre_defined = -1
    avcC);
  const stsd = fullBox('stsd', 0, 0, u32(1), avc1);

  const stbl = box('stbl', stsd, stts, ...(stss ? [stss] : []), stsc, stsz, stco);
  const dinf = box('dinf', box('dref', u32(0), u32(1), fullBox('url ', 0, 1)));
  const minf = box('minf', box('vmhd', u32(1), u32(0), u32(0)), dinf, stbl);
  const mdhd = fullBox('mdhd', 0, 0, u32(0), u32(0), u32(timescale), u32(total), u16(0x55C4), u16(0));
  const hdlr = fullBox('hdlr', 0, 0, u32(0), str('vide'), u32(0), u32(0), u32(0), str('Catoptron\0'));
  const mdia = box('mdia', mdhd, hdlr, minf);

  const tkhd = fullBox('tkhd', 0, 3, u32(0), u32(0), u32(1), u32(0), u32(total),
                       u32(0), u32(0), u16(0), u16(0), u16(0), u16(0), UNITY,
                       u32(width << 16), u32(height << 16));
  const trak = box('trak', tkhd, mdia);
  const mvhd = fullBox('mvhd', 0, 0, u32(0), u32(0), u32(timescale), u32(total),
                       u32(0x00010000), u16(0x0100), u16(0), u32(0), u32(0), UNITY,
                       u32(0), u32(0), u32(0), u32(0), u32(0), u32(0), u32(2));
  const moov = box('moov', mvhd, trak);

  return cat([ftyp, mdatHeader, ...samples.map(s => s.data), moov]);
}
