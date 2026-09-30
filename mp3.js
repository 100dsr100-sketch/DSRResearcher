/* DSR Researcher - 1e: export the summary as an MP3.
   Browsers can't record the phone's own read-aloud voices, so the MP3 is made by Piper, a free neural
   voice that runs inside the page (ONNX Runtime + WebAssembly). The engine and the voice (~90 MB) are
   downloaded once into this app's own cache, so later exports work offline and nothing is sent anywhere.
   Audio is encoded to MP3 (lamejs) sentence by sentence, so even a long summary stays small in memory. */
"use strict";
const MP3 = {
  CACHE: "dsrres-voice-1",          // NOT "dsr-research-…": the service worker deletes old caches with that prefix
  ORT: "https://cdnjs.cloudflare.com/ajax/libs/onnxruntime-web/1.18.0/",
  LAME: "https://cdnjs.cloudflare.com/ajax/libs/lamejs/1.2.1/lame.min.js",
  PHON: "https://cdn.jsdelivr.net/npm/@mintplex-labs/piper-tts-web@1.0.5/dist/piper-o91UDS6e.js",
  PHON_WASM: "https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/piper_phonemize",
  VOICE: "https://huggingface.co/diffusionstudio/piper-voices/resolve/main/en/en_GB/jenny_dioco/medium/en_GB-jenny_dioco-medium.onnx",
  KBPS: 64,
  engine: null, busy: false, cancelled: false,
};
MP3.FILES = [MP3.ORT + "ort.wasm.min.js", MP3.ORT + "ort-wasm-simd.wasm", MP3.LAME, MP3.PHON,
  MP3.PHON_WASM + ".wasm", MP3.PHON_WASM + ".data", MP3.VOICE + ".json", MP3.VOICE];

/* fetch through the voice cache, reporting download progress. The blob gets its proper type, as scripts
   and WebAssembly are then started from blob: URLs, which the browser checks */
const typed = (b, url) => b.slice(0, b.size, /\.wasm$/.test(url) ? "application/wasm" : /\.js$/.test(url) ? "text/javascript" : "application/octet-stream");
async function voiceFile(url, onBytes) {
  let cache = null; try { cache = await caches.open(MP3.CACHE); } catch {}
  const hit = cache && await cache.match(url);
  if (hit) return typed(await hit.blob(), url);
  const r = await fetch(url);
  if (!r.ok) throw new Error("Couldn't download the voice (" + r.status + ")");
  const reader = r.body.getReader(), parts = [];
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    if (MP3.cancelled) { reader.cancel(); throw new Error("cancelled"); }
    parts.push(value); onBytes?.(value.length);
  }
  const blob = new Blob(parts);
  try { await cache?.put(url, new Response(blob)); } catch {}   // storage full: still works, just downloads again next time
  return typed(blob, url);
}
async function voiceCached() {
  try { const c = await caches.open(MP3.CACHE); return (await Promise.all(MP3.FILES.map(u => c.match(u)))).every(Boolean); } catch { return false; }
}
function loadScript(blob) {
  return new Promise((ok, bad) => { const s = document.createElement("script"); s.src = URL.createObjectURL(blob); s.onload = ok; s.onerror = () => bad(new Error("Couldn't start the voice engine")); document.head.appendChild(s); });
}

