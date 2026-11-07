// DomHeatmap: a ready-to-use canvas chart around StableProcessor + HeatRenderer.
//
//   const chart = new DomHeatmap(canvas, { bucket: 5, colMs: 250 });
//   await chart.setHistory(columns);     // optional: colour a history (parallel workers)
//   chart.push(column);                  // every new column (e.g. from a Columnizer)
//
// Mouse: wheel = zoom price around the cursor, Shift + wheel = zoom time, drag = pan (stops following), double-click =
// follow the live edge again. Drawing is done on requestAnimationFrame only when something changed. Performance:
//   - new column while following → the image is shifted and only the live edge is drawn (incremental scroll);
//   - price drifting while following → the finished image is moved vertically (one GPU blit) until the move exceeds
//     SHIFT_PX, then it is recomputed; a full recompute also happens at least every FULL_MS;
//   - the heat image is computed at CSS-pixel resolution and scaled to the device pixels (sharp on HiDPI screens).

import { StableProcessor } from './processor.js';
import { processHistory } from './backfill.js';
import { HeatRenderer, buildPalette } from './render.js';

/** Vertical move (px) up to which the finished image is only shifted; full recompute interval while following (ms). */
const SHIFT_PX = 24, FULL_MS = 3000;

export class DomHeatmap {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{bucket:number, colMs?:number, settings?:object, palette?:Uint32Array, ppp?:number, colW?:number, rightPad?:number,
   *          maxColumns?:number, midLine?:boolean|string, background?:string, workers?:number,
   *          onDraw?:(ctx:CanvasRenderingContext2D, chart:DomHeatmap) => void}} opt
   *   bucket price width of one bucket; colMs column length; settings colour settings (processor.js DEFAULTS); ppp pixels per
   *   price unit (default: fit ±100 buckets); colW pixels per column; rightPad free space right of the live edge (px);
   *   maxColumns columns kept (oldest dropped); midLine draw the mid price (col.mid) as a line (true or a CSS colour);
   *   onDraw custom overlay, called after the heat image with a CSS-pixel transform
   */
  constructor(canvas, opt) {
    this.canvas = canvas; this.ctx = canvas.getContext('2d', { alpha: false });
    this.o = { colMs: 250, settings: {}, colW: 1, rightPad: 40, maxColumns: 20000, midLine: true, background: '#000', ...opt };
    this.renderer = new HeatRenderer({ palette: this.o.palette || buildPalette() });
    this.cols = []; this.res = []; this.proc = new StableProcessor(this.o.settings, this._popt());
    this.colW = this.o.colW; this.ppp = this.o.ppp || NaN; this.center = NaN;
    this.follow = true; this.endIndex = -1;   // endIndex: the column at the right edge while not following
    this._img = null; this._tmp = null; this._key = ''; this._imgCenter = NaN; this._fullAt = 0; this._shAcc = 0; this._pend = null;
    this._dirty = true; this._raf = 0; this._busy = false;
    this._bind(); this._loop();
  }

  _popt() { return { bucket: this.o.bucket, colMs: this.o.colMs }; }

  // ---------- data ----------
  /** Replaces all columns and colours them (in parallel where possible). Resolves when done. */
  async setHistory(cols) {
    this.cols = cols.slice(-this.o.maxColumns);
    await this._recolour();
  }
  /** Adds the next column (seq must increase) and colours it. */
  push(col) {
    if (this._busy) { (this._queue ||= []).push(col); return; }   // a recolour is running: added when it is done
    this.cols.push(col); this.res.push(this.proc.process(col));
    if (this.cols.length > this.o.maxColumns) { const d = this.cols.length - this.o.maxColumns; this.cols.splice(0, d); this.res.splice(0, d); if (!this.follow) this.endIndex -= d; this._key = ''; }
    if (this.follow) { this._shAcc += this.colW; this._pend = (this._pend || 0) + 1; }
    this._dirty = true;
  }
  /** Changes colour settings (processor.js DEFAULTS) and recolours everything. */
  async setSettings(settings) {
    this.o.settings = { ...this.o.settings, ...settings };
    await this._recolour();
  }
  /** Changes the palette (buildPalette output). */
  setPalette(lut) { this.renderer.lut = lut; this._key = ''; this._dirty = true; }
  async _recolour() {
    this._busy = true;
    const r = await processHistory(this.cols, this.o.settings, this._popt(), this.o.workers != null ? { workers: this.o.workers } : {});
    this.res = r.results; this.proc = r.processor; this._busy = false; this._key = ''; this._dirty = true;
    const q = this._queue; this._queue = null; if (q) for (const c of q) this.push(c);
  }

  // ---------- geometry (CSS pixels) ----------
  get width() { return this.canvas.clientWidth; }
  get height() { return this.canvas.clientHeight; }
  /** Index of the column at the right edge. */
  get end() { return this.follow ? this.cols.length - 1 : Math.min(this.endIndex, this.cols.length - 1); }
  /** x of the right edge of the newest visible column. */
  get xEnd() { return this.width - this.o.rightPad; }
  yOfPrice(p) { return this.height / 2 - (p - this.center) * this.ppp; }
  priceOfY(y) { return this.center + (this.height / 2 - y) / this.ppp; }
  /** x of the left edge of column i. */
  xOfIndex(i) { return this.xEnd - (this.end - i + 1) * this.colW; }
  indexOfX(x) { return this.end - Math.floor((this.xEnd - x) / this.colW); }

  /** Mid price of the newest column with data (col.mid, else the middle of its bucket window). */
  _lastMid() {
    for (let i = this.cols.length - 1; i >= 0; i--) { const c = this.cols[i]; if (c.mid > 0) return c.mid; if (c.v?.length) return (c.kb + c.v.length / 2) * this.o.bucket; }
    return NaN;
  }

  // ---------- drawing ----------
  _loop() { this._raf = requestAnimationFrame(() => { this._loop(); if (this._dirty) { this._dirty = false; this.draw(); } }); }

  /** Draws now (normally called by the animation loop when something changed). */
  draw() {
    const w = this.width, h = this.height, dpr = globalThis.devicePixelRatio || 1, cv = this.canvas, ctx = this.ctx;
    if (!(w > 0 && h > 0)) return;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); this._key = ''; }
    if (!this.cols.length) { ctx.fillStyle = this.o.background; ctx.fillRect(0, 0, cv.width, cv.height); return; }
    if (!(this.ppp > 0)) this.ppp = h / (this.o.bucket * 200);
    // follow: keep the mid price inside the middle half of the view (eased)
    const mid = this._lastMid();
    if (!(this.center > 0)) this.center = mid;
    if (this.follow && mid > 0) { const lim = h * 0.25 / this.ppp, d = mid - this.center; if (Math.abs(d) > lim) this.center += (d - Math.sign(d) * lim) * 0.25; }
    if (!this._img || this._img.width !== w || this._img.height !== h) {
      this._img = new ImageData(w, h); this._buf = new Uint32Array(this._img.data.buffer);
      this._tmp = document.createElement('canvas'); this._tmp.width = w; this._tmp.height = h; this._key = '';
    }
    const key = [w, h, this.colW, this.ppp, this.follow ? 'f' : this.endIndex, this.o.rightPad, this.res.length && this.res === this._resRef].join('|');
    const dy = (this.center - this._imgCenter) * this.ppp, now = performance.now();
    const view = (c) => ({ width: w, height: h, cols: this.cols, res: this.res, endIndex: this.end, xEnd: this.xEnd, colW: this.colW,
      priceTop: c + h / 2 / this.ppp, priceBottom: c - h / 2 / this.ppp, bucket: this.o.bucket });
    let blit = false;
    if (key === this._key && this._pend && Math.abs(dy) < SHIFT_PX && now - this._fullAt < FULL_MS) {
      // new column(s): shift the cached image (in its own vertical frame) and draw the live edge
      const sh = Math.floor(this._shAcc); this._shAcc -= sh;
      this.renderer.render(this._buf, view(this._imgCenter), { shift: sh });
      this._tmp.getContext('2d').putImageData(this._img, 0, 0); blit = true;
    } else if (key !== this._key || this._pend || !(Math.abs(dy) < SHIFT_PX) || now - this._fullAt > FULL_MS) {
      this.renderer.render(this._buf, view(this.center));
      this._tmp.getContext('2d').putImageData(this._img, 0, 0);
      this._key = key; this._resRef = this.res; this._imgCenter = this.center; this._fullAt = now; this._shAcc = 0; blit = true;
    } else blit = true;   // only the centre moved a little: move the finished image
    this._pend = 0;
    if (blit) {
      const off = Math.round((this.center - this._imgCenter) * this.ppp * dpr);
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = this.o.background; ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.imageSmoothingEnabled = false; ctx.drawImage(this._tmp, 0, 0, w, h, 0, off, w * dpr, h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (this.o.midLine) this._midLine(ctx);
    this.o.onDraw?.(ctx, this);
    // keep animating while the centre is still easing towards price
    if (this.follow && mid > 0 && Math.abs(mid - this.center) > h * 0.25 / this.ppp + 1 / this.ppp) this._dirty = true;
  }

  /** Mid price line through the visible columns (col.mid), one vertex per price change. */
  _midLine(ctx) {
    const i0 = Math.max(0, this.indexOfX(0) - 1), i1 = this.end;
    ctx.strokeStyle = typeof this.o.midLine === 'string' ? this.o.midLine : 'rgba(255,255,255,0.85)'; ctx.lineWidth = 1.2; ctx.beginPath();
    let started = false, py = 0;
    for (let i = i0; i <= i1; i++) {
      const m = this.cols[i]?.mid; if (!(m > 0)) { started = false; continue; }
      const x = this.xOfIndex(i), y = this.yOfPrice(m);
      if (!started) { ctx.moveTo(x, y); started = true; } else if (y !== py) { ctx.lineTo(x, py); ctx.lineTo(x, y); }
      py = y;
    }
    if (started) ctx.lineTo(this.xOfIndex(i1 + 1), py);
    ctx.stroke();
  }

  // ---------- interaction ----------
  _bind() {
    const cv = this.canvas; let drag = null;
    cv.style.touchAction = 'none';   // touch: drag pans the chart instead of scrolling the page
    this._on = {
      wheel: (e) => {
        e.preventDefault();
        const f = e.deltaY < 0 ? 1.15 : 1 / 1.15, r = cv.getBoundingClientRect(), y = e.clientY - r.top;
        if (e.shiftKey) this.colW = Math.max(0.02, Math.min(24, this.colW * f));
        else { const p = this.priceOfY(y); this.ppp = Math.max(1e-6, this.ppp * f); this.center = p - (this.height / 2 - y) / this.ppp; }   // zoom around the cursor
        this._dirty = true;
      },
      down: (e) => { drag = { x: e.clientX, y: e.clientY, c: this.center, end: this.end }; },
      move: (e) => {
        if (!drag) return;
        const dx = e.clientX - drag.x, dyy = e.clientY - drag.y;
        if (Math.abs(dx) + Math.abs(dyy) < 3 && this.follow) return;
        this.follow = false; this.endIndex = Math.min(this.cols.length - 1, Math.max(0, Math.round(drag.end - dx / this.colW)));
        this.center = drag.c + dyy / this.ppp; this._dirty = true;
      },
      up: () => { drag = null; },
      dbl: () => { this.follow = true; this.center = this._lastMid(); this._dirty = true; },
      resize: () => { this._dirty = true; },
    };
    cv.addEventListener('wheel', this._on.wheel, { passive: false });
    cv.addEventListener('pointerdown', this._on.down); addEventListener('pointermove', this._on.move); addEventListener('pointerup', this._on.up);
    cv.addEventListener('dblclick', this._on.dbl); addEventListener('resize', this._on.resize);
  }

  /** Stops drawing and removes all listeners. */
  destroy() {
    cancelAnimationFrame(this._raf); const cv = this.canvas, o = this._on;
    cv.removeEventListener('wheel', o.wheel); cv.removeEventListener('pointerdown', o.down); removeEventListener('pointermove', o.move);
    removeEventListener('pointerup', o.up); cv.removeEventListener('dblclick', o.dbl); removeEventListener('resize', o.resize);
  }
}
