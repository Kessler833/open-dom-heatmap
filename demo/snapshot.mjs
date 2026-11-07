// Renders a synthetic history to a PNG without a browser (node demo/snapshot.mjs [out.png]) — used for the README image.
// Tiny PNG writer: RGBA, no filter, zlib from Node.
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { processSequential, HeatRenderer } from '../src/index.js';
import { synthHistory } from './synth.js';

/** CRC-32 as used by PNG chunks. */
const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc = (buf) => { let c = -1; for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]), c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
}
/** PNG bytes from a Uint32Array of 0xAABBGGRR pixels. */
function png(px, w, h) {
  const raw = Buffer.alloc((w * 4 + 1) * h), b = Buffer.from(px.buffer, px.byteOffset, px.byteLength);
  for (let y = 0; y < h; y++) b.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);   // filter byte 0 + RGBA row
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// README images (node demo/snapshot.mjs [outDir]):
//   hero.png       — the stable colours, full bucket resolution
//   compare.png    — left: naive colouring (size ÷ largest size of the column), right: open-dom-heatmap, same data
//   zoomed-out.png — price zoomed out ~8×: many buckets per pixel, walls stay visible (volume dominance)
const dir = process.argv[2] || 'docs', N = 3600;
const { cols, bucket } = synthHistory({ n: N, seed: 21 });
const res = processSequential({}, { bucket, colMs: 250 }, cols), last = cols[N - 1];
const mid = (last.kb + (last.v.length >> 1)) * bucket, r = new HeatRenderer();
/** Renders `results` at w × h with ppp pixels per price unit, the newest column at the right edge, `span` columns wide. */
function shot(results, w, h, ppp, span) {
  const buf = new Uint32Array(w * h);
  r.render(buf, { width: w, height: h, cols, res: results, endIndex: N - 1, xEnd: w, colW: w / span, priceTop: mid + h / 2 / ppp, priceBottom: mid - h / 2 / ppp, bucket });
  return buf;
}
/** Two images side by side with a 6 px black gap. */
function sideBySide(a, b, w, h) {
  const W2 = w * 2 + 6, out = new Uint32Array(W2 * h).fill(0xff000000);
  for (let y = 0; y < h; y++) { out.set(a.subarray(y * w, (y + 1) * w), y * W2); out.set(b.subarray(y * w, (y + 1) * w), y * W2 + w + 6); }
  return { out, W2 };
}
// naive colouring: every bucket = size / largest size of its column (what most simple heatmaps do)
const naive = cols.map((c) => { if (!c.v || !c.v.length) return { kb: 0, h: new Uint8Array(0), far: null }; let mx = 0; for (const x of c.v) if (x > mx) mx = x; return { kb: c.kb, h: Uint8Array.from(c.v, (x) => Math.round(255 * x / (mx || 1))), far: null }; });

writeFileSync(`${dir}/hero.png`, png(shot(res, 1600, 720, 0.12, 3400), 1600, 720));
{ const w = 640, h = 560, a = shot(naive, w, h, 0.12, 1500), b = shot(res, w, h, 0.12, 1500), { out, W2 } = sideBySide(a, b, w, h); writeFileSync(`${dir}/compare.png`, png(out, W2, h)); }
writeFileSync(`${dir}/zoomed-out.png`, png(shot(res, 1200, 560, 0.04, 3400), 1200, 560));
console.log('written to', dir);
