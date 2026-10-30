/* NT-Sense browser engine.
 * A line-by-line JavaScript port of the Python program (step14 preprocess, step18 backend,
 * step19 quality check), so the website can run with no server: every ECG stays in the
 * visitor's browser. Works in a Web Worker (worker.js) and in Node (for the parity tests).
 */
(function (root) {
"use strict";

const LEADS = ["I", "II", "III", "aVR", "aVL", "aVF", "V1", "V2", "V3", "V4", "V5", "V6"];
const LEAD_II = 1, FS_OUT = 125, N_OUT = 1250;
const LOG300 = Math.log10(300);
const DISCLAIMER = "Research prototype. Estimates NT-proBNP; does not measure it. " +
                   "Confirm with a laboratory test. Not for clinical decisions.";
const MODE_NAME = {0: "12-lead", 1: "monitor"};
const MAX_WINDOWS_WEB = 8;          // the laptop program reads up to 30; a browser reads 8

// name -> [lowest, highest, unit, hint]   (same as step18 INPUTS)
const INPUTS = {
  creatinine: [0.1, 20, "mg/dL", "If your lab reports micromol/L, divide by 88.4."],
  hemoglobin: [3, 25, "g/dL", "If your lab reports g/L, divide by 10."],
  bmi: [10, 80, "kg/m2", "BMI = weight (kg) / height (m) squared."],
  bun: [1, 250, "mg/dL", "If your lab reports urea in mmol/L, multiply by 2.8."],
  sodium: [100, 180, "mmol/L", ""],
  potassium: [1.5, 10, "mmol/L", ""],
  bicarbonate: [5, 50, "mmol/L", ""],
  albumin: [1, 6, "g/dL", "If your lab reports g/L, divide by 10."],
  glucose: [20, 1500, "mg/dL", "If your lab reports mmol/L, multiply by 18."],
  troponin_t: [0, 30, "ng/mL", "If your lab reports ng/L (high-sensitivity), divide by 1000."],
  wbc: [0.1, 200, "x10^3/uL", ""],
  platelets: [5, 1500, "x10^3/uL", ""],
  rdw: [9, 35, "%", ""],
  calcium: [4, 15, "mg/dL", "If your lab reports mmol/L, multiply by 4."],
  magnesium: [0.5, 5, "mg/dL", "If your lab reports mmol/L, multiply by 2.43."],
  inr: [0.5, 15, "", ""],
  anion_gap: [0, 50, "mmol/L", ""],
  prior_ntprobnp: [5, 70000, "pg/mL", ""],
  prior_ntprobnp_days: [0.04, 3650, "days", ""],
  n_prior_ntprobnp: [1, 100, "tests", ""],
  prior_admissions: [0, 200, "admissions", ""],
  prior_hf: [0, 1, "", "Use 1 for yes, 0 for no."],
  prior_ckd: [0, 1, "", "Use 1 for yes, 0 for no."],
};
const LABS = ["creatinine", "hemoglobin", "bmi"];
// step33 NEW_LABS: name -> [log10?, low clip, high clip]
const NEW_LABS = {bun: [true, 1, 250], sodium: [false, 110, 170], potassium: [false, 1.5, 9],
  bicarbonate: [false, 5, 50], albumin: [false, 1, 6], glucose: [true, 20, 1500],
  troponin_t: [true, 0.005, 30], wbc: [true, 0.1, 200], platelets: [true, 5, 1500],
  rdw: [false, 9, 35], calcium: [false, 4, 15], magnesium: [false, 0.5, 5], inr: [true, 0.5, 15],
  anion_gap: [false, 0, 50]};

// ---------------------------------------------------------------- small helpers
const clip = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const isNum = v => typeof v === "number" && Number.isFinite(v);
function pyRound(x, nd) {            // Python round(): half to even at exact ties
  if (nd === undefined) {
    const f = Math.floor(x), d = x - f;
    if (d > 0.5) return f + 1; if (d < 0.5) return f;
    return f % 2 === 0 ? f : f + 1;
  }
  return Number(x.toFixed(nd));
}
const mean = a => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s / a.length; };
function median(a) {
  const s = Array.from(a).sort((x, y) => x - y), n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}
function stdPop(a) { const m = mean(a); let s = 0; for (const v of a) s += (v - m) * (v - m); return Math.sqrt(s / a.length); }
class UserError extends Error {}

// ---------------------------------------------------------------- reading files
/** WFDB format-16 reader (step14 read_wfdb_16). Returns {cols: [Float64Array per signal], fs, names}. */
function readWfdb16(heaText, datBuf) {
  const lines = heaText.split(/\r?\n/).filter(l => l.trim() && !l.startsWith("#"));
  const head = lines[0].trim().split(/\s+/);
  const nSig = parseInt(head[1], 10), fs = parseFloat(head[2].split("/")[0]), n = parseInt(head[3], 10);
  const gains = [], bases = [], names = [], fmts = new Set();
  for (const l of lines.slice(1, 1 + nSig)) {
    const f = l.trim().split(/\s+/);
    fmts.add(f[1]);
    const g = /^([-\d.eE+]+)(?:\(([-\d]+)\))?/.exec(f[2]);
    const gain = g ? parseFloat(g[1]) : 200.0;
    gains.push(gain !== 0 ? gain : 200.0);
    const adcZero = f.length > 4 ? parseInt(f[4], 10) : 0;
    bases.push(g && g[2] ? parseInt(g[2], 10) : adcZero);
    names.push(f[f.length - 1]);
  }
  if (fmts.size !== 1 || !fmts.has("16")) throw new UserError(`unsupported format {${[...fmts].map(s => `'${s}'`).join(", ")}}`);
  const all = new Int16Array(datBuf, 0, Math.floor(datBuf.byteLength / 2));
  const rows = Math.min(Math.floor(all.length / nSig), n);
  const cols = [];
  for (let c = 0; c < nSig; c++) {
    const out = new Float64Array(rows);
    for (let r = 0; r < rows; r++) {
      const raw = all[r * nSig + c];
      out[r] = raw === -32768 ? NaN : (Math.fround(raw) - bases[c]) / gains[c];
    }
    cols.push(out);
  }
  return {cols, fs, names};
}

/** pandas read_csv(header=None).iloc[:,0] + to_numeric(errors="coerce"). */
function readCsvColumn(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (line === "") continue;
    let cell = line.split(",")[0].trim().replace(/^"(.*)"$/, "$1");
    const v = cell === "" ? NaN : Number(cell);
    out.push(Number.isFinite(v) ? v : NaN);
  }
  return Float64Array.from(out);
}

