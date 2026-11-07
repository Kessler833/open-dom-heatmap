// Benchmark (node bench/bench.mjs [columns]): processing cost per column, sequential vs. parallel backfill (worker_threads,
// same chunk plan as processHistory), difference between them, and renderer frame times.
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import os from 'node:os';
import { processSequential, processChunk, planChunks, HeatRenderer } from '../src/index.js';
import { synthHistory } from '../demo/synth.js';

const OPT = { bucket: 5, colMs: 250 };

if (!isMainThread) {   // worker: colour one chunk
  const { cols, warm, first } = workerData;
  parentPort.postMessage(processChunk({}, OPT, cols, warm, first));
} else {
  const N = +(process.argv[2] || 7200), nW = Math.max(2, Math.min(8, os.cpus().length - 1));
  const { cols } = synthHistory({ n: N, seed: 11 });
  const rows = cols[0].v.length, far = cols[0].far?.v.length || 0;
  console.log(`${N} columns, ${rows} buckets + ${far} far buckets per column, ${os.cpus().length} cores`);

  let t = performance.now();
  const seq = processSequential({}, OPT, cols);
  const seqMs = performance.now() - t;
  console.log(`sequential:  ${seqMs.toFixed(0)} ms  (${(seqMs / N).toFixed(3)} ms per column)`);

  t = performance.now();
  const par = new Array(N);
  await Promise.all(planChunks(N, nW).map(({ a, b, w0 }) => new Promise((res, rej) => {
    const w = new Worker(new URL(import.meta.url), { workerData: { cols: cols.slice(w0, b), warm: a - w0, first: w0 === 0 } });
    w.on('message', (list) => { for (let i = 0; i < list.length; i++) par[a + i] = list[i]; res(); w.terminate(); });
    w.on('error', rej);
  })));
  const parMs = performance.now() - t;
  let d = 0, n = 0; for (let i = 0; i < N; i++) for (let k = 0; k < seq[i].h.length; k++) { d += Math.abs(seq[i].h[k] - par[i].h[k]); n++; }
  console.log(`parallel:    ${parMs.toFixed(0)} ms  (${nW} workers, incl. start-up and copying)  → ${(seqMs / parMs).toFixed(1)}× faster`);
  console.log(`difference:  ${(d / n).toFixed(3)} / 255 mean against the sequential chain`);

  const r = new HeatRenderer(), w = 1440, h = 800, buf = new Uint32Array(w * h), mid = (cols[N - 1].kb + rows / 2) * 5;
  const frame = (colW, ppp, inc) => {
    const view = { width: w, height: h, cols, res: seq, endIndex: N - 1, xEnd: w - 40, colW, priceTop: mid + h / 2 / ppp, priceBottom: mid - h / 2 / ppp, bucket: 5 };
    const ts = []; for (let i = 0; i < 7; i++) { const a = performance.now(); r.render(buf, view, inc ? { shift: 1 } : {}); ts.push(performance.now() - a); }
    return ts.sort((x, y) => x - y)[3].toFixed(1);
  };
  console.log(`render 1440×800 full:  ${frame(1, 0.2)} ms (1 column/px), ${frame(0.5, 0.2)} ms (2 columns/px), ${frame(0.5, 0.03)} ms (price zoomed out 7×)`);
  console.log(`render incremental (new column): ${frame(0.5, 0.2, true)} ms`);
}
