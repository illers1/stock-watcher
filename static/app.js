/* Stock Watcher — the watchlist lives in localStorage; quotes come from /api. */
import { parseAnalysis } from "./analyze.mjs";
import { scoreAnalysis, scoreBand, FACTORS, PRESETS, DEFAULT_HORIZON_DAYS } from "./score.mjs";
import { renderDetail } from "./detail.mjs";

(function () {
  "use strict";

  var STORE_KEY = "stockwatcher.symbols.v1";
  var PREF_KEY = "stockwatcher.prefs.v1";
  var ANALYSIS_KEY = "stockwatcher.analysis.v2";
  var ANALYSIS_TTL_MS = 30 * 60 * 1000;   // fundamentals move slowly
  var ANALYSIS_CONCURRENCY = 3;
  var SYMBOL_OK = /^[A-Z0-9.\-=^&:$]{1,24}$/;

  /* A small offline index so the autocomplete is useful even when the upstream
     symbol search is unavailable. Anything not listed can still be typed in. */
  var COMMON = [
    ["AAPL", "Apple Inc."], ["MSFT", "Microsoft Corporation"], ["NVDA", "NVIDIA Corporation"],
    ["GOOGL", "Alphabet Inc. Class A"], ["GOOG", "Alphabet Inc. Class C"], ["AMZN", "Amazon.com Inc."],
    ["META", "Meta Platforms Inc."], ["TSLA", "Tesla Inc."], ["AVGO", "Broadcom Inc."],
    ["BRK.A", "Berkshire Hathaway Class A"], ["BRK.B", "Berkshire Hathaway Class B"],
    ["JPM", "JPMorgan Chase & Co."], ["V", "Visa Inc."], ["MA", "Mastercard Inc."],
    ["WMT", "Walmart Inc."], ["COST", "Costco Wholesale"], ["HD", "Home Depot"],
    ["PG", "Procter & Gamble"], ["JNJ", "Johnson & Johnson"], ["UNH", "UnitedHealth Group"],
    ["LLY", "Eli Lilly and Company"], ["MRK", "Merck & Co."], ["PFE", "Pfizer Inc."],
    ["ABBV", "AbbVie Inc."], ["XOM", "Exxon Mobil"], ["CVX", "Chevron Corporation"],
    ["KO", "Coca-Cola Company"], ["PEP", "PepsiCo Inc."], ["MCD", "McDonald's Corporation"],
    ["NKE", "Nike Inc."], ["SBUX", "Starbucks Corporation"], ["DIS", "Walt Disney Company"],
    ["NFLX", "Netflix Inc."], ["CMCSA", "Comcast Corporation"], ["T", "AT&T Inc."],
    ["VZ", "Verizon Communications"], ["INTC", "Intel Corporation"], ["AMD", "Advanced Micro Devices"],
    ["QCOM", "Qualcomm Inc."], ["TXN", "Texas Instruments"], ["MU", "Micron Technology"],
    ["ORCL", "Oracle Corporation"], ["CRM", "Salesforce Inc."], ["ADBE", "Adobe Inc."],
    ["IBM", "IBM Corporation"], ["CSCO", "Cisco Systems"], ["NOW", "ServiceNow Inc."],
    ["UBER", "Uber Technologies"], ["ABNB", "Airbnb Inc."], ["SHOP", "Shopify Inc."],
    ["PYPL", "PayPal Holdings"], ["SQ", "Block Inc."], ["COIN", "Coinbase Global"],
    ["PLTR", "Palantir Technologies"], ["SNOW", "Snowflake Inc."], ["CRWD", "CrowdStrike Holdings"],
    ["BA", "Boeing Company"], ["CAT", "Caterpillar Inc."], ["GE", "GE Aerospace"],
    ["F", "Ford Motor Company"], ["GM", "General Motors"], ["RIVN", "Rivian Automotive"],
    ["ASML", "ASML Holding N.V."], ["TSM", "Taiwan Semiconductor"], ["SONY", "Sony Group"],
    ["TM", "Toyota Motor Corporation"], ["BAC", "Bank of America"], ["WFC", "Wells Fargo"],
    ["GS", "Goldman Sachs Group"], ["MS", "Morgan Stanley"], ["AXP", "American Express"],
    ["SPY", "SPDR S&P 500 ETF Trust"], ["VOO", "Vanguard S&P 500 ETF"], ["IVV", "iShares Core S&P 500"],
    ["QQQ", "Invesco QQQ Trust"], ["DIA", "SPDR Dow Jones Industrial Average ETF"],
    ["IWM", "iShares Russell 2000 ETF"], ["VTI", "Vanguard Total Stock Market ETF"],
    ["VXUS", "Vanguard Total International Stock ETF"], ["BND", "Vanguard Total Bond Market ETF"],
    ["SCHD", "Schwab US Dividend Equity ETF"], ["ARKK", "ARK Innovation ETF"],
    ["GLD", "SPDR Gold Shares"], ["SLV", "iShares Silver Trust"], ["USO", "United States Oil Fund"],
    [".SPX", "S&P 500 Index"], [".DJI", "Dow Jones Industrial Average"],
    [".IXIC", "Nasdaq Composite Index"], [".VIX", "CBOE Volatility Index"],
    ["BTC.CM=", "Bitcoin / USD"], ["ETH.CM=", "Ether / USD"]
  ];

  var els = {};
  ["rows", "empty", "status", "banner", "refresh", "interval", "clear", "summary",
   "sum-count", "sum-up", "sum-down", "sum-avg", "quotes", "suggestions",
   "symbol-input", "add-form", "table-wrap", "weights", "presets", "sliders",
   "preset-name", "horizon", "horizon-out", "detail-panel", "dp-backdrop"].forEach(function (id) {
    els[id.replace(/-(\w)/g, function (m, c) { return c.toUpperCase(); })] =
      document.getElementById(id);
  });

  var symbols = load(STORE_KEY, ["AAPL", "MSFT", "NVDA", "SPY"]);
  var prefs = load(PREF_KEY, {
    interval: 60, sortKey: null, sortDir: -1,
    preset: "sprint", weights: null, horizonDays: DEFAULT_HORIZON_DAYS,
  });
  if (!prefs.weights) prefs.weights = Object.assign({}, PRESETS.sprint.weights);
  if (!prefs.horizonDays) prefs.horizonDays = DEFAULT_HORIZON_DAYS;
  if (!prefs.preset) prefs.preset = "sprint";
  var quotes = {};      // symbol -> latest payload
  var lastPrice = {};   // symbol -> price at previous render, for the tick flash
  var analyses = loadAnalyses();   // symbol -> {at, model}
  var scores = {};                 // symbol -> scored result, recomputed on weight change
  var calendarEvents = {};         // symbol -> upcoming earnings event
  var analysing = {};              // symbol -> true while a fetch is in flight
  var openSymbol = null;
  var timer = null;
  var inFlight = false;

  function load(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      if (!raw) return fallback;
      var val = JSON.parse(raw);
      if (Array.isArray(fallback)) return Array.isArray(val) ? val : fallback;
      return val && typeof val === "object" ? val : fallback;
    } catch (e) { return fallback; }
  }
  function save(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* private mode */ }
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

  /* Where today's price sits between the day's low and high. */
  function rangeBar(q) {
    if (q.dayLow === null || q.dayHigh === null || q.price === null) return "—";
    var span = q.dayHigh - q.dayLow;
    var pos = span > 0 ? (q.price - q.dayLow) / span : 0.5;
    pos = Math.max(0, Math.min(1, pos));
    var dir = dirClass(q.change);
    return '<span class="range">' +
      '<span class="range-lo">' + fmtPrice(q.dayLow) + '</span>' +
      '<span class="range-track"><span class="range-dot ' + dir + '" style="left:' +
        (pos * 100).toFixed(1) + '%"></span></span>' +
      '<span class="range-hi">' + fmtPrice(q.dayHigh) + '</span></span>';
  }

  function extendedLine(q) {
    var e = q.extended;
    if (!e || e.price === null || e.price === undefined) return "";
    if (q.marketStatus !== "PRE_MKT" && q.marketStatus !== "POST_MKT") return "";
    var label = q.marketStatus === "PRE_MKT" ? "Pre" : "After";
    return '<span class="ext ' + dirClass(e.change) + '">' + label + ' ' +
      fmtPrice(e.price) + ' (' + fmtPct(e.changePercent) + ')</span>';
  }


  /* ---------------- analysis ---------------- */

  function loadAnalyses() {
    var raw = load(ANALYSIS_KEY, {});
    var out = {};
    // Parsed models are cached rather than the raw bundles: a fraction of the
    // size, and re-scoring on a weight change needs nothing else.
    Object.keys(raw || {}).forEach(function (sym) {
      var entry = raw[sym];
      if (entry && entry.model && Date.now() - entry.at < ANALYSIS_TTL_MS) out[sym] = entry;
    });
    return out;
  }

  function persistAnalyses() {
    var slim = {};
    symbols.forEach(function (s) { if (analyses[s]) slim[s] = analyses[s]; });
    save(ANALYSIS_KEY, slim);
  }

  function rescore() {
    scores = {};
    Object.keys(analyses).forEach(function (sym) {
      var model = analyses[sym] && analyses[sym].model;
      if (model) scores[sym] = scoreAnalysis(model, prefs.weights, prefs.horizonDays);
    });
  }

  function fetchCalendar() {
    return fetch("/api/calendar?days=" + encodeURIComponent(Math.max(7, prefs.horizonDays)))
      .then(function (r) { return r.json(); })
      .then(function (d) { calendarEvents = d.events || {}; })
      .catch(function () { calendarEvents = {}; });
  }

  function analyseSymbol(sym) {
    if (analysing[sym]) return Promise.resolve();
    var cached = analyses[sym];
    if (cached && Date.now() - cached.at < ANALYSIS_TTL_MS) return Promise.resolve();
    analysing[sym] = true;
    render();

    return fetch("/api/analysis?symbol=" + encodeURIComponent(sym))
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d || d.error) throw new Error(d && d.error ? d.error : "no data");
        var model = parseAnalysis(d.sources, sym, calendarEvents[sym] || null);
        analyses[sym] = { at: Date.now(), model: model };
        scores[sym] = scoreAnalysis(model, prefs.weights, prefs.horizonDays);
        persistAnalyses();
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

  /** Work through the watchlist a few symbols at a time. */
  function analyseAll() {
    var queue = symbols.filter(function (s) {
      var c = analyses[s];
      return !analysing[s] && (!c || Date.now() - c.at >= ANALYSIS_TTL_MS);
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
        '<p class="dp-sub">' + (entry && entry.failed ? "Analysis unavailable" : "Analysing\u2026") + '</p></div>' +
        '<button class="dp-close" data-close aria-label="Close">\u00d7</button></header>' +
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

  /** Where this symbol sits on the watchlist by rating — the view that matters
      when the goal is picking between them rather than judging one alone. */
  function rankOf(sym) {
    var ranked = symbols
      .filter(function (s) { return scores[s] && scores[s].overall !== null; })
      .sort(function (a, b) { return scores[b].overall - scores[a].overall; });
    var i = ranked.indexOf(sym);
    return i === -1 ? null : { position: i + 1, total: ranked.length };
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
    }).join("") + '<button type="button" class="preset' +
      (prefs.preset === "custom" ? " on" : "") + '" data-preset="custom" hidden>Custom</button>';

    els.sliders.innerHTML = FACTORS.map(function (f) {
      var w = Number(prefs.weights[f.key] || 0);
      return '<label class="slider" title="' + esc(f.hint) + '">' +
        '<span class="sl-name">' + esc(f.label) + '</span>' +
        '<input type="range" min="0" max="40" step="1" value="' + w + '" data-weight="' + f.key + '">' +
        '<output>' + w + '</output></label>';
    }).join("");

    els.presetName.textContent = PRESETS[prefs.preset]
      ? PRESETS[prefs.preset].label : "Custom";
    els.horizon.value = String(prefs.horizonDays);
    els.horizonOut.textContent = prefs.horizonDays + " days";
  }

  /* Update the controls in place. Rebuilding the markup on every input event
     replaces the very element being dragged, which ends the drag after the
     first pixel of movement — a click still worked, so the controls only
     appeared to be click-only. Only a preset change rebuilds. */
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

  var panelTimer = null;
  var saveTimer = null;

  function applyWeights(opts) {
    opts = opts || {};
    rescore();
    if (opts.rebuild) renderWeightControls();
    else updateWeightOutputs();
    render();

    // Re-rendering the panel and writing localStorage on every frame of a drag
    // is wasted work; both can settle once the slider comes to rest.
    if (openSymbol) {
      if (panelTimer) clearTimeout(panelTimer);
      panelTimer = setTimeout(function () { if (openSymbol) openDetail(openSymbol); }, 120);
    }
    if (opts.save !== false) {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(function () { save(PREF_KEY, prefs); }, 250);
    }
  }

  /* ---------------- rendering ---------------- */

  function ordered() {
    var list = symbols.map(function (s) { return quotes[s] || { symbol: s, pending: true }; });
    if (!prefs.sortKey) return list;
    var key = prefs.sortKey, dir = prefs.sortDir;
    return list.slice().sort(function (a, b) {
      if (key === "symbol") return String(a.symbol).localeCompare(String(b.symbol)) * dir;
      var av, bv;
      if (key === "score") {
        av = scores[a.symbol] ? scores[a.symbol].overall : null;
        bv = scores[b.symbol] ? scores[b.symbol].overall : null;
      } else {
        av = a[key]; bv = b[key];
      }
      var aMissing = av === null || av === undefined;
      var bMissing = bv === null || bv === undefined;
      if (aMissing && bMissing) return 0;
      if (aMissing) return 1;
      if (bMissing) return -1;
      return (av - bv) * dir;
    });
  }

  function rowHtml(q) {
    var sym = q.symbol;
    var removeCell = '<td class="act"><button class="remove" data-remove="' + esc(sym) +
      '" title="Remove ' + esc(sym) + '" aria-label="Remove ' + esc(sym) + '">×</button></td>';

    if (q.pending) {
      return '<tr data-symbol="' + esc(sym) + '"><td class="sym"><span class="sym-code">' +
        esc(sym) + '</span></td><td colspan="7" class="sub">Loading…</td>' + removeCell + '</tr>';
    }
    if (q.error) {
      return '<tr class="err" data-symbol="' + esc(sym) + '">' +
        '<td class="sym"><span class="sym-code">' + esc(sym) + '</span>' +
        '<span class="sym-name err-text">' + esc(q.error) + '</span></td>' +
        '<td colspan="7" class="sub">No quote available — check the symbol, then remove it.</td>' +
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
      '<td class="price">' + fmtPrice(q.price) +
        '<span class="cur">' + esc(q.currency) + '</span>' + extendedLine(q) + '</td>' +
      '<td class="' + dir + ' chg">' + fmtSigned(q.change) + '</td>' +
      '<td class="pct"><span class="pill ' + dir + '">' + fmtPct(q.changePercent) + '</span></td>' +
      '<td class="sub col-hide">' + rangeBar(q) + '</td>' +
      '<td class="sub col-hide">' + fmtBig(q.marketCap) + '</td>' +
      '<td class="sub col-hide">' + fmtBig(q.volume) + '</td>' +
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
    var low = sc.confidence < 0.6 ? " score-thin" : "";
    return '<td class="score"><span class="score-badge tone-' + band.tone + low +
      '" title="' + esc(band.label) + ' · confidence ' + Math.round(sc.confidence * 100) +
      '%">' + Math.round(sc.overall) + '</span></td>';
  }

  function render() {
    els.empty.hidden = symbols.length > 0;
    els.tableWrap.hidden = symbols.length === 0;
    els.summary.hidden = symbols.length === 0;
    els.rows.innerHTML = ordered().map(rowHtml).join("");
    renderSummary();
    renderSortIndicator();
  }

  function renderSummary() {
    var live = symbols.map(function (s) { return quotes[s]; }).filter(function (q) {
      return q && !q.error && q.changePercent !== null && q.changePercent !== undefined;
    });
    var up = 0, down = 0, total = 0;
    live.forEach(function (q) {
      if (q.changePercent > 0) up++; else if (q.changePercent < 0) down++;
      total += q.changePercent;
    });
    var avg = live.length ? total / live.length : null;
    els.sumCount.textContent = symbols.length;
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

  /* ---------------- data ---------------- */

  function refresh() {
    if (!symbols.length) { render(); setStatus("Watchlist empty"); setBanner(""); return Promise.resolve(); }
    if (inFlight) return Promise.resolve();
    inFlight = true;
    els.refresh.classList.add("busy");
    setStatus("Updating…");

    return fetch("/api/quotes?symbols=" + encodeURIComponent(symbols.join(",")))
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (data) {
        (data.quotes || []).forEach(function (q) {
          if (q && q.symbol) quotes[q.symbol.toUpperCase()] = q;
        });
        render();
        if (data.error) {
          var when = data.asOf ? new Date(data.asOf * 1000).toLocaleTimeString() : "earlier";
          setStatus("Stale — last update " + when, true);
          setBanner(data.error + ". Showing the last prices received.");
        } else {
          setStatus("Updated " + new Date().toLocaleTimeString([], {
            hour: "2-digit", minute: "2-digit", second: "2-digit" }));
          setBanner("");
        }
      })
      .catch(function (err) {
        setStatus("Update failed — " + err.message, true);
        setBanner("Could not reach the local server. Is it still running in your terminal?");
      })
      .then(function () {
        inFlight = false;
        els.refresh.classList.remove("busy");
      });
  }

  function scheduleRefresh() {
    if (timer) clearInterval(timer);
    var secs = Number(prefs.interval) || 0;
    if (secs > 0) timer = setInterval(refresh, secs * 1000);
  }

  /* ---------------- watchlist ---------------- */

  function addSymbol(raw) {
    var sym = String(raw || "").trim().toUpperCase();
    if (!sym) return;
    if (!SYMBOL_OK.test(sym)) { setStatus("“" + sym + "” is not a valid symbol", true); return; }
    if (symbols.indexOf(sym) !== -1) { setStatus(sym + " is already on your watchlist"); flash(sym); return; }
    symbols.push(sym);
    save(STORE_KEY, symbols);
    render();
    refresh();
    analyseSymbol(sym);
  }

  function removeSymbol(sym) {
    var i = symbols.indexOf(sym);
    if (i === -1) return;
    symbols.splice(i, 1);
    delete quotes[sym];
    delete lastPrice[sym];
    save(STORE_KEY, symbols);
    render();
    setStatus(symbols.length ? "Removed " + sym : "Watchlist empty");
  }

  function flash(sym) {
    var row = els.rows.querySelector('tr[data-symbol="' + sym + '"]');
    if (!row) return;
    row.classList.remove("tick-up");
    void row.offsetWidth;   // restart the animation
    row.classList.add("tick-up");
  }

  /* ---------------- autocomplete ---------------- */

  var suggestions = [];
  var active = -1;
  var searchTimer = null;
  var searchSeq = 0;

  function localMatches(q) {
    var needle = q.toLowerCase();
    var starts = [], contains = [];
    COMMON.forEach(function (row) {
      var sym = row[0].toLowerCase(), name = row[1].toLowerCase();
      var item = { symbol: row[0], name: row[1], exchange: "" };
      if (sym.indexOf(needle) === 0 || name.indexOf(needle) === 0) starts.push(item);
      else if (sym.indexOf(needle) > -1 || name.indexOf(needle) > -1) contains.push(item);
    });
    return starts.concat(contains).slice(0, 8);
  }

  function merge(local, remote) {
    var out = [], seen = {};
    local.concat(remote).forEach(function (item) {
      var key = item.symbol.toUpperCase();
      if (seen[key]) return;
      seen[key] = 1;
      out.push(item);
    });
    return out.slice(0, 8);
  }

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

  function showSuggestions(query) {
    var local = localMatches(query);
    suggestions = local;
    active = -1;
    renderSuggestions();

    var seq = ++searchSeq;
    fetch("/api/search?q=" + encodeURIComponent(query))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (seq !== searchSeq || document.activeElement !== els.symbolInput) return;
        if (els.symbolInput.value.trim().toLowerCase() !== query.toLowerCase()) return;
        suggestions = merge(local, data.results || []);
        renderSuggestions();
      })
      .catch(function () { /* keep the local matches */ });
  }

  els.symbolInput.addEventListener("input", function () {
    var q = els.symbolInput.value.trim();
    if (searchTimer) clearTimeout(searchTimer);
    if (!q) return closeSuggestions();
    suggestions = localMatches(q);
    active = -1;
    renderSuggestions();
    searchTimer = setTimeout(function () { showSuggestions(q); }, 200);
  });

  els.symbolInput.addEventListener("keydown", function (e) {
    if (els.suggestions.hidden) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      active += (e.key === "ArrowDown" ? 1 : -1);
      if (active < -1) active = suggestions.length - 1;
      if (active >= suggestions.length) active = -1;
      renderSuggestions();
      var sel = els.suggestions.querySelector('[aria-selected="true"]');
      if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Escape") {
      closeSuggestions();
    }
  });

  els.suggestions.addEventListener("mousedown", function (e) {
    var li = e.target.closest("li[data-index]");
    if (!li) return;
    e.preventDefault();
    addSymbol(suggestions[Number(li.dataset.index)].symbol);
    els.symbolInput.value = "";
    closeSuggestions();
  });

  document.addEventListener("click", function (e) {
    if (!e.target.closest(".combo")) closeSuggestions();
  });

  /* ---------------- events ---------------- */

  els.addForm.addEventListener("submit", function (e) {
    e.preventDefault();
    if (active >= 0 && suggestions[active]) addSymbol(suggestions[active].symbol);
    else addSymbol(els.symbolInput.value);
    els.symbolInput.value = "";
    closeSuggestions();
  });

  els.rows.addEventListener("click", function (e) {
    var btn = e.target.closest("[data-remove]");
    if (btn) { removeSymbol(btn.dataset.remove); return; }
    var row = e.target.closest("tr[data-symbol]");
    if (row) openDetail(row.dataset.symbol);
  });

  els.detailPanel.addEventListener("click", function (e) {
    if (e.target.closest("[data-close]")) closeDetail();
  });
  els.dpBackdrop.addEventListener("click", closeDetail);

  els.presets.addEventListener("click", function (e) {
    var btn = e.target.closest("[data-preset]");
    if (!btn) return;
    var key = btn.dataset.preset;
    if (!PRESETS[key]) return;
    prefs.preset = key;
    prefs.weights = Object.assign({}, PRESETS[key].weights);
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
    else { prefs.sortKey = key; prefs.sortDir = key === "symbol" ? 1 : -1; }
    save(PREF_KEY, prefs);
    render();
  });

  els.refresh.addEventListener("click", function () { refresh(); });

  els.interval.addEventListener("change", function () {
    prefs.interval = Number(els.interval.value);
    save(PREF_KEY, prefs);
    scheduleRefresh();
  });

  els.clear.addEventListener("click", function () {
    if (!symbols.length) return;
    if (!confirm("Remove all " + symbols.length + " symbols from your watchlist?")) return;
    symbols = [];
    quotes = {};
    lastPrice = {};
    save(STORE_KEY, symbols);
    render();
    setStatus("Watchlist empty");
  });

  document.addEventListener("keydown", function (e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    var tag = e.target.tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
    if (e.key === "/") { e.preventDefault(); els.symbolInput.focus(); }
    else if (e.key === "r" || e.key === "R") refresh();
    else if (e.key === "Escape" && openSymbol) closeDetail();
  });

  // Catch up as soon as the tab is looked at again.
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden && prefs.interval > 0) refresh();
  });

  /* ---------------- boot ---------------- */

  els.interval.value = String(prefs.interval);
  rescore();
  renderWeightControls();
  render();
  refresh();
  scheduleRefresh();
  fetchCalendar().then(analyseAll);
})();