// ---------------------------------------------------------------- filters (scipy, exactly)
function filtersFor(F, fs) {
  const key = String(Math.round(fs));
  if (Math.abs(fs - Math.round(fs)) > 1e-9 || !F[key])
    throw new UserError(`sampling rate ${fs} Hz is not supported in the online version (use one of ${Object.keys(F).join(", ")} Hz)`);
  return F[key];
}
function sosfilt(sos, x, zi0, scale) {
  const ns = sos.length, z = sos.map((s, i) => [zi0[i][0] * scale, zi0[i][1] * scale]);
  const y = new Float64Array(x.length);
  for (let n = 0; n < x.length; n++) {
    let v = x[n];
    for (let s = 0; s < ns; s++) {
      const [b0, b1, b2, , a1, a2] = sos[s], zs = z[s];
      const out = b0 * v + zs[0];
      zs[0] = b1 * v - a1 * out + zs[1];
      zs[1] = b2 * v - a2 * out;
      v = out;
    }
    y[n] = v;
  }
  return y;
}
/** scipy.signal.sosfiltfilt(sos, x) with the default odd padding. */
function sosfiltfilt(f, x) {
  const n = x.length, e = f.edge;
  if (n <= e) throw new UserError(`The length of the input vector x must be greater than padlen, which is ${e}.`);
  const ext = new Float64Array(n + 2 * e);
  for (let i = 0; i < e; i++) ext[i] = 2 * x[0] - x[e - i];
  ext.set(x, e);
  for (let i = 0; i < e; i++) ext[n + e + i] = 2 * x[n - 1] - x[n - 2 - i];
  let y = sosfilt(f.sos, ext, f.zi, ext[0]);
  y.reverse();
  y = sosfilt(f.sos, y, f.zi, y[0]);
  y.reverse();
  return y.subarray(e, e + n);
}
/** scipy.signal.resample_poly(x, 125, fs) with the default Kaiser window. */
function resamplePoly(rs, x) {
  if (!rs) return Float64Array.from(x);
  const {up, down, h, pre_remove} = rs, nIn = x.length, H = h.length;
  const nOut = Math.floor(nIn * up / down) + ((nIn * up) % down ? 1 : 0);
  const y = new Float64Array(nOut);
  for (let m = 0; m < nOut; m++) {
    const n = (m + pre_remove) * down;
    let i0 = Math.max(0, Math.ceil((n - H + 1) / up)), i1 = Math.min(nIn - 1, Math.floor(n / up));
    let s = 0;
    for (let i = i0; i <= i1; i++) s += x[i] * h[n - i * up];
    y[m] = s;
  }
  return y;
}
function interpNan(x) {
  const good = [], bad = [];
  for (let i = 0; i < x.length; i++) (Number.isNaN(x[i]) ? bad : good).push(i);
  if (!good.length) return null;
  if (!bad.length) return x;
  const y = Float64Array.from(x);
  let g = 0;
  for (const i of bad) {                   // np.interp: constant beyond the ends
    while (g < good.length - 1 && good[g + 1] < i) g++;
    if (i < good[0]) y[i] = x[good[0]];
    else if (i > good[good.length - 1]) y[i] = x[good[good.length - 1]];
    else { const a = good[g], b = good[g + 1]; y[i] = x[a] + (x[b] - x[a]) * (i - a) / (b - a); }
  }
  return y;
}
/** step14 preprocess(): -> Float32Array(12 * 1250), standard lead order, mV. */
function preprocess(F, cols, fs, names) {
  const f = filtersFor(F, fs);
  const out = new Float32Array(12 * N_OUT);
  const lookup = {};
  names.forEach((nm, i) => { lookup[nm.toUpperCase()] = i; });
  LEADS.forEach((lead, k) => {
    const i = lookup[lead.toUpperCase()];
    if (i === undefined) return;
    const x = interpNan(cols[i]);
    if (!x) return;
    const y = resamplePoly(f.resample, sosfiltfilt(f, x));
    for (let t = 0; t < N_OUT; t++) out[k * N_OUT + t] = t < y.length ? clip(y[t], -5, 5) : 0;
  });
  return out;
}

