/* Daily Movers — the session's largest moves, with what coincided with them.

   Explanations are fetched only when a row is opened. Most of a movers list
   gets glanced at rather than read, and each explanation costs two upstream
   requests, so fetching forty of them up front would be waste. */

import { explainMove, summariseCause } from "./movers-model.mjs";
import { mountFilterGuide, MOVER_FILTERS } from "./filter-guide.mjs";
import { SECTORS } from "./screen-model.mjs";
import { loadWatchlist, saveWatchlist } from "./watchlist.mjs";

(function () {
  "use strict";

  var VIEW_KEY = "stockwatcher.movers.v1";

  var els = {};
  ["status", "refresh", "filters", "cap", "sector", "minPrice", "minVolume", "count",
   "gainers", "losers", "empty", "banner", "coverage"].forEach(function (id) {
    els[id] = document.getElementById(id);
  });

  var view = load(VIEW_KEY, { cap: "any", sector: "any", minPrice: 5, minVolume: 500000, count: 15 });
  var symbols = loadWatchlist();
  var data = { gainers: [], losers: [], sectors: {} };
  var sessionDate = null;
  var explanations = {};   // symbol -> assembled explanation
  var pending = {};
  var loading = false;

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
    setStatus("Loading…");
    els.banner.hidden = true;

    var qs = new URLSearchParams({
      cap: view.cap, sector: view.sector,
      minPrice: view.minPrice, minVolume: view.minVolume, count: view.count,
    });
    return fetch("/api/movers?" + qs)
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.error) { els.banner.textContent = d.error; els.banner.hidden = false; }
        data = d;
        explanations = {};
        /* The feed states the session it describes; a guess from the clock
           gets every public holiday wrong. */
        sessionDate = d.sessionDate || null;
        renderCoverage(d);
        render();
        setStatus((d.gainers || []).length + (d.losers || []).length + " movers · " +
          new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
      })
      .catch(function (err) { setStatus("Load failed — " + err.message, true); })
      .then(function () { loading = false; });
  }

  function explain(sym) {
    if (explanations[sym] || pending[sym]) return Promise.resolve();
    pending[sym] = fetch("/api/mover-why?symbol=" + encodeURIComponent(sym))
      .then(function (r) { return r.json(); })
      .then(function (why) {
        var mover = findMover(sym);
        explanations[sym] = explainMove(mover, why, data.sectors, sessionDate);
      })
      .catch(function () { explanations[sym] = { evidence: [], unexplained: true, articles: [] }; })
      .then(function () { delete pending[sym]; render(); });
    return pending[sym];
  }

  function findMover(sym) {
    return (data.gainers || []).concat(data.losers || [])
      .find(function (m) { return m.symbol === sym; }) || null;
  }

  /* ---------------- rendering ---------------- */

  function renderCoverage(d) {
    if (!d || d.tradeable === undefined) { els.coverage.hidden = true; return; }
    var when = sessionDate
      ? new Date(sessionDate + "T00:00:00").toLocaleDateString(undefined,
          { weekday: "long", day: "numeric", month: "long" })
      : "the last session";
    els.coverage.innerHTML =
      "Moves from the session ending <strong>" + esc(when) + "</strong>. " +
      "<strong>" + d.tradeable.toLocaleString() + "</strong> of " +
      d.universeSize.toLocaleString() + " US-listed stocks clear the price and volume " +
      "floors and are ranked; the rest can print large percentages on almost no trading.";
    els.coverage.hidden = false;
  }

  function evidenceHtml(e) {
    if (e.kind === "coverage") {
      return '<li class="ev ev-' + e.strength + '"><b>' + esc(e.headline) + '</b>' +
        '<ul class="ev-articles">' + (e.articles || []).map(function (a) {
          return '<li>' + (a.url
            ? '<a href="' + esc(a.url) + '" target="_blank" rel="noopener noreferrer">' + esc(a.title) + '</a>'
            : esc(a.title)) +
            '<span class="ev-meta">' + esc(a.publisher || "") + " · " + esc(a.created || "") + '</span></li>';
        }).join("") + '</ul></li>';
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
          ? (exp.evidence.length
              ? '<ul class="ev-list">' + exp.evidence.map(evidenceHtml).join("") + '</ul>'
              : '') +
            (exp.unexplained
              ? '<p class="ev-none">Nothing in the public record accounts for this. No results within four days, ' +
                'no headlines around the session, and the sector did not move with it. Large moves without a ' +
                'visible cause are common in smaller companies and are not evidence of anything by themselves.</p>'
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

  ["cap", "sector", "minPrice", "minVolume", "count"].forEach(function (key) {
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
  ["cap", "sector", "minPrice", "minVolume", "count"].forEach(function (k) {
    els[k].value = String(view[k]);
  });
  fetchMovers();
})();
