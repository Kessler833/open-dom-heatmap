// Demo: a synthetic order-book history coloured with open-dom-heatmap, then "live" columns streaming in at 4 per second
// (incremental scroll), with sliders for every setting (each change recolours the whole history in parallel workers).

import { processHistory, HeatRenderer, DEFAULTS } from '../src/index.js';
import { synthHistory } from './synth.js';

const HIST = 6000, LIVE = 2400, COL_MS = 250;
const canvas = document.getElementById('heat'), ctx = canvas.getContext('2d', { alpha: false });
const stats = document.getElementById('stats');
const renderer = new HeatRenderer();
const cfg = { ...DEFAULTS };
let data, shown, results, proc, img, buf, ppp = 0.25, colW = 0.5, center = NaN, seed = 7, busy = false, lastRender = 0, backfillMs = 0, shAcc = 0;

// ---------- settings panel ----------
const SLIDERS = [
  ['lowCut', 'Lower cut-off (%)', 0, 90, 1], ['highCut', 'Upper cut-off (%)', 80, 100, 0.1], ['local', 'Local vs. wide', 0, 1, 0.05],
  ['smooth', 'Time smoothing (s)', 0, 5, 0.25], ['hold', 'Persistence (s)', 0, 10, 0.5], ['base', 'Base tone', 0, 0.25, 0.01],
  ['contrast', 'Contrast (gamma)', 0.3, 3, 0.05], ['edge', 'Far blend: range', 0.05, 1, 0.05], ['edgeStr', 'Far blend: strength', 0, 1, 0.05],
];
const box = document.getElementById('controls');
for (const [k, label, min, max, step] of SLIDERS) {
  const l = document.createElement('label'); l.innerHTML = `${label} <span>${cfg[k]}</span>`;
  const r = Object.assign(document.createElement('input'), { type: 'range', min, max, step, value: cfg[k] });
  r.oninput = () => { cfg[k] = +r.value; l.querySelector('span').textContent = r.value; recolour(); };
  box.append(l, r);
}
{
  const l = document.createElement('label'); l.textContent = 'Far blend: curve';
  const s = document.createElement('select'); for (const c of ['log', 'lin', 'smooth', 'exp']) s.add(new Option(c, c));
  s.onchange = () => { cfg.edgeCurve = s.value; recolour(); };
  box.append(l, s);
}
document.getElementById('regen').onclick = () => { seed++; start(); };

// ---------- data + colouring ----------
/** Recolours everything shown so far (debounced while a slider moves). */
let pend = 0;
function recolour() { clearTimeout(pend); pend = setTimeout(async () => { await backfill(); draw(true); }, 120); }

async function backfill() {
  busy = true;
  const t0 = performance.now();
  const r = await processHistory(data.cols.slice(0, shown), cfg, { bucket: data.bucket, colMs: COL_MS });
  backfillMs = performance.now() - t0; results = r.results; proc = r.processor; busy = false;
}

async function start() {
  data = synthHistory({ n: HIST + LIVE, seed, bucket: 5, rows: 1200 });   // full bucket resolution over ±6000 $
  shown = HIST; center = NaN;
  await backfill(); draw(true);
}

// live: one new column every 250 ms, coloured by the continuing processor, drawn incrementally
setInterval(() => {
  if (!data || busy || shown >= data.cols.length) return;
  const col = data.cols[shown++]; results.push(proc.process(col));
  shAcc += colW; const s = Math.floor(shAcc); shAcc -= s;   // whole pixels to scroll; the remainder is carried
  draw(false, s);
}, COL_MS);

// ---------- drawing ----------
function draw(full, shiftCols = 0) {
  const w = canvas.clientWidth, h = canvas.clientHeight; if (!(w > 0 && h > 0) || !results) return;
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; full = true; }
  if (!img || img.width !== w || img.height !== h) { img = new ImageData(w, h); buf = new Uint32Array(img.data.buffer); full = true; }
  const last = data.cols[shown - 1], mid = (last.kb + (last.v.length >> 1) + 0.5) * data.bucket;
  if (!(center > 0)) center = mid;
  const dc = mid - center;
  if (Math.abs(dc) * ppp > h * 0.3) { center += dc - Math.sign(dc) * h * 0.3 / ppp; full = true; }   // follow price (recentre in steps)
  const view = { width: w, height: h, cols: data.cols, res: results, endIndex: shown - 1, xEnd: w - 40, colW,
    priceTop: center + h / 2 / ppp, priceBottom: center - h / 2 / ppp, bucket: data.bucket };
  const t0 = performance.now();
  if (full) shAcc = 0;
  renderer.render(buf, view, full ? {} : { shift: shiftCols });
  ctx.putImageData(img, 0, 0);
  lastRender = performance.now() - t0;
  stats.textContent = `history: ${HIST} columns + ${shown - HIST} live\nbackfill: ${backfillMs.toFixed(0)} ms (parallel workers)\n` +
    `last draw: ${lastRender.toFixed(1)} ms (${full ? 'full' : 'incremental'})\nzoom: ${ppp.toFixed(3)} px/$, ${colW.toFixed(2)} px/column`;
}

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const f = e.deltaY < 0 ? 1.15 : 1 / 1.15;
  if (e.shiftKey) colW = Math.max(0.02, Math.min(12, colW * f)); else ppp = Math.max(0.005, Math.min(20, ppp * f));
  draw(true);
}, { passive: false });
addEventListener('resize', () => draw(true));
start();
