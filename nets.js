/* NT-Sense helper: holds some of the networks and runs them, so the networks are shared over
   several processor cores (a phone has 4 to 8). worker.js starts up to 4 of these. */
importScripts("engine.js");
const E = self.NTEngine;
const nets = {};                       // "final:3" -> network
let xkey = null, xs = null, zc = {};   // the current ECG windows and the encoder cache ("What if?")

self.onmessage = (ev) => {
  const m = ev.data;
  try {
    if (m.op === "load") {
      nets[m.name + ":" + m.idx] = E.unpackNet(m.buf, m.nTab, m.dtype);
      self.postMessage({id: m.id, ok: true});
    } else if (m.op === "run") {
      if (m.xkey !== xkey) { xkey = m.xkey; xs = m.xs; zc = {}; }   // same ECG: keep the same arrays, so the cache hits
      const ys = {}, sal = m.wantSal ? new Float64Array(12 * E.N_OUT) : null;
      for (const idx of m.idxs) {
        const k = m.name + ":" + idx, net = nets[k], row = [];
        if (!net) throw new Error("network " + k + " is not loaded");
        const cache = zc[k] || (zc[k] = new Map());
        for (const x of xs) {
          const r = E.netRun(net, x, m.tab, m.mode, m.wantSal, cache);
          row.push(r.y);
          if (sal) for (let i = 0; i < sal.length; i++) sal[i] += r.grad[i] * x[i];
        }
        ys[idx] = row;
        self.postMessage({tick: 1});
      }
      self.postMessage({id: m.id, ok: true, ys, sal}, sal ? [sal.buffer] : []);
    }
  } catch (e) {
    self.postMessage({id: m.id, ok: false, error: e && e.message ? e.message : String(e)});
  }
};
