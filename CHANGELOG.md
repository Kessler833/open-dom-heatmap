# Changelog

## 0.2.0

- `DomHeatmap`: ready-made canvas chart — zoom (wheel / Shift + wheel), pan (drag), follow the live edge (double-click),
  incremental scroll for new columns, vertical move without recomputing, HiDPI, optional mid-price line, custom overlays.
- `bookToColumn`, `bookToBuckets`, `bestPrices`, `Columnizer`: from an order book (Map, `[price, size]` pairs or object) to
  heatmap columns; bids round down, asks up; a live book sampled every `colMs` with an optional spike filter.
- Live demo with the Binance spot order book (public data, no API key): `demo/live.html`.
- TypeScript declarations (`src/index.d.ts`), `llms-full.txt` for AI agents, CI (GitHub Actions, Node 18 / 20 / 22).

## 0.1.0

- First release: `StableProcessor`, parallel backfill (`processHistory`), `HeatRenderer`, demo, tests, benchmark.
