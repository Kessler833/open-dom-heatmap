// Type declarations for open-dom-heatmap (the library itself is plain JavaScript, ES modules).

/** Colour settings of StableProcessor (all optional; see DEFAULTS). */
export interface Settings {
  /** Percent of levels (vs. their surroundings) that stay in the base tone. Default 35. */
  lowCut?: number;
  /** Percent above which levels get the hottest colour. Default 99. */
  highCut?: number;
  /** 1 = compare with direct neighbours, 0 = with the wide area. Default 0.5. */
  local?: number;
  /** Time smoothing of the sizes in seconds. Default 0.5. */
  smooth?: number;
  /** Base tone for empty / small levels inside the book, 0 … 0.25. Default 0.07. */
  base?: number;
  /** Persistence in seconds (levels fade out instead of vanishing). Default 1.5. */
  hold?: number;
  /** Gamma of the colour curve. Default 1. */
  contrast?: number;
  /** Far-depth blend width (share of each half of the detailed window). Default 0.3. */
  edge?: number;
  /** Far-depth blend shape. Default 'log'. */
  edgeCurve?: 'log' | 'lin' | 'smooth' | 'exp';
  /** Far-depth blend strength 0 … 1 (darkening counts twice). Default 0.5. */
  edgeStr?: number;
}
export const DEFAULTS: Readonly<Required<Settings>>;

/** Coarse whole-book depth: bucket j = price (base + j) × g. Keep g constant over time. */
export interface FarDepth { g: number; base: number; v: Float32Array; }

/** One time column of the book. v[i] = summed resting size (bids + asks) at bucket kb + i; v null / empty = gap column. */
export interface Column {
  /** Increasing column number; a jump means missing columns. */
  seq: number;
  /** Bucket index of v[0] (price = (kb + i) × bucket). */
  kb?: number;
  v?: Float32Array | null;
  /** Optional sizes for the background instead of v (e.g. before your own level aggregation). */
  raw?: Float32Array;
  far?: FarDepth;
  /** Optional mid price (DomHeatmap draws it as a line). */
  mid?: number;
}

/** Colour steps of one column: h[i] (0 … 255) for bucket kb + i, far[j] for far bucket j. */
export interface ColumnResult { kb: number; h: Uint8Array; far: Uint8Array | null; }

/** Per-processor options: bucket = price width of one bucket (needed with far depth), colMs = column length in ms. */
export interface ProcessorOptions { bucket?: number; colMs?: number; }

/** Colours columns one by one (causal); keeps per-bucket state between columns. */
export class StableProcessor {
  constructor(settings?: Settings, opt?: ProcessorOptions);
  /** Processes the next column (seq must increase). */
  process(col: Column): ColumnResult;
  /** Forgets all state. */
  reset(): void;
  /** Skips the fade-in (for a processor that starts in the middle of a history). */
  noFadeIn(): void;
}
/** Per-bucket state older than this many columns is forgotten (bounded memory). */
export const STALE: number;
/** ln of the local × wide geometric-mean background of the non-empty values of v (NaN where a window has no data). */
export function lnBackground(v: ArrayLike<number>, w: number, ww: number, local: number): Float32Array;

/** Warm-up columns per parallel chunk; histories shorter than PAR_MIN are processed sequentially. */
export const WARM: number;
export const PAR_MIN: number;
/** Colours a whole history, in parallel web workers where available. `processor` continues after the last column. */
export function processHistory(cols: Column[], settings?: Settings, opt?: ProcessorOptions, par?: { workers?: number; warm?: number }):
  Promise<{ results: ColumnResult[]; processor: StableProcessor }>;
/** Colours all columns with one sequential chain. */
export function processSequential(settings: Settings, opt: ProcessorOptions, cols: Column[]): ColumnResult[];
/** Colours cols[warm …] after a warm-up over cols[0 … warm). */
export function processChunk(settings: Settings, opt: ProcessorOptions, cols: Column[], warm: number, first: boolean): ColumnResult[];
/** Chunk plan: output range [a, b), warm-up from w0. */
export function planChunks(n: number, nWorkers: number, warm?: number): { a: number; b: number; w0: number }[];

