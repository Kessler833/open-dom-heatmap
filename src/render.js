// Heatmap renderer: draws processed columns into a 32-bit pixel buffer (an ImageData's Uint32Array view).
//
// SUMMARY BY VOLUME DOMINANCE: when several buckets fall on one pixel row (price zoomed out) or several columns on one pixel
// column (time zoomed out), each bucket scores colour × √(its size / the largest size on that pixel); the pixel shows the
// highest score. The level with the most volume keeps its full colour, smaller ones count with reduced brightness — a wall
// stays a visible line instead of being averaged away (a plain mean washed walls out where many similar buckets met) or being
// outshone by a small level that only looks big against a thin neighbourhood (a plain max). Pixels without any size (empty
// buckets, fading persistence) show their brightest colour; coarse far blocks count by colour. At most XCAP columns are read
// per pixel column (evenly spaced).
//
// INCREMENTAL SCROLL: when new columns arrive, render(…, { shift }) moves the existing image left by `shift` px and computes
// only the pixel columns at the right edge — past columns never change their colour, so the result equals a full redraw.

/** At most this many columns are read per pixel column when time is zoomed far out. */
export const XCAP = 6;

/** Default palette stops: [position 0…1, r, g, b] (black → navy → blue → cyan → green → yellow → orange → red → white). */
export const CLASSIC = [[0, 0, 0, 0], [0.05, 4, 8, 28], [0.14, 8, 26, 82], [0.26, 10, 70, 160], [0.40, 0, 150, 210],
  [0.54, 0, 210, 170], [0.66, 120, 230, 60], [0.77, 245, 225, 40], [0.87, 255, 140, 20], [0.95, 255, 40, 30], [1, 255, 255, 255]];

/**
 * 256-entry colour table for the 0…255 steps (pixel format of ImageData on little-endian machines: 0xAABBGGRR).
 * @param {Array<[number, number, number, number]>} [stops] palette stops
 * @param {number} [gamma] < 1 brightens the lower steps
 * @returns {Uint32Array}
 */
export function buildPalette(stops = CLASSIC, gamma = 0.85) {
  const lut = new Uint32Array(256);
  for (let g = 0; g < 256; g++) {
    const x = g === 0 ? 0 : Math.pow(g / 255, gamma);
    let k = 0; while (k < stops.length - 2 && x > stops[k + 1][0]) k++;
    const [x0, r0, g0, b0] = stops[k], [x1, r1, g1, b1] = stops[k + 1], f = (x - x0) / (x1 - x0 || 1);
    lut[g] = (255 << 24) | (Math.round(b0 + (b1 - b0) * f) << 16) | (Math.round(g0 + (g1 - g0) * f) << 8) | Math.round(r0 + (r1 - r0) * f);
  }
  return lut;
}

/**
 * Renders processed columns.
 * view = {
 *   width, height,          // pixel size of the buffer
 *   cols, res,              // input columns (for the sizes v / kb / far) and their processor results, same index
 *   endIndex,               // index of the column at the right edge
 *   xEnd,                   // x (px) of the right edge of that column
 *   colW,                   // px per column (< 1 = several columns per pixel)
 *   priceTop, priceBottom,  // price at y = 0 and at y = height
 *   bucket,                 // price width of one bucket
 * }
 */
export class HeatRenderer {
  /** @param {{palette?: Uint32Array}} [opt] */
  constructor(opt = {}) { this.lut = opt.palette || buildPalette(); }

