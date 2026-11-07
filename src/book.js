// From an order book to heatmap columns.
//
// bookToColumn() sums the resting size of a book (bids and asks) per price bucket over a bucket range — the input format of
// StableProcessor. Bids round DOWN onto their bucket and asks round UP, so the best bid and best ask never share a bucket
// (the spread stays visible). Accepts the common book shapes: a Map price → size, an array of [price, size] pairs (numbers
// or strings, as most exchange APIs send them) or an object { price: size }.
//
// Columnizer turns a live, continuously changing book into evenly spaced columns: call sample() every colMs (or let it run
// its own timer with start()); each column is centred on the current mid price (±rows buckets) and gets an increasing seq.
// Optional spike filter: a level must have been there at the previous sample too (min of both samples), so sub-interval
// flash quotes do not paint the heatmap.

/** Iterates [price, size] pairs of a Map, an array of pairs or a plain object. */
function* pairs(side) {
  if (!side) return;
  if (side instanceof Map) { for (const [p, q] of side) yield [+p, +q]; return; }
  if (Array.isArray(side)) { for (const e of side) yield [+e[0], +e[1]]; return; }
  for (const p in side) yield [+p, +side[p]];
}

/** Best (highest) bid and best (lowest) ask of a book; NaN when a side is empty. */
export function bestPrices(bids, asks) {
  let bb = -Infinity, ba = Infinity;
  for (const [p, q] of pairs(bids)) if (q > 0 && p > bb) bb = p;
  for (const [p, q] of pairs(asks)) if (q > 0 && p < ba) ba = p;
  return { bid: bb > -Infinity ? bb : NaN, ask: ba < Infinity ? ba : NaN };
}

/**
 * Resting size per bucket kLo … kHi (bucket k = prices [k × bucket, (k + 1) × bucket)).
 * @param {Map|Array|Object} bids price → size
 * @param {Map|Array|Object} asks price → size
 * @param {{bucket:number, kLo:number, kHi:number}} o
 * @returns {{kb:number, v:Float32Array}} kb = kLo, v[i] = size at bucket kLo + i
 */
export function bookToBuckets(bids, asks, { bucket, kLo, kHi }) {
  const n = Math.max(0, kHi - kLo + 1), v = new Float32Array(n), eps = 1e-9;
  for (const [p, q] of pairs(bids)) { if (!(q > 0)) continue; const i = Math.floor(p / bucket + eps) - kLo; if (i >= 0 && i < n) v[i] += q; }
  for (const [p, q] of pairs(asks)) { if (!(q > 0)) continue; const i = Math.ceil(p / bucket - eps) - kLo; if (i >= 0 && i < n) v[i] += q; }   // asks round up
  return { kb: kLo, v };
}

/**
 * One heatmap column from a book: ±rows buckets around the mid price (or an explicit kLo / kHi).
 * @param {Map|Array|Object} bids
 * @param {Map|Array|Object} asks
 * @param {{seq:number, bucket:number, rows?:number, kLo?:number, kHi?:number, far?:{g:number, lo:number, hi:number}}} o
 *   far = also build a coarse far-depth array on grid g between prices lo and hi (whole book beyond the detailed window)
 * @returns {{seq:number, kb:number, v:Float32Array, mid:number, far?:{g:number, base:number, v:Float32Array}}}
 */
export function bookToColumn(bids, asks, o) {
  const { bid, ask } = bestPrices(bids, asks), mid = (bid + ask) / 2, b = o.bucket;
  if (!(mid > 0)) return { seq: o.seq, kb: 0, v: null, mid: NaN };   // empty / one-sided book → a gap column
  const rows = o.rows ?? 200, kMid = Math.floor(mid / b);
  const kLo = o.kLo ?? kMid - rows, kHi = o.kHi ?? kMid + rows;
  const col = { seq: o.seq, mid, ...bookToBuckets(bids, asks, { bucket: b, kLo, kHi }) };
  if (o.far) {
    const g = o.far.g, base = Math.floor(o.far.lo / g), m = Math.max(0, Math.floor(o.far.hi / g) - base + 1);
    col.far = { g, base, v: bookToBuckets(bids, asks, { bucket: g, kLo: base, kHi: base + m - 1 }).v };
  }
  return col;
}

/**
 * Samples a live book into evenly spaced columns.
 * Usage: const cz = new Columnizer(() => ({ bids, asks }), { bucket: 5, rows: 200, colMs: 250 }, (col) => chart.push(col));
 *        cz.start();   // or call cz.sample() yourself every colMs
 */
export class Columnizer {
  /**
   * @param {() => {bids:any, asks:any}} getBook returns the current book (any shape bookToBuckets accepts)
   * @param {{bucket:number, rows?:number, colMs?:number, spikeFilter?:boolean, far?:{g:number, lo:number, hi:number}}} o
   * @param {(col:object) => void} onColumn receives each new column
   */
  constructor(getBook, o, onColumn) {
    this.getBook = getBook; this.o = { rows: 200, colMs: 250, spikeFilter: true, ...o }; this.onColumn = onColumn;
    this.seq = 0; this.prev = null; this.timer = null; this.t0 = 0;
  }
  /** Takes one sample now and emits a column. A missed interval (tab in background, …) shows up as a gap in seq. */
  sample(now = Date.now()) {
    const o = this.o;
    const seq = this.t0 ? Math.max(this.seq + 1, Math.round((now - this.t0) / o.colMs) + 1) : (this.t0 = now, 1);   // column number by wall time
    this.seq = seq;
    const { bids, asks } = this.getBook() || {};
    const col = bookToColumn(bids, asks, { seq, bucket: o.bucket, rows: o.rows, far: o.far });
    // spike filter: per bucket the smaller of this and the previous sample (a level must stand one full interval)
    const p = this.prev;
    if (o.spikeFilter && col.v && p?.v) {
      const raw = col.v.slice();
      for (let i = 0; i < col.v.length; i++) { const j = col.kb + i - p.kb; const q = j >= 0 && j < p.raw.length ? p.raw[j] : 0; if (q < col.v[i]) col.v[i] = q; }
      this.prev = { kb: col.kb, v: col.v, raw };
    } else this.prev = col.v ? { kb: col.kb, v: col.v, raw: col.v.slice() } : null;
    this.onColumn(col);
    return col;
  }
  /** Samples every colMs on its own timer. */
  start() { if (!this.timer) this.timer = setInterval(() => this.sample(), this.o.colMs); return this; }
  /** Stops the timer. */
  stop() { clearInterval(this.timer); this.timer = null; }
}
