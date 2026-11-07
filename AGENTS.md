# AGENTS.md

Instructions for AI coding agents using or changing this library.

## What it is

A zero-dependency ES module library that turns order-book sizes per price bucket and time column into colour steps
0…255 (`StableProcessor`), colours long histories in parallel (`processHistory`) and draws them into a 32-bit pixel buffer
(`HeatRenderer`).

## Install

No package registry release yet. Copy or vendor the `src/` folder, or:

```bash
git clone https://github.com/Kessler833/open-dom-heatmap.git
```

Import from `src/index.js`. Requires ES modules (Node ≥ 18 or any modern browser). `processHistory` uses module workers
when `Worker` exists; `src/worker.js` must then be served next to `src/backfill.js`.

## Use

1. Build one column per time step: `{ seq, kb, v: Float32Array }` (`v[i]` = summed resting size at bucket `kb + i`).
2. Live: `const p = new StableProcessor(cfg, { bucket, colMs }); const { h } = p.process(col);`
3. History: `const { results, processor } = await processHistory(cols, cfg, { bucket, colMs });` then keep calling
   `processor.process(col)` for new columns.
4. Draw: `new HeatRenderer().render(uint32Buffer, view)` (view fields are documented in `src/render.js`); for a new column
   pass `{ shift: wholePixels }` to scroll instead of redrawing.

## Verify changes

```bash
npm test
npm run bench
```

Tests check determinism, that parallel chunks reproduce the sequential chain, bounded memory, volume-dominance rendering
and that incremental scrolling equals a full redraw. Keep them green; keep comments on every non-obvious line.
