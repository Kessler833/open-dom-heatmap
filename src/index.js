// open-dom-heatmap — public entry point.
export { StableProcessor, DEFAULTS, STALE, lnBackground } from './processor.js';
export { processHistory, processSequential, processChunk, planChunks, WARM, PAR_MIN } from './backfill.js';
export { HeatRenderer, buildPalette, CLASSIC, XCAP } from './render.js';
export { bookToColumn, bookToBuckets, bestPrices, Columnizer } from './book.js';
export { DomHeatmap } from './chart.js';
