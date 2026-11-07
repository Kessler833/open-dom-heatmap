// open-dom-heatmap — colour processor for order-book (liquidity) heatmaps.
//
// Turns the resting order-book size per price bucket of each time column into a colour step 0…255, so that a heatmap of the
// book stays readable: walls stand out against their surroundings, the picture does not flicker, there are no black holes
// inside the book and no "everything is white near price" effect. Inspired by the settings Bookmap documents publicly
// (percentile cut-offs that are recalibrated over time); the algorithm itself is an independent design.
//
// Pipeline per column (causal: columns are processed in time order, each exactly once):
//   1. BACKGROUND = local × wide: geometric mean of the non-empty buckets within ±W (single walls) blended with ±W_WIDE (bigger
//      zones), `local` = share of the local one. Geometric means via prefix sums of log sizes → O(n) per column for any window.
//      The background is smoothed over time per ABSOLUTE price bucket (EMA in the log domain, faster attack upwards).
//   2. LOG RATIO size / background, histogram → PERCENTILE CUT-OFFS (lowCut / highCut, smoothed over ~40 columns). The ratio is
//      stretched over the whole palette between them; `contrast` bends the curve (gamma).
//   3. QUIET: optional time smoothing of the sizes (`smooth` seconds), persistence (a cell fades over `hold` seconds instead of
//      vanishing), one base tone for empty / small levels inside the book, a fade-in after a start or a data gap.
//   4. BOUNDED MEMORY: every bucket remembers the column it was last updated in; state older than STALE columns is forgotten.
//      (Without it a bucket price has not visited for hours kept its old background and persistence, and an old wall could
//      flash up again.) Because memory is bounded, history can be coloured in PARALLEL chunks that reproduce the single
//      sequential chain (see backfill.js).
//   5. OPTIONAL FAR DEPTH: a coarse whole-book array (e.g. 20 bp buckets) is mapped on the SAME scale, its background shifted so
//      its colour matches the detailed grid at the grid's edge, and the detailed grid is blended into it towards its border
//      (edge / edgeCurve / edgeStr) — no hard step where the detailed grid ends.
//
// Input column:  { seq, v: Float32Array (size per bucket, index 0 = bucket kb), kb, raw?: Float32Array (same layout, used for
//                  the background instead of v, e.g. before your own level aggregation), far?: { g, base, v } }
//                  seq = increasing integer column number (gaps in seq = missing columns); v null / empty = a gap column.
// Output:        { kb, h: Uint8Array (0…255 per bucket of v), far: Uint8Array | null (per far bucket) }

/** Background windows (± buckets): local walls / wide structure; far depth: ± far buckets. */
export const W = 30, W_WIDE = 200, FW = 6, FW_WIDE = 50;
/** EMA rates per column: background (τ 20 columns), cut-offs (τ 40 columns). */
const BG_A = 1 - Math.exp(-1 / 20), CUT_A = 1 - Math.exp(-1 / 40);
/** Fade-in length (columns) after a start / gap; gap columns in a row that restart the fade-in. */
export const RAMP = 60, GAP_RESET = 40;
/** Minimum cut-off span in ln units (a flat book is not stretched over the whole palette). */
const MIN_SPAN = 1.2;
/** Per-bucket state older than STALE columns is forgotten (bounded memory, see header point 4). */
export const STALE = 400;
/** Log-domain background grid: stored as ln bg + OFF (0 = unset); faster attack when the new value is above 1.5×. */
const OFF = 1000, LN15 = Math.log(1.5), LN50 = Math.log(50);   // LN50: a fading size below 1/50 of its background is empty
/** Histogram of log ratios for the percentiles: HB bins over HLO … HHI (ln units). */
const HB = 256, HLO = -8, HHI = 8;

/** Default settings (all optional). */
export const DEFAULTS = Object.freeze({
  lowCut: 35,        // % of levels (vs. their surroundings) that stay in the base tone
  highCut: 99,       // % above which levels get the hottest colour
  local: 0.5,        // 1 = compare with direct neighbours only, 0 = with the wide area only
  smooth: 0.5,       // time smoothing of the sizes (seconds)
  base: 0.07,        // base tone for empty / small levels inside the book (0 … 0.25 of the palette)
  hold: 1.5,         // persistence (seconds): a level fades out instead of vanishing
  contrast: 1,       // gamma of the colour curve (> 1: middle sizes darker, big ones hotter)
  edge: 0.3,         // far-depth blend: width (share of each half of the detailed grid)
  edgeCurve: 'log',  // far-depth blend shape: 'log' | 'lin' | 'smooth' | 'exp'
  edgeStr: 0.5,      // far-depth blend strength (0 = off); darkening counts it twice
});

