/* Catalysts — the third window.

   The watchlist starts from symbols you chose and the earnings window starts
   from the calendar; this starts from events. Everything dated and
   company-specific is merged into one timeline, so a month can be read
   forwards rather than a stock at a time.

   The watchlist is shared with the other windows through the same
   localStorage key, so adding from here shows up there immediately. */

import { buildCatalysts, countByKind, KINDS } from "./catalysts-model.mjs";

(function () {
  "use strict";

  var STORE_KEY = "stockwatcher.symbols.v1";   // shared with the watchlist
  var VIEW_KEY = "stockwatcher.catalysts.v1";  // this window's own filters

  var els = {};
  ["status", "refresh", "filters", "window", "kinds", "watchlist-only",
   "timeline", "empty", "banner", "legend"].forEach(function (id) {
    els[id.replace(/-(\w)/g, function (m, c) { return c.toUpperCase(); })] =
      document.getElementById(id);
  });

  var view = load(VIEW_KEY, { days: 30, kinds: Object.keys(KINDS), watchlistOnly: false });
  var symbols = load(STORE_KEY, []);
  var items = [];
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

  var esc = function (s) {
    return String(s === null || s === undefined ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  };

  function setStatus(text, isError) {
    els.status.textContent = text;
    els.status.className = "status" + (isError ? " err" : "");
  }

  /* ---------------- data ---------------- */

  function fetchAll() {
    if (loading) return Promise.resolve();
    loading = true;
    setStatus("Loading…");
    els.banner.hidden = true;

    var days = Number(view.days) || 30;
    return Promise.all([
      fetch("/api/catalysts?days=" + days).then(function (r) { return r.json(); })
        .catch(function () { return { sources: {}, error: "catalysts unavailable" }; }),
      fetch("/api/calendar?days=" + Math.min(days, 60)).then(function (r) { return r.json(); })
        .catch(function () { return { events: {} }; }),
    ]).then(function (res) {
      var cat = res[0], cal = res[1];
      items = buildCatalysts(cat.sources, cal.events, { days: days });
      render();
      if (cat.error) {
        els.banner.textContent = cat.error + ". Some sources may be missing.";
        els.banner.hidden = false;
      }
      setStatus(items.length + " events · updated " +
        new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
    }).catch(function (err) {
      setStatus("Load failed — " + err.message, true);
    }).then(function () { loading = false; });
  }

  /* ---------------- rendering ---------------- */

  function visible() {
    return items.filter(function (i) {
      if (view.kinds.indexOf(i.kind) === -1) return false;
      if (view.watchlistOnly && symbols.indexOf(i.symbol) === -1) return false;
      return true;
    });
  }

  function dayLabel(iso, daysAway) {
    var d = new Date(iso + "T00:00:00");
    var weekday = d.toLocaleDateString(undefined, { weekday: "long" });
    var rest = d.toLocaleDateString(undefined, { day: "numeric", month: "long" });
    var rel = daysAway === 0 ? "today" : daysAway === 1 ? "tomorrow" : "in " + daysAway + " days";
    return { weekday: weekday, rest: rest, rel: rel };
  }

  function itemRow(i) {
    var watched = symbols.indexOf(i.symbol) !== -1;
    var facts = (i.facts || []).filter(Boolean);
    return '<li class="cat-item">' +
      '<span class="cat-kind kind-' + i.kind + '">' + esc(KINDS[i.kind].label) + '</span>' +
      '<span class="cat-sym">' + esc(i.symbol) +
        (watched ? '<span class="cat-watched" title="On your watchlist">●</span>' : '') +
        '<span class="cat-name">' + esc(i.name || "") + '</span></span>' +
      '<span class="cat-what">' +
        '<span class="cat-title">' +
          (i.url
            ? '<a href="' + esc(i.url) + '" target="_blank" rel="noopener noreferrer">' + esc(i.title) + '</a>'
            : esc(i.title)) +
          (i.confirmed ? '' : '<span class="cat-est" title="Not announced by the company">estimated</span>') +
        '</span>' +
        (facts.length
          ? '<span class="cat-facts">' + facts.map(function (f) {
              return '<span>' + esc(f) + '</span>';
            }).join("") + '</span>'
          : '') +
        (i.excerpt
          ? '<blockquote class="cat-quote">' + esc(i.excerpt) +
            (i.url ? ' <a href="' + esc(i.url) + '" target="_blank" rel="noopener noreferrer">filing</a>' : '') +
            '</blockquote>'
          : '') +
        (i.note ? '<span class="cat-note">' + esc(i.note) + '</span>' : '') +
      '</span>' +
      '<span class="cat-act">' +
        (watched
          ? '<button class="linkbtn" data-remove="' + esc(i.symbol) + '">Remove</button>'
          : '<button class="btn btn-small" data-add="' + esc(i.symbol) + '">Watch</button>') +
      '</span></li>';
  }

  /* Every filter explained in place, rather than hidden in a tooltip. */
  function renderLegend() {
    els.legend.innerHTML = Object.keys(KINDS).map(function (k) {
      var on = view.kinds.indexOf(k) !== -1;
      return '<div class="legend-row' + (on ? "" : " legend-off") + '">' +
        '<dt><span class="cat-kind kind-' + k + '">' + esc(KINDS[k].label) + '</span></dt>' +
        '<dd>' + esc(KINDS[k].blurb) + '</dd></div>';
    }).join("");
  }

  function render() {
    var rows = visible();
    els.empty.hidden = rows.length > 0;

    var groups = [];
    var byDate = {};
    rows.forEach(function (i) {
      if (!byDate[i.date]) { byDate[i.date] = []; groups.push(i.date); }
      byDate[i.date].push(i);
    });

    els.timeline.innerHTML = groups.map(function (date) {
      var label = dayLabel(date, byDate[date][0].daysAway);
      return '<section class="cat-day">' +
        '<h2 class="cat-date"><span class="cd-weekday">' + esc(label.weekday) + '</span>' +
        '<span class="cd-rest">' + esc(label.rest) + '</span>' +
        '<span class="cd-rel">' + esc(label.rel) + '</span></h2>' +
        '<ul class="cat-list">' + byDate[date].map(itemRow).join("") + '</ul>' +
        '</section>';
    }).join("");

    renderChips();
    renderLegend();
  }

  function renderChips() {
    var counts = countByKind(items.filter(function (i) {
      return !view.watchlistOnly || symbols.indexOf(i.symbol) !== -1;
    }));
    els.kinds.innerHTML = Object.keys(KINDS).map(function (k) {
      var on = view.kinds.indexOf(k) !== -1;
      return '<button type="button" class="chip kind-' + k + (on ? " on" : "") +
        '" data-kind="' + k + '" title="' + esc(KINDS[k].hint) + '">' +
        esc(KINDS[k].label) + '<span class="chip-n">' + counts[k] + '</span></button>';
    }).join("");
  }

  /* ---------------- events ---------------- */

  els.kinds.addEventListener("click", function (e) {
    var btn = e.target.closest("[data-kind]");
    if (!btn) return;
    var k = btn.dataset.kind;
    var at = view.kinds.indexOf(k);
    if (at === -1) view.kinds.push(k); else view.kinds.splice(at, 1);
    save(VIEW_KEY, view);
    render();
  });

  els.window.addEventListener("change", function () {
    view.days = Number(els.window.value);
    save(VIEW_KEY, view);
    fetchAll();
  });

  els.watchlistOnly.addEventListener("change", function () {
    view.watchlistOnly = els.watchlistOnly.checked;
    save(VIEW_KEY, view);
    render();
  });

  els.timeline.addEventListener("click", function (e) {
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

  els.refresh.addEventListener("click", function () { fetchAll(); });

  document.addEventListener("keydown", function (e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    var tag = e.target.tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
    if (e.key === "r" || e.key === "R") fetchAll();
  });

  /* ---------------- boot ---------------- */

  els.window.value = String(view.days);
  els.watchlistOnly.checked = !!view.watchlistOnly;
  renderChips();
  renderLegend();
  fetchAll();
})();
