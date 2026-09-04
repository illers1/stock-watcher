/* Earnings Radar — the second window.

   The watchlist starts from symbols you chose; this starts from the calendar.
   Nasdaq's earnings feed says who reports and when, and every row is then put
   through exactly the same analysis and the same 0-100 rating as the watchlist,
   so a week of scheduled reports can be ranked rather than merely listed.

   Weights, the horizon and the watchlist itself are shared with index.html
   through the same localStorage keys, so the two windows never disagree. */

import { parseAnalysis } from "./analyze.mjs";
import { parseEarnings, summarise } from "./earnings-model.mjs";
import { scoreAnalysis, scoreBand, FACTORS, PRESETS, DEFAULT_HORIZON_DAYS } from "./score.mjs";
import { renderDetail } from "./detail.mjs";

(function () {
  "use strict";

  var STORE_KEY = "stockwatcher.symbols.v1";     // shared with the watchlist
  var PREF_KEY = "stockwatcher.prefs.v1";        // shared: weights, horizon, preset
  var EARN_KEY = "stockwatcher.earnings.v1";     // this window's own filters
  var ANALYSIS_KEY = "stockwatcher.analysis.v2"; // read-only here; see below

  var ANALYSIS_TTL_MS = 30 * 60 * 1000;
  var ANALYSIS_CONCURRENCY = 3;
  var RATE_BATCH = 12;          // how many rows a rating pass covers
  var QUOTE_LIMIT = 200;        // symbols worth a live price on one screen
  var QUOTE_CHUNK = 50;         // the quote feed takes the whole set at once

  var els = {};
  ["rows", "empty", "status", "banner", "refresh", "summary", "sum-count", "sum-bmo",
   "sum-amc", "sum-rated", "cal", "table-wrap", "weights", "presets", "sliders",
   "preset-name", "horizon", "horizon-out", "detail-panel", "dp-backdrop",
   "window", "session", "mincap", "query", "filters", "rate-more", "rate-btn",
   "rate-note"].forEach(function (id) {
    els[id.replace(/-(\w)/g, function (m, c) { return c.toUpperCase(); })] =
      document.getElementById(id);
  });

  var prefs = load(PREF_KEY, {
    preset: "sprint", weights: null, horizonDays: DEFAULT_HORIZON_DAYS,
  });
  if (!prefs.weights) prefs.weights = Object.assign({}, PRESETS.sprint.weights);
  if (!prefs.horizonDays) prefs.horizonDays = DEFAULT_HORIZON_DAYS;
  if (!prefs.preset) prefs.preset = "sprint";

  var filters = load(EARN_KEY, {
    days: 5, session: "", minCap: 2e9, query: "", sortKey: "date", sortDir: 1,
  });

  var watchlist = load(STORE_KEY, []);
  var all = [];          // every row the calendar returned, parsed
  var visible = [];      // what the filters leave, in sort order
  var quotes = {};       // symbol -> live quote
  var analyses = seedAnalyses();   // symbol -> {at, model, failed}
  var scores = {};       // symbol -> scored result
  var analysing = {};    // symbol -> true while in flight
  var openSymbol = null;
  var loading = false;

  function load(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      if (!raw) return fallback;
      var val = JSON.parse(raw);
      if (Array.isArray(fallback)) return Array.isArray(val) ? val : fallback;
      return val && typeof val === "object" ? Object.assign({}, fallback, val) : fallback;
    } catch (e) { return fallback; }
  }
  function save(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* private mode */ }
  }

  /* The watchlist window caches its analyses under ANALYSIS_KEY and prunes
     anything not on the watchlist. Reading it here is a free head start on the
     symbols already looked at; writing to it is not — a busy calendar week
     would fill the quota with hundreds of symbols only to have the other
     window drop them again. So: read on boot, keep the rest in memory. */
  function seedAnalyses() {
    var raw = load(ANALYSIS_KEY, {});
    var out = {};
    Object.keys(raw || {}).forEach(function (sym) {
      var entry = raw[sym];
      if (entry && entry.model && Date.now() - entry.at < ANALYSIS_TTL_MS) out[sym] = entry;
    });
    return out;
  }

  /* ---------------- formatting ---------------- */

  function fmtPrice(v) {
    if (v === null || v === undefined) return "—";
    var digits = Math.abs(v) !== 0 && Math.abs(v) < 1 ? 4 : 2;
    return v.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
  }
  function fmtPct(v, digits) {
    if (v === null || v === undefined) return "—";
    return (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(digits === undefined ? 2 : digits) + "%";
  }
  function fmtBig(v) {
    if (v === null || v === undefined) return "—";
    var units = [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "K"]];
    for (var i = 0; i < units.length; i++) {
      if (Math.abs(v) >= units[i][0]) {
        var n = v / units[i][0];
        return "$" + n.toFixed(Math.abs(n) >= 100 ? 0 : Math.abs(n) >= 10 ? 1 : 2) + units[i][1];
      }
    }
    return "$" + String(Math.round(v));
  }
  function fmtEps(v) {
    if (v === null || v === undefined) return "—";
    return (v < 0 ? "−$" : "$") + Math.abs(v).toFixed(2);
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

  var WEEKDAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  var MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  function dayLabel(iso, daysAway) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
    if (!m) return iso || "—";
    var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    var name = daysAway === 0 ? "Today" : daysAway === 1 ? "Tomorrow" : WEEKDAY[d.getDay()];
    return name + " " + MONTH[d.getMonth()] + " " + d.getDate();
  }

  /* ---------------- filtering and sorting ---------------- */

  function applyFilters() {
    var q = String(filters.query || "").trim().toLowerCase();
    var rows = all.filter(function (r) {
      if (filters.session && r.session.key !== filters.session) return false;
      // A row with no market cap at all is filtered out with the small caps:
      // Nasdaq omits it for shells and freshly listed names, and keeping them
      // would put the least knowable companies at the top of every screen.
      if (filters.minCap > 0 && !(r.marketCap >= filters.minCap)) return false;
      if (q && r.symbol.toLowerCase().indexOf(q) === -1 &&
          String(r.name).toLowerCase().indexOf(q) === -1) return false;
      return true;
    });
    visible = sortRows(rows);
  }

  function valueOf(row, key) {
    if (key === "score") return scores[row.symbol] ? scores[row.symbol].overall : null;
    if (key === "price" || key === "changePercent") {
      var q = quotes[row.symbol];
      return q && !q.error ? q[key] : null;
    }
    return row[key];
  }

  function sortRows(rows) {
    var key = filters.sortKey || "date", dir = filters.sortDir;
    return rows.slice().sort(function (a, b) {
      if (key === "symbol") return String(a.symbol).localeCompare(String(b.symbol)) * dir;
      if (key === "date") {
        var byDate = String(a.date).localeCompare(String(b.date)) * dir;
        // Within a day, the largest company is the one that moves the market.
        return byDate || ((b.marketCap || 0) - (a.marketCap || 0));
      }
      var av = valueOf(a, key), bv = valueOf(b, key);
      var aMissing = av === null || av === undefined;
      var bMissing = bv === null || bv === undefined;
      if (aMissing && bMissing) return (b.marketCap || 0) - (a.marketCap || 0);
      if (aMissing) return 1;
      if (bMissing) return -1;
      return (av - bv) * dir || ((b.marketCap || 0) - (a.marketCap || 0));
    });
  }

  /* ---------------- rendering ---------------- */

  function rowHtml(r) {
    var sym = r.symbol;
    var q = quotes[sym];
    var priced = q && !q.error;
    var onList = watchlist.indexOf(sym) !== -1;

    return '<tr data-symbol="' + esc(sym) + '">' +
      '<td class="sym"><span class="sym-code">' + esc(sym) + '</span>' +
        '<span class="sym-name" title="' + esc(r.name) + '">' + esc(r.name) + '</span></td>' +
      '<td class="when"><span class="when-day">' + esc(dayLabel(r.date, r.daysAway)) + '</span>' +
        '<span class="tag tag-' + r.session.key + '" title="' + esc(r.session.label) + '">' +
        esc(r.session.short) + '</span></td>' +
      '<td class="price">' + (priced ? fmtPrice(q.price) : '<span class="sub">—</span>') + '</td>' +
      '<td class="pct">' + (priced
        ? '<span class="pill ' + dirClass(q.changePercent) + '">' + fmtPct(q.changePercent) + '</span>'
        : '<span class="sub">—</span>') + '</td>' +
      '<td class="sub col-hide">' + fmtBig(r.marketCap) + '</td>' +
      '<td class="sub col-hide">' + fmtEps(r.epsForecast) +
        (r.estimates ? '<span class="ests">' + r.estimates + ' est</span>' : "") + '</td>' +
      '<td class="col-hide ' + dirClass(r.epsGrowth) + '">' + fmtPct(r.epsGrowth, 0) + '</td>' +
      scoreCell(sym) +
      '<td class="act"><button class="watch' + (onList ? " on" : "") +
        '" data-add="' + esc(sym) + '" title="' +
        (onList ? "On your watchlist" : "Add " + esc(sym) + " to your watchlist") +
        '" aria-label="' + (onList ? "On your watchlist" : "Add " + esc(sym) + " to your watchlist") +
        '">' + (onList ? "✓" : "+") + '</button></td>' +
      '</tr>';
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

  function dayHeaderHtml(row) {
    var onDay = visible.filter(function (r) { return r.date === row.date; }).length;
    return '<tr class="day-head"><td colspan="9">' +
      '<span class="dh-name">' + esc(dayLabel(row.date, row.daysAway)) + '</span>' +
      '<span class="dh-count">' + onDay + (onDay === 1 ? " company" : " companies") + '</span>' +
      '</td></tr>';
  }

  function render() {
    var grouped = (filters.sortKey || "date") === "date";
    var html = [];
    var lastDate = null;
    visible.forEach(function (r) {
      if (grouped && r.date !== lastDate) { html.push(dayHeaderHtml(r)); lastDate = r.date; }
      html.push(rowHtml(r));
    });
    els.rows.innerHTML = html.join("");

    els.empty.hidden = visible.length > 0 || loading;
    els.tableWrap.hidden = visible.length === 0;
    els.summary.hidden = all.length === 0;
    renderSummary();
    renderSortIndicator();
    renderRateButton();
  }

  function renderSummary() {
    var s = summarise(visible);
    var rated = visible.filter(function (r) {
      return scores[r.symbol] && scores[r.symbol].overall !== null;
    }).length;
    els.sumCount.textContent = s.count;
    els.sumBmo.textContent = s.bmo;
    els.sumAmc.textContent = s.amc;
    els.sumRated.textContent = rated + " / " + s.count;
  }

  function renderSortIndicator() {
    Array.prototype.forEach.call(els.cal.querySelectorAll("th[data-sort]"), function (th) {
      var label = th.dataset.label || th.textContent.trim();
      th.dataset.label = label;
      th.textContent = label + (filters.sortKey === th.dataset.sort
        ? (filters.sortDir > 0 ? " ▲" : " ▼") : "");
    });
  }

  function unrated() {
    return visible.filter(function (r) {
      var c = analyses[r.symbol];
      return !analysing[r.symbol] && !(c && (c.model || c.failed));
    });
  }

  function renderRateButton() {
    var left = unrated().length;
    els.rateMore.hidden = visible.length === 0 || left === 0;
    els.rateBtn.textContent = "Rate the next " + Math.min(RATE_BATCH, left);
    els.rateNote.textContent = left + " of " + visible.length + " still unrated — " +
      "each one is a full analysis, so they are fetched a batch at a time.";
  }

  function setStatus(text, isError) {
    els.status.textContent = text;
    els.status.className = "status" + (isError ? " err" : "");
  }
  function setBanner(text) {
    els.banner.textContent = text || "";
    els.banner.hidden = !text;
  }

  /* ---------------- data ---------------- */

  function loadCalendar() {
    loading = true;
    els.refresh.classList.add("busy");
    setStatus("Loading the calendar…");

    return fetch("/api/earnings?days=" + encodeURIComponent(filters.days))
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (data) {
        if (data.error) throw new Error(data.error);
        all = parseEarnings(data);
        applyFilters();
        rescore();
        render();
        setStatus(all.length + " companies · " + esc(data.from || "") + " to " + esc(data.to || ""));
        setBanner(data.truncated
          ? "The window was long enough to be cut short upstream; the last few days may be incomplete."
          : "");
        return fetchQuotes();
      })
      .then(function () { return rateBatch(); })
      .catch(function (err) {
        all = [];
        applyFilters();
        render();
        setStatus("Could not load the calendar", true);
        setBanner("Nasdaq's earnings calendar did not answer (" + err.message + "). " +
          "Press Refresh to try again.");
      })
      .then(function () {
        loading = false;
        els.refresh.classList.remove("busy");
        els.empty.hidden = visible.length > 0;
      });
  }

  /** Live prices for what is on screen, in chunks the quote feed accepts. */
  function fetchQuotes() {
    var wanted = visible.slice(0, QUOTE_LIMIT).map(function (r) { return r.symbol; })
      .filter(function (s) { return !quotes[s]; });
    if (!wanted.length) return Promise.resolve();

    var chunks = [];
    for (var i = 0; i < wanted.length; i += QUOTE_CHUNK) chunks.push(wanted.slice(i, i + QUOTE_CHUNK));

    return Promise.all(chunks.map(function (chunk) {
      return fetch("/api/quotes?symbols=" + encodeURIComponent(chunk.join(",")))
        .then(function (r) { return r.json(); })
        .then(function (d) {
          (d.quotes || []).forEach(function (q) {
            if (q && q.symbol) quotes[q.symbol.toUpperCase()] = q;
          });
        })
        .catch(function () { /* a missing price is not a missing row */ });
    })).then(function () { applyFilters(); render(); });
  }

  function rescore() {
    scores = {};
    Object.keys(analyses).forEach(function (sym) {
      var model = analyses[sym] && analyses[sym].model;
      if (model) scores[sym] = scoreAnalysis(model, prefs.weights, prefs.horizonDays);
    });
  }

  function eventFor(sym) {
    for (var i = 0; i < all.length; i++) if (all[i].symbol === sym) return all[i].event;
    return null;
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
        // The calendar already knows the date, so the catalyst factor is scored
        // from the row itself — no second trip to /api/calendar.
        var model = parseAnalysis(d.sources, sym, eventFor(sym));
        analyses[sym] = { at: Date.now(), model: model };
        scores[sym] = scoreAnalysis(model, prefs.weights, prefs.horizonDays);
      })
      .catch(function () {
        analyses[sym] = { at: Date.now(), model: null, failed: true };
      })
      .then(function () {
        delete analysing[sym];
        render();
        if (openSymbol === sym) openDetail(sym);
      });
  }

  /** Rate the next batch of visible rows, a few requests at a time. */
  function rateBatch() {
    var queue = unrated().slice(0, RATE_BATCH).map(function (r) { return r.symbol; });
    if (!queue.length) return Promise.resolve();
    setStatus("Rating " + queue.length + " companies…");

    var index = 0;
    function next() {
      if (index >= queue.length) return Promise.resolve();
      return analyseSymbol(queue[index++]).then(next);
    }
    var lanes = [];
    for (var i = 0; i < Math.min(ANALYSIS_CONCURRENCY, queue.length); i++) lanes.push(next());
    return Promise.all(lanes).then(function () {
      applyFilters();
      render();
      var left = unrated().length;
      setStatus(left ? left + " left to rate" : "All " + visible.length + " rated");
    });
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
          ? '<p class="muted" style="padding:20px">Could not load analysis for this symbol. Newly listed ' +
            'and foreign-domiciled companies often have no Nasdaq fundamentals behind the calendar entry.</p>'
          : '<div class="dp-loading"><span></span><span></span><span></span></div>');
      if (!entry) analyseSymbol(sym);
      return;
    }
    els.detailPanel.innerHTML = renderDetail(entry.model, scores[sym] ||
      scoreAnalysis(entry.model, prefs.weights, prefs.horizonDays), prefs, rankOf(sym));
    els.detailPanel.scrollTop = 0;
  }

  /** Rank against the rest of this window — the comparison the page is for. */
  function rankOf(sym) {
    var ranked = visible
      .map(function (r) { return r.symbol; })
      .filter(function (s) { return scores[s] && scores[s].overall !== null; })
      .sort(function (a, b) { return scores[b].overall - scores[a].overall; });
    var i = ranked.indexOf(sym);
    return i === -1 ? null
      : { position: i + 1, total: ranked.length, of: "rated in this window" };
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

  /* Update in place rather than rebuilding: replacing the element being dragged
     ends the drag after the first pixel. Only a preset change rebuilds. */
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
    applyFilters();
    render();

    if (openSymbol) {
      if (panelTimer) clearTimeout(panelTimer);
      panelTimer = setTimeout(function () { if (openSymbol) openDetail(openSymbol); }, 120);
    }
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () { save(PREF_KEY, prefs); }, 250);
  }

  /* ---------------- events ---------------- */

  els.filters.addEventListener("submit", function (e) { e.preventDefault(); });

  els.window.addEventListener("change", function () {
    filters.days = Number(els.window.value);
    save(EARN_KEY, filters);
    loadCalendar();
  });

  ["session", "mincap"].forEach(function (id) {
    els[id].addEventListener("change", function () {
      filters.session = els.session.value;
      filters.minCap = Number(els.mincap.value);
      save(EARN_KEY, filters);
      applyFilters();
      render();
      fetchQuotes();
    });
  });

  var queryTimer = null;
  els.query.addEventListener("input", function () {
    if (queryTimer) clearTimeout(queryTimer);
    queryTimer = setTimeout(function () {
      filters.query = els.query.value;
      save(EARN_KEY, filters);
      applyFilters();
      render();
    }, 150);
  });

  els.cal.querySelector("thead").addEventListener("click", function (e) {
    var th = e.target.closest("th[data-sort]");
    if (!th) return;
    var key = th.dataset.sort;
    if (filters.sortKey === key) filters.sortDir = -filters.sortDir;
    else { filters.sortKey = key; filters.sortDir = (key === "symbol" || key === "date") ? 1 : -1; }
    save(EARN_KEY, filters);
    applyFilters();
    render();
  });

  els.rows.addEventListener("click", function (e) {
    var add = e.target.closest("[data-add]");
    if (add) { e.stopPropagation(); toggleWatch(add.dataset.add); return; }
    var row = e.target.closest("tr[data-symbol]");
    if (row) openDetail(row.dataset.symbol);
  });

  function toggleWatch(sym) {
    var i = watchlist.indexOf(sym);
    if (i === -1) { watchlist.push(sym); setStatus(sym + " added to your watchlist"); }
    else { watchlist.splice(i, 1); setStatus(sym + " removed from your watchlist"); }
    save(STORE_KEY, watchlist);
    render();
  }

  els.rateBtn.addEventListener("click", function () { rateBatch(); });
  els.refresh.addEventListener("click", function () { if (!loading) loadCalendar(); });

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

  document.addEventListener("keydown", function (e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    var tag = e.target.tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") {
      if (e.key === "Escape" && openSymbol) closeDetail();
      return;
    }
    if (e.key === "/") { e.preventDefault(); els.query.focus(); }
    else if (e.key === "r" || e.key === "R") { if (!loading) loadCalendar(); }
    else if (e.key === "Escape" && openSymbol) closeDetail();
  });

  /* ---------------- boot ---------------- */

  els.window.value = String(filters.days);
  els.session.value = filters.session || "";
  els.mincap.value = String(filters.minCap);
  els.query.value = filters.query || "";
  renderWeightControls();
  render();
  loadCalendar();
})();