// ---------------------------------------------------------------- signal quality (step19)
const QUALITY_METHOD = "Checked on the raw signal before cleaning: missing or flat leads, gaps, clipping, " +
  "strong baseline wander (over 80% of the power below 1 Hz), electrical or muscle noise (power above 40 Hz) " +
  "and whether clear heartbeats are visible (kurtosis). Based on Li, Mark & Clifford " +
  "2008 and Behar et al. 2013.";
/** scipy.signal.welch(x, fs, nperseg) with the defaults (Hann, 50% overlap, constant detrend, density). */
function welch(x, fs, nper) {
  const step = nper - Math.floor(nper / 2), nseg = Math.floor((x.length - nper) / step) + 1;
  const win = new Float64Array(nper);
  for (let i = 0; i < nper; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / nper);
  let w2 = 0; for (const w of win) w2 += w * w;
  const nf = Math.floor(nper / 2) + 1, P = new Float64Array(nf);
  const cosT = new Float64Array(nper), sinT = new Float64Array(nper);
  for (let i = 0; i < nper; i++) { cosT[i] = Math.cos(2 * Math.PI * i / nper); sinT[i] = Math.sin(2 * Math.PI * i / nper); }
  const seg = new Float64Array(nper);
  for (let s = 0; s < nseg; s++) {
    let m = 0;
    for (let i = 0; i < nper; i++) m += x[s * step + i];
    m /= nper;
    for (let i = 0; i < nper; i++) seg[i] = (x[s * step + i] - m) * win[i];
    for (let k = 0; k < nf; k++) {
      let re = 0, im = 0, idx = 0;
      for (let i = 0; i < nper; i++) { re += seg[i] * cosT[idx]; im -= seg[i] * sinT[idx]; idx += k; if (idx >= nper) idx -= nper; }
      P[k] += re * re + im * im;
    }
  }
  const scale = 1 / (fs * w2);
  for (let k = 0; k < nf; k++) {
    P[k] = P[k] / nseg * scale;
    if (k > 0 && !(nper % 2 === 0 && k === nf - 1)) P[k] *= 2;
  }
  const freqs = new Float64Array(nf);
  for (let k = 0; k < nf; k++) freqs[k] = k * fs / nper;
  return [freqs, P];
}
function leadIssues(F, x, fs) {
  if (!x || x.every(Number.isNaN)) return ["missing"];
  const out = [];
  let nan = 0; for (const v of x) if (Number.isNaN(v)) nan++;
  if (nan / x.length > 0.05) out.push("gaps in the recording");
  x = Float64Array.from(Array.from(x).filter(v => !Number.isNaN(v)));
  if (x.length < 2 * fs) return out.concat(["too short"]);
  let mx = -Infinity, mn = Infinity; for (const v of x) { if (v > mx) mx = v; if (v < mn) mn = v; }
  if (stdPop(x) < 0.02 || mx - mn < 0.1) return out.concat(["flat (no signal)"]);
  let cMax = 0, cMin = 0; for (const v of x) { if (v === mx) cMax++; if (v === mn) cMin++; }
  if ((cMax + cMin) / x.length > 0.01) out.push("clipped (signal too large)");
  const m = mean(x), xc = x.map(v => v - m);
  const [f, pw] = welch(xc, fs, Math.min(x.length, Math.trunc(4 * fs)));
  const top = Math.min(150.0, fs / 2);
  const sum = (lo, hi, loInc) => { let s = 0; for (let k = 0; k < f.length; k++) if ((loInc ? f[k] >= lo : f[k] > lo) && f[k] <= hi) s += pw[k]; return s; };
  const tot = sum(0, 40, false) + 1e-12;
  if (sum(1, 40, true) / tot < 0.2) out.push("baseline wander");
  if (fs >= 200) {
    const hf = sum(40, top, false) / (sum(0.5, top, true) + 1e-12);
    if (hf > 0.5) out.push("electrical or muscle noise");
  }
  const y = sosfiltfilt(filtersFor(F, fs), x), my = mean(y);
  let m2 = 0, m4 = 0; for (const v of y) { const d = (v - my) * (v - my); m2 += d; m4 += d * d; }
  m2 /= y.length; m4 /= y.length;
  if (m4 / (m2 * m2) < 3.5) out.push("no clear heartbeats");
  return out;
}
function quality12(F, cols, fs, names) {
  const look = {}; names.forEach((n, i) => { look[n.toUpperCase()] = i; });
  const leads = {};
  for (const name of LEADS) { const i = look[name.toUpperCase()]; leads[name] = leadIssues(F, i === undefined ? null : cols[i], fs); }
  const bad = LEADS.filter(n => leads[n].length);
  const missing = LEADS.filter(n => leads[n].includes("missing") || leads[n].includes("flat (no signal)"));
  const status = !bad.length ? "good" : (bad.length >= 3 || missing.length >= 2 ? "poor" : "check");
  let summary;
  if (!bad.length) summary = "All 12 leads look clean.";
  else {
    summary = `${bad.length} of 12 leads ${bad.length > 1 ? "have" : "has"} a problem: ` +
      bad.slice(0, 5).map(n => `${n} (${leads[n].join(", ")})`).join("; ") + (bad.length > 5 ? "; ..." : "") + ".";
    if (missing.length) summary += " The model sees a missing or flat lead as a straight line.";
  }
  return {status, summary, leads, method: QUALITY_METHOD};
}
function qualityMonitor(F, lead2, fs) {
  const L = Math.round(10 * fs), wins = [];
  for (let s = 0; s + L <= lead2.length && wins.length < 60; s += L) wins.push(leadIssues(F, lead2.subarray(s, s + L), fs));
  const clean = wins.filter(w => !w.length).length, counts = {};
  for (const w of wins) for (const k of w) counts[k] = (counts[k] || 0) + 1;
  const share = clean / Math.max(wins.length, 1);
  const status = share >= 0.8 ? "good" : (share >= 0.5 ? "check" : "poor");
  let summary = `${clean} of ${wins.length} ten-second window${wins.length !== 1 ? "s" : ""} look clean.`;
  const ks = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (ks.length) summary += " Problems seen: " + ks.map(([k, v]) => `${k} (${v})`).join("; ") + ".";
  return {status, summary, windows_total: wins.length, windows_clean: clean, problems: counts, method: QUALITY_METHOD};
}

