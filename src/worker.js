// Module worker for processHistory() (backfill.js): colours one chunk and sends the results back packed into a few
// transferable arrays (no copy on the way back).
// In:  { id, cfg, opt, warm, first, cols }
// Out: { id, kb: Int32Array, hn: Int32Array (h length per column), fn: Int32Array (far length, −1 = none),
//        h: Uint8Array (all h concatenated), f: Uint8Array (all far concatenated) }

import { processChunk } from './backfill.js';

self.onmessage = ({ data }) => {
  const { id, cfg, opt, warm, first, cols } = data;
  const list = processChunk(cfg, opt, cols, warm, first), n = list.length;
  const kb = new Int32Array(n), hn = new Int32Array(n), fn = new Int32Array(n);
  let hTot = 0, fTot = 0;
  for (let i = 0; i < n; i++) { const r = list[i]; kb[i] = r.kb; hn[i] = r.h.length; fn[i] = r.far ? r.far.length : -1; hTot += r.h.length; fTot += r.far ? r.far.length : 0; }
  const h = new Uint8Array(hTot), f = new Uint8Array(fTot);
  for (let i = 0, ph = 0, pf = 0; i < n; i++) {
    h.set(list[i].h, ph); ph += list[i].h.length;
    if (list[i].far) { f.set(list[i].far, pf); pf += list[i].far.length; }
  }
  self.postMessage({ id, kb, hn, fn, h, f }, [kb.buffer, hn.buffer, fn.buffer, h.buffer, f.buffer]);
};
