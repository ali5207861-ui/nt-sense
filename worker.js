/* Runs the NT-Sense engine off the main thread, so the page stays smooth while the networks work. */
importScripts("engine.js");
const E = self.NTEngine;
const BASE = self.location.href.replace(/[^/]*$/, "");
let engine = null, ready = null, keyText = null, key = null, half = false;

async function get(path) {
  const r = await fetch(BASE + path);
  if (!r.ok) throw new Error(`could not load ${path} (${r.status})`);
  return r;
}
// download progress of the network files, shown by the page ("Downloading the model 40%")
const prog = {total: 0, part: {}};
function report() {
  let done = 0; for (const v of Object.values(prog.part)) done += v;
  self.postMessage({progress: {done, total: prog.total}});
}
async function download(path) {
  const r = await get(path);
  const net = /\.bin$/.test(path) && prog.total;
  // Content-Length is only a guide (a server may compress): progress is capped, the bytes are not
  const len = r.headers.get("Content-Encoding") ? 0 : +r.headers.get("Content-Length") || 0;
  if (!net || !r.body || !len) { const b = await r.arrayBuffer(); if (net) { prog.part[path] = 1; report(); } return b; }
  const reader = r.body.getReader(), chunks = []; let got = 0, last = 0;
  for (;;) {
    const {done, value} = await reader.read();
    if (done) break;
    chunks.push(value); got += value.length;
    if (got - last > 65536) { last = got; prog.part[path] = Math.min(0.99, got / len); report(); }
  }
  const buf = new Uint8Array(got); let at = 0;
  for (const c of chunks) { buf.set(c, at); at += c.length; }
  prog.part[path] = 1; report();
  return buf.buffer;
}
// a model file, decrypted when the private link's key is needed
async function bytes(path) {
  return E.openBytes(await download(path), key);
}
const text = async path => new TextDecoder().decode(await bytes(path));
async function init() {
  key = await E.importKey(keyText);
  const manifest = JSON.parse(await text("model/manifest.json"));
  const filters = await (await get("model/filters.json")).json();
  engine = new E.Engine(manifest, filters, bytes);
  engine.half = half;
  prog.total = Object.keys(manifest.sets).reduce((n, k) => n + (manifest.sets[k] ? engine.variant(k)[0].length : 0), 0);
}

self.onmessage = async (ev) => {
  const {id, kind, form = {}, files = {}} = ev.data;
  const prefix = kind === "12lead" ? "Could not analyse this ECG: " : "Could not analyse this signal: ";
  try {
    if (kind === "key") { keyText = ev.data.key || null; half = !!ev.data.half; self.postMessage({id, ok: true, out: {}}); return; }
    if (kind === "file") { key = key || await E.importKey(keyText); self.postMessage({id, ok: true, out: await text(ev.data.path)}); return; }
    if (!ready) ready = init();
    await ready;
    let out;
    if (kind === "health") out = engine.health();
    else if (kind === "warm") { await engine.set("base"); if (engine.hasFinal) await engine.set("final"); out = {ok: true}; }
    else if (kind === "12lead") {
      const [age, sex] = E.basics(form);
      const inp = E.cleanInputs(form);
      if (!files.hea || !files.dat) throw new E.UserError("Both the .hea and the .dat file are needed.");
      out = await engine.predict12(files.hea, files.dat, age, sex, inp, !!ev.data.fast);
    } else if (kind === "monitor") {
      const [age, sex] = E.basics(form);
      const inp = E.cleanInputs(form);
      const fs = parseFloat(form.fs === undefined ? "nan" : form.fs);
      if (!(fs >= 50 && fs <= 2000)) throw new E.UserError("fs (sampling rate) must be 50-2000 Hz.");
      if (!files.csv) throw new E.UserError("The lead II CSV file is needed.");
      out = await engine.predictMonitor(E.readCsvColumn(files.csv), fs, age, sex, inp, !!ev.data.fast);
    } else throw new Error("unknown request " + kind);
    self.postMessage({id, ok: true, out});
  } catch (e) {
    if (e instanceof E.LockedError) ready = null;            // a later request may bring the right key
    const known = kind === "12lead" || kind === "monitor";
    const locked = e instanceof E.LockedError;
    self.postMessage({id, ok: false, locked, status: locked ? 403 : known ? 400 : 500,
                      detail: (known && !locked ? prefix : "") + (e && e.message ? e.message : String(e))});
  }
};