// ---------------------------------------------------------------- the network (step15 ECGNet, BatchNorm folded)
// layer list per network (same order the export script writes the weights):
//   stem conv 12->32 k15 s2 p7 + relu
//   4 blocks: convA (k7, stride s, p3) relu, convB (k7, s1, p3), skip (1x1 stride s) or identity, add, relu
//   head: Linear(128+n_tab+1 -> 64) relu, Linear(64 -> 1)
const ARCH = {stem: [12, 32, 15, 2, 7], blocks: [[32, 32, 1], [32, 64, 2], [64, 128, 2], [128, 128, 2]]};
function unpackNet(buf, nTab) {
  const f = new Float32Array(buf); let p = 0;
  const take = n => { const a = f.subarray(p, p + n); p += n; return a; };
  const conv = (cin, cout, k, s, pad) => ({cin, cout, k, s, pad, w: take(cout * cin * k), b: take(cout)});
  const [ci, co, k, s, pad] = ARCH.stem;
  const net = {stem: conv(ci, co, k, s, pad), blocks: [], nTab};
  for (const [a, b, st] of ARCH.blocks) {
    const blk = {A: conv(a, b, 7, st, 3), B: conv(b, b, 7, 1, 3), skip: null};
    if (!(st === 1 && a === b)) blk.skip = conv(a, b, 1, st, 0);
    net.blocks.push(blk);
  }
  const nin = 128 + nTab + 1;
  net.W1 = take(64 * nin); net.b1 = take(64); net.W2 = take(64); net.b2 = take(1);
  if (p !== f.length) throw new Error(`weight file has ${f.length} numbers, expected ${p}`);
  return net;
}
function convFwd(c, inp, L) {
  const Lo = Math.floor((L + 2 * c.pad - c.k) / c.s) + 1, out = new Float64Array(c.cout * Lo);
  for (let co = 0; co < c.cout; co++) {
    const ob = co * Lo, bv = c.b[co];
    for (let o = 0; o < Lo; o++) out[ob + o] = bv;
    for (let ci = 0; ci < c.cin; ci++) {
      const ib = ci * L, wb = (co * c.cin + ci) * c.k;
      for (let t = 0; t < c.k; t++) {
        const wv = c.w[wb + t];
        if (wv === 0) continue;
        const o0 = Math.max(0, Math.ceil((c.pad - t) / c.s)), o1 = Math.min(Lo - 1, Math.floor((L - 1 + c.pad - t) / c.s));
        let i = ib + o0 * c.s - c.pad + t;
        for (let o = o0; o <= o1; o++, i += c.s) out[ob + o] += wv * inp[i];
      }
    }
  }
  return [out, Lo];
}
function convBwd(c, gout, Lo, L) {               // gradient w.r.t. the conv input
  const gin = new Float64Array(c.cin * L);
  for (let co = 0; co < c.cout; co++) {
    const ob = co * Lo;
    for (let ci = 0; ci < c.cin; ci++) {
      const ib = ci * L, wb = (co * c.cin + ci) * c.k;
      for (let t = 0; t < c.k; t++) {
        const wv = c.w[wb + t];
        if (wv === 0) continue;
        const o0 = Math.max(0, Math.ceil((c.pad - t) / c.s)), o1 = Math.min(Lo - 1, Math.floor((L - 1 + c.pad - t) / c.s));
        let i = ib + o0 * c.s - c.pad + t;
        for (let o = o0; o <= o1; o++, i += c.s) gin[i] += wv * gout[ob + o];
      }
    }
  }
  return gin;
}
const relu = a => { for (let i = 0; i < a.length; i++) if (a[i] < 0) a[i] = 0; return a; };
/** One forward pass (+ optional gradient of the output w.r.t. the input). x: Float32Array(12*1250) already masked. */
function headOnly(net, z, tab, mode) {
  const C = 128, nin = C + net.nTab + 1, feat = new Float64Array(nin);
  feat.set(z); for (let i = 0; i < net.nTab; i++) feat[C + i] = tab[i]; feat[nin - 1] = mode;
  let y = net.b2[0];
  for (let j = 0; j < 64; j++) { let s = net.b1[j]; for (let i = 0; i < nin; i++) s += net.W1[j * nin + i] * feat[i]; if (s > 0) y += net.W2[j] * s; }
  return y;
}
function netRun(net, x, tab, mode, wantGrad, zc) {
  if (!wantGrad && zc && zc.has(x)) return {y: headOnly(net, zc.get(x), tab, mode)};
  let L = N_OUT;
  let [h, Lh] = convFwd(net.stem, x, L);
  const stemPre = Float64Array.from(h); relu(h);
  const cache = [];
  let cur = h, Lc = Lh;
  for (const blk of net.blocks) {
    const [a, La] = convFwd(blk.A, cur, Lc); const aPre = Float64Array.from(a); relu(a);
    const [m, Lm] = convFwd(blk.B, a, La);
    let sk;
    if (blk.skip) sk = convFwd(blk.skip, cur, Lc)[0]; else sk = cur;
    const pre = new Float64Array(m.length);
    for (let i = 0; i < m.length; i++) pre[i] = m[i] + sk[i];
    const out = Float64Array.from(pre); relu(out);
    cache.push({blk, inp: cur, Lin: Lc, aPre, La, pre, Lout: Lm});
    cur = out; Lc = Lm;
  }
  const C = 128, z = new Float64Array(C);
  for (let c = 0; c < C; c++) { let s = 0; for (let l = 0; l < Lc; l++) s += cur[c * Lc + l]; z[c] = s / Lc; }
  if (zc) zc.set(x, z);
  const nin = C + net.nTab + 1, feat = new Float64Array(nin);
  feat.set(z); for (let i = 0; i < net.nTab; i++) feat[C + i] = tab[i]; feat[nin - 1] = mode;
  const hid = new Float64Array(64);
  for (let j = 0; j < 64; j++) { let s = net.b1[j]; for (let i = 0; i < nin; i++) s += net.W1[j * nin + i] * feat[i]; hid[j] = s; }
  let y = net.b2[0];
  for (let j = 0; j < 64; j++) if (hid[j] > 0) y += net.W2[j] * hid[j];
  if (!wantGrad) return {y};
  // ---- backward
  const gz = new Float64Array(C);
  for (let j = 0; j < 64; j++) {
    if (!(hid[j] > 0)) continue;
    const g = net.W2[j];
    for (let c = 0; c < C; c++) gz[c] += g * net.W1[j * nin + c];
  }
  let g = new Float64Array(C * Lc);
  for (let c = 0; c < C; c++) for (let l = 0; l < Lc; l++) g[c * Lc + l] = gz[c] / Lc;
  for (let b = cache.length - 1; b >= 0; b--) {
    const k = cache[b], blk = k.blk;
    for (let i = 0; i < g.length; i++) if (!(k.pre[i] > 0)) g[i] = 0;
    let ga = convBwd(blk.B, g, k.Lout, k.La);
    for (let i = 0; i < ga.length; i++) if (!(k.aPre[i] > 0)) ga[i] = 0;
    const gin = convBwd(blk.A, ga, k.La, k.Lin);
    if (blk.skip) { const gs = convBwd(blk.skip, g, k.Lout, k.Lin); for (let i = 0; i < gin.length; i++) gin[i] += gs[i]; }
    else for (let i = 0; i < gin.length; i++) gin[i] += g[i];
    g = gin;
  }
  for (let i = 0; i < g.length; i++) if (!(stemPre[i] > 0)) g[i] = 0;
  const gx = convBwd(net.stem, g, Lh, L);
  return {y, grad: gx};
}
function applyMode(x, mode) {
  if (mode !== 1) return x;
  const y = new Float32Array(x.length);
  y.set(x.subarray(LEAD_II * N_OUT, (LEAD_II + 1) * N_OUT), LEAD_II * N_OUT);
  return y;
}

