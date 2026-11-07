// Synthetic order-book history for the demo, the tests and the benchmark (deterministic: seeded random numbers).
// Price follows a random walk; every column holds the summed book size per bucket in a window of ±rows buckets around the
// price (default ±1200 buckets = full resolution over the whole demo view; the window moves with price), with thick liquidity near the touch, noise, and walls that
// sit at fixed prices for a while (some are pulled, some get eaten when price trades through them). Optionally a coarse
// far-depth array (whole book on a coarse grid, only used beyond the detailed window) and a few gaps (missing columns, as when an app was closed).

/** Small fast seeded RNG (mulberry32). */
export function rng(seed = 1) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/**
 * @param {{n?:number, seed?:number, price?:number, bucket?:number, rows?:number, far?:boolean, gaps?:boolean}} [o]
 *   n columns, start price, bucket width, ±rows buckets per column, far = add coarse whole-book depth, gaps = add missing columns
 * @returns {{cols: Array, bucket:number}}
 */
export function synthHistory(o = {}) {
  const n = o.n ?? 3000, R = rng(o.seed ?? 7), bucket = o.bucket ?? 5, rows = o.rows ?? 1200, withFar = o.far ?? true;
  const gauss = () => { let u = 0; for (let i = 0; i < 6; i++) u += R(); return u - 3; };
  let price = o.price ?? 75000, seq = 0;
  const g = Math.round(price * 0.002);   // far-depth grid (~20 bp), fixed for the whole history (state is kept per far bucket)
  const walls = [];   // { k (bucket), q (size), until (column), pullAt }
  // resting size per absolute bucket is persistent (a real book changes slowly): one log-normal factor per bucket, redrawn
  // now and then; per column only a little noise on top
  const fac = new Map(), facOf = (k) => { let f = fac.get(k); if (f === undefined || R() < 0.004) { f = R() < 0.05 ? 0 : Math.exp(gauss() * 0.4); fac.set(k, f); } return f; };
  const ffac = new Map(), ffacOf = (j) => { let f = ffac.get(j); if (f === undefined || R() < 0.002) { f = Math.exp(gauss() * 0.6) * (R() < 0.01 ? 8 : 1); ffac.set(j, f); } return f; };
  const cols = [];
  for (let c = 0; c < n; c++) {
    seq++;
    if (o.gaps !== false && R() < 0.0005) { const skip = 20 + Math.floor(R() * 80); seq += skip; }   // a data gap
    price += gauss() * bucket * 0.6 + (R() < 0.002 ? gauss() * bucket * 25 : 0);                  // walk + rare jumps
    const kMid = Math.floor(price / bucket), kb = kMid - rows, len = 2 * rows + 1;
    // new walls now and then (sizes log-normal: few big, many medium), away from price, alive for a while; walls price
    // trades through are eaten
    if (R() < 0.02) walls.push({ k: kMid + Math.round(gauss() * Math.min(rows, 600) * 0.5), q: 25 * Math.exp(Math.abs(gauss()) * 1.6), until: c + 200 + R() * 2000, pullAt: R() < 0.3 ? c + 50 + R() * 600 : Infinity });
    for (let i = walls.length - 1; i >= 0; i--) { const w = walls[i]; if (c > w.until || c > w.pullAt || Math.abs(w.k - kMid) < 1) walls.splice(i, 1); }
    const v = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      const d = Math.abs(kb + i - kMid);
      if (d === 0) continue;                                                       // the spread
      v[i] = (2 + 30 * Math.exp(-d / 40)) * facOf(kb + i) * Math.exp(gauss() * 0.15);   // thick near the touch, persistent per price
    }
    for (const w of walls) { const i = w.k - kb; if (i >= 0 && i < len) v[i] += w.q; }
    const col = { seq, kb, v };
    if (withFar) {   // whole book on a ~20 bp grid from 0.5 × to 1.5 × price
      const base = Math.floor(price * 0.5 / g), m = Math.floor(price / g) + 1, fv = new Float32Array(m);
      for (let j = 0; j < m; j++) { const p = (base + j) * g, d = Math.abs(p - price) / price; fv[j] = d < 1e-3 ? 0 : 400 * Math.exp(-d * 30) * ffacOf(base + j) * Math.exp(gauss() * 0.1); }
      col.far = { g, base, v: fv };
    }
    cols.push(col);
  }
  return { cols, bucket };
}