/**
 * Per-bucket state on an absolute bucket index: a typed array that grows as price moves (much faster than a Map).
 */
class Grid {
  constructor(T = Float32Array) { this.T = T; this.lo = 0; this.a = new T(0); }
  /** Makes sure buckets kLo … kLo + n − 1 exist (new ones = 0); returns the array offset of kLo. */
  span(kLo, n) {
    const hi = this.lo + this.a.length;
    if (!this.a.length) { this.lo = kLo - 256; this.a = new this.T(n + 512); }
    else if (kLo < this.lo || kLo + n > hi) {
      const nlo = Math.min(this.lo, kLo) - 256, nhi = Math.max(hi, kLo + n) + 256, b = new this.T(nhi - nlo);
      b.set(this.a, this.lo - nlo); this.lo = nlo; this.a = b;
    }
    return kLo - this.lo;
  }
}

/**
 * ln of the geometric-mean background of the non-empty values of v, blended: a × local (±w) + (1 − a) × wide (±ww).
 * NaN where a window has no data. O(n) via prefix sums of log sizes and counts.
 * @param {ArrayLike<number>} v sizes
 * @returns {Float32Array}
 */
export function lnBackground(v, w, ww, a) {
  const n = v.length, S = new Float64Array(n + 1), C = new Int32Array(n + 1), out = new Float32Array(n);
  for (let i = 0; i < n; i++) { const x = v[i]; S[i + 1] = S[i] + (x > 0 ? Math.log(x) : 0); C[i + 1] = C[i] + (x > 0 ? 1 : 0); }
  for (let i = 0; i < n; i++) {
    const l0 = Math.max(0, i - w), l1 = Math.min(n, i + w + 1), c = C[l1] - C[l0];
    const g0 = Math.max(0, i - ww), g1 = Math.min(n, i + ww + 1), cw = C[g1] - C[g0];
    const ll = c ? (S[l1] - S[l0]) / c : NaN, lw = cw ? (S[g1] - S[g0]) / cw : NaN;
    out[i] = c && cw ? a * ll + (1 - a) * lw : cw ? lw : NaN;
  }
  return out;
}

/** Percentile p (0…1) of the values recorded in histogram h with tot entries (ln units). */
function histPct(h, tot, p) {
  let c = 0; const t = p * tot;
  for (let k = 0; k < HB; k++) { c += h[k]; if (c >= t) return HLO + ((k + 0.5) / HB) * (HHI - HLO); }
  return HHI;
}

/**
 * One processor per heatmap source (e.g. one per symbol and timeframe). Keeps the per-bucket state between columns.
 */
export class StableProcessor {
  /**
   * @param {Partial<typeof DEFAULTS>} cfg colour settings (see DEFAULTS)
   * @param {{bucket?: number, colMs?: number}} [opt] bucket = price width of one bucket (only needed with far depth),
   *   colMs = length of one column in ms (times in cfg are seconds)
   */
  constructor(cfg = {}, opt = {}) {
    const num = (x, d) => (Number.isFinite(+x) ? +x : d), c = { ...DEFAULTS, ...cfg };
    this.lowP = Math.min(0.95, Math.max(0, num(c.lowCut, 35) / 100));
    this.highP = Math.min(1, Math.max(this.lowP + 0.02, num(c.highCut, 99) / 100));
    this.local = Math.min(1, Math.max(0, num(c.local, 0.5)));
    this.smoothS = Math.max(0, num(c.smooth, 0.5));
    this.base = Math.max(0, Math.min(0.25, num(c.base, 0.07)));
    this.holdS = Math.max(0, num(c.hold, 1.5));
    this.gam = Math.max(0.2, Math.min(5, num(c.contrast, 1)));
    this.edge = Math.max(0.02, Math.min(1, num(c.edge, 0.3)));
    this.edgeCurve = ['lin', 'exp', 'log', 'smooth'].includes(c.edgeCurve) ? c.edgeCurve : 'log';
    this.edgeStr = Math.max(0, Math.min(1, num(c.edgeStr, 0.5)));
    this.cfg = c; this.bucket = num(opt.bucket, 1); this.colMs = Math.max(1, num(opt.colMs, 250));
    this.dec = this.holdS > 0 ? Math.exp(-this.colMs / (this.holdS * 1000)) : 0;              // persistence factor per column
    this.sA = this.smoothS > 0 ? 1 - Math.exp(-this.colMs / (this.smoothS * 1000)) : 1;     // size smoothing rate per column
    this.reset();
  }