// ---------------------------------------------------------------- tabular inputs (step18)
function labTransform(name, v) {
  if (name === "creatinine") return Math.log10(clip(v, 0.2, 15));
  if (name === "hemoglobin") return clip(v, 3, 20);
  return clip(v, 10, 80);
}
function finalTransform(name, v) {
  if (LABS.includes(name)) return labTransform(name, v);
  if (NEW_LABS[name]) { const [lg, lo, hi] = NEW_LABS[name]; v = clip(v, lo, hi); return lg ? Math.log10(v) : v; }
  if (name === "prior_admissions") return Math.log1p(Number.isNaN(v) ? 0 : v);
  if (name === "prior_ntprobnp") return Math.log10(clip(v, 5, 70000));
  if (name === "prior_days") return Math.log1p(clip(v, 0, 365));
  if (name === "n_prior") return Math.log1p(Number.isNaN(v) ? 0 : v);
  throw new Error("unknown input " + name);
}
function finalTab(age, sex, inp, stats, names) {
  const get = k => (inp[k] === null || inp[k] === undefined) ? NaN : Number(inp[k]);
  const z = (k, raw) => Number.isFinite(raw) ? [(finalTransform(k, raw) - stats[k].mean) / stats[k].sd, 0] : [0, 1];
  let prior = get("prior_ntprobnp"), days = get("prior_ntprobnp_days");
  if (Number.isFinite(days) && days > 365) { prior = NaN; days = NaN; }
  const nz = v => Number.isNaN(v) ? 0 : v;
  const vals = {age: (age - 65) / 15, sex: Number(sex),
    prior_hf: Number.isNaN(get("prior_hf")) ? 0 : get("prior_hf"),
    prior_ckd: Number.isNaN(get("prior_ckd")) ? 0 : get("prior_ckd"),
    prior_admissions: z("prior_admissions", nz(get("prior_admissions")))[0]};
  for (const k of LABS.concat(Object.keys(NEW_LABS))) [vals[k], vals[k + "_missing"]] = z(k, get(k));
  [vals.prior_ntprobnp, vals.no_prior_ntprobnp] = z("prior_ntprobnp", prior);
  vals.prior_days = z("prior_days", days)[0];
  let n = get("n_prior_ntprobnp");
  n = Number.isNaN(n) ? (Number.isFinite(prior) ? 1 : 0) : (Number.isFinite(prior) ? n : 0);
  vals.n_prior = z("n_prior", n)[0];
  return Float32Array.from(names.map(k => { if (!(k in vals)) throw new Error("unknown model input " + k); return vals[k]; }));
}
const ruleInThreshold = age => age < 50 ? 450 : (age <= 75 ? 900 : 1800);