async function loadEngine(onStatus) {
  if (MP3.engine) return MP3.engine;
  const SIZE = 93e6; let got = 0;
  const bytes = n => { got += n; onStatus(`Downloading the voice (once only)… ${Math.min(99, Math.round(got * 100 / SIZE))}%`, got / SIZE); };
  onStatus(await voiceCached() ? "Starting the voice…" : "Downloading the voice (once only)… 0%", 0);
  const b = {};
  for (const u of MP3.FILES) b[u] = URL.createObjectURL(await voiceFile(u, bytes));   // one at a time: gentle on phones
  onStatus("Starting the voice…", 1);
  if (!window.ort) await loadScript(await (await fetch(b[MP3.ORT + "ort.wasm.min.js"])).blob());
  if (!window.lamejs) await loadScript(await (await fetch(b[MP3.LAME])).blob());
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.wasmPaths = { "ort-wasm-simd.wasm": b[MP3.ORT + "ort-wasm-simd.wasm"] };
  const config = JSON.parse(await (await fetch(b[MP3.VOICE + ".json"])).text());
  const session = await ort.InferenceSession.create(await (await fetch(b[MP3.VOICE])).arrayBuffer(), { executionProviders: ["wasm"] });
  const { createPiperPhonemize } = await import(b[MP3.PHON]);
  let out = [];
  const phon = await createPiperPhonemize({
    print: d => out.push(JSON.parse(d).phoneme_ids), printErr: () => {},
    locateFile: u => u.endsWith(".wasm") ? b[MP3.PHON_WASM + ".wasm"] : u.endsWith(".data") ? b[MP3.PHON_WASM + ".data"] : u,
  });
  const phonemes = texts => { out = []; phon.callMain(["-l", config.espeak.voice, "--input", JSON.stringify(texts.map(text => ({ text }))), "--espeak_data", "/espeak-ng-data"]); return out; };
  return (MP3.engine = { config, session, phonemes });
}

async function speakToPcm(eng, ids, rate) {
  const inf = eng.config.inference;
  const feeds = {
    input: new ort.Tensor("int64", ids, [1, ids.length]),
    input_lengths: new ort.Tensor("int64", [ids.length]),
    scales: new ort.Tensor("float32", [inf.noise_scale, inf.length_scale / rate, inf.noise_w]),
  };
  if (Object.keys(eng.config.speaker_id_map || {}).length) feeds.sid = new ort.Tensor("int64", [0]);
  return (await eng.session.run(feeds)).output.data;
}
const toInt16 = f => { const o = new Int16Array(f.length); for (let i = 0; i < f.length; i++) { const v = f[i]; o[i] = v >= 1 ? 32767 : v <= -1 ? -32768 : v * 32767; } return o; };

/* the (possibly edited) document -> [{ text, pause }] - pause is the silence after it, in seconds */
function mp3Script() {
  const items = [];
  for (const el of $("#doc").querySelectorAll("h1,h2,p")) {
    if (el.classList.contains("src")) continue;
    const s = sentencesOf(el.textContent.replace(/\s+/g, " ").trim());
    s.forEach((t, i) => items.push({ text: speakable(t), pause: i < s.length - 1 ? 0.15 : /^H/.test(el.tagName) ? 0.7 : 0.5 }));
  }
  return items.filter(x => /[a-z0-9]/i.test(x.text));
}

async function exportMp3(fileName, rate, onStatus) {
  MP3.busy = true; MP3.cancelled = false; awake.sync();
  try {
    const script = mp3Script();
    if (!script.length) throw new Error("There's nothing to read");
    const eng = await loadEngine(onStatus);
    const sr = eng.config.audio.sample_rate;
    const enc = new lamejs.Mp3Encoder(1, sr, MP3.KBPS), parts = [];
    const push = d => { if (d.length) parts.push(new Uint8Array(d)); };
    const t0 = Date.now(); let secs = 0;
    for (let i = 0; i < script.length; i++) {
      if (MP3.cancelled) throw new Error("cancelled");
      const left = i > 2 ? ` – about ${Math.max(1, Math.round((Date.now() - t0) / i * (script.length - i) / 60000))} min left` : "";
      onStatus(`Making the MP3… ${Math.round(i * 100 / script.length)}%${left}`, i / script.length);
      await new Promise(r => setTimeout(r, 0));                         // let the screen update between sentences
      const [ids] = eng.phonemes([script[i].text]);
      if (ids?.length) { const pcm = toInt16(await speakToPcm(eng, ids, rate)); push(enc.encodeBuffer(pcm)); secs += pcm.length / sr; }
      const gap = new Int16Array(Math.round(script[i].pause * sr)); push(enc.encodeBuffer(gap)); secs += script[i].pause;
    }
    push(enc.flush());
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob(parts, { type: "audio/mpeg" }));
    a.download = fileName.replace(/[\\/:*?"<>|]+/g, "_") + ".mp3";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    return Math.round(secs);
  } finally { MP3.busy = false; awake.sync(); }
}