  /** Forgets all state (e.g. after a long data gap you do not want to bridge). */
  reset() {
    this.bg = new Grid(); this.out = new Grid(); this.vs = new Grid(); this.seen = new Grid(Float64Array);   // fine grid state
    this.fbg = new Grid(); this.fout = new Grid();                                                          // far depth state
    this.cut = { L: NaN, U: NaN };   // smoothed cut-offs (ln ratio)
    this.lastSeq = null; this._empty = 0; this._nSince = null; this._ramp = 1;
  }

  /**
   * Skips the fade-in: use it when a processor starts in the middle of a history (parallel chunks do this).
   */
  noFadeIn() { this._nSince = 1e9; }

  /**
   * Processes the next column (seq must increase). Returns its colour steps.
   * @param {{seq:number, kb?:number, v?:Float32Array|null, raw?:Float32Array, far?:{g:number, base:number, v:Float32Array}}} col
   * @returns {{kb:number, h:Uint8Array, far:Uint8Array|null}}
   */
  process(col) {
    const gap = this.lastSeq == null ? 1 : Math.max(1, col.seq - this.lastSeq);
    this.lastSeq = col.seq;
    const v = col.v;
    // gap column (no data): a run of more than GAP_RESET of them restarts the fade-in
    if (!v || !v.length) { if (++this._empty >= GAP_RESET) this._nSince = null; return { kb: 0, h: new Uint8Array(0), far: null }; }
    this._empty = 0;
    const kb = col.kb | 0, raw = col.raw && col.raw.length === v.length ? col.raw : v, n = v.length;
    let lo = -1, hi = -1; for (let i = 0; i < n; i++) if (v[i] > 0) { if (lo < 0) lo = i; hi = i; }
    // fade-in over RAMP columns after a start or a gap of more than GAP_RESET columns (background and cut-offs settle there)
    this._nSince = gap > GAP_RESET || this._nSince == null ? 0 : this._nSince + 1;
    this._ramp = Math.min(1, (this._nSince + 1) / RAMP);
    this._seq = col.seq;
    const h = this._map(v, raw, kb, gap, lo >= 0 ? [lo, hi] : [1, 0]);
    const F = col.far, far = F && F.v && F.g > 0 ? this._farMap(F, kb, n, gap, lo, hi, h) : null;
    if (far && this.edgeStr > 0) this._blendEdge(h, far, F, kb, n);
    return { kb, h, far };
  }

