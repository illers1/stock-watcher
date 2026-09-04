/* Group Watchlist — the third window.

   The other two windows keep everything in this browser. This one does not:
   the list lives on the server under a group code, and everybody holding the
   link edits the same one. The code sits in the URL fragment, which browsers
   never transmit, and every API call is a POST, so the code stays out of query
   strings, access logs and Referer headers. It is the only credential there
   is.

   What stays local: the rating weights, the horizon, and the name you type in.
   What is shared: the symbols, and who each one is credited to. */

import { parseAnalysis } from "./analyze.mjs";
import { scoreAnalysis, scoreBand, FACTORS, PRESETS, DEFAULT_HORIZON_DAYS } from "./score.mjs";
import { renderDetail } from "./detail.mjs";

(function () {
  "use strict";

  var PREF_KEY = "stockwatcher.prefs.v1";        // shared with the other windows
  var NAME_KEY = "stockwatcher.name.v1";
  var LAST_GROUP_KEY = "stockwatcher.group.v1";  // so a bare /group.html reopens it

  var ANALYSIS_TTL_MS = 30 * 60 * 1000;
  var ANALYSIS_CONCURRENCY = 3;
  var QUOTE_MS = 60000;    // live prices
  var POLL_MS = 20000;     // has anybody else changed the list?

  var els = {};
  ["gate", "room", "create", "join-form", "join-code", "room-code", "display-name",
   "copy", "leave", "add-form", "symbol-input", "suggestions", "banner", "status",
   "refresh", "summary", "sum-count", "sum-up", "sum-down", "sum-avg", "quotes",
   "rows", "empty", "table-wrap", "weights", "presets", "sliders", "preset-name",
   "horizon", "horizon-out", "detail-panel", "dp-backdrop"].forEach(function (id) {
    els[id.replace(/-(\w)/g, function (m, c) { return c.toUpperCase(); })] =
      document.getElementById(id);
  });

  var prefs = load(PREF_KEY, {
    preset: "sprint", weights: null, horizonDays: DEFAULT_HORIZON_DAYS,
    sortKey: null, sortDir: -1,
  });
  if (!prefs.weights) prefs.weights = Object.assign({}, PRESETS.sprint.weights);
  if (!prefs.horizonDays) prefs.horizonDays = DEFAULT_HORIZON_DAYS;
  if (!prefs.preset) prefs.preset = "sprint";

  var code = null;
  var entries = [];      // [{symbol, addedBy, at}] as the server has it
  var revision = -1;
  var quotes = {};
  var lastPrice = {};
  var analyses = {};
  var scores = {};
  var analysing = {};
  var openSymbol = null;
  var myName = loadName();
  var quoteTimer = null;
  var pollTimer = null;

  function load(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      if (!raw) return fallback;
      var val = JSON.parse(raw);
      return val && typeof val === "object" ? Object.assign({}, fallback, val) : fallback;
    } catch (e) { return fallback; }
  }
  function save(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* private mode */ }
  }
  function loadName() {
    try { return localStorage.getItem(NAME_KEY) || ""; } catch (e) { return ""; }
  }

  function symbols() {
    return entries.map(function (e) { return e.symbol; });
  }

  /* ---------------- formatting ---------------- */

  function fmtPrice(v) {
    if (v === null || v === undefined) return "—";
    var digits = Math.abs(v) !== 0 && Math.abs(v) < 1 ? 4 : 2;
    return v.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
  }
  function fmtSigned(v) {
    if (v === null || v === undefined) return "—";
    return (v > 0 ? "+" : v < 0 ? "−" : "") + fmtPrice(Math.abs(v));
  }
  function fmtPct(v) {
    if (v === null || v === undefined) return "—";
    return (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(2) + "%";
  }
  function fmtBig(v) {
    if (v === null || v === undefined) return "—";
    var units = [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "K"]];
    for (var i = 0; i < units.length; i++) {
      if (Math.abs(v) >= units[i][0]) {
        var n = v / units[i][0];
        return n.toFixed(Math.abs(n) >= 100 ? 0 : Math.abs(n) >= 10 ? 1 : 2) + units[i][1];
      }
    }
    return String(Math.round(v));
  }
  function dirClass(v) {
    if (v === null || v === undefined || v === 0) return "flat";
    return v > 0 ? "up" : "down";
  }
  function esc(s) {
    return String(s === null || s === undefined ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function fmtCode(c) {
    return c && c.length === 10 ? c.slice(0, 5) + "-" + c.slice(5) : String(c || "—");
  }

  /* ---------------- the group API ---------------- */

  /* POST for everything, including reads: the code must not appear in a URL. */
  function api(body) {
    return fetch("/api/group", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(function (r) { return r.json(); });
  }

  /* Every response carries the whole list and its revision, so a reply that
     arrives out of order is dropped: an older revision for the group we are
     already in can only be a slower request overtaking a newer one, and
     applying it would flicker somebody's symbol back onto the screen. */
  function adopt(data) {
    if (!data || data.error) throw new Error(data && data.error ? data.error : "no data");
    if (data.code === code && data.revision < revision) return false;
    var moved = data.revision !== revision;
    code = data.code;
    entries = data.symbols || [];
    revision = data.revision;
    return moved;
  }

  function openGroup(next) {
    return api({ action: "get", code: next })
      .then(function (data) {
        adopt(data);
        save(LAST_GROUP_KEY, { code: code });
        if (location.hash.slice(1) !== code) location.hash = code;
        showRoom();
        render();
        setStatus("Joined group " + fmtCode(code));
        return refreshQuotes().then(analyseAll);
      })
      .catch(function (err) {
        showGate();
        setBanner(err.message);
      });
  }

  function createGroup() {
    els.create.classList.add("busy");
    return api({ action: "create" })
      .then(function (data) {
        adopt(data);
        save(LAST_GROUP_KEY, { code: code });
        location.hash = code;
        showRoom();
        render();
        setStatus("Group " + fmtCode(code) + " created — send the link to your friends");
        setBanner("");
      })
      .catch(function (err) { setBanner("Could not create a group (" + err.message + ")"); })
      .then(function () { els.create.classList.remove("busy"); });
  }

  /** Every edit returns the whole list, so the answer is also the refresh.
      Deliberately not serialised: typing two symbols in quick succession must
      not drop the second, and out-of-order replies are handled by `adopt`. */
  function edit(action, symbol) {
    return api({ action: action, code: code, symbol: symbol, by: myName })
      .then(function (data) {
        adopt(data);
        render();
        setBanner("");
        setStatus(symbol + (action === "add" ? " added" : " removed") + " for everyone");
        if (action === "add") {
          // The price and the rating follow on their own; neither should hold
          // up the next thing the person types.
          refreshQuotes();
          analyseSymbol(symbol);
        }
      })
      .catch(function (err) { setBanner(err.message); });
  }

  /* Somebody else may have changed the list. Only re-render when the revision
     actually moved, so a poll costs nothing visible. */
  function poll() {
    if (!code || document.hidden) return Promise.resolve();
    return api({ action: "get", code: code })
      .then(function (data) {
        if (!adopt(data)) return;
        render();
        setStatus("List updated by someone in the group");
        return refreshQuotes().then(analyseAll);
      })
      .catch(function () { /* a missed poll is not worth a banner */ });
  }

  /* ---------------- quotes ---------------- */

  function refreshQuotes() {
    var list = symbols();
    if (!list.length) { render(); return Promise.resolve(); }
    return fetch("/api/quotes?symbols=" + encodeURIComponent(list.join(",")))
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (data) {
        (data.quotes || []).forEach(function (q) {
          if (q && q.symbol) quotes[q.symbol.toUpperCase()] = q;
        });
        render();
        if (!data.error) {
          setStatus("Updated " + new Date().toLocaleTimeString([], {
            hour: "2-digit", minute: "2-digit", second: "2-digit" }));
        }
      })
      .catch(function () { setStatus("Could not reach the quote service", true); });
  }

  /* ---------------- analysis ---------------- */

  function rescore() {
    scores = {};
    Object.keys(analyses).forEach(function (sym) {
      var model = analyses[sym] && analyses[sym].model;
      if (model) scores[sym] = scoreAnalysis(model, prefs.weights, prefs.horizonDays);
    });
  }

  function analyseSymbol(sym) {
    if (analysing[sym]) return Promise.resolve();
    var cached = analyses[sym];
    if (cached && cached.model && Date.now() - cached.at < ANALYSIS_TTL_MS) return Promise.resolve();
    analysing[sym] = true;
    render();

    return fetch("/api/analysis?symbol=" + encodeURIComponent(sym))
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d || d.error) throw new Error(d && d.error ? d.error : "no data");
        analyses[sym] = { at: Date.now(), model: parseAnalysis(d.sources, sym, null) };
        scores[sym] = scoreAnalysis(analyses[sym].model, prefs.weights, prefs.horizonDays);
      })
      .catch(function () { analyses[sym] = { at: Date.now(), model: null, failed: true }; })
      .then(function () {
        delete analysing[sym];
        render();
        if (openSymbol === sym) openDetail(sym);
      });
  }

  function analyseAll() {
    var queue = symbols().filter(function (s) {
      var c = analyses[s];
      return !analysing[s] && !(c && (c.model || c.failed));
    });
    if (!queue.length) return Promise.resolve();

    var index = 0;
    function next() {
      if (index >= queue.length) return Promise.resolve();
      return analyseSymbol(queue[index++]).then(next);
    }
    var lanes = [];
    for (var i = 0; i < Math.min(ANALYSIS_CONCURRENCY, queue.length); i++) lanes.push(next());
    return Promise.all(lanes);
  }

  /* ---------------- rendering ---------------- */

  function showGate() {
    els.gate.hidden = false;
    els.room.hidden = true;
    stopTimers();
    setStatus("Not in a group");
  }

  function showRoom() {
    els.gate.hidden = true;
    els.room.hidden = false;
    els.roomCode.textContent = fmtCode(code);
    els.displayName.value = myName;
    startTimers();
  }

  function startTimers() {
    stopTimers();
    quoteTimer = setInterval(refreshQuotes, QUOTE_MS);
    pollTimer = setInterval(poll, POLL_MS);
  }
  function stopTimers() {
    if (quoteTimer) clearInterval(quoteTimer);
    if (pollTimer) clearInterval(pollTimer);
    quoteTimer = pollTimer = null;
  }

  function ordered() {
    var list = entries.map(function (e) {
      var q = quotes[e.symbol];
      return Object.assign({ symbol: e.symbol, addedBy: e.addedBy, pending: !q },
        q || {}, { symbol: e.symbol, addedBy: e.addedBy });
    });
    if (!prefs.sortKey) return list;
    var key = prefs.sortKey, dir = prefs.sortDir;
    return list.slice().sort(function (a, b) {
      if (key === "symbol") return String(a.symbol).localeCompare(String(b.symbol)) * dir;
      if (key === "addedBy") {
        return String(a.addedBy || "~").localeCompare(String(b.addedBy || "~")) * dir;
      }
      var av = key === "score" ? (scores[a.symbol] ? scores[a.symbol].overall : null) : a[key];
      var bv = key === "score" ? (scores[b.symbol] ? scores[b.symbol].overall : null) : b[key];
      var am = av === null || av === undefined, bm = bv === null || bv === undefined;
      if (am && bm) return 0;
      if (am) return 1;
      if (bm) return -1;
      return (av - bv) * dir;
    });
  }

  function rowHtml(q) {
    var sym = q.symbol;
    var removeCell = '<td class="act"><button class="remove" data-remove="' + esc(sym) +
      '" title="Remove ' + esc(sym) + ' for everyone" aria-label="Remove ' + esc(sym) +
      ' for everyone">×</button></td>';
    var by = '<td class="by sub col-hide">' +
      (q.addedBy ? esc(q.addedBy) : '<span class="unclaimed">someone</span>') + '</td>';

    if (q.pending) {
      return '<tr data-symbol="' + esc(sym) + '"><td class="sym"><span class="sym-code">' +
        esc(sym) + '</span></td><td colspan="6" class="sub">Loading…</td>' + removeCell + '</tr>';
    }
    if (q.error) {
      return '<tr class="err" data-symbol="' + esc(sym) + '">' +
        '<td class="sym"><span class="sym-code">' + esc(sym) + '</span>' +
        '<span class="sym-name err-text">' + esc(q.error) + '</span></td>' +
        '<td colspan="6" class="sub">No quote available — check the symbol, then remove it.</td>' +
        removeCell + '</tr>';
    }

    var dir = dirClass(q.change);
    var prev = lastPrice[sym];
    var tick = (prev !== undefined && prev !== null && q.price !== null && q.price !== prev)
      ? (q.price > prev ? "tick-up" : "tick-down") : "";
    lastPrice[sym] = q.price;

    return '<tr class="' + tick + '" data-symbol="' + esc(sym) + '">' +
      '<td class="sym"><span class="sym-code">' + esc(sym) + '</span>' +
        '<span class="sym-name" title="' + esc(q.name) + '">' + esc(q.name) + '</span></td>' +
      '<td class="price">' + fmtPrice(q.price) + '<span class="cur">' + esc(q.currency) + '</span></td>' +
      '<td class="' + dir + ' chg">' + fmtSigned(q.change) + '</td>' +
      '<td class="pct"><span class="pill ' + dir + '">' + fmtPct(q.changePercent) + '</span></td>' +
      by +
      '<td class="sub col-hide">' + fmtBig(q.marketCap) + '</td>' +
      scoreCell(sym) +
      removeCell + '</tr>';
  }

  function scoreCell(sym) {
    if (analysing[sym]) return '<td class="score"><span class="score-wait">•••</span></td>';
    var sc = scores[sym];
    if (!sc || sc.overall === null || sc.overall === undefined) {
      var failed = analyses[sym] && analyses[sym].failed;
      return '<td class="score"><span class="sub">' + (failed ? "n/a" : "—") + '</span></td>';
    }
    var band = scoreBand(sc.overall);
    var thin = sc.confidence < 0.6 ? " score-thin" : "";
    return '<td class="score"><span class="score-badge tone-' + band.tone + thin +
      '" title="' + esc(band.label) + ' · confidence ' + Math.round(sc.confidence * 100) +
      '%">' + Math.round(sc.overall) + '</span></td>';
  }

  function render() {
    els.empty.hidden = entries.length > 0;
    els.tableWrap.hidden = entries.length === 0;
    els.summary.hidden = entries.length === 0;
    els.rows.innerHTML = ordered().map(rowHtml).join("");
    renderSummary();
    renderSortIndicator();
  }

  function renderSummary() {
    var live = symbols().map(function (s) { return quotes[s]; }).filter(function (q) {
      return q && !q.error && q.changePercent !== null && q.changePercent !== undefined;
    });
    var up = 0, down = 0, total = 0;
    live.forEach(function (q) {
      if (q.changePercent > 0) up++; else if (q.changePercent < 0) down++;
      total += q.changePercent;
    });
    var avg = live.length ? total / live.length : null;
    els.sumCount.textContent = entries.length;
    els.sumUp.textContent = up;
    els.sumDown.textContent = down;
    els.sumAvg.textContent = fmtPct(avg);
    els.sumAvg.className = "stat-value " + dirClass(avg);
  }

  function renderSortIndicator() {
    Array.prototype.forEach.call(els.quotes.querySelectorAll("th[data-sort]"), function (th) {
      var label = th.dataset.label || th.textContent.trim();
      th.dataset.label = label;
      th.textContent = label + (prefs.sortKey === th.dataset.sort
        ? (prefs.sortDir > 0 ? " ▲" : " ▼") : "");
    });
  }

  function setStatus(text, isError) {
    els.status.textContent = text;
    els.status.className = "status" + (isError ? " err" : "");
  }
  function setBanner(text) {
    els.banner.textContent = text || "";
    els.banner.hidden = !text;
  }

  /* ---------------- detail panel ---------------- */

  function openDetail(sym) {
    var entry = analyses[sym];
    openSymbol = sym;
    els.dpBackdrop.hidden = false;
    els.detailPanel.hidden = false;
    document.body.classList.add("panel-open");

    if (!entry || !entry.model) {
      els.detailPanel.innerHTML =
        '<header class="dp-head"><div><h2>' + esc(sym) + '</h2>' +
        '<p class="dp-sub">' + (entry && entry.failed ? "Analysis unavailable" : "Analysing…") + '</p></div>' +
        '<button class="dp-close" data-close aria-label="Close">×</button></header>' +
        (entry && entry.failed
          ? '<p class="muted" style="padding:20px">Could not load analysis for this symbol. It may not be a US-listed equity.</p>'
          : '<div class="dp-loading"><span></span><span></span><span></span></div>');
      if (!entry) analyseSymbol(sym);
      return;
    }
    els.detailPanel.innerHTML = renderDetail(entry.model, scores[sym] ||
      scoreAnalysis(entry.model, prefs.weights, prefs.horizonDays), prefs, rankOf(sym));
    els.detailPanel.scrollTop = 0;
  }

  function rankOf(sym) {
    var ranked = symbols()
      .filter(function (s) { return scores[s] && scores[s].overall !== null; })
      .sort(function (a, b) { return scores[b].overall - scores[a].overall; });
    var i = ranked.indexOf(sym);
    return i === -1 ? null
      : { position: i + 1, total: ranked.length, of: "on the group list" };
  }

  function closeDetail() {
    openSymbol = null;
    els.detailPanel.hidden = true;
    els.dpBackdrop.hidden = true;
    document.body.classList.remove("panel-open");
  }

  /* ---------------- weight controls ---------------- */

  function renderWeightControls() {
    els.presets.innerHTML = Object.keys(PRESETS).map(function (key) {
      return '<button type="button" class="preset' + (prefs.preset === key ? " on" : "") +
        '" data-preset="' + key + '">' + esc(PRESETS[key].label) + '</button>';
    }).join("");
    els.sliders.innerHTML = FACTORS.map(function (f) {
      var w = Number(prefs.weights[f.key] || 0);
      return '<label class="slider" title="' + esc(f.hint) + '">' +
        '<span class="sl-name">' + esc(f.label) + '</span>' +
        '<input type="range" min="0" max="40" step="1" value="' + w + '" data-weight="' + f.key + '">' +
        '<output>' + w + '</output></label>';
    }).join("");
    els.presetName.textContent = PRESETS[prefs.preset] ? PRESETS[prefs.preset].label : "Custom";
    els.horizon.value = String(prefs.horizonDays);
    els.horizonOut.textContent = prefs.horizonDays + " days";
  }

  function updateWeightOutputs() {
    Array.prototype.forEach.call(els.sliders.querySelectorAll("[data-weight]"), function (input) {
      var w = Number(prefs.weights[input.dataset.weight] || 0);
      var out = input.nextElementSibling;
      if (out && out.textContent !== String(w)) out.textContent = w;
      if (document.activeElement !== input && Number(input.value) !== w) input.value = String(w);
    });
    Array.prototype.forEach.call(els.presets.querySelectorAll("[data-preset]"), function (b) {
      b.classList.toggle("on", b.dataset.preset === prefs.preset);
    });
    els.presetName.textContent = PRESETS[prefs.preset] ? PRESETS[prefs.preset].label : "Custom";
    els.horizonOut.textContent = prefs.horizonDays + " days";
  }

  var panelTimer = null, saveTimer = null;

  function applyWeights(opts) {
    opts = opts || {};
    rescore();
    if (opts.rebuild) renderWeightControls();
    else updateWeightOutputs();
    render();
    if (openSymbol) {
      if (panelTimer) clearTimeout(panelTimer);
      panelTimer = setTimeout(function () { if (openSymbol) openDetail(openSymbol); }, 120);
    }
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () { save(PREF_KEY, prefs); }, 250);
  }

  /* ---------------- autocomplete ---------------- */

  /* Deliberately thinner than the watchlist's: no offline symbol list, just the
     upstream lookup, degrading to plain typing when it is rate-limited. */
  var suggestions = [], active = -1, searchTimer = null, searchSeq = 0;

  function closeSuggestions() {
    els.suggestions.hidden = true;
    els.suggestions.innerHTML = "";
    els.symbolInput.setAttribute("aria-expanded", "false");
    suggestions = [];
    active = -1;
  }

  function renderSuggestions() {
    if (!suggestions.length) return closeSuggestions();
    els.suggestions.innerHTML = suggestions.map(function (s, i) {
      return '<li role="option" data-index="' + i + '" aria-selected="' + (i === active) + '">' +
        '<span class="s-sym">' + esc(s.symbol) + '</span>' +
        '<span class="s-name">' + esc(s.name) + '</span>' +
        '<span class="s-ex">' + esc(s.exchange) + '</span></li>';
    }).join("");
    els.suggestions.hidden = false;
    els.symbolInput.setAttribute("aria-expanded", "true");
  }

  els.symbolInput.addEventListener("input", function () {
    var q = els.symbolInput.value.trim();
    if (searchTimer) clearTimeout(searchTimer);
    if (!q) return closeSuggestions();
    searchTimer = setTimeout(function () {
      var seq = ++searchSeq;
      fetch("/api/search?q=" + encodeURIComponent(q))
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (seq !== searchSeq || els.symbolInput.value.trim() !== q) return;
          suggestions = (data.results || []).slice(0, 8);
          active = -1;
          renderSuggestions();
        })
        .catch(function () { closeSuggestions(); });
    }, 200);
  });

  els.symbolInput.addEventListener("keydown", function (e) {
    if (els.suggestions.hidden) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      active += (e.key === "ArrowDown" ? 1 : -1);
      if (active < -1) active = suggestions.length - 1;
      if (active >= suggestions.length) active = -1;
      renderSuggestions();
    } else if (e.key === "Escape") {
      closeSuggestions();
    }
  });

  els.suggestions.addEventListener("mousedown", function (e) {
    var li = e.target.closest("li[data-index]");
    if (!li) return;
    e.preventDefault();
    edit("add", suggestions[Number(li.dataset.index)].symbol);
    els.symbolInput.value = "";
    closeSuggestions();
  });

  document.addEventListener("click", function (e) {
    if (!e.target.closest(".combo")) closeSuggestions();
  });

  /* ---------------- events ---------------- */

  els.create.addEventListener("click", createGroup);

  els.joinForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var raw = els.joinCode.value.toUpperCase().replace(/[\s\-_]/g, "");
    if (raw.length !== 10) { setBanner("A group code is ten characters, like FGHJK-MNPQR."); return; }
    setBanner("");
    openGroup(raw);
  });

  els.addForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var picked = active >= 0 && suggestions[active] ? suggestions[active].symbol
      : els.symbolInput.value.trim().toUpperCase();
    els.symbolInput.value = "";
    closeSuggestions();
    if (picked) edit("add", picked);
  });

  els.rows.addEventListener("click", function (e) {
    var btn = e.target.closest("[data-remove]");
    if (btn) { edit("remove", btn.dataset.remove); return; }
    var row = e.target.closest("tr[data-symbol]");
    if (row) openDetail(row.dataset.symbol);
  });

  els.displayName.addEventListener("input", function () {
    myName = els.displayName.value.slice(0, 24);
    // Only labels future additions; nothing already on the list is rewritten.
    try { localStorage.setItem(NAME_KEY, myName); } catch (err) { /* private mode */ }
  });

  els.copy.addEventListener("click", function () {
    var link = location.origin + location.pathname + "#" + code;
    var done = function () {
      els.copy.textContent = "Link copied";
      setTimeout(function () { els.copy.textContent = "Copy invite link"; }, 1600);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(link).then(done, function () { prompt("Copy this link:", link); });
    } else {
      prompt("Copy this link:", link);
    }
  });

  els.leave.addEventListener("click", function () {
    // Local only: the group and its list carry on without you.
    code = null;
    entries = [];
    revision = -1;
    quotes = {};
    save(LAST_GROUP_KEY, { code: null });
    location.hash = "";
    showGate();
    setBanner("");
  });

  els.refresh.addEventListener("click", function () {
    if (code) poll().then(refreshQuotes);
  });

  els.detailPanel.addEventListener("click", function (e) {
    if (e.target.closest("[data-close]")) closeDetail();
  });
  els.dpBackdrop.addEventListener("click", closeDetail);

  els.presets.addEventListener("click", function (e) {
    var btn = e.target.closest("[data-preset]");
    if (!btn || !PRESETS[btn.dataset.preset]) return;
    prefs.preset = btn.dataset.preset;
    prefs.weights = Object.assign({}, PRESETS[prefs.preset].weights);
    applyWeights({ rebuild: true });
  });

  els.sliders.addEventListener("input", function (e) {
    var input = e.target.closest("[data-weight]");
    if (!input) return;
    prefs.weights[input.dataset.weight] = Number(input.value);
    prefs.preset = "custom";
    applyWeights();
  });

  els.horizon.addEventListener("input", function () {
    prefs.horizonDays = Number(els.horizon.value);
    applyWeights();
  });

  els.quotes.querySelector("thead").addEventListener("click", function (e) {
    var th = e.target.closest("th[data-sort]");
    if (!th) return;
    var key = th.dataset.sort;
    if (prefs.sortKey === key) prefs.sortDir = -prefs.sortDir;
    else { prefs.sortKey = key; prefs.sortDir = (key === "symbol" || key === "addedBy") ? 1 : -1; }
    save(PREF_KEY, prefs);
    render();
  });

  document.addEventListener("keydown", function (e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    var tag = e.target.tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") {
      if (e.key === "Escape" && openSymbol) closeDetail();
      return;
    }
    if (e.key === "/" && !els.room.hidden) { e.preventDefault(); els.symbolInput.focus(); }
    else if (e.key === "r" || e.key === "R") { if (code) poll().then(refreshQuotes); }
    else if (e.key === "Escape" && openSymbol) closeDetail();
  });

  // Somebody may have edited the list while the tab sat in the background.
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden && code) poll();
  });

  // Following a second invite link in the same tab should switch groups.
  window.addEventListener("hashchange", function () {
    var next = location.hash.slice(1).toUpperCase().replace(/[\s\-_]/g, "");
    if (next.length === 10 && next !== code) openGroup(next);
  });

  /* ---------------- boot ---------------- */

  renderWeightControls();
  var fromHash = location.hash.slice(1).toUpperCase().replace(/[\s\-_]/g, "");
  var remembered = load(LAST_GROUP_KEY, { code: null }).code;
  var start = fromHash.length === 10 ? fromHash : remembered;

  if (start) {
    showRoom();
    setStatus("Opening group…");
    openGroup(start);
  } else {
    showGate();
  }
})();
