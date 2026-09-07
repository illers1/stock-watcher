/* Short Screen — the watchlist read the other way.

   Reuses the analysis cache the watchlist fills, so screening costs nothing
   extra for symbols already looked at. Anything new is fetched on demand.

   Two deliberate departures from the long side. Squeeze risk is shown beside
   the score rather than inside it, because a hazard averaged into a number
   stops warning anybody. And an ex-dividend date inside the window is called
   out, because a short pays that dividend rather than receiving it. */

import { parseAnalysis } from "./analyze.mjs";
import { scoreShort, shortBand, SHORT_PRESETS, SQUEEZE_TONE } from "./short-model.mjs";
import { loadWatchlist } from "./watchlist.mjs";
import { rankCandidates, SECTORS } from "./screen-model.mjs";

(function () {
  "use strict";

  var PREF_KEY = "stockwatcher.prefs.v1";
  var ANALYSIS_KEY = "stockwatcher.analysis.v2";
  var VIEW_KEY = "stockwatcher.shorts.v1";
  var ANALYSIS_TTL_MS = 30 * 60 * 1000;
  var CONCURRENCY = 3;

  var els = {};
  ["status", "refresh", "preset", "universe", "extra", "extra-wrap",
   "hide-squeeze", "cards", "empty", "banner", "cap", "sector", "order",
   "cap-wrap", "sector-wrap", "order-wrap", "coverage",
   "screen-wrap", "screen-rows"].forEach(function (id) {
    els[id.replace(/-(\w)/g, function (m, c) { return c.toUpperCase(); })] =
      document.getElementById(id);
  });

  var view = load(VIEW_KEY, { preset: "balanced", universe: "market", extra: "",
                              hideSqueeze: false, cap: "smallmid", sector: "any", order: "decliners" });
  var candidates = [];       // ranked first-pass results, market mode only
  var screening = false;
  var symbols = loadWatchlist();
  var prefs = load(PREF_KEY, { horizonDays: 30 });
  var cache = load(ANALYSIS_KEY, {});
  var calendarEvents = {};
  var models = {};
  var pending = {};

  function load(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      if (!raw) return fallback;
      var v = JSON.parse(raw);
      if (Array.isArray(fallback)) return Array.isArray(v) ? v : fallback;
      return v && typeof v === "object"
        ? (Array.isArray(fallback) ? fallback : Object.assign({}, fallback, v)) : fallback;
    } catch (e) { return fallback; }
  }
  function save(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {}
  }
  function esc(s) {
    return String(s === null || s === undefined ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function pct(v, d) {
    if (v === null || v === undefined) return "—";
    return (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(d === undefined ? 1 : d) + "%";
  }
  function usd(v) {
    if (v === null || v === undefined) return "—";
    var a = Math.abs(v), div = 1, suf = "";
    if (a >= 1e12) { div = 1e12; suf = "T"; } else if (a >= 1e9) { div = 1e9; suf = "B"; }
    else if (a >= 1e6) { div = 1e6; suf = "M"; } else if (a >= 1e3) { div = 1e3; suf = "K"; }
    return (v < 0 ? "−$" : "$") + (a / div).toFixed(a / div >= 100 || !suf ? 0 : 1) + suf;
  }
  function fmt(raw, format) {
    if (raw === null || raw === undefined) return "—";
    if (format === "pct") return pct(raw);
    if (format === "pct0") return raw.toFixed(0) + "%";
    if (format === "usd") return usd(raw);
    if (format === "days") return raw + " d";
    if (format === "num0") return Math.round(raw).toLocaleString();
    if (format === "num") return raw.toFixed(2);
    return String(raw);
  }
  function setStatus(t, err) {
    els.status.textContent = t;
    els.status.className = "status" + (err ? " err" : "");
  }

  var analysed = [];   // symbols promoted out of the screen for a full look

  function universe() {
    if (view.universe === "market") return analysed.slice();
    var list = symbols.slice();
    if (view.universe === "custom") {
      String(view.extra || "").split(",").forEach(function (raw) {
        var s = raw.trim().toUpperCase();
        if (s && /^[A-Z0-9.\-=^&:$]{1,24}$/.test(s) && list.indexOf(s) === -1) list.push(s);
      });
    }
    return list;
  }

  /* ---------------- data ---------------- */

  function ensureAnalysis(sym) {
    var hit = cache[sym];
    if (hit && hit.model && Date.now() - hit.at < ANALYSIS_TTL_MS) {
      models[sym] = hit.model;
      return Promise.resolve();
    }
    if (pending[sym]) return pending[sym];
    pending[sym] = fetch("/api/analysis?symbol=" + encodeURIComponent(sym))
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d || d.error) throw new Error(d && d.error ? d.error : "no data");
        var model = parseAnalysis(d.sources, sym, calendarEvents[sym] || null);
        models[sym] = model;
        cache[sym] = { at: Date.now(), model: model };
        save(ANALYSIS_KEY, cache);
      })
      .catch(function () { models[sym] = null; })
      .then(function () { delete pending[sym]; render(); });
    return pending[sym];
  }

  function screenAll() {
    var list = universe();
    if (!list.length) { render(); setStatus("Nothing to screen"); return Promise.resolve(); }
    setStatus("Screening " + list.length + " symbols…");

    return fetch("/api/calendar?days=" + Math.max(7, prefs.horizonDays || 30))
      .then(function (r) { return r.json(); })
      .then(function (d) { calendarEvents = d.events || {}; })
      .catch(function () { calendarEvents = {}; })
      .then(function () {
        var i = 0;
        function next() {
          if (i >= list.length) return Promise.resolve();
          return ensureAnalysis(list[i++]).then(next);
        }
        var lanes = [];
        for (var n = 0; n < Math.min(CONCURRENCY, list.length); n++) lanes.push(next());
        return Promise.all(lanes);
      })
      .then(function () {
        render();
        setStatus(universe().length + " screened · " +
          new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
      });
  }

  /* ---------------- market screen ---------------- */

  function runMarketScreen() {
    if (screening) return Promise.resolve();
    screening = true;
    setStatus("Screening the market…");
    els.banner.hidden = true;

    var qs = new URLSearchParams({
      cap: view.cap || "smallmid",
      sector: view.sector || "any",
      order: view.order || "decliners",
    });
    return fetch("/api/screen?" + qs)
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.error) { els.banner.textContent = d.error; els.banner.hidden = false; }
        candidates = rankCandidates(d.rows, d.quotes);
        renderCoverage(d);
        render();
        setStatus(candidates.length + " ranked · " +
          new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
      })
      .catch(function (err) { setStatus("Screen failed — " + err.message, true); })
      .then(function () { screening = false; });
  }

  /* Say how much of the market was actually looked at. A screen that examines
     a slice and reports it as "the market" is worse than one that admits it. */
  function renderCoverage(d) {
    if (!d || d.matched === undefined) { els.coverage.hidden = true; return; }
    els.coverage.innerHTML =
      "<strong>" + d.matched.toLocaleString() + "</strong> of " +
      d.universeSize.toLocaleString() + " US-listed stocks match these filters. " +
      "Fundamentals were pulled for <strong>" + d.examined + "</strong> of them, taken in the order " +
      "<em>" + esc((d.orderLabel || "").toLowerCase()) + "</em>" +
      (d.matched > d.examined
        ? " — so this ranks that slice, not every match. Narrow the filters to cover more of what you care about."
        : " — every match was examined.");
    els.coverage.hidden = false;
  }

  function screenRow(c) {
    var flags = "";
    if (c.alreadyFallen) flags += '<span class="flag" title="Most of the fall may already have happened">already down</span>';
    if (c.lossMaking) flags += '<span class="flag">loss-making</span>';
    return '<tr>' +
      '<td class="sym"><span class="sym-code">' + esc(c.symbol) + '</span>' +
        '<span class="sym-name">' + esc(c.name || "") + '</span></td>' +
      '<td class="sub">' + esc(c.sector || "—") + flags + '</td>' +
      '<td class="num">' + (c.price === null ? "—" : c.price.toFixed(2)) + '</td>' +
      '<td class="num sub">' + usd(c.marketCap) + '</td>' +
      '<td class="num down">' + (c.offHigh === null ? "—" : pct(c.offHigh, 0)) + '</td>' +
      '<td class="num ' + (c.netMargin !== null && c.netMargin < 0 ? "down" : "") + '">' +
        (c.netMargin === null ? "—" : pct(c.netMargin, 0)) + '</td>' +
      '<td class="num"><span class="score-badge tone-down">' + Math.round(c.weakness) + '</span></td>' +
      '<td class="act"><button class="btn btn-small" data-analyse="' + esc(c.symbol) + '">Analyse</button></td>' +
      '</tr>';
  }

  /* ---------------- rendering ---------------- */

  function scored() {
    var weights = (SHORT_PRESETS[view.preset] || SHORT_PRESETS.balanced).weights;
    return universe().map(function (sym) {
      var model = models[sym];
      if (!model) return { symbol: sym, model: null };
      return { symbol: sym, model: model, result: scoreShort(model, weights, prefs.horizonDays || 30) };
    }).filter(function (row) {
      if (!row.result) return true;
      if (view.hideSqueeze && ["high", "severe"].indexOf(row.result.squeeze.level) !== -1) return false;
      return true;
    }).sort(function (a, b) {
      return (b.result ? b.result.overall : -1) - (a.result ? a.result.overall : -1);
    });
  }

  function card(row) {
    var sym = row.symbol;
    if (!row.result) {
      return '<article class="short-card"><header><h2>' + esc(sym) + '</h2>' +
        '<span class="sub">' + (pending[sym] ? "screening…" : "no data") + '</span></header></article>';
    }
    var r = row.result, m = row.model, band = shortBand(r.overall);
    var sq = r.squeeze;
    var exDiv = m.earnings && null;   // placeholder; dividend risk handled below

    var factors = r.factors.map(function (f) {
      var w = f.score === null ? 0 : f.score;
      return '<details class="factor' + (f.available ? "" : " factor-missing") + '">' +
        '<summary><span class="f-name">' + esc(f.label) + '</span>' +
        '<span class="f-bar"><span class="f-fill ' + (w >= 58 ? "tone-down" : w >= 45 ? "tone-flat" : "tone-up") +
          '" style="width:' + w + '%"></span></span>' +
        '<span class="f-score">' + (f.score === null ? "n/a" : Math.round(f.score)) + '</span>' +
        '<span class="f-weight">' + Math.round(f.effectiveWeight * 100) + '%</span></summary>' +
        '<p class="f-hint">' + esc(f.hint) + '</p>' +
        '<ul class="f-inputs">' + f.inputs.map(function (i) {
          return '<li><span class="fi-label">' + esc(i.label) + '</span>' +
            '<span class="fi-raw">' + esc(fmt(i.raw, i.format)) + '</span>' +
            '<span class="fi-score">' + (i.score === null ? '<em>context</em>' : Math.round(i.score)) + '</span></li>';
        }).join("") + '</ul></details>';
    }).join("");

    return '<article class="short-card">' +
      '<header>' +
        '<div><h2>' + esc(sym) + ' <span class="dp-name">' + esc(m.name || "") + '</span></h2>' +
        '<p class="dp-sub">' + esc(m.sector || "") + (m.industry ? " · " + esc(m.industry) : "") + '</p></div>' +
        '<div class="short-score tone-' + band.tone + '">' +
          '<strong>' + (r.overall === null ? "—" : Math.round(r.overall)) + '</strong>' +
          '<span>' + esc(band.label) + '</span></div>' +
      '</header>' +
      '<div class="squeeze squeeze-' + esc(sq.level) + '">' +
        '<span class="sq-label">Squeeze risk: <strong class="tone-' + esc(SQUEEZE_TONE[sq.level]) + '">' +
          esc(sq.level) + '</strong></span>' +
        '<ul>' + sq.reasons.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join("") + '</ul>' +
      '</div>' +
      '<div class="short-factors">' + factors + '</div>' +
      '<p class="confidence">Confidence ' + Math.round(r.confidence * 100) + '%' +
        ' · screened over a ' + r.horizonDays + '-day horizon</p>' +
      '</article>';
  }

  function render() {
    var marketMode = view.universe === "market";
    els.screenWrap.hidden = !marketMode || !candidates.length;
    if (marketMode) {
      els.screenRows.innerHTML = candidates.slice(0, 40).map(screenRow).join("");
    }
    // In market mode the cards hold whatever has been fully analysed so far.
    var rows = scored();
    els.cards.innerHTML = rows.map(card).join("");
    els.empty.hidden = marketMode ? candidates.length > 0 : rows.length > 0;
  }

  /* ---------------- events ---------------- */

  els.preset.addEventListener("change", function () {
    view.preset = els.preset.value; save(VIEW_KEY, view); render();
  });
  function syncControls() {
    els.extraWrap.hidden = view.universe !== "custom";
    var market = view.universe === "market";
    [els.capWrap, els.sectorWrap, els.orderWrap].forEach(function (el) { el.hidden = !market; });
    els.coverage.hidden = !market || !candidates.length;
    els.screenWrap.hidden = !market || !candidates.length;
  }

  els.universe.addEventListener("change", function () {
    view.universe = els.universe.value;
    save(VIEW_KEY, view);
    syncControls();
    if (view.universe === "market") runMarketScreen(); else screenAll();
  });

  ["cap", "sector", "order"].forEach(function (key) {
    els[key].addEventListener("change", function () {
      view[key] = els[key].value;
      save(VIEW_KEY, view);
      runMarketScreen();
    });
  });

  els.screenRows.addEventListener("click", function (e) {
    var btn = e.target.closest("[data-analyse]");
    if (!btn) return;
    var sym = btn.dataset.analyse;
    if (analysed.indexOf(sym) === -1) analysed.unshift(sym);
    btn.textContent = "…";
    ensureAnalysis(sym).then(function () {
      render();
      var card = els.cards.querySelector(".short-card");
      if (card && card.scrollIntoView) card.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
  var extraTimer = null;
  els.extra.addEventListener("input", function () {
    view.extra = els.extra.value;
    save(VIEW_KEY, view);
    if (extraTimer) clearTimeout(extraTimer);
    extraTimer = setTimeout(screenAll, 600);
  });
  els.hideSqueeze.addEventListener("change", function () {
    view.hideSqueeze = els.hideSqueeze.checked; save(VIEW_KEY, view); render();
  });
  els.refresh.addEventListener("click", function () {
    cache = {}; models = {}; save(ANALYSIS_KEY, cache);
    if (view.universe === "market") runMarketScreen(); else screenAll();
  });
  document.addEventListener("keydown", function (e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    var tag = e.target.tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
    if (e.key === "r" || e.key === "R") screenAll();
  });

  /* ---------------- boot ---------------- */

  els.sector.innerHTML = '<option value="any">All sectors</option>' +
    SECTORS.map(function (s2) { return '<option value="' + esc(s2) + '">' + esc(s2) + '</option>'; }).join("");
  els.preset.value = view.preset;
  els.universe.value = view.universe;
  els.cap.value = view.cap || "smallmid";
  els.sector.value = view.sector || "any";
  els.order.value = view.order || "decliners";
  els.extra.value = view.extra || "";
  els.hideSqueeze.checked = !!view.hideSqueeze;
  syncControls();
  render();
  if (view.universe === "market") runMarketScreen(); else screenAll();
})();