  /** Fine grid: v (+ raw for the background) → 0…255, updating the per-bucket state and the cut-offs (header points 1–4). */
  _map(v, raw, k0, gap, inBook) {
    const n = v.length, base = this.base, gam = this.gam, cut = this.cut;
    const a = 1 - Math.pow(1 - BG_A, gap), aUp = Math.max(a, 0.3), aC = 1 - Math.pow(1 - CUT_A, gap);
    const dec = this.dec > 0 ? Math.pow(this.dec, gap) : 0, sA = this.sA >= 1 ? 1 : 1 - Math.pow(1 - this.sA, gap);
    const lnB = lnBackground(raw, W, W_WIDE, this.local); this._lnB = lnB;   // kept for the far depth's edge match
    const ob = this.bg.span(k0, n), B = this.bg.a, os = this.vs.span(k0, n), V = this.vs.a, oo = this.out.span(k0, n), O = this.out.a;
    const oe = this.seen.span(k0, n), SE = this.seen.a, seq = this._seq;
    const age = this._age && this._age.length >= n ? this._age : (this._age = new Float64Array(n + 256));
    // 1. time-smoothed background (log domain, per absolute bucket) and sizes → log ratio; histogram for the cut-offs
    const lr = new Float32Array(n), hist = new Uint32Array(HB); let tot = 0;
    for (let i = 0; i < n; i++) {
      const ls = SE[oe + i], ag = ls > 0 ? seq - ls : Infinity; age[i] = ag; SE[oe + i] = seq;   // columns since the last update
      if (ag > STALE) { B[ob + i] = 0; V[os + i] = 0; O[oo + i] = 0; }                              // bounded memory
      // EMA rates over the bucket's OWN elapsed columns: a bucket at the edge of a moving window that is only visited now and
      // then catches up at once instead of keeping old state for a long time (this keeps the memory bounded)
      const aI = ag === gap ? a : 1 - Math.pow(1 - BG_A, ag), aUpI = ag === gap ? aUp : Math.max(aI, 0.3);
      const sAI = sA >= 1 || ag === gap ? sA : 1 - Math.pow(1 - this.sA, ag);
      const o = lnB[i]; let lb = B[ob + i];
      if (o === o) { lb = lb !== 0 ? lb + (o + OFF - lb) * (o + OFF > lb + LN15 ? aUpI : aI) : o + OFF; B[ob + i] = lb; }
      let x = v[i];
      if (sA < 1) {
        const p = V[os + i]; x = p > 0 || x > 0 ? p + (x - p) * sAI : 0;
        // a vanished level decays towards 0 but never reaches it (it ended as 1e-45 and still counted in the cut-off
        // histogram, an endless memory): below 2 % of its background it is empty
        if (v[i] === 0 && lb !== 0 && x < Math.exp(lb - OFF - LN50)) x = 0;
        V[os + i] = x;
      }
      if (x > 0 && lb !== 0) {
        const r = Math.log(x) - (lb - OFF); lr[i] = r;
        const k = Math.floor(((r - HLO) / (HHI - HLO)) * HB); hist[k < 0 ? 0 : k >= HB ? HB - 1 : k]++; tot++;
      } else lr[i] = NaN;
    }
    // 2. cut-offs: percentiles of this column, smoothed over ~40 columns (the first column sets them directly)
    if (tot >= 8) {
      const pL = histPct(hist, tot, this.lowP), pU = histPct(hist, tot, this.highP);
      if (cut.L === cut.L) { cut.L += (pL - cut.L) * aC; cut.U += (pU - cut.U) * aC; } else { cut.L = pL; cut.U = pU; }
    }
    // 3. stretch between the cut-offs, contrast curve, persistence, base tone
    const L = cut.L, span = Math.max(MIN_SPAN, cut.U - cut.L), out = new Uint8Array(n), mul = this._ramp;
    const lo = inBook[0], hi = inBook[1];
    for (let i = 0; i < n; i++) {
      const r = lr[i]; let g = 0;
      if (r === r && L === L) { const u = (r - L) / span; g = (u <= 0 ? 0 : u >= 1 ? 1 : gam === 1 ? u : Math.pow(u, gam)) * mul; }
      if (dec > 0) { const ag = age[i], p = O[oo + i] * (ag === gap ? dec : Math.pow(this.dec, ag)); if (p > g) g = p; O[oo + i] = g; }   // fades over the real elapsed columns
      if (g < base && i >= lo && i <= hi) g = base;
      out[i] = (g * 255 + 0.5) | 0;
    }
    return out;
  }