// ---------------------------------------------------------------- engine (step18 Engine)
class Engine {
  /** manifest: model/manifest.json; filters: model/filters.json; load(path) -> ArrayBuffer */
  constructor(manifest, filters, load) {
    this.M = manifest; this.F = filters; this.load = load; this.sets = {};
    this.device = "browser";
    this.hasFinal = !!manifest.sets.final;
  }
  async set(name) {
    if (this.sets[name]) return this.sets[name];
    const d = this.M.sets[name];
    const nets = [];
    for (const f of d.files) nets.push(unpackNet(await this.load("model/" + f), d.n_tab));
    const s = Object.assign({}, d, {key: name, nets});
    if (name === "base") s.tab = (age, sex) => Float32Array.from([(age - 65) / 15, Number(sex)]);
    else s.tab = (age, sex, inp) => finalTab(age, sex, inp, d.stats, d.tab_names);
    return (this.sets[name] = s);
  }
  health() {
    return {status: "ok", device: this.device, bigger_model: this.hasFinal ? "final" : null,
            networks: {base: this.M.sets.base.files.length, bigger: this.hasFinal ? this.M.sets.final.files.length : 0},
            final_model_missing_files: []};
  }
  async choose(inp) {
    inp = inp || {};
    const given = Object.keys(inp).filter(k => inp[k] !== null && inp[k] !== undefined);
    if (this.hasFinal && inp.creatinine !== null && inp.creatinine !== undefined) {
      let used = given.filter(k => k in INPUTS);
      const ignored = given.filter(k => !(k in INPUTS));
      let note = ignored.length ? "Not used by this model: " + ignored.join(", ") + "." : "";
      const d = inp.prior_ntprobnp_days;
      if (d !== null && d !== undefined && d > 365) {
        note += " The previous NT-proBNP is older than 365 days, so it was not used " +
                "(the model learned only from results of the last year).";
        used = used.filter(k => !["prior_ntprobnp", "prior_ntprobnp_days", "n_prior_ntprobnp"].includes(k));
      }
      return [await this.set("final"), note.trim(), used];
    }
    let note = "";
    if (given.length && !this.hasFinal) note = "Extra inputs were ignored: the bigger model is not installed.";
    else if (given.length) note = "Extra inputs were ignored: creatinine is needed to switch on the bigger model.";
    return [await this.set("base"), note, []];
  }
  masked(X, mode) {                     // same ECG again (e.g. "What if?") -> same arrays, so caches hit
    const key = mode + ":" + X.length + ":" + X.map(x => { let h = 0; for (let i = 0; i < x.length; i += 7) h = (h * 31 + Math.round(x[i] * 1e5)) | 0; return h; }).join(",");
    if (this._key !== key) { this._key = key; this._xs = X.map(x => applyMode(x, mode)); this._z = new Map(); }
    return this._xs;
  }
  zCache(ms, i) { const k = ms.key + i; if (!this._z.has(k)) this._z.set(k, new Map()); return this._z.get(k); }
  run(X, tabRow, mode, ms, wantSal) {
    const nW = X.length, nM = ms.nets.length, preds = [];
    const xs = this.masked(X, mode);
    const sal = wantSal ? new Float64Array(12 * N_OUT) : null;
    ms.nets.forEach((net, ni) => {
      const row = [], zc = this.zCache(ms, ni);
      for (const xi of xs) {
        const r = netRun(net, xi, tabRow, mode, wantSal, zc);
        row.push(r.y * ms.y_sd + ms.y_mean);
        if (wantSal) for (let i = 0; i < sal.length; i++) sal[i] += r.grad[i] * xi[i];
      }
      preds.push(row);
    });
    const est = [];
    for (let w = 0; w < nW; w++) { let s = 0; for (let m = 0; m < nM; m++) s += preds[m][w]; est.push(s / nM); }
    const spread = stdPop(preds.map(r => median(r)));
    if (wantSal) for (let i = 0; i < sal.length; i++) sal[i] /= nM * nW;
    return {est, spread, sal};
  }
  hasPrior(ms, inp) {
    if (!ms.conformal || !inp) return false;
    const d = inp.prior_ntprobnp_days;
    return inp.prior_ntprobnp !== null && inp.prior_ntprobnp !== undefined && d !== null && d !== undefined && d <= 365;
  }
  resid(ms, mode, hp) {                 // quantiles of the test-set errors (aggregate only)
    const r = ms.resid_quantiles[String(mode)];
    return ms.conformal ? r[hp ? "true" : "false"] : r;
  }
  summary(estW, spread, mode, ms, inp) {
    const est = median(estW), hp = this.hasPrior(ms, inp);
    let w = {}, how;
    if (ms.conformal) {
      const key = hp ? "true" : "false";
      for (const lev of ["0.90", "0.80"]) { const c = ms.conformal[ms.conf_mode[String(mode)]][lev]; w[lev] = c.adaptive_group[key] * (spread + c.eps); }
      how = "conformal, adaptive, calibrated for patients " + (hp ? "WITH" : "WITHOUT") + " a previous NT-proBNP (step 36)";
    } else {
      w = ms.conf_q[String(mode)];
      how = "conformal, same width for every patient (test-set errors of this model)";
    }
    const q = this.resid(ms, mode, hp);
    const typical = ms.conformal ? ms.typical_group[String(mode)][hp ? "true" : "false"] : ms.typical[String(mode)];
    const lo90 = est - w["0.90"], hi90 = est + w["0.90"];
    const side = lo90 >= LOG300 ? "above" : (hi90 < LOG300 ? "below" : "both");
    return {model: ms.name, estimate_pg_ml: pyRound(10 ** est),
            range90_pg_ml: [pyRound(10 ** lo90), pyRound(10 ** hi90)],
            range80_pg_ml: [pyRound(10 ** (est - w["0.80"])), pyRound(10 ** (est + w["0.80"]))],
            range_method: how, range90_vs_300: side,
            prob_ge_300: pyRound(probGe(q, LOG300 - est), 3),
            typical_error_x: pyRound(typical, 2), _est: est, _q: q};
  }
  package_(x0, estW, spread, sal, age, mode, ms, inp, note, used, compare) {
    const s = this.summary(estW, spread, mode, ms, inp);
    const est = s._est, q = s._q; delete s._est; delete s._q;
    const thrAge = ruleInThreshold(age);
    const p300 = s.prob_ge_300, pAge = probGe(q, Math.log10(thrAge) - est);
    const risk = p300 >= 0.7 ? "high" : (p300 >= 0.3 ? "intermediate" : "low");
    // saliency: |grad x input|, 40 ms smoothing (np.convolve "same", k = 5)
    const mag = new Float64Array(12 * N_OUT);
    for (let c = 0; c < 12; c++) for (let t = 0; t < N_OUT; t++) {
      let s2 = 0; for (let j = -2; j <= 2; j++) { const u = t + j; if (u >= 0 && u < N_OUT) s2 += Math.abs(sal[c * N_OUT + u]); }
      mag[c * N_OUT + t] = s2 / 5;
    }
    const leads = mode === 1 ? [1] : [...Array(12).keys()];
    const imp = leads.map(c => { let s3 = 0; for (let t = 0; t < N_OUT; t++) s3 += mag[c * N_OUT + t]; return s3; });
    const impSum = imp.reduce((a, b) => a + b, 0) + 1e-12;
    let mx = 0; for (const c of leads) for (let t = 0; t < N_OUT; t++) mx = Math.max(mx, mag[c * N_OUT + t]);
    const r3 = v => Math.round(v * 1000) / 1000;
    const lead_importance = {}; leads.forEach((c, i) => { lead_importance[LEADS[c]] = pyRound(imp[i] / impSum, 3); });
    return Object.assign({
      mode: MODE_NAME[mode], model_used: ms.name, n_networks: ms.nets.length,
      inputs_used: Object.fromEntries(used.map(k => [k, inp[k]])),
      has_prior_ntprobnp: this.hasPrior(ms, inp), labs_note: note, compare,
    }, s, {
      age_rule_in_threshold_pg_ml: thrAge, prob_ge_age_threshold: pyRound(pAge, 3), risk_band: risk,
      network_spread_x: pyRound(10 ** spread, 3), n_windows: estW.length,
      window_spread_log10: pyRound(stdPop(estW), 3), lead_importance,
      display: {fs: FS_OUT, leads: leads.map(c => LEADS[c]),
        signal_mV: leads.map(c => Array.from(x0.subarray(c * N_OUT, (c + 1) * N_OUT), r3)),
        saliency_0to1: leads.map(c => Array.from(mag.subarray(c * N_OUT, (c + 1) * N_OUT), v => r3(v / (mx + 1e-12))))},
      disclaimer: DISCLAIMER,
    });
  }
  async analyse(X, age, sex, mode, inp, fast) {
    const [ms, note, used] = await this.choose(inp);
    const r = this.run(X, ms.tab(age, sex, inp || {}), mode, ms, !fast);
    if (fast) r.sal = new Float64Array(12 * N_OUT);
    let compare = null;
    if (ms.key !== "base") {
      const base = await this.set("base");
      const rb = this.run(X, base.tab(age, sex, {}), mode, base, false);
      const a = this.summary(rb.est, rb.spread, mode, base, {}), b = this.summary(r.est, r.spread, mode, ms, inp);
      for (const d of [a, b]) { delete d._est; delete d._q; }
      compare = {without_labs: a, with_labs: b};
    }
    return this.package_(X[0], r.est, r.spread, r.sal, age, mode, ms, inp, note, used, compare);
  }
  async predict12(heaText, datBuf, age, sex, inp, fast) {
    const {cols, fs, names} = readWfdb16(heaText, datBuf);
    const x = preprocess(this.F, cols, fs, names);
    let flat = 0;
    for (let c = 0; c < 12; c++) if (stdPop(x.subarray(c * N_OUT, (c + 1) * N_OUT)) < 0.01) flat++;
    if (flat >= 6) throw new UserError("ECG looks flat (half the leads have no signal).");
    const out = await this.analyse([x], age, sex, 0, inp, fast);
    try { out.quality = quality12(this.F, cols, fs, names); }
    catch (e) { out.quality = {status: "unknown", summary: "Quality check failed: " + e.message}; }
    return out;
  }
  async predictMonitor(lead2, fs, age, sex, inp, fast) {
    const raw = lead2;
    lead2 = Float64Array.from(Float32Array.from(lead2));      // step18 reads the CSV as float32
    const L = Math.round(10 * fs), wins = [];
    for (let s = 0; s + L <= lead2.length; s += L) {
      const w = lead2.subarray(s, s + L);
      let nan = 0; const ok = []; for (const v of w) Number.isNaN(v) ? nan++ : ok.push(v);
      if (nan / w.length > 0.1 || !ok.length || stdPop(ok) < 0.01) continue;
      wins.push(preprocess(this.F, [w], fs, ["II"]));
      if (wins.length >= MAX_WINDOWS_WEB) break;
    }
    if (!wins.length) throw new UserError("Need at least one clean 10-second stretch of lead II.");
    const out = await this.analyse(wins, age, sex, 1, inp, fast);
    if (wins.length >= MAX_WINDOWS_WEB)
      out.labs_note = ((out.labs_note || "") + ` The online version reads the first ${MAX_WINDOWS_WEB} clean 10-second windows.`).trim();
    try { out.quality = qualityMonitor(this.F, raw, fs); }
    catch (e) { out.quality = {status: "unknown", summary: "Quality check failed: " + e.message}; }
    return out;
  }
}
/** share of the error distribution with r >= c, from its 1001 quantiles */
function probGe(q, c) { let n = 0; for (const v of q) if (v >= c) n++; return n / q.length; }