  /**
   * Draws into buf (Uint32Array of width × height). opt.shift given (≥ 0, whole px): incremental — move the image left by
   * `shift` px and draw only the pixel columns at the live edge (the caller carries the sub-pixel remainder of colW).
   */
  render(buf, view, opt = {}) {
    const { width: iw, height: ih, cols, res, endIndex, xEnd, colW, priceTop, priceBottom, bucket } = view;
    const lut = this.lut, black = lut[0], inc = opt.shift != null, sh = Math.min(iw, Math.max(0, opt.shift | 0));
    let xFrom = 0;
    if (inc) {   // incremental: keep the image (shifted), redraw only the right edge
      if (sh > 0) for (let y = 0, r = 0; y < ih; y++, r += iw) buf.copyWithin(r, r + sh, r + iw);
      xFrom = Math.max(0, Math.floor(xEnd) - sh - Math.ceil(colW) - 3);
    }
    // per pixel row: bucket range and price range (independent of x)
    const R = this._rows(ih), ppy = (priceTop - priceBottom) / ih;
    for (let y = 0; y < ih; y++) {
      const pT = priceTop - y * ppy, pB = priceTop - (y + 1) * ppy;
      R.pTop[y] = pT; R.pBot[y] = pB; R.kTop[y] = Math.floor(pT / bucket + 1e-9); R.kBot[y] = Math.min(R.kTop[y], Math.floor(pB / bucket + 1e-9));
    }
    const { kTop, kBot, pTop, pBot, num, den, zG, cG, fj0, fj1 } = R;
    let fjG = NaN, prev = -2;
    for (let x = xFrom; x < iw; x++) {
      // columns overlapping pixel column [x, x + 1)
      let c0, c1;
      if (colW >= 1) c0 = c1 = endIndex - Math.floor((xEnd - x - 0.5) / colW);
      else { c0 = Math.floor(endIndex - (xEnd - x) / colW) + 1; c1 = Math.ceil(endIndex + 1 - (xEnd - x - 1) / colW) - 1; if (c1 < c0) c1 = c0; }
      if (c0 < 0) c0 = 0; if (c1 >= cols.length) c1 = cols.length - 1; if (c1 > endIndex) c1 = endIndex;
      if (c1 < c0) { for (let y = 0, p = x; y < ih; y++, p += iw) buf[p] = black; prev = -2; continue; }
      if (colW >= 1 && c0 === prev && x > 0) { for (let y = 0, p = x; y < ih; y++, p += iw) buf[p] = buf[p - 1]; continue; }   // same column as the pixel before
      prev = c0;
      const step = Math.max(1, Math.ceil((c1 - c0 + 1) / XCAP));
      num.fill(0); den.fill(0); zG.fill(0); cG.fill(0);
      for (let ci = c1; ci >= c0; ci -= step) {
        const col = cols[ci], r = res[ci]; if (!r) continue;
        const hh = r.h, cn = hh.length, skb = r.kb, v = col.v, vn = v ? v.length : 0, dv = skb - (col.kb | 0);
        const far = r.far, F = col.far, fB = far ? F.base | 0 : 0, fn = far ? far.length : 0;
        if (far && F.g !== fjG) { fjG = F.g; for (let y = 0; y < ih; y++) { fj0[y] = Math.floor(pBot[y] / fjG); fj1[y] = Math.floor(pTop[y] / fjG); } }
        for (let y = 0; y < ih; y++) {
          let k0 = kBot[y] - skb, k1 = kTop[y] - skb;
          const inside = k0 >= 0 && k1 < cn;
          if (k1 >= 0 && k0 < cn) {   // detailed buckets of this pixel row: score = colour × √size, kept by max (see header)
            if (k0 < 0) k0 = 0; if (k1 >= cn) k1 = cn - 1;
            let A = num[y], V = den[y], Z = zG[y];
            for (let k = k0; k <= k1; k++) {
              const kv = k + dv, sz = kv >= 0 && kv < vn ? v[kv] : 0, g = hh[k];
              if (sz > 0) { const sc = g * Math.sqrt(sz); if (sc > A) A = sc; if (sz > V) V = sz; } else if (g > Z) Z = g;
            }
            num[y] = A; den[y] = V; zG[y] = Z;
          }
          if (far && !inside) {   // (partly) beyond the detailed grid: strongest coarse block
            let j0 = fj0[y] - fB, j1 = fj1[y] - fB;
            if (j1 >= 0 && j0 < fn) {
              if (j0 < 0) j0 = 0; if (j1 >= fn) j1 = fn - 1;
              let gf = cG[y]; for (let j = j0; j <= j1; j++) if (far[j] > gf) gf = far[j];
              cG[y] = gf;
            }
          }
        }
      }
      for (let y = 0, p = x; y < ih; y++, p += iw) {
        const V = den[y]; let g = V > 0 ? num[y] / Math.sqrt(V) : zG[y];
        if (cG[y] > g) g = cG[y];
        buf[p] = g > 0 ? lut[g > 255 ? 255 : (g + 0.5) | 0] : black;
      }
    }
  }

  /** Per-row work arrays (reused between frames). */
  _rows(ih) {
    let R = this._R;
    if (!R || R.kTop.length !== ih) {
      R = this._R = { kTop: new Int32Array(ih), kBot: new Int32Array(ih), pTop: new Float64Array(ih), pBot: new Float64Array(ih),
        num: new Float32Array(ih), den: new Float32Array(ih), zG: new Float32Array(ih), cG: new Float32Array(ih), fj0: new Int32Array(ih), fj1: new Int32Array(ih) };
    }
    return R;
  }
}