/** Renderer view: which columns and which price range are drawn into a width × height buffer. */
export interface View {
  width: number; height: number;
  cols: Column[]; res: ColumnResult[];
  /** Index of the column at the right edge, and the x (px) of that column's right edge. */
  endIndex: number; xEnd: number;
  /** Pixels per column (< 1 = several columns per pixel). */
  colW: number;
  /** Price at y = 0 and at y = height. */
  priceTop: number; priceBottom: number;
  bucket: number;
}
/** Draws processed columns into a Uint32Array (ImageData) with volume dominance; { shift } = incremental scroll by whole px. */
export class HeatRenderer {
  constructor(opt?: { palette?: Uint32Array });
  lut: Uint32Array;
  render(buf: Uint32Array, view: View, opt?: { shift?: number }): void;
}
/** At most this many columns are read per pixel column. */
export const XCAP: number;
/** Palette stops [position 0 … 1, r, g, b]. */
export type PaletteStops = [number, number, number, number][];
export const CLASSIC: PaletteStops;
/** 256-entry colour table (0xAABBGGRR) for the colour steps. */
export function buildPalette(stops?: PaletteStops, gamma?: number): Uint32Array;

/** Order-book side: Map price → size, [price, size] pairs (numbers or strings) or { price: size }. */
export type BookSide = Map<number, number> | Array<[number | string, number | string]> | Record<string, number | string>;
/** Best bid / ask (NaN when a side is empty). */
export function bestPrices(bids: BookSide, asks: BookSide): { bid: number; ask: number };
/** Resting size per bucket kLo … kHi; bids round down, asks round up. */
export function bookToBuckets(bids: BookSide, asks: BookSide, o: { bucket: number; kLo: number; kHi: number }): { kb: number; v: Float32Array };
/** One column from a book: ±rows buckets around the mid price (or explicit kLo / kHi), optionally with far depth. */
export function bookToColumn(bids: BookSide, asks: BookSide,
  o: { seq: number; bucket: number; rows?: number; kLo?: number; kHi?: number; far?: { g: number; lo: number; hi: number } }): Column & { mid: number };
/** Samples a live book into evenly spaced columns (with an optional spike filter). */
export class Columnizer {
  constructor(getBook: () => { bids: BookSide; asks: BookSide } | null | undefined,
    o: { bucket: number; rows?: number; colMs?: number; spikeFilter?: boolean; far?: { g: number; lo: number; hi: number } },
    onColumn: (col: Column) => void);
  sample(now?: number): Column;
  start(): this;
  stop(): void;
}

/** Options of the ready-made canvas chart. */
export interface DomHeatmapOptions {
  bucket: number;
  colMs?: number;
  settings?: Settings;
  palette?: Uint32Array;
  /** Pixels per price unit (default: fit ±100 buckets) and pixels per column (default 1). */
  ppp?: number; colW?: number;
  /** Free space right of the live edge, px. Default 40. */
  rightPad?: number;
  /** Columns kept (oldest dropped). Default 20000. */
  maxColumns?: number;
  /** Draw col.mid as a line: true or a CSS colour. Default true. */
  midLine?: boolean | string;
  background?: string;
  /** Worker pool size for recolouring (0 = no workers). */
  workers?: number;
  /** Custom overlay, called after the heat image with a CSS-pixel transform. */
  onDraw?: (ctx: CanvasRenderingContext2D, chart: DomHeatmap) => void;
}
/** Ready-made canvas chart: zoom, pan, follow, incremental scroll, HiDPI. */
export class DomHeatmap {
  constructor(canvas: HTMLCanvasElement, opt: DomHeatmapOptions);
  cols: Column[]; res: ColumnResult[];
  /** Pixels per price unit, pixels per column, price at the vertical centre, following the live edge. */
  ppp: number; colW: number; center: number; follow: boolean;
  setHistory(cols: Column[]): Promise<void>;
  push(col: Column): void;
  setSettings(settings: Settings): Promise<void>;
  setPalette(lut: Uint32Array): void;
  draw(): void;
  destroy(): void;
  yOfPrice(p: number): number; priceOfY(y: number): number;
  xOfIndex(i: number): number; indexOfX(x: number): number;
  readonly end: number; readonly xEnd: number; readonly width: number; readonly height: number;
}