// ---------------------------------------------------------------- form handling (step18 make_app)
function basics(form) {
  const age = parseFloat(form.age), sexS = form.sex_male;
  const sex = sexS === undefined ? NaN : Number(sexS);
  if (form.age === undefined || sexS === undefined || Number.isNaN(age) || !Number.isInteger(sex)) throw new UserError("age and sex_male are required.");
  if (!(age >= 18 && age <= 110) || ![0, 1].includes(sex)) throw new UserError("age must be 18-110 and sex_male 0 or 1.");
  return [age, sex];
}
function cleanInputs(form) {
  const out = {};
  for (const [k, [lo, hi, unit, tip]] of Object.entries(INPUTS)) {
    const raw = form[k];
    if (raw === undefined || raw === null || String(raw).trim() === "") { out[k] = null; continue; }
    const v = Number(String(raw).trim());
    if (Number.isNaN(v)) throw new UserError(`${k} = '${raw}' is not a number.`);
    if (!(v >= lo && v <= hi) || !Number.isFinite(v)) throw new UserError(`${k} = ${v} is outside ${lo}-${hi} ${unit}. ${tip}`.trim());
    out[k] = v;
  }
  if (out.prior_ntprobnp !== null && out.prior_ntprobnp_days === null)
    throw new UserError("Please enter how many days ago the previous NT-proBNP was measured.");
  return out;
}