  /**
   * Far depth on the same scale as the fine grid (header point 5): sizes as density per display bucket, background = its own
   * local × wide geometric mean shifted per side so that the colour at the grid edge equals the fine grid's colour there.
   */
  _farMap(F, kb, n, gap, lo, hi, hFine) {
    const fv = F.v, m = fv.length, b = this.bucket, fG = F.g, fB = F.base | 0, k = b / fG, base = this.base, gam = this.gam;
    const dens = new Float32Array(m); for (let j = 0; j < m; j++) dens[j] = fv[j] * k;
    const lnF = lnBackground(dens, FW, FW_WIDE, this.local), lnFine = this._lnB;
    // fine background at its lower / upper edge (mean of the outer 8 valid buckets), fallback for the shift
    const edgeLn = (from, step) => { let s2 = 0, c = 0; for (let i = from, t = 0; i >= 0 && i < n && t < 40 && c < 8; i += step, t++) if (lnFine[i] === lnFine[i]) { s2 += lnFine[i]; c++; } return c ? s2 / c : NaN; };
    const jOf = (price) => Math.floor(price / fG) - fB;
    const jLo = jOf(kb * b), jHi = jOf((kb + n) * b);
    const fLo = edgeLn(Math.max(0, lo), 1), fHi = edgeLn(Math.min(n - 1, hi), -1);
    // shift per side so the far colour at the grid edge equals the fine colour there:
    // (ln dens_e − (lnF_e + sh) − L) / span = g_e  →  sh = ln dens_e − lnF_e − L − g_e × span
    const L0 = this.cut.L, span0 = Math.max(MIN_SPAN, this.cut.U - this.cut.L);
    const gEdge = (from, step) => { let s2 = 0, c = 0; for (let i = from, t = 0; i >= 0 && i < n && t < 12; i += step, t++) { s2 += hFine[i] / 255; c++; } return c ? s2 / c : NaN; };
    const lnDensAt = (j0, dir) => { let s2 = 0, c = 0; for (let j = j0, t = 0; j >= 0 && j < m && t < 3; j += dir, t++) if (dens[j] > 0) { s2 += Math.log(dens[j]); c++; } return c ? s2 / c : NaN; };
    const shOf = (j, dir, g) => { const ld = lnDensAt(j, dir); return ld === ld && lnF[j] === lnF[j] && g === g && L0 === L0 ? ld - lnF[j] - L0 - g * span0 : NaN; };
    let sLo = shOf(jLo, -1, gEdge(Math.max(0, lo), 1)), sHi = shOf(jHi, 1, gEdge(Math.min(n - 1, hi), -1));
    if (!(sLo === sLo)) sLo = fLo === fLo && lnF[jLo] === lnF[jLo] ? fLo - lnF[jLo] : 0;
    if (!(sHi === sHi)) sHi = fHi === fHi && lnF[jHi] === lnF[jHi] ? fHi - lnF[jHi] : sLo;
    const a = 1 - Math.pow(1 - BG_A, gap), aUp = Math.max(a, 0.3), dec = this.dec > 0 ? Math.pow(this.dec, gap) : 0;
    const ob = this.fbg.span(fB, m), B = this.fbg.a, oo = this.fout.span(fB, m), O = this.fout.a;
    const L = this.cut.L, span = span0, mul = this._ramp, out = new Uint8Array(m);
    for (let j = 0; j < m; j++) {
      const sh = j <= jLo ? sLo : j >= jHi ? sHi : sLo + (sHi - sLo) * (j - jLo) / Math.max(1, jHi - jLo);
      const o = lnF[j] === lnF[j] ? lnF[j] + sh : NaN; let lb = B[ob + j];
      if (o === o) { lb = lb !== 0 ? lb + (o + OFF - lb) * (o + OFF > lb + LN15 ? aUp : a) : o + OFF; B[ob + j] = lb; }
      let g = 0;
      if (dens[j] > 0 && lb !== 0 && L === L) { const u = (Math.log(dens[j]) - (lb - OFF) - L) / span; g = (u <= 0 ? 0 : u >= 1 ? 1 : gam === 1 ? u : Math.pow(u, gam)) * mul; }
      if (dec > 0) { const p = O[oo + j] * dec; if (p > g) g = p; O[oo + j] = g; }
      if (g < base) g = base;   // the whole book: base tone everywhere
      out[j] = (g * 255 + 0.5) | 0;
    }
    return out;
  }

  /**
   * Blends the detailed grid into the far depth towards its border (no hard step). w(u) = weight of the detail, u = 0 at the
   * border … 1 at the inner end of the blend zone: lin, exp (slow at first), log (fast, least dimming), smooth (S-curve).
   * The coarse share is scaled by edgeStr, darkening once more by edgeStr (it rather dims too little than too much).
   */
  _blendEdge(h, far, F, kb, n) {
    const fG = F.g, fB = F.base | 0, b = this.bucket, half = Math.max(1, n / 2), fn = far.length, cv = this.edgeCurve, st = this.edgeStr;
    const E3 = Math.exp(3) - 1, L9 = Math.log(10);
    for (let i = 0; i < n; i++) {
      const e = Math.min(i, n - 1 - i) / half; if (e >= this.edge) continue;
      const u = e / this.edge, w = cv === 'lin' ? u : cv === 'exp' ? (Math.exp(3 * u) - 1) / E3 : cv === 'smooth' ? u * u * (3 - 2 * u) : Math.log(1 + 9 * u) / L9;
      const j = Math.floor(((kb + i + 0.5) * b) / fG) - fB; if (j < 0 || j >= fn) continue;
      const d = far[j] - h[i], m = (1 - w) * st * (d < 0 ? st : 1);
      h[i] = (h[i] + m * d + 0.5) | 0;
    }
  }
}
