// Tests (node --test test/): determinism, parallel chunks = sequential chain, bounded memory, renderer behaviour.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StableProcessor, STALE, processSequential, processChunk, planChunks, WARM, HeatRenderer } from '../src/index.js';
import { synthHistory } from '../demo/synth.js';

const OPT = { bucket: 5, colMs: 250 };

/** Mean absolute difference and share of steps differing by more than 8 between two result lists (fine grid). */
function diff(a, b) {
  let d = 0, n = 0, big = 0;
  for (let i = 0; i < a.length; i++) for (let k = 0; k < a[i].h.length; k++) { const e = Math.abs(a[i].h[k] - b[i].h[k]); d += e; n++; if (e > 8) big++; }
  return { mean: d / n, big: big / n };
}

test('same input gives the same output', () => {
  const { cols } = synthHistory({ n: 800, seed: 3 });
  const a = processSequential({}, OPT, cols), b = processSequential({}, OPT, cols);
  assert.equal(diff(a, b).mean, 0);
});

test('outputs are 0…255 per bucket and gap columns are empty', () => {
  const { cols } = synthHistory({ n: 1500, seed: 4 });
  const res = processSequential({}, OPT, [...cols.slice(0, 700), { seq: cols[699].seq + 1, v: null }, ...cols.slice(700).map((c) => ({ ...c, seq: c.seq + 1 }))]);
  assert.equal(res[700].h.length, 0);
  for (const r of res) { assert.ok(r.h instanceof Uint8Array); if (r.far) assert.ok(r.far instanceof Uint8Array); }
});

test('parallel chunks reproduce the single sequential chain', () => {
  const { cols } = synthHistory({ n: 6000, seed: 5 });
  const seq = processSequential({}, OPT, cols), par = new Array(cols.length);
  for (const { a, b, w0 } of planChunks(cols.length, 4)) {
    const list = processChunk({}, OPT, cols.slice(w0, b), a - w0, w0 === 0);
    for (let i = 0; i < list.length; i++) par[a + i] = list[i];
  }
  const { mean, big } = diff(seq, par);
  assert.ok(mean < 0.1, `mean difference ${mean.toFixed(3)} / 255`);
  assert.ok(big < 0.001, `share of large differences ${big}`);
});

test('memory is bounded: state older than STALE columns is forgotten', () => {
  // two processors see the same last WARM columns; one of them saw a long, different history before
  const { cols } = synthHistory({ n: 4000, seed: 6 });
  const tail = cols.slice(-WARM - 200);
  const A = new StableProcessor({}, OPT); for (const c of cols.slice(0, -tail.length)) A.process(c);
  const B = new StableProcessor({}, OPT); B.noFadeIn();
  let d = 0, n = 0;
  tail.forEach((c, i) => { const ra = A.process(c), rb = B.process(c); if (i >= WARM) for (let k = 0; k < ra.h.length; k++) { d += Math.abs(ra.h[k] - rb.h[k]); n++; } });
  assert.ok(d / n < 0.1, `mean difference ${(d / n).toFixed(3)}`);
  assert.ok(STALE < WARM);
});

/** One column with a wall at bucket 50 (size 500) among 1-sized levels, processed for a while. */
function wallScene() {
  const P = new StableProcessor({ smooth: 0, hold: 0 }, { bucket: 1, colMs: 250 }), cols = [], res = [];
  for (let s = 1; s <= 120; s++) { const v = new Float32Array(100).fill(1); v[50] = 500; const c = { seq: s, kb: 0, v }; cols.push(c); res.push(P.process(c)); }
  return { cols, res };
}

test('renderer: a wall stays bright when many buckets share a pixel (volume dominance)', () => {
  const { cols, res } = wallScene(), r = new HeatRenderer(), w = 20, h = 10, buf = new Uint32Array(w * h);
  const gWall = res.at(-1).h[50];
  // 100 buckets on 10 pixel rows: 10 buckets per row; the wall's row must show the wall's colour
  r.render(buf, { width: w, height: h, cols, res, endIndex: cols.length - 1, xEnd: w, colW: 1, priceTop: 100, priceBottom: 0, bucket: 1 });
  const row = 4;   // prices 60…50 → buckets 50…59 (the wall is bucket 50)
  assert.equal(buf[row * w + (w - 1)], r.lut[gWall]);
});

test('renderer: incremental scroll equals a full redraw', () => {
  const { cols, res } = wallScene(), r = new HeatRenderer(), w = 60, h = 20;
  const view = (end) => ({ width: w, height: h, cols, res, endIndex: end, xEnd: w - 5, colW: 2, priceTop: 100, priceBottom: 0, bucket: 1 });
  const a = new Uint32Array(w * h), b = new Uint32Array(w * h);
  r.render(a, view(100)); r.render(a, view(101), { shift: 2 });   // incremental: one new column of 2 px
  r.render(b, view(101));                                         // full
  assert.deepEqual(a, b);
});

test('bookToColumn: bids round down, asks up, every book shape', async () => {
  const { bookToColumn, bookToBuckets } = await import('../src/book.js');
  const bids = [['99.9', '2'], ['95', '1']], asks = new Map([[100.1, 3], [104.9, 4]]);
  const c = bookToColumn(bids, asks, { seq: 1, bucket: 5, rows: 2 });
  assert.equal(c.mid, 100);
  assert.equal(c.kb, 18);                                   // floor(100 / 5) − 2
  assert.deepEqual([...c.v], [0, 3, 0, 7, 0]);              // bucket 19 = 95 … 100: bids 2 + 1; bucket 21: asks 3 + 4
  const o = bookToBuckets({ 101: 1 }, {}, { bucket: 1, kLo: 100, kHi: 102 });
  assert.deepEqual([...o.v], [0, 1, 0]);
  assert.equal(bookToColumn([], [], { seq: 2, bucket: 5 }).v, null);   // empty book → gap column
});

test('Columnizer: increasing seq, spike filter keeps the smaller of two samples', async () => {
  const { Columnizer } = await import('../src/book.js');
  let book = { bids: [[99, 10]], asks: [[101, 1]] }; const out = [];
  const cz = new Columnizer(() => book, { bucket: 1, rows: 3, colMs: 250 }, (c) => out.push(c));
  cz.sample(1000); book = { bids: [[99, 50]], asks: [[101, 1]] }; cz.sample(1250); cz.sample(2000);
  assert.deepEqual(out.map((c) => c.seq), [1, 2, 5]);       // the missed samples show up as a gap
  const i = 99 - out[1].kb;
  assert.equal(out[1].v[i], 10);                            // the jump to 50 must stand one interval first
  assert.equal(out[2].v[i], 50);
});
