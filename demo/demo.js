// Demo: a synthetic order-book history in a DomHeatmap, then "live" columns streaming in at 4 per second, with sliders for
// every setting (each change recolours the whole history in parallel workers).

import { DomHeatmap, DEFAULTS } from '../src/index.js';
import { synthHistory } from './synth.js';

const HIST = 6000, LIVE = 2400, COL_MS = 250, BUCKET = 5;
const stats = document.getElementById('stats');
const cfg = { ...DEFAULTS };
let data, shown = 0, seed = 7, backfillMs = 0;

const chart = new DomHeatmap(document.getElementById('heat'), { bucket: BUCKET, colMs: COL_MS, colW: 0.5, ppp: 0.25, settings: cfg });

// ---------- settings panel ----------
const SLIDERS = [
  ['lowCut', 'Lower cut-off (%)', 0, 90, 1], ['highCut', 'Upper cut-off (%)', 80, 100, 0.1], ['local', 'Local vs. wide', 0, 1, 0.05],
  ['smooth', 'Time smoothing (s)', 0, 5, 0.25], ['hold', 'Persistence (s)', 0, 10, 0.5], ['base', 'Base tone', 0, 0.25, 0.01],
  ['contrast', 'Contrast (gamma)', 0.3, 3, 0.05], ['edge', 'Far blend: range', 0.05, 1, 0.05], ['edgeStr', 'Far blend: strength', 0, 1, 0.05],
];
const box = document.getElementById('controls');
let pend = 0;
/** Recolours after a setting changed (debounced while a slider moves). */
const recolour = () => { clearTimeout(pend); pend = setTimeout(async () => { const t = performance.now(); await chart.setSettings(cfg); backfillMs = performance.now() - t; }, 120); };
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

// ---------- data ----------
async function start() {
  data = synthHistory({ n: HIST + LIVE, seed, bucket: BUCKET, rows: 1200 });   // full bucket resolution over ±6000 $
  shown = HIST;
  const t = performance.now(); await chart.setHistory(data.cols.slice(0, HIST)); backfillMs = performance.now() - t;
}
// live: one new column every 250 ms
setInterval(() => { if (data && shown < data.cols.length) chart.push(data.cols[shown++]); }, COL_MS);
setInterval(() => {
  stats.textContent = `history: ${HIST} columns + ${Math.max(0, shown - HIST)} live\nbackfill: ${backfillMs.toFixed(0)} ms (parallel workers)\n` +
    `zoom: ${chart.ppp.toFixed(3)} px/$, ${chart.colW.toFixed(2)} px/column\n${chart.follow ? 'following live' : 'paused — double-click to follow'}`;
}, 500);
start();
