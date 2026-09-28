/* DSR Researcher - a summary of a subject from the internet, sized to a reading/listening time,
   read aloud with the phone's voices, editable and saveable.
   Sources: Wikipedia (free, no key, CORS-friendly). The summary is EXTRACTIVE: the best sentences
   of the article(s), kept in order, until the length fits - no AI service involved. */
"use strict";
const $ = (s, r = document) => r.querySelector(s);
const main = $("#main");
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
function toast(m, ms = 2600) { const t = $("#toast"); t.textContent = m; t.style.display = "block"; clearTimeout(toast.t); toast.t = setTimeout(() => t.style.display = "none", ms); }

const WPM = 150;                                   // comfortable listening / reading speed
const LENGTHS = [1, 2, 5, 10, 15, 20, 30];
const WIKI = "https://en.wikipedia.org/w/api.php?format=json&origin=*&";

/* ======================= saved research ======================= */
const store = {
  all() { try { return JSON.parse(localStorage.getItem("dsrres.items") || "[]"); } catch { return []; } },
  put(item) { const a = store.all().filter(x => x.id !== item.id); a.unshift(item); try { localStorage.setItem("dsrres.items", JSON.stringify(a)); return true; } catch { toast("Couldn't save – the phone's storage for this app is full"); return false; } },
  del(id) { try { localStorage.setItem("dsrres.items", JSON.stringify(store.all().filter(x => x.id !== id))); } catch {} },
  get(id) { return store.all().find(x => x.id === id); },
};
const pref = (k, v) => { try { if (v === undefined) return localStorage.getItem("dsrres." + k); localStorage.setItem("dsrres." + k, v); } catch {} };

/* ======================= Wikipedia ======================= */
async function wiki(params) {
  const r = await fetch(WIKI + new URLSearchParams(params));
  if (!r.ok) throw new Error("Wikipedia didn't answer (" + r.status + ")");
  return r.json();
}
async function searchTitles(q, n = 8) {
  const j = await wiki({ action: "query", list: "search", srsearch: q, srlimit: n, srprop: "" });
  return (j.query?.search || []).map(x => x.title);
}
async function article(title) {
  const j = await wiki({ action: "query", prop: "extracts|info", explaintext: 1, exsectionformat: "wiki", inprop: "url", redirects: 1, titles: title });
  const p = Object.values(j.query?.pages || {})[0];
  if (!p || p.missing !== undefined || !p.extract) return null;
  return { title: p.title, url: p.fullurl || ("https://en.wikipedia.org/wiki/" + encodeURIComponent(p.title)), text: p.extract };
}

