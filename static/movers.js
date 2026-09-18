/* Movers — the largest moves over a session, a week or a month, with what
   coincided with them.

   Explanations are fetched only when a row is opened. Most of a movers list
   gets glanced at rather than read, and each explanation costs two upstream
   requests, so fetching forty of them up front would be waste. */

import { explainMove, summariseCause, PERIODS, periodKey, periodWindow, shortDate }
  from "./movers-model.mjs";
import { mountFilterGuide, MOVER_FILTERS } from "./filter-guide.mjs";
import { SECTORS } from "./screen-model.mjs";
import { loadWatchlist, saveWatchlist } from "./watchlist.mjs";

(function () {
  "use strict";

  var VIEW_KEY = "stockwatcher.movers.v1";

  var els = {};
  ["status", "refresh", "filters", "period", "cap", "sector", "minPrice", "count",
   "gainers", "losers", "empty", "banner", "coverage", "gainersHead", "losersHead"].forEach(function (id) {
    els[id] = document.getElementById(id);
  });

  var view = load(VIEW_KEY, { period: "day", cap: "any", sector: "any", minPrice: 3, count: 15 });
  var symbols = loadWatchlist();
  var data = { gainers: [], losers: [], sectors: {} };
  var period = periodKey(view.period);
  var sessionDate = null;
  var explanations = {};   // symbol -> assembled explanation
  var pending = {};
  var loading = false;
  /* Bumped on every load. A reply to the previous period's request must not be
     folded into this one's rows: the symbol would be right and the move, the
     sector and the window all wrong. */
  var generation = 0;

  function load(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      if (!raw) return fallback;
      var v = JSON.parse(raw);
      return v && typeof v === "object" ? Object.assign({}, fallback, v) : fallback;
    } catch (e) { return fallback; }
  }
  function save(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {} }

  function esc(s) {
    return String(s === null || s === undefined ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function pct(v) {
    if (v === null || v === undefined) return "—";
    return (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(2) + "%";
  }
  function usd(v) {
    if (v === null || v === undefined) return "—";
    var a = Math.abs(v), div = 1, suf = "";
    if (a >= 1e12) { div = 1e12; suf = "T"; } else if (a >= 1e9) { div = 1e9; suf = "B"; }
    else if (a >= 1e6) { div = 1e6; suf = "M"; } else if (a >= 1e3) { div = 1e3; suf = "K"; }
    return "$" + (a / div).toFixed(a / div >= 100 || !suf ? 0 : 1) + suf;
  }
  function setStatus(t, err) {
    els.status.textContent = t;
    els.status.className = "status" + (err ? " err" : "");
  }

  /* ---------------- data ---------------- */

  function fetchMovers() {
    if (loading) return Promise.resolve();
    loading = true;
    generation += 1;
    var gen = generation;
    setStatus("Loading…");
    els.banner.hidden = true;

    var qs = new URLSearchParams({
      period: view.period, cap: view.cap, sector: view.sector,
      minPrice: view.minPrice, count: view.count,
    });
    return fetch("/api/movers?" + qs)
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (gen !== generation) return;
        if (d.error) { els.banner.textContent = d.error; els.banner.hidden = false; }
        data = d;
        explanations = {};
        period = periodKey(d.period || view.period);
        /* The feed states the session it describes; a guess from the clock
           gets every public holiday wrong. */
        sessionDate = d.sessionDate || null;
        renderCoverage(d);
        renderHeads();
        render();
        setStatus((d.gainers || []).length + (d.losers || []).length + " movers · " +
          new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
      })
      .catch(function (err) { setStatus("Load failed — " + err.message, true); })
      .then(function () { loading = false; });
  }

  function explain(sym) {
    if (explanations[sym] || pending[sym]) return Promise.resolve();
    var gen = generation;
    pending[sym] = fetch("/api/mover-why?symbol=" + encodeURIComponent(sym))
      .then(function (r) { return r.json(); })
      .then(function (why) {
        // The list may have been reloaded under a different period since.
        if (gen !== generation) return;
        var mover = findMover(sym);
        if (!mover || why.symbol !== sym) return;
        explanations[sym] = explainMove(mover, why, data.sectors, sessionDate,
          { period: period, market: data.market });
      })
      .catch(function () {
        if (gen === generation) {
          explanations[sym] = { evidence: [], unexplained: true, articles: [] };
        }
      })
      .then(function () { delete pending[sym]; if (gen === generation) render(); });
    return pending[sym];
  }

  function findMover(sym) {
    return (data.gainers || []).concat(data.losers || [])
      .find(function (m) { return m.symbol === sym; }) || null;
  }

  /* ---------------- rendering ---------------- */

  function renderHeads() {
    var over = period === "day" ? "" : " over the past " + PERIODS[period].noun;
    els.gainersHead.textContent = "Biggest gainers" + over;
    els.losersHead.textContent = "Biggest losers" + over;
  }

  function renderCoverage(d) {
    if (!d || d.tradeable === undefined) { els.coverage.hidden = true; return; }
    var win = periodWindow(period, sessionDate);
    var span = !sessionDate ? "the last session"
      : period === "day" ? "the session ending <strong>" + esc(shortDate(sessionDate)) + "</strong>"
      : "<strong>" + esc(shortDate(win.start)) + "</strong> to <strong>" +
        esc(shortDate(win.end)) + "</strong>";
    els.coverage.innerHTML =
      "Moves over " + span + ". " +
      "<strong>" + d.tradeable.toLocaleString() + "</strong> of " +
      d.universeSize.toLocaleString() + " US-listed stocks clear the $3 price and " +
      "$25M market-value floors and are ranked." +
      (d.unpriced ? " <strong>" + d.unpriced.toLocaleString() + "</strong> more clear the floors but " +
        "carry no " + PERIODS[period].adj + " figure — mostly units and preference lines — and are left out." : "") +
      (d.market === null || d.market === undefined ? "" :
        " The typical stock moved <strong>" + pct(d.market) + "</strong>.");
    els.coverage.hidden = false;
  }

  function articleHtml(a) {
    return '<li>' +
      (a.tag ? '<span class="ev-tag">' + esc(a.tag) + '</span>' : '') +
      (a.url
        ? '<a href="' + esc(a.url) + '" target="_blank" rel="noopener noreferrer">' + esc(a.title) + '</a>'
        : esc(a.title)) +
      '<span class="ev-meta">' + esc(a.publisher || "") + " · " + esc(a.created || "") + '</span></li>';
  }

  /* The reading the evidence best supports, said first and in plain words —
     the rest of the panel is the working behind it. */
  function verdictHtml(v) {
    if (!v) return "";
    var tag = v.confidence === "likely" ? "Most likely reason"
            : v.confidence === "possible" ? "Possible reason"
            : "No clear reason";
    var src = v.source;
    return '<div class="verdict verdict-' + esc(v.confidence) + '">' +
      '<span class="verdict-tag">' + esc(tag) + '</span>' +
      '<b>' + esc(v.title) + '</b>' +
      '<p>' + esc(v.text) + '</p>' +
      (v.warning ? '<p class="verdict-warning">' + esc(v.warning) + '</p>' : '') +
      (src
        ? '<blockquote class="verdict-source">' +
            (src.url
              ? '<a href="' + esc(src.url) + '" target="_blank" rel="noopener noreferrer">' + esc(src.title) + '</a>'
              : esc(src.title)) +
            '<span class="ev-meta">' + esc(src.publisher || "") + " · " + esc(src.created || "") + '</span>' +
            (src.excerpt ? '<span class="verdict-excerpt">' + esc(src.excerpt) + '</span>' : '') +
          '</blockquote>'
        : '') +
      (v.note ? '<p class="verdict-note">' + esc(v.note) + '</p>' : '') +
      '</div>';
  }

  function evidenceHtml(e) {
    if (e.kind === "coverage") {
      return '<li class="ev ev-' + e.strength + '"><b>' + esc(e.headline) + '</b>' +
        (e.detail ? '<span class="ev-detail">' + esc(e.detail) + '</span>' : "") +
        '<ul class="ev-articles">' + (e.articles || []).map(articleHtml).join("") + '</ul></li>';
    }
    return '<li class="ev ev-' + e.strength + '"><b>' + esc(e.headline) + '</b>' +
      (e.detail ? '<span class="ev-detail">' + esc(e.detail) + '</span>' : "") +
      (e.contradiction ? '<span class="ev-contradiction">' + esc(e.contradiction) + '</span>' : "") +
      '</li>';
  }

  function moverRow(m) {
    var sym = m.symbol;
    var exp = explanations[sym];
    var watched = symbols.indexOf(sym) !== -1;
    var cause = exp ? summariseCause(exp) : (pending[sym] ? "looking…" : "open for detail");

    return '<details class="mover" data-symbol="' + esc(sym) + '">' +
      '<summary>' +
        '<span class="mv-sym">' + esc(sym) +
          (watched ? '<span class="cat-watched" title="On your watchlist">●</span>' : '') +
          '<span class="mv-name">' + esc(m.name || "") + '</span></span>' +
        '<span class="mv-move ' + (m.changePercent >= 0 ? "up" : "down") + '">' + pct(m.changePercent) + '</span>' +
        '<span class="mv-cap sub">' + usd(m.marketCap) + '</span>' +
        '<span class="mv-cause sub">' + esc(cause) + '</span>' +
      '</summary>' +
      '<div class="mover-body">' +
        (exp
          ? verdictHtml(exp.verdict) +
            (exp.evidence.length
              ? '<p class="ev-head">What that is based on</p>' +
                '<ul class="ev-list">' + exp.evidence.map(evidenceHtml).join("") + '</ul>'
              : '')
          : '<p class="sub">' + (pending[sym] ? "Looking for what happened…" : "") + '</p>') +
        '<div class="mover-actions">' +
          (watched
            ? '<button class="linkbtn" data-remove="' + esc(sym) + '">Remove from watchlist</button>'
            : '<button class="btn btn-small" data-add="' + esc(sym) + '">Add to watchlist</button>') +
        '</div>' +
      '</div></details>';
  }

  function render() {
    var g = data.gainers || [], l = data.losers || [];
    els.empty.hidden = g.length + l.length > 0;
    // Preserve which rows are open across a re-render.
    var open = {};
    document.querySelectorAll(".mover[open]").forEach(function (d) { open[d.dataset.symbol] = true; });
    els.gainers.innerHTML = g.map(moverRow).join("");
    els.losers.innerHTML = l.map(moverRow).join("");
    Object.keys(open).forEach(function (sym) {
      var el = document.querySelector('.mover[data-symbol="' + sym + '"]');
      if (el) el.open = true;
    });
  }

  /* ---------------- events ---------------- */

  ["period", "cap", "sector", "minPrice", "count"].forEach(function (key) {
    els[key].addEventListener("change", function () {
      view[key] = els[key].value;
      save(VIEW_KEY, view);
      fetchMovers();
    });
  });

  document.addEventListener("toggle", function (e) {
    var d = e.target.closest ? e.target.closest(".mover[open]") : null;
    if (d && d.dataset.symbol) explain(d.dataset.symbol);
  }, true);

  [els.gainers, els.losers].forEach(function (root) {
    root.addEventListener("click", function (e) {
      var add = e.target.closest("[data-add]");
      var remove = e.target.closest("[data-remove]");
      if (add) {
        if (symbols.indexOf(add.dataset.add) === -1) symbols.push(add.dataset.add);
      } else if (remove) {
        var i = symbols.indexOf(remove.dataset.remove);
        if (i !== -1) symbols.splice(i, 1);
      } else return;
      e.preventDefault();
      saveWatchlist(symbols);
      render();
    });
  });

  els.refresh.addEventListener("click", function () { fetchMovers(); });
  document.addEventListener("keydown", function (e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    var tag = e.target.tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
    if (e.key === "r" || e.key === "R") fetchMovers();
  });

  /* ---------------- boot ---------------- */

  mountFilterGuide(MOVER_FILTERS);
  els.sector.innerHTML = '<option value="any">All sectors</option>' +
    SECTORS.map(function (s) { return '<option value="' + esc(s) + '">' + esc(s) + '</option>'; }).join("");
  ["period", "cap", "sector", "minPrice", "count"].forEach(function (k) {
    els[k].value = String(view[k]);
  });
  renderHeads();
  fetchMovers();
})();
