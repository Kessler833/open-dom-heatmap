// Records the live Binance order book for a while and renders it to a PNG (node demo/live-snapshot.mjs [seconds] [out.png]).
// Needs Node 22+ (global WebSocket). Same procedure as demo/live.js: diff stream + REST snapshot, resync on gaps.
import { writeFileSync } from 'node:fs';
import { Columnizer, processSequential, HeatRenderer } from '../src/index.js';
import { png } from './snapshot.mjs';

const SECS = +(process.argv[2] || 150), OUT = process.argv[3] || 'docs/live-btc.png', SYM = 'BTCUSDT', BUCKET = 5, ROWS = 220;
const bids = new Map(), asks = new Map(); let last = 0, synced = false; const buf = [];
const apply = (e) => {
  if (e.u <= last) return;
  if (e.U > last + 1) { synced = false; buf.length = 0; buf.push(e); snapshot(); return; }   // gap → resync
  for (const [p, q] of e.b) { if (+q > 0) bids.set(+p, +q); else bids.delete(+p); }
  for (const [p, q] of e.a) { if (+q > 0) asks.set(+p, +q); else asks.delete(+p); }
  last = e.u;
};
async function snapshot() {
  const d = await (await fetch(`https://api.binance.com/api/v3/depth?symbol=${SYM}&limit=5000`)).json();
  bids.clear(); asks.clear(); for (const [p, q] of d.bids) bids.set(+p, +q); for (const [p, q] of d.asks) asks.set(+p, +q);
  last = d.lastUpdateId; synced = true; for (const e of buf.splice(0)) apply(e);
}
const ws = new WebSocket(`wss://stream.binance.com:9443/ws/${SYM.toLowerCase()}@depth@100ms`);
ws.onmessage = (m) => { const e = JSON.parse(m.data); if (synced) apply(e); else buf.push(e); };
ws.onopen = () => snapshot();
const cols = [];
const cz = new Columnizer(() => (synced ? { bids, asks } : null), { bucket: BUCKET, rows: ROWS, colMs: 250 }, (c) => cols.push(c)).start();
setTimeout(() => {
  cz.stop(); ws.close();
  const res = processSequential({}, { bucket: BUCKET, colMs: 250 }, cols), N = cols.length, W = 1200, H = 600;
  const mids = cols.filter((c) => c.mid > 0).map((c) => c.mid), mid = (Math.min(...mids) + Math.max(...mids)) / 2, ppp = H / (BUCKET * ROWS * 1.6);
  const px = new Uint32Array(W * H);
  new HeatRenderer().render(px, { width: W, height: H, cols, res, endIndex: N - 1, xEnd: W, colW: W / N, priceTop: mid + H / 2 / ppp, priceBottom: mid - H / 2 / ppp, bucket: BUCKET });
  // mid price line (white, 2 px), drawn into the pixels
  for (let i = 0; i < N; i++) { const m = cols[i].mid; if (!(m > 0)) continue; const y = Math.round(H / 2 - (m - mid) * ppp), x0 = Math.floor(i * W / N), x1 = Math.floor((i + 1) * W / N); for (const yy of [y, y + 1]) if (yy >= 0 && yy < H) for (let x = x0; x < x1; x++) px[yy * W + x] = 0xffffffff; }   // 2 px
  writeFileSync(OUT, png(px, W, H));
  console.log(`${N} columns, ${OUT}`);
}, SECS * 1000);