// ---------------------------------------------------------------- private link (encrypted model files)
// step39_export_web.py can encrypt the model files (AES-256-GCM). The key is only in the private
// link, after "#k=", and the browser never sends that part to the server. File layout:
// "NTE1" (4 bytes) + IV (12 bytes) + ciphertext with its 16-byte tag.
const MAGIC = [78, 84, 69, 49];                                   // "NTE1"
class LockedError extends Error {}
function isSealed(buf) {
  const b = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));
  return b.length === 4 && MAGIC.every((v, i) => b[i] === v);
}
function keyFromHash(hash) {
  const m = /(?:^#|&)k=([A-Za-z0-9_-]{43})(?:&|$)/.exec(hash || "");
  return m ? m[1] : null;
}
async function importKey(b64url) {
  if (!b64url) return null;
  const s = atob(b64url.replace(/-/g, "+").replace(/_/g, "/") + "=");
  const raw = Uint8Array.from(s, ch => ch.charCodeAt(0));
  if (raw.length !== 32) throw new LockedError("This link is not complete. Please open the full link or scan the QR code again.");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
}
async function openBytes(buf, key) {
  if (!isSealed(buf)) return buf;
  if (!key) throw new LockedError("NT-Sense is a private demo. Please open it from the link or QR code you were given.");
  try {
    return await crypto.subtle.decrypt({name: "AES-GCM", iv: new Uint8Array(buf, 4, 12)}, key, new Uint8Array(buf, 16));
  } catch (e) {
    throw new LockedError("This link does not open NT-Sense (wrong or old key). Please use the latest link or QR code.");
  }
}

root.NTEngine = {Engine, readWfdb16, readCsvColumn, preprocess, quality12, qualityMonitor, leadIssues, welch,
  sosfiltfilt, resamplePoly, filtersFor, unpackNet, netRun, applyMode, finalTab, basics, cleanInputs, UserError,
  pyRound, LEADS, INPUTS, N_OUT, LockedError, isSealed, keyFromHash, importKey, openBytes};
})(typeof self !== "undefined" ? self : globalThis);
