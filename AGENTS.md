# AGENTS.md

Instructions for AI coding agents using or changing open-dom-heatmap.

## What it is

A zero-dependency ES module library for order-book (DOM / liquidity) heatmaps:

- `DomHeatmap` — ready-made canvas chart (zoom, pan, follow, incremental scroll, HiDPI).
- `Columnizer`, `bookToColumn` — from an order book to heatmap columns.
- `StableProcessor`, `processHistory` — the colouring (live and parallel history backfill).
- `HeatRenderer` — low-level drawing into an ImageData buffer.

Full API with types: `src/index.d.ts`. Everything in one file: `llms-full.txt`.

## Install

No npm release yet. Clone or vendor the `src/` folder:

```bash
git clone https://github.com/Kessler833/open-dom-heatmap.git
```

Import from `src/index.js` (ES modules; Node ≥ 18 or any modern browser). Serve `src/worker.js` next to `src/backfill.js`
(module workers; the library falls back to the calling thread when `Worker` is missing).

## Use (most common case: a live chart)

1. Keep an order book up to date (Map price → size per side, or `[price, size]` pairs as exchanges send them).
2. `const chart = new DomHeatmap(canvas, { bucket, colMs: 250 });` — `bucket` = price width of one row (e.g. 5 for BTC,
   0.5 for ETH, 0.02 for SOL).
3. `new Columnizer(() => ({ bids, asks }), { bucket, rows: 200, colMs: 250 }, (col) => chart.push(col)).start();`
4. Optional history: `await chart.setHistory(columns)` with columns `{ seq, kb, v }` (see README "Input format").
5. Settings: `await chart.setSettings({ lowCut, highCut, ... })` (see `DEFAULTS`).

A complete live example with the Binance depth stream: `demo/live.js`.

## Verify changes

```bash
npm test          # node --test: determinism, parallel = sequential, bounded memory, renderer, book helpers
npm run bench     # processing / backfill / render timings
npm run llms      # regenerate llms-full.txt after changing README.md, AGENTS.md or src/index.d.ts
```

Keep the tests green, keep a comment on every non-obvious line, keep zero dependencies.
