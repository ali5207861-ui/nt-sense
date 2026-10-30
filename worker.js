/* Runs the NT-Sense engine off the main thread, so the page stays smooth while the networks work. */
importScripts("engine.js");
const E = self.NTEngine;
const BASE = self.location.href.replace(/[^/]*$/, "");
let engine = null, ready = null, keyText = null, key = null;

async function get(path) {
  const r = await fetch(BASE + path);
  if (!r.ok) throw new Error(`could not load ${path} (${r.status})`);
  return r;
}
// a model file, decrypted when the private link's key is needed
async function bytes(path) {
  return E.openBytes(await (await get(path)).arrayBuffer(), key);
}
const text = async path => new TextDecoder().decode(await bytes(path));
async function init() {
  key = await E.importKey(keyText);
  const manifest = JSON.parse(await text("model/manifest.json"));
  const filters = await (await get("model/filters.json")).json();
  engine = new E.Engine(manifest, filters, bytes);
}

self.onmessage = async (ev) => {
  const {id, kind, form = {}, files = {}} = ev.data;
  const prefix = kind === "12lead" ? "Could not analyse this ECG: " : "Could not analyse this signal: ";
  try {
    if (kind === "key") { keyText = ev.data.key || null; self.postMessage({id, ok: true, out: {}}); return; }
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