/* ======================= text -> sections -> sentences ======================= */
const SKIP_SECTIONS = /^(references|see also|external links|notes|further reading|bibliography|sources|citations|footnotes|gallery|works cited|explanatory notes|notes and references|primary sources|secondary sources|filmography|discography|awards|selected works)$/i;
const STOP = new Set("a an the and or but if of in on at to for from by with as is are was were be been being it its this that these those he she they them his her their we you i not no so than then there here which who whom whose what when where why how also into over under about after before between during through up down out off again further once all any both each few more most other some such only own same too very can will just do does did has have had would could should may might must shall one two three first new many much".split(" "));
const words = s => (s.toLowerCase().match(/[a-z0-9’']+/g) || []);
const wc = s => (s.match(/\S+/g) || []).length;

function sectionsOf(art, heading) {
  // "== History ==" style headings (level 2+); text before the first heading is the lead
  const out = []; let cur = { title: heading || "", lead: true, text: [] };
  for (const line of art.text.split("\n")) {
    const h = line.match(/^(=+)\s*(.*?)\s*\1\s*$/);
    if (h) { out.push(cur); cur = { title: h[2], level: h[1].length, lead: false, text: [] }; continue; }
    if (line.trim()) cur.text.push(line.trim());
  }
  out.push(cur);
  return out.filter(s => s.text.length && !SKIP_SECTIONS.test(s.title));
}
const ABBR = /\b(e\.g|i\.e|etc|vs|Mr|Mrs|Ms|Dr|St|Jr|Sr|No|approx|c|ca|Inc|Ltd|Co|U\.S|U\.K)\.$/i;
/* Wikipedia's plain text keeps the husks of removed pronunciation/IPA markup: "Loch Ness (; Scottish
   Gaelic: Loch Nis [l̪ˠɔx ˈniʃ])" - awkward to read and to hear. Tidy them away. */
function tidy(t) {
  return t.replace(/\s*\[[^\]]*[ˈˌːɔəɪʊʃʒθðŋæɑɛɒʌɜɐɾɫ̪ˠ][^\]]*\]/g, "")   // IPA in [ ]
    .replace(/\(\s*[;,]\s*/g, "(").replace(/\s*\(\s*\)/g, "")
    .replace(/\(\s*(listen|pronunciation)\s*\)/gi, "").replace(/\s{2,}/g, " ").replace(/\s+([,.;:])/g, "$1");
}
function sentencesOf(para) {
  para = tidy(para);
  const parts = para.split(/(?<=[.!?])\s+(?=["“(]?[A-Z0-9])/);
  const out = [];
  for (const p of parts) {
    if (out.length && ABBR.test(out[out.length - 1])) out[out.length - 1] += " " + p; else out.push(p);
  }
  return out.map(s => s.trim()).filter(Boolean);
}

/* ======================= the summariser ======================= */
function summarise(arts, topic, targetWords) {
  // flatten into sentences with their section, keep paragraph breaks
  const secs = [];
  arts.forEach((art, ai) => {
    for (const s of sectionsOf(art, ai ? art.title : "")) {
      const sents = [];
      s.text.forEach((para, pi) => sentencesOf(para).forEach((t, si) => sents.push({ t, pi, si, n: wc(t) })));
      secs.push({ art: ai, artTitle: art.title, title: ai && s.lead ? art.title : s.title, lead: s.lead, sents });
    }
  });
  const all = secs.flatMap(s => s.sents);
  const total = all.reduce((a, s) => a + s.n, 0);

  // term weights: topic words weigh most, then the document's own frequent words
  const tf = new Map();
  for (const s of all) for (const w of words(s.t)) if (!STOP.has(w) && w.length > 2) tf.set(w, (tf.get(w) || 0) + 1);
  const topicW = new Set(words(topic).filter(w => !STOP.has(w)));
  const weight = w => (topicW.has(w) ? 4 : 0) + Math.log(1 + (tf.get(w) || 0));

  for (const sec of secs) {
    for (const s of sec.sents) {
      const ws = words(s.t).filter(w => !STOP.has(w) && w.length > 2);
      let sc = ws.reduce((a, w) => a + weight(w), 0) / Math.sqrt(Math.max(ws.length, 1));
      if (s.si === 0) sc += 2; else if (s.si === 1) sc += 0.8;          // paragraph openers carry the point
      if (sec.lead) sc += s.pi === 0 ? 4 : 1.5;                          // the lead summarises the article
      if (sec.art > 0) sc -= 1;                                          // main article first
      if (s.n < 6) sc -= 3; if (s.n > 55) sc -= 2;
      if ((s.t.match(/[()\[\];]/g) || []).length > 4) sc -= 1.5;
      s.score = sc;
    }
  }

  let picked;
  if (total <= targetWords * 1.05) picked = new Set(all);                 // everything fits
  else {
    picked = new Set(); let used = 0;
    // 1) the lead's opening sentences
    for (const s of (secs.find(x => x.lead && x.art === 0)?.sents || []).slice(0, 3)) { if (used + s.n > targetWords && picked.size) break; picked.add(s); used += s.n; }
    // 2) best of the rest, but spread over sections (no section may hog the budget)
    const cap = new Map(secs.map(sec => [sec, Math.max(2, Math.ceil(sec.sents.length * Math.max(0.25, targetWords / total) * 1.6))]));
    const ranked = secs.flatMap(sec => sec.sents.map(s => [sec, s])).sort((a, b) => b[1].score - a[1].score);
    const count = new Map();
    for (const [sec, s] of ranked) {
      if (used >= targetWords) break;
      if (picked.has(s) || (count.get(sec) || 0) >= cap.get(sec)) continue;
      if (used + s.n > targetWords * 1.08) continue;
      picked.add(s); used += s.n; count.set(sec, (count.get(sec) || 0) + 1);
    }
  }

  // back in document order, grouped by section and paragraph
  let html = "", usedWords = 0;
  for (const sec of secs) {
    const keep = sec.sents.filter(s => picked.has(s)); if (!keep.length) continue;
    if (sec.title) html += `<h2>${esc(sec.title)}</h2>`;
    let para = [], lastPi = null;
    const flush = () => { if (para.length) html += `<p>${esc(para.join(" "))}</p>`; para = []; };
    for (const s of keep) { if (lastPi !== null && s.pi !== lastPi) flush(); para.push(s.t); lastPi = s.pi; usedWords += s.n; }
    flush();
  }
  return { html, words: usedWords, available: total };
}

async function research(topic, minutes, onStatus) {
  const target = Math.max(60, Math.round(minutes * WPM));
  onStatus("Searching…");
  let titles = await searchTitles(topic, 10);
  if (!titles.length) throw new Error("Nothing found on Wikipedia for “" + topic + "”");
  const arts = []; let have = 0;
  for (const t of titles) {
    if (arts.length && have >= target * 1.6) break;                 // enough material to choose from
    if (arts.length >= (minutes >= 10 ? 6 : 3)) break;
    onStatus(`Reading “${t}”…`);
    const a = await article(t).catch(() => null);
    if (!a || /may refer to:?$/m.test(a.text.split("\n").slice(0, 3).join(" "))) continue;   // disambiguation page
    arts.push(a); have += wc(a.text);
  }
  if (!arts.length) throw new Error("Couldn't read an article for “" + topic + "”");
  onStatus("Summarising…");
  const s = summarise(arts, topic, target);
  const mins = Math.max(1, Math.round(s.words / WPM));
  const note = s.words < target * 0.8 ? ` (that's everything the sources had – you asked for ${minutes} min)` : "";
  const html = `<h1>${esc(arts[0].title)}</h1><div class="meta">About ${mins} minute${mins === 1 ? "" : "s"} · ${s.words.toLocaleString()} words${esc(note)}</div>${s.html}` +
    `<p class="src">Sources: ${arts.map(a => `<a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.title)}</a>`).join(", ")} (Wikipedia, CC BY-SA)</p>`;
  return { title: arts[0].title, html, minutes: mins, words: s.words };
}

/* ======================= read aloud ======================= */
/* 1b: years spoken the way people say them (the voices read "1980" as "one nine eight zero" or "one
   thousand nine hundred and eighty"). Only the spoken text changes, not the document. */
const ONES = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
  "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const two = n => n < 20 ? ONES[n] : TENS[Math.floor(n / 10)] + (n % 10 ? "-" + ONES[n % 10] : "");
const pluralise = w => w.replace(/y$/, "ie") + "s";            // eighty -> eighties, hundred -> hundreds
function sayYear(y, plural = false) {
  const hi = Math.floor(y / 100), lo = y % 100;
  let out;
  if (y >= 2000 && y <= 2009) out = y === 2000 ? "two thousand" : "two thousand and " + ONES[lo];
  else if (lo === 0) out = two(hi) + " hundred";               // 1900 -> nineteen hundred
  else if (lo < 10) out = two(hi) + " oh " + ONES[lo];         // 1905 -> nineteen oh five
  else out = two(hi) + " " + two(lo);                          // 1980 -> nineteen eighty, 2019 -> twenty nineteen
  if (plural) { const w = out.split(" "); w[w.length - 1] = pluralise(w[w.length - 1]); out = w.join(" "); }
  return out;
}
function speakable(t) {
  return t
    // ranges first: 1914–1918 / 1914-18 -> "... to ..."
    .replace(/\b(1[0-9]\d\d|20\d\d)\s*[–—-]\s*(1[0-9]\d\d|20\d\d|\d\d)\b/g, (m, a, b) => {
      const end = b.length === 2 ? Math.floor(+a / 100) * 100 + +b : +b;
      return sayYear(+a) + " to " + sayYear(end);
    })
    .replace(/\b(1[0-9]\d0|20\d0)s\b/g, (m, y) => sayYear(+y, true))                            // 1980s -> nineteen eighties
    .replace(/(?<![\d,.£$€])\b(1[0-9]\d\d|20\d\d)\b(?![,.]\d|\s*%)/g, (m, y) => sayYear(+y));   // plain years
}
const tts = {
  synth: window.speechSynthesis, voices: [], queue: [], i: 0, playing: false, curEl: null,
  load() {
    if (!this.synth) return;
    const fill = () => {
      this.voices = this.synth.getVoices().filter(v => /^en/i.test(v.lang)).concat(this.synth.getVoices().filter(v => !/^en/i.test(v.lang)));
      const sel = $("#pVoice"); if (!sel) return;
      const chosen = pref("voice") || this.bestDefault()?.voiceURI;
      sel.innerHTML = this.voices.map(v => `<option value="${esc(v.voiceURI)}">${esc(v.name)} (${esc(v.lang)})${/female/i.test(v.name) ? "" : ""}</option>`).join("") || `<option>No voices on this device</option>`;
      if (chosen) sel.value = chosen;
    };
    fill(); this.synth.onvoiceschanged = fill;
  },
  /* default: an English (UK first) FEMALE voice; prefer the natural/online ones */
  bestDefault() {
    const score = v => (/^en-GB/i.test(v.lang) ? 3 : /^en/i.test(v.lang) ? 1 : -9)
      + (/female|woman|libby|sonia|hazel|susan|serena|kate|martha|amy|emma|olivia|natasha|zira|samantha|karen|moira|tessa|fiona|aria|jenny|maisie|mia/i.test(v.name) ? 5 : 0)
      - (/\bmale\b|george|ryan|daniel|oliver|thomas|arthur|guy|david|mark|james|brian|william/i.test(v.name) ? 5 : 0)
      + (/natural|neural|online|network|premium|enhanced|google/i.test(v.name + v.voiceURI) ? 1 : 0);
    return [...this.voices].sort((a, b) => score(b) - score(a))[0];
  },
  voice() { const uri = $("#pVoice")?.value; return this.voices.find(v => v.voiceURI === uri) || this.bestDefault(); },
  build() {
    // sentence queue from the (possibly edited) document; each item remembers its block to highlight
    this.queue = [];
    for (const el of $("#doc").querySelectorAll("h1,h2,p")) {
      if (el.classList.contains("src")) continue;
      for (const t of sentencesOf(el.textContent.replace(/\s+/g, " ").trim())) this.queue.push({ el, t });
    }
  },
  mark(el) { this.curEl?.classList.remove("speaking"); this.curEl = el; el?.classList.add("speaking"); el?.scrollIntoView({ block: "center", behavior: "smooth" }); },
  speakNext() {
    if (!this.playing) return;
    if (this.i >= this.queue.length) { this.stop(); toast("Finished reading"); return; }
    const item = this.queue[this.i];
    this.mark(item.el);
    const u = new SpeechSynthesisUtterance(speakable(item.t));
    const v = this.voice(); if (v) { u.voice = v; u.lang = v.lang; }
    u.rate = +$("#pRate").value || 1;
    u.onend = () => { if (!this.playing) return; this.i++; this.speakNext(); };
    u.onerror = e => { if (e.error === "interrupted" || e.error === "canceled") return; this.i++; this.speakNext(); };
    this.synth.speak(u);
  },
  play() {
    if (!this.synth) return toast("This browser has no read-aloud voices");
    if (!this.queue.length || this.i >= this.queue.length) { this.build(); this.i = 0; }
    this.playing = true; this.synth.cancel(); this.speakNext(); ui();
  },
  // Android's pause()/resume() is unreliable: pause = stop now, resume = re-speak the current sentence
  pause() { this.playing = false; this.synth?.cancel(); ui(); },
  stop() { this.playing = false; this.synth?.cancel(); this.i = 0; this.queue = []; this.mark(null); ui(); },
};
function ui() { const b = $("#pPlay"); if (b) b.textContent = tts.playing ? "⏸ Pause" : (tts.i > 0 && tts.queue.length ? "▶ Resume" : "▶ Read aloud"); }

/* ======================= views ======================= */
function home() {
  tts.stop(); $("#player").style.display = "none";
  const last = +(pref("minutes") || 5);
  const items = store.all();
  main.innerHTML = `
    <div class="card">
      <h2>Research a subject</h2>
      <label>Subject</label>
      <input id="topic" type="search" enterkeyhint="search" placeholder="e.g. Loch Ness, Black holes, The Beatles" autocomplete="off">
      <label>Length (reading / listening time)</label>
      <div class="lens" id="lens">${LENGTHS.map(m => `<button data-m="${m}" class="${m === last ? "on" : ""}">${m} min</button>`).join("")}
        <button data-m="custom" class="${LENGTHS.includes(last) ? "" : "on"}">Custom</button></div>
      <div id="customRow" style="display:${LENGTHS.includes(last) ? "none" : "block"}"><label>Minutes</label><input id="customMin" type="number" min="1" max="120" value="${LENGTHS.includes(last) ? 45 : last}"></div>
      <div class="row" style="margin-top:12px"><button class="pri" id="go">Research</button></div>
      <div class="status" id="status"></div>
      <div class="hint">Summaries are built from Wikipedia (free, no account) – the best sentences, in order, cut to your length (about ${WPM} words a minute). Longer lengths add related articles.</div>
    </div>
    <h3>Saved research</h3>
    <div id="savedList">${items.length ? items.map(it => `<div class="saved" data-id="${it.id}"><div class="nm"><b>${esc(it.name)}</b><span>${esc(new Date(it.updated).toLocaleString())} · about ${it.minutes} min</span></div><button class="sm" data-open>Open</button></div>`).join("") : `<div class="hint">Nothing saved yet.</div>`}</div>`;
  let minutes = last;
  $("#lens").onclick = e => {
    const b = e.target.closest("button"); if (!b) return;
    $("#lens").querySelectorAll("button").forEach(x => x.classList.toggle("on", x === b));
    $("#customRow").style.display = b.dataset.m === "custom" ? "block" : "none";
    minutes = b.dataset.m === "custom" ? +$("#customMin").value : +b.dataset.m;
  };
  $("#customMin").oninput = e => { minutes = +e.target.value; };
  const go = async () => {
    const topic = $("#topic").value.trim(); if (!topic) return toast("Type a subject first");
    if ($("#customRow").style.display !== "none") minutes = Math.min(120, Math.max(1, +$("#customMin").value || 5));
    pref("minutes", minutes);
    $("#go").disabled = true;
    try {
      const r = await research(topic, minutes, s => $("#status").textContent = s);
      openDoc({ id: null, name: `${r.title} – ${minutes} min`, topic, minutes: r.minutes, html: r.html, created: Date.now(), updated: Date.now() });
    } catch (e) { $("#status").textContent = e.message; } finally { const g = $("#go"); if (g) g.disabled = false; }
  };
  $("#go").onclick = go;
  $("#topic").addEventListener("keydown", e => { if (e.key === "Enter" || e.keyCode === 13) { e.preventDefault(); e.target.blur(); go(); } });
  $("#savedList").onclick = e => { const row = e.target.closest(".saved"); if (row && e.target.closest("[data-open]")) openDoc(store.get(row.dataset.id)); };
}

function openDoc(item) {
  tts.stop();
  main.innerHTML = `
    <div class="row" style="margin-bottom:8px"><button class="sm" id="back">← New research</button><div class="grow"></div>
      <button class="sm" id="export">Export .txt</button>${item.id ? `<button class="sm danger" id="del">Delete</button>` : ""}<button class="sm pri" id="save">${item.id ? "Saved ✓" : "Save"}</button></div>
    <label>Name</label><input id="name" value="${esc(item.name)}">
    <label>Summary – tap to edit</label>
    <div id="doc" contenteditable="true">${item.html}</div>
    <div class="hint">Edit freely – Read aloud always reads what's here now. Links to the sources are at the end.</div>`;
  $("#player").style.display = "block";
  tts.load(); ui();
  let dirty = !item.id;
  const saveBtn = $("#save");
  const markDirty = () => { dirty = true; saveBtn.textContent = "Save"; if (tts.queue.length) tts.queue = []; };
  $("#doc").addEventListener("input", markDirty); $("#name").addEventListener("input", markDirty);
  const save = (quiet) => {
    if (!item.id) item.id = uid();
    item.name = $("#name").value.trim() || item.name; item.html = $("#doc").innerHTML.replace(/ class="speaking"/g, ""); item.updated = Date.now();
    if (store.put(item)) { dirty = false; saveBtn.textContent = "Saved ✓"; if (!quiet) toast("Saved"); }
  };
  saveBtn.onclick = () => save();
  // once it's been saved, edits save themselves
  let t; $("#doc").addEventListener("input", () => { if (!item.id) return; clearTimeout(t); t = setTimeout(() => save(true), 1500); });
  $("#back").onclick = () => { if (dirty && item.html && !confirm("Leave without saving this summary?")) return; home(); };
  $("#export").onclick = () => {
    const txt = [...$("#doc").querySelectorAll("h1,h2,p,div.meta")].map(e => e.tagName === "H1" ? e.textContent.toUpperCase() : e.tagName === "H2" ? "\n" + e.textContent : e.textContent).join("\n\n");
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([txt], { type: "text/plain" })); a.download = ($("#name").value || "research").replace(/[\\/:*?"<>|]+/g, "_") + ".txt"; a.click();
  };
  const del = $("#del"); if (del) del.onclick = () => { if (confirm("Delete this saved research?")) { store.del(item.id); home(); } };
}

/* player controls */
$("#pPlay").onclick = () => tts.playing ? tts.pause() : tts.play();
$("#pStop").onclick = () => tts.stop();
$("#pVoice").onchange = e => { pref("voice", e.target.value); if (tts.playing) { tts.synth.cancel(); tts.speakNext(); } };
$("#pRate").oninput = e => { $("#pRateLbl").textContent = (+e.target.value).toFixed(1) + "×"; pref("rate", e.target.value); };
{ const r = pref("rate"); if (r) { $("#pRate").value = r; $("#pRateLbl").textContent = (+r).toFixed(1) + "×"; } }
window.addEventListener("pagehide", () => tts.synth?.cancel());

home();
if ("serviceWorker" in navigator) navigator.serviceWorker.register("service-worker.js").catch(() => {});
