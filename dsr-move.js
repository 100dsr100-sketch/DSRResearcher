/* DSR move kit - moves a DSR web app's on-device data from its old shared address (100dsr100-sketch.github.io,
   where every DSR app shared one storage) to the app's own address (<name>.pages.dev).

   Load it FIRST in <head>, after a config script:
     <script>window.DSR_MOVE = { name: "DSR Researcher", to: "https://dsr-researcher.pages.dev/", ls: ["dsrres."], idb: [] };</script>
     <script src="dsr-move.js"></script>
   ls  = localStorage key prefixes that belong to this app (the old address holds every DSR app's keys)
   idb = IndexedDB database names that belong to this app

   Old address: shows an "OLD COPY - has moved" page instead of the app. "Move my data" uploads this app's data to
   dsr-move-relay (one-time code, 10-minute expiry) and opens the new address as #dsr-move-in=<code>, which collects
   it, stores it, deletes it from the relay. Or a data file can be saved here and chosen there (#dsr-move-in). */
(function () {
  "use strict";
  var C = window.DSR_MOVE; if (!C) return;
  var OLD = /(^|\.)github\.io$/.test(location.hostname), IN = /^#dsr-move-in(=[0-9a-f]{32})?$/.test(location.hash);
  if (!OLD && !IN) return;
  window.stop();                                   // the app itself doesn't start on this page
  var RELAY = "https://dsr-move-relay.100dsr100.workers.dev/p/";
  async function put(k, body) { var r = await fetch(RELAY + k, { method: "PUT", body: body }); if (!r.ok) throw new Error("relay " + r.status); }

  /* ---------- the page ---------- */
  function page(html) {
    document.documentElement.innerHTML = '<head><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + esc(C.name) + '</title><style>' +
      'body{margin:0;background:#000;color:#ece6d2;font:16px/1.5 system-ui,-apple-system,Roboto,sans-serif;padding:28px 20px}' +
      'h1{color:#efc13f;font-size:22px;margin:0 0 14px}p{margin:0 0 14px}.dim{color:#9a937c;font-size:14px}' +
      'button,a.b{display:block;width:100%;max-width:420px;box-sizing:border-box;margin:0 0 12px;border-radius:24px;padding:13px 18px;font:600 16px system-ui,sans-serif;text-align:center;text-decoration:none;cursor:pointer}' +
      '.p{background:#d4af37;color:#120e00;border:0}.g{background:none;color:#efc13f;border:1px solid #d4af37}' +
      '#st{color:#efc13f;min-height:24px;margin:6px 0 16px}</style></head><body>' + html + '</body>';
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function st(t) { var e = document.getElementById("st"); if (e) e.textContent = t; }
  function $(id) { return document.getElementById(id); }

  /* ---------- reading and writing the data ---------- */
  function mine(k) { return (C.ls || []).some(function (p) { return k.indexOf(p) === 0; }); }
  function req(r) { return new Promise(function (res, rej) { r.onsuccess = function () { res(r.result); }; r.onerror = function () { rej(r.error); }; }); }
  async function exportAll() {
    var out = { app: C.name, at: Date.now(), ls: {}, idb: [] };
    for (var i = 0; i < localStorage.length; i++) { var k = localStorage.key(i); if (mine(k)) out.ls[k] = localStorage.getItem(k); }
    for (var n = 0; n < (C.idb || []).length; n++) {
      var name = C.idb[n];
      if (indexedDB.databases) { var list = await indexedDB.databases(); if (!list.some(function (d) { return d.name === name; })) continue; }
      var db = await req(indexedDB.open(name)), d = { name: name, version: db.version, stores: [] };
      for (var s = 0; s < db.objectStoreNames.length; s++) {
        var sn = db.objectStoreNames[s], os = db.transaction(sn, "readonly").objectStore(sn);
        var info = { name: sn, keyPath: os.keyPath, autoIncrement: os.autoIncrement, indexes: [] };
        for (var x = 0; x < os.indexNames.length; x++) { var ix = os.index(os.indexNames[x]); info.indexes.push({ name: ix.name, keyPath: ix.keyPath, unique: ix.unique, multiEntry: ix.multiEntry }); }
        var t = db.transaction(sn, "readonly").objectStore(sn);
        info.keys = await req(t.getAllKeys()); info.values = await req(db.transaction(sn, "readonly").objectStore(sn).getAll());
        d.stores.push(info);
      }
      db.close(); out.idb.push(d);
    }
    return out;
  }
  async function importAll(data) {
    Object.keys(data.ls || {}).forEach(function (k) { localStorage.setItem(k, data.ls[k]); });
    for (var n = 0; n < (data.idb || []).length; n++) {
      var d = data.idb[n];
      await req(indexedDB.deleteDatabase(d.name)).catch(function () {});
      var open = indexedDB.open(d.name, d.version || 1);
      open.onupgradeneeded = function () {
        var db = open.result;
        d.stores.forEach(function (s) {
          var os = db.createObjectStore(s.name, s.keyPath != null ? { keyPath: s.keyPath, autoIncrement: s.autoIncrement } : { autoIncrement: s.autoIncrement });
          s.indexes.forEach(function (ix) { os.createIndex(ix.name, ix.keyPath, { unique: ix.unique, multiEntry: ix.multiEntry }); });
        });
      };
      var db = await req(open);
      for (var s = 0; s < d.stores.length; s++) {
        var S = d.stores[s];
        await new Promise(function (res, rej) {
          var tx = db.transaction(S.name, "readwrite"), os = tx.objectStore(S.name);
          S.values.forEach(function (v, i) { if (S.keyPath != null) os.put(v); else os.put(v, S.keys[i]); });
          tx.oncomplete = res; tx.onerror = function () { rej(tx.error); };
        });
      }
      db.close();
    }
  }
  /* a file can't hold Blobs (photos etc.) directly: turn them into data: URLs and back */
  async function toJSON(v) {
    if (v instanceof Blob) return { __blob: await new Promise(function (r) { var f = new FileReader(); f.onload = function () { r(f.result); }; f.readAsDataURL(v); }) };
    if (Array.isArray(v)) { var a = []; for (var i = 0; i < v.length; i++) a.push(await toJSON(v[i])); return a; }
    if (v && typeof v === "object" && !(v instanceof Date)) { var o = {}; for (var k in v) o[k] = await toJSON(v[k]); return o; }
    return v;
  }
  async function fromJSON(v) {
    if (v && typeof v === "object" && typeof v.__blob === "string") return await (await fetch(v.__blob)).blob();
    if (Array.isArray(v)) { var a = []; for (var i = 0; i < v.length; i++) a.push(await fromJSON(v[i])); return a; }
    if (v && typeof v === "object") { var o = {}; for (var k in v) o[k] = await fromJSON(v[k]); return o; }
    return v;
  }
  function count(d) { var n = Object.keys(d.ls).length; d.idb.forEach(function (x) { x.stores.forEach(function (s) { n += s.values.length; }); }); return n; }

  /* ---------- old address: hand over ---------- */
  if (OLD) {
    /* the old copy must never look like the app - otherwise two installed icons can't be told apart */
    page('<div style="display:inline-block;background:#8b1e1e;color:#fff;font-weight:800;letter-spacing:2px;border-radius:8px;padding:6px 14px;margin-bottom:14px">OLD COPY</div>' +
      '<h1>' + esc(C.name) + ' has moved</h1>' +
      '<p>This is the old copy. The app now has its own address, so it no longer shares storage or installs with the other DSR apps:</p>' +
      '<p><b style="color:#efc13f">' + esc(C.to.replace(/^https:\/\//, "").replace(/\/$/, "")) + '</b></p>' +
      '<div id="st"></div>' +
      '<div id="moveBtns" style="display:none"><button class="p" id="go">Move my data and open the new app</button>' +
      '<button class="g" id="file">Save my data as a file instead</button></div>' +
      '<a class="b p" id="skip" href="' + esc(C.to) + '">Open the new app</a>' +
      '<p style="margin-top:18px"><b style="color:#efc13f">Then remove this old copy:</b> long-press its icon › <b>Uninstall</b>. If Android asks about data in Chrome, tap <b>Keep Data</b> - that storage still holds your other DSR apps.</p>');
    document.title = "OLD – " + C.name;
    var data = null;
    exportAll().then(function (d) {
      data = d; var n = count(d);
      if (n) { $("moveBtns").style.display = ""; $("skip").className = "b g"; $("skip").textContent = "Open the new app without moving anything"; st("Ready to move " + n + " saved item" + (n > 1 ? "s" : "") + "."); }
    })
      .catch(function (e) { st("Couldn't read the data here: " + e.message); });
    /* the hand-over goes through dsr-move-relay (our own Cloudflare Worker): this page uploads the data under a
       one-time code and opens the new address with it; the new address collects it and deletes it. No pop-up
       windows (unreliable from an installed app), and nothing left behind (it expires after 10 minutes anyway). */
    $("go").onclick = async function () {
      if (!data) return;
      this.disabled = true;
      try {
        st("Packing…");
        var json = JSON.stringify(await toJSON(data)), code = "", b = new Uint8Array(16);
        crypto.getRandomValues(b); b.forEach(function (x) { code += (x + 256).toString(16).slice(1); });
        var size = 19 * 1024 * 1024, parts = Math.max(1, Math.ceil(json.length / size));
        for (var i = 0; i < parts; i++) {
          st("Sending… " + Math.round(i / parts * 100) + "%");
          await put(code + "/" + i, json.slice(i * size, (i + 1) * size));
        }
        await put(code + "/meta", JSON.stringify({ parts: parts, app: C.name }));
        st("Sent ✓ - opening the new app…");
        location.href = C.to + "#dsr-move-in=" + code;
      } catch (e) { st("Couldn't send it (" + e.message + "). Check you're online, or use \"Save my data as a file\"."); this.disabled = false; }
    };
    $("file").onclick = async function () {
      if (!data) return; st("Making the file…");
      var json = JSON.stringify(await toJSON(data)), a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([json], { type: "application/json" }));
      a.download = C.name.replace(/\s+/g, "-") + "-data.json"; document.body.appendChild(a); a.click(); a.remove();
      st("Saved to Downloads. Now open the new app's address and add #dsr-move-in, or tap below.");
      $("skip").href = C.to + "#dsr-move-in"; $("skip").textContent = "Open the new app to import the file";
    };
    return;
  }

  /* ---------- new address: receive ---------- */
  var CODE = (location.hash.match(/=([0-9a-f]{32})$/) || [])[1];
  page('<h1>Bringing your data into ' + esc(C.name) + '</h1><div id="st">' + (CODE ? "Collecting your data…" : "Choose the data file you saved from the old app.") + '</div>' +
    '<div id="after"></div>' +
    '<button class="g" id="pick">Choose a saved data file instead</button><input type="file" id="f" accept=".json,application/json" style="display:none">' +
    '<a class="b g" href="' + esc(location.pathname) + '">Cancel - just open the app</a>');
  history.replaceState(null, "", location.pathname + "#dsr-move-in");   // the code is used once
  function done(n) {
    st("Done ✓ " + n + " item" + (n === 1 ? "" : "s") + " moved.");
    $("pick").style.display = "none";
    $("after").innerHTML = '<p>Now install the app from here if it isn\'t already: Chrome ⋮ › <b>Add to home screen</b> › <b>Install</b>. Then uninstall the old copy (tap <b>Keep Data</b> if asked).</p>' +
      '<a class="b p" href="' + esc(location.pathname) + '">Open ' + esc(C.name) + '</a>';
  }
  async function take(d) {
    try { await importAll(d); done(count(d)); } catch (e) { st("Couldn't store it: " + e.message); }
  }
  async function getPart(k) {
    for (var tries = 0; tries < 8; tries++) {           // a just-written part can take a moment to show up
      var r = await fetch(RELAY + CODE + "/" + k, { cache: "no-store" });
      if (r.ok) return await r.text();
      await new Promise(function (res) { setTimeout(res, 1500); });
    }
    throw new Error("the data wasn't there (it expires 10 minutes after sending) - send it again from the old app");
  }
  if (CODE) (async function () {
    try {
      var meta = JSON.parse(await getPart("meta")), json = "";
      for (var i = 0; i < meta.parts; i++) { st("Collecting your data… " + Math.round(i / meta.parts * 100) + "%"); json += await getPart(i); }
      st("Storing…");
      var d = await fromJSON(JSON.parse(json));
      await importAll(d);
      fetch(RELAY + CODE, { method: "DELETE" }).catch(function () {});
      done(count(d));
    } catch (e) { st("Couldn't bring it over: " + e.message); }
  })();
  $("pick").onclick = function () { $("f").click(); };
  $("f").onchange = async function () {
    var f = this.files[0]; if (!f) return; st("Reading the file…");
    try { take(await fromJSON(JSON.parse(await f.text()))); } catch (e) { st("That file couldn't be read: " + e.message); }
  };
})();
