// Parallel backfill: colour a long history with several web workers at once.
//
// The processor is causal (each column depends on the state left by the ones before), so a history cannot simply be split.
// But its memory is BOUNDED (per-bucket state is forgotten after STALE columns, cut-offs settle over ~40 columns), so a chunk
// that starts WARM columns earlier and discards that warm-up reaches the same state the single sequential chain would have at
// the chunk's start. The warm-up is the price of parallelism (see WARM and bench/bench.mjs for measured numbers).
//
// processHistory() uses a pool of module workers when `Worker` exists (browsers, Electron) and otherwise runs the same chunks
// one after another in the calling thread (Node, tests) — the result is identical either way.

import { StableProcessor, STALE } from './processor.js';

/**
 * Warm-up columns per chunk: ≥ STALE + settling of the cut-offs. Measured on synthetic 7200-column histories: from 300
 * columns on the mean difference to the sequential chain is 0.000 / 255 (largest single step 1, a rounding step).
 */
export const WARM = STALE + 200;
/** Below this many columns a single sequential chain is used (the warm-up would cost more than it saves). */
export const PAR_MIN = 2500;
/** Minimum columns per chunk. */
export const CHUNK_MIN = 800;

/**
 * Colours cols[warm …] with a fresh processor that first runs over cols[0 … warm) and discards that output.
 * first = the chunk starts at the very beginning of the history (then it fades in like the single chain would).
 * @returns {Array<{kb:number, h:Uint8Array, far:Uint8Array|null}>}
 */
export function processChunk(cfg, opt, cols, warm, first) {
  const P = new StableProcessor(cfg, opt);
  if (!first) P.noFadeIn();
  const out = [];
  for (let i = 0; i < cols.length; i++) { const r = P.process(cols[i]); if (i >= warm) out.push(r); }
  return out;
}

/** Colours all columns with one sequential chain (the reference the parallel version reproduces). */
export function processSequential(cfg, opt, cols) { return processChunk(cfg, opt, cols, 0, true); }

/** Splits [0, n) into chunks: { a, b, w0 } = output range [a, b), warm-up from w0. */
export function planChunks(n, nWorkers, warm = WARM) {
  const nCh = Math.max(1, Math.min(nWorkers, Math.floor(n / CHUNK_MIN))), out = [];
  for (let c = 0; c < nCh; c++) {
    const a = Math.floor((n * c) / nCh), b = Math.floor((n * (c + 1)) / nCh);
    const w0 = a - warm < warm ? 0 : a - warm;   // close to the start: warm up from the first column (same fade-in)
    out.push({ a, b, w0 });
  }
  return out;
}

let POOL;
/** Lazily created pool of module workers (null where workers are not available). */
function pool(n) {
  if (POOL !== undefined) return POOL;
  try {
    if (typeof Worker === 'undefined') return (POOL = null);
    const ws = [], cb = new Map(); let seq = 0, rr = 0;
    for (let i = 0; i < n; i++) ws.push(new Worker(new URL('./worker.js', import.meta.url), { type: 'module' }));
    const fail = () => { POOL = null; for (const f of cb.values()) f(null); cb.clear(); };   // a failing worker: fall back
    for (const w of ws) { w.onmessage = ({ data }) => { const f = cb.get(data.id); cb.delete(data.id); f?.(data); }; w.onerror = fail; w.onmessageerror = fail; }
    POOL = { n, run: (msg) => new Promise((res) => { const id = ++seq; cb.set(id, res); ws[rr++ % ws.length].postMessage({ ...msg, id }); }) };
  } catch { POOL = null; }
  return POOL;
}

/**
 * Colours a whole history, in parallel where possible.
 * @param {Array} cols columns in time order (see processor.js for the format)
 * @param {object} cfg colour settings
 * @param {{bucket?:number, colMs?:number}} opt
 * @param {{workers?: number, warm?: number}} [par] workers = pool size (default: cores − 1, 2 … 8; 0 = no workers)
 * @returns {Promise<{results: Array<{kb:number, h:Uint8Array, far:Uint8Array|null}>, processor: StableProcessor}>}
 *   processor = a processor whose state continues after the last column, ready for live columns
 */
export async function processHistory(cols, cfg, opt = {}, par = {}) {
  const warm = par.warm ?? WARM, n = cols.length;
  const nW = par.workers ?? Math.max(2, Math.min(8, (globalThis.navigator?.hardwareConcurrency || 4) - 1));
  // the live processor: warmed up on the last `warm` columns, so it continues seamlessly after the history
  const live = new StableProcessor(cfg, opt);
  const tail = Math.max(0, n - warm); if (tail > 0) live.noFadeIn();
  for (let i = tail; i < n; i++) live.process(cols[i]);
  if (n < PAR_MIN || nW < 2) return { results: processSequential(cfg, opt, cols), processor: live };
  const P = nW > 0 ? pool(nW) : null, chunks = planChunks(n, nW, warm), results = new Array(n);
  const runs = chunks.map(async ({ a, b, w0 }) => {
    const slice = cols.slice(w0, b);
    let r = P ? await P.run({ cfg, opt, warm: a - w0, first: w0 === 0, cols: slice }) : null;
    // worker result: concatenated arrays → per-column views; no worker (or it failed): same chunk in this thread
    let list;
    if (r) {
      list = [];
      for (let i = 0, ph = 0, pf = 0; i < r.kb.length; i++) {
        const hn = r.hn[i], fn = r.fn[i], h = r.h.subarray(ph, ph + hn); ph += hn;
        let far = null; if (fn >= 0) { far = r.f.subarray(pf, pf + fn); pf += fn; }
        list.push({ kb: r.kb[i], h, far });
      }
    } else list = processChunk(cfg, opt, slice, a - w0, w0 === 0);
    for (let i = 0; i < list.length; i++) results[a + i] = list[i];
  });
  await Promise.all(runs);
  return { results, processor: live };
}
