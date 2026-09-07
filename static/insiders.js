/* Insider Trades — the market-wide Form 4 tape.

   The watchlist panel answers "what have insiders done at this company".
   This answers the other question: what is being filed right now, anywhere.
   Both run through the same parser, so a trade reads the same in either place.

   The watchlist is shared with the other windows through the same
   localStorage key. */

import { parseForm4, CODES } from "./insider-model.mjs";

(function () {
  "use strict";

  var STORE_KEY = "stockwatcher.symbols.v1";
  var VIEW_KEY = "stockwatcher.insiders.v1";
  var FEED_LIMIT = 40;

  var els = {};
  ["status", "refresh", "filters", "mode", "minValue", "ticker", "watchlist-only",
   "feed-rows", "empty", "banner", "legend", "feed-table"].forEach(function (id) {
    els[id.replace(/-(\w)/g, function (m, c) { return c.toUpperCase(); })] =
      document.getElementById(id);
  });

  var view = load(VIEW_KEY, { mode: "decisions", minValue: 50000, ticker: "", watchlistOnly: false });
  var symbols = load(STORE_KEY, []);
  var trades = [];
  var loading = false;

  function load(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      if (!raw) return fallback;
      var v = JSON.parse(raw);
      if (Array.isArray(fallback)) return Array.isArray(v) ? v : fallback;
      return v && typeof v === "object" ? Object.assign({}, fallback, v) : fallback;
    } catch (e) { return fallback; }
  }
  function save(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* private mode */ }
  }

  function esc(s) {
    return String(s === null || s === undefined ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function n0(v) { return (v === null || v === undefined) ? "—" : Math.round(v).toLocaleString(); }
  function usd(v) {
    if (v === null || v === undefined) return "—";
    var a = Math.abs(v), div = 1, suf = "";
    if (a >= 1e9) { div = 1e9; suf = "B"; }
    else if (a >= 1e6) { div = 1e6; suf = "M"; }
    else if (a >= 1e3) { div = 1e3; suf = "K"; }
    return (v < 0 ? "−$" : "$") + (a / div).toFixed(a / div >= 100 || !suf ? 0 : 1) + suf;
  }
  function titleCase(s) {
    return String(s || "").toLowerCase().replace(/\b\w/g, function (m) { return m.toUpperCase(); });
  }
  function setStatus(text, isError) {
    els.status.textContent = text;
    els.status.className = "status" + (isError ? " err" : "");
  }

  /* ---------------- data ---------------- */

  function fetchFeed() {
    if (loading) return Promise.resolve();
    loading = true;
    setStatus("Loading filings…");
    els.banner.hidden = true;

    return fetch("/api/insider-feed?limit=" + FEED_LIMIT)
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.error) {
          els.banner.textContent = d.error;
          els.banner.hidden = false;
        }
        trades = [];
        (d.filings || []).forEach(function (f) {
          var parsed = parseForm4(f.xml, f);
          if (!parsed || !parsed.symbol) return;
          parsed.transactions.forEach(function (t) {
            // Derivative lines are option mechanics, not a position change.
            if (t.security !== "equity") return;
            trades.push({
              symbol: parsed.symbol,
              issuer: parsed.issuer,
              name: parsed.owner,
              title: parsed.title,
              roles: parsed.roles,
              planned: parsed.planned,
              url: f.indexUrl || f.url,
              filingDate: f.filingDate || parsed.filingDate,
              code: t.code, label: t.label, kind: t.kind,
              discretionary: t.discretionary,
              shares: t.shares, price: t.price, value: t.value,
              stakePercent: t.stakePercent, disposed: t.disposed,
              date: t.date,
            });
          });
        });
        render();
        setStatus(trades.length + " transactions · updated " +
          new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
      })
      .catch(function (err) { setStatus("Load failed — " + err.message, true); })
      .then(function () { loading = false; });
  }

  /* ---------------- rendering ---------------- */

  function visible() {
    var min = Number(view.minValue) || 0;
    var wanted = String(view.ticker || "").trim().toUpperCase();
    return trades.filter(function (t) {
      if (view.mode === "decisions" && !(t.discretionary && !t.planned)) return false;
      if (view.mode === "buys" && t.kind !== "buy") return false;
      if (view.mode === "sells" && t.kind !== "sell") return false;
      if (min && (t.value === null || Math.abs(t.value) < min)) return false;
      if (wanted && t.symbol !== wanted) return false;
      if (view.watchlistOnly && symbols.indexOf(t.symbol) === -1) return false;
      return true;
    });
  }

  function row(t) {
    var watched = symbols.indexOf(t.symbol) !== -1;
    var routine = !t.discretionary || t.planned;
    var role = t.title || (t.roles || []).join(", ") || "—";
    return '<tr class="' + (routine ? "routine" : "") + '">' +
      '<td class="sym"><span class="sym-code">' + esc(t.symbol) + '</span>' +
        (watched ? '<span class="cat-watched" title="On your watchlist">●</span>' : '') +
        '<span class="sym-name">' + esc(titleCase(t.issuer)) + '</span></td>' +
      '<td>' + (t.url
          ? '<a href="' + esc(t.url) + '" target="_blank" rel="noopener noreferrer">' + esc(titleCase(t.name)) + '</a>'
          : esc(titleCase(t.name))) +
        '<span class="sym-name">' + esc(role) + '</span></td>' +
      '<td><span class="tag tag-' + t.kind + '">' + esc(t.label) + '</span>' +
        (t.planned ? '<span class="tag tag-plan" title="Arranged in advance under Rule 10b5-1">10b5-1</span>' : '') +
      '</td>' +
      '<td class="num">' + n0(t.shares) + '</td>' +
      '<td class="num ' + (t.stakePercent ? (t.disposed ? "down" : "up") : "sub") + '">' +
        (t.stakePercent === null || t.stakePercent === undefined ? "—" : t.stakePercent.toFixed(1) + "%") + '</td>' +
      '<td class="num ' + (t.kind === "buy" ? "up" : t.kind === "sell" ? "down" : "") + '">' + usd(t.value) + '</td>' +
      '<td class="num sub">' + esc(t.date || t.filingDate || "—") + '</td>' +
      '<td class="act">' + (watched
        ? '<button class="linkbtn" data-remove="' + esc(t.symbol) + '">Remove</button>'
        : '<button class="btn btn-small" data-add="' + esc(t.symbol) + '">Watch</button>') + '</td>' +
      '</tr>';
  }

  function render() {
    var rows = visible();
    els.empty.hidden = rows.length > 0;
    els.feedTable.parentNode.hidden = rows.length === 0;
    els.feedRows.innerHTML = rows.map(row).join("");
    renderLegend(rows);
  }

  /* Codes explained in place: most of a Form 4 tape is not a decision. */
  function renderLegend(rows) {
    var counts = {};
    rows.forEach(function (t) { counts[t.code] = (counts[t.code] || 0) + 1; });
    var order = ["P", "S", "A", "M", "F", "G"];
    els.legend.innerHTML = order.map(function (code) {
      var spec = CODES[code];
      var why = {
        P: "A purchase on the open market with the insider's own money. The rarest filing and the one worth noticing.",
        S: "A sale on the open market. Weaker as a signal than a buy — people sell to diversify, pay tax or buy a house.",
        A: "Shares granted as compensation. Vests on a schedule set long ago; no decision was taken today.",
        M: "An option exercised, usually near expiry. Often paired with a sale to cover the cost.",
        F: "Shares surrendered to cover the tax due on a grant. Automatic, and not a sale into the market.",
        G: "Shares given away. Moves the holding without any view on the price.",
      }[code];
      return '<div class="legend-row">' +
        '<dt><span class="tag tag-' + spec.kind + '">' + esc(code) + ' · ' + esc(spec.label) + '</span></dt>' +
        '<dd>' + esc(why) + (counts[code] ? ' <span class="legend-n">' + counts[code] + ' shown</span>' : '') + '</dd>' +
        '</div>';
    }).join("");
  }

  /* ---------------- events ---------------- */

  els.mode.addEventListener("change", function () {
    view.mode = els.mode.value; save(VIEW_KEY, view); render();
  });
  els.minValue.addEventListener("change", function () {
    view.minValue = Number(els.minValue.value); save(VIEW_KEY, view); render();
  });
  els.ticker.addEventListener("input", function () {
    view.ticker = els.ticker.value; save(VIEW_KEY, view); render();
  });
  els.watchlistOnly.addEventListener("change", function () {
    view.watchlistOnly = els.watchlistOnly.checked; save(VIEW_KEY, view); render();
  });

  els.feedRows.addEventListener("click", function (e) {
    var add = e.target.closest("[data-add]");
    var remove = e.target.closest("[data-remove]");
    if (add) {
      if (symbols.indexOf(add.dataset.add) === -1) symbols.push(add.dataset.add);
    } else if (remove) {
      var i = symbols.indexOf(remove.dataset.remove);
      if (i !== -1) symbols.splice(i, 1);
    } else return;
    save(STORE_KEY, symbols);
    render();
  });

  els.refresh.addEventListener("click", function () { fetchFeed(); });

  document.addEventListener("keydown", function (e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    var tag = e.target.tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
    if (e.key === "r" || e.key === "R") fetchFeed();
  });

  /* ---------------- boot ---------------- */

  els.mode.value = view.mode;
  els.minValue.value = String(view.minValue);
  els.ticker.value = view.ticker || "";
  els.watchlistOnly.checked = !!view.watchlistOnly;
  renderLegend([]);
  fetchFeed();
})();
