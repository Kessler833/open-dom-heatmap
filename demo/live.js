// Live demo: the Binance spot order book (public websocket + REST, no API key) as a DOM heatmap.
//
// Local order book, following Binance's documented procedure: open the diff stream (<sym>@depth@100ms) and buffer its events,
// fetch a REST snapshot (5000 levels per side), drop buffered events older than the snapshot, then apply every event in
// order. A gap in the update ids → resync from a new snapshot. A Columnizer samples the book every 250 ms into columns for
// the DomHeatmap (heat columns only start once the book is synced).

import { DomHeatmap, Columnizer } from '../src/index.js';

const SYMBOLS = { BTCUSDT: 5, ETHUSDT: 0.5, SOLUSDT: 0.02 };   // symbol → bucket (price units)
const ROWS = 220;                                               // ±buckets per column (the REST snapshot reaches about ±1.3 %)
const status = document.getElementById('status'), sel = document.getElementById('sym'), canvas = document.getElementById('heat');
for (const s of Object.keys(SYMBOLS)) sel.add(new Option(s.replace('USDT', ' / USDT'), s));

let feed = null, chart = null, cz = null;

/** Local copy of one Binance order book (bids / asks: Map price → size). */
class BinanceBook {
  constructor(sym, onState) {
    this.sym = sym; this.onState = onState; this.bids = new Map(); this.asks = new Map();
    this.buf = []; this.last = 0; this.synced = false; this.closed = false; this._open();
  }
  _open() {
    this.ws = new WebSocket(`wss://stream.binance.com:9443/ws/${this.sym.toLowerCase()}@depth@100ms`);
    this.ws.onmessage = (e) => this._onEvent(JSON.parse(e.data));
    this.ws.onopen = () => this._snapshot();
    this.ws.onclose = () => { if (!this.closed) { this.onState('reconnecting…'); this.synced = false; setTimeout(() => this._open(), 2000); } };
  }
  /** REST snapshot, then replay the buffered events that are newer. */
  async _snapshot() {
    this.synced = false; this.onState('loading snapshot…');
    try {
      const r = await fetch(`https://api.binance.com/api/v3/depth?symbol=${this.sym}&limit=5000`), d = await r.json();
      this.bids = new Map(d.bids.map(([p, q]) => [+p, +q])); this.asks = new Map(d.asks.map(([p, q]) => [+p, +q]));
      this.last = d.lastUpdateId;
      const pend = this.buf.filter((e) => e.u > this.last); this.buf = [];
      this.synced = true;
      for (const e of pend) this._apply(e);
      this.onState('live');
    } catch (err) { this.onState('snapshot failed, retrying…'); setTimeout(() => this._snapshot(), 3000); }
  }
  _onEvent(e) { if (!this.synced) { this.buf.push(e); return; } this._apply(e); }
  /** Applies one diff event (U = first, u = last update id); a gap in the ids → new snapshot. */
  _apply(e) {
    if (e.u <= this.last) return;
    if (e.U > this.last + 1) { this.synced = false; this.buf = [e]; this._snapshot(); return; }
    for (const [p, q] of e.b) { const x = +p, s = +q; if (s > 0) this.bids.set(x, s); else this.bids.delete(x); }
    for (const [p, q] of e.a) { const x = +p, s = +q; if (s > 0) this.asks.set(x, s); else this.asks.delete(x); }
    this.last = e.u;
  }
  close() { this.closed = true; this.ws.close(); }
}

function start(sym) {
  feed?.close(); cz?.stop(); chart?.destroy();
  const bucket = SYMBOLS[sym];
  chart = new DomHeatmap(canvas, { bucket, colMs: 250, colW: 2, ppp: canvas.clientHeight / (bucket * ROWS * 1.2) });
  feed = new BinanceBook(sym, (s) => { status.textContent = s; });
  // one column every 250 ms, ±ROWS buckets around the mid price; a book that is not synced yet gives a gap column
  cz = new Columnizer(() => (feed.synced ? feed : null), { bucket, rows: ROWS, colMs: 250 }, (col) => chart.push(col)).start();
}
sel.onchange = () => start(sel.value);
start(sel.value);
