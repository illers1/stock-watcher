/* The per-stock analysis panel: score breakdown, catalysts, analysts,
   earnings, insiders, risk and news. Pure rendering — it is handed a parsed
   analysis and a score, and returns HTML. */

import { FACTORS, PRESETS, scoreBand } from "./score.mjs";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const n0 = (v) => (v === null || v === undefined ? "—" : Math.round(v).toLocaleString());
const n2 = (v) => (v === null || v === undefined ? "—" :
  v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const pct = (v, d = 2) => (v === null || v === undefined ? "—" :
  (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(d) + "%");
const pctPlain = (v, d = 1) => (v === null || v === undefined ? "—" : v.toFixed(d) + "%");
const usd = (v) => {
  if (v === null || v === undefined) return "—";
  const a = Math.abs(v);
  const [div, suf] = a >= 1e12 ? [1e12, "T"] : a >= 1e9 ? [1e9, "B"] : a >= 1e6 ? [1e6, "M"] : a >= 1e3 ? [1e3, "K"] : [1, ""];
  return (v < 0 ? "−$" : "$") + (a / div).toFixed(a / div >= 100 ? 0 : 1) + suf;
};
const dirClass = (v) => (v === null || v === undefined || v === 0 ? "flat" : v > 0 ? "up" : "down");

const fmtInput = (raw, format) => {
  if (raw === null || raw === undefined) return "—";
  switch (format) {
    case "pct": return pct(raw, 1);
    case "pct0": return pctPlain(raw, 0);
    case "usd": return usd(raw);
    case "num": return n2(raw);
    case "num0": return n0(raw);
    case "days": return raw === null ? "—" : `${raw} d`;
    default: return String(raw);
  }
};

/* ---------- score ring ---------- */

function ring(score) {
  const band = scoreBand(score);
  if (score === null || score === undefined) {
    return `<div class="ring ring-empty"><span class="ring-num">—</span></div>`;
  }
  const r = 46, circ = 2 * Math.PI * r;
  const dash = (score / 100) * circ;
  return `
    <div class="ring">
      <svg viewBox="0 0 110 110" aria-hidden="true">
        <circle cx="55" cy="55" r="${r}" class="ring-track"/>
        <circle cx="55" cy="55" r="${r}" class="ring-fill tone-${band.tone}"
                stroke-dasharray="${dash.toFixed(1)} ${(circ - dash).toFixed(1)}"
                transform="rotate(-90 55 55)"/>
      </svg>
      <span class="ring-num tone-${band.tone}">${Math.round(score)}</span>
    </div>`;
}

/* ---------- factor breakdown ---------- */

function factorRow(f) {
  const band = scoreBand(f.score);
  const width = f.score === null ? 0 : f.score;
  const inputs = f.inputs.map((i) => `
    <li>
      <span class="fi-label">${esc(i.label)}</span>
      <span class="fi-raw">${esc(fmtInput(i.raw, i.format))}</span>
      <span class="fi-score">${i.score === null ? '<em>context</em>' : Math.round(i.score)}</span>
    </li>`).join("");

  return `
    <details class="factor${f.available ? "" : " factor-missing"}">
      <summary>
        <span class="f-name">${esc(f.label)}</span>
        <span class="f-bar"><span class="f-fill tone-${band.tone}" style="width:${width}%"></span></span>
        <span class="f-score tone-${band.tone}">${f.score === null ? "n/a" : Math.round(f.score)}</span>
        <span class="f-weight">${Math.round(f.effectiveWeight * 100)}%</span>
      </summary>
      <p class="f-hint">${esc(f.hint)}</p>
      ${inputs ? `<ul class="f-inputs">${inputs}</ul>` : '<p class="f-hint">No data available for this factor.</p>'}
    </details>`;
}

/* ---------- sections ---------- */

function catalystSection(a) {
  const next = a.earnings?.next;
  if (!next) {
    return `<p class="muted">No earnings date found in the scanned window. The
      calendar only covers the next few weeks, so a date further out will not appear here.</p>`;
  }
  const soon = next.daysAway >= 0 && next.daysAway <= 30;
  const when = next.time && next.time.includes("after") ? "after the close"
    : next.time && next.time.includes("before") ? "before the open" : "time not announced";
  return `
    <div class="catalyst ${soon ? "catalyst-hot" : ""}">
      <div class="cat-days">${next.daysAway}<span>days</span></div>
      <div>
        <strong>Earnings ${esc(next.date)}</strong> — ${esc(when)}
        ${next.epsForecast !== null ? `<br>Consensus EPS estimate ${n2(next.epsForecast)}` : ""}
        ${a.earnings?.beatRate !== null && a.earnings?.beatRate !== undefined
          ? `<br>Beat consensus in ${Math.round(a.earnings.beatRate * 100)}% of the last ${a.earnings.quarters} quarters`
          : ""}
      </div>
    </div>`;
}

function analystSection(a) {
  const an = a.analysts;
  if (!an) return `<p class="muted">No analyst coverage data available.</p>`;
  const total = (an.buy ?? 0) + (an.hold ?? 0) + (an.sell ?? 0);
  const seg = (v, cls) => total ? `<span class="${cls}" style="width:${(v / total) * 100}%"></span>` : "";

  // Where today's price sits between the low and high target.
  let marker = null;
  if (an.low !== null && an.high !== null && a.price !== null && an.high > an.low) {
    marker = Math.max(0, Math.min(100, ((a.price - an.low) / (an.high - an.low)) * 100));
  }
  const meanPos = (an.low !== null && an.high !== null && an.mean !== null && an.high > an.low)
    ? Math.max(0, Math.min(100, ((an.mean - an.low) / (an.high - an.low)) * 100)) : null;

  return `
    <div class="kv">
      <div><dt>Consensus</dt><dd>${esc(an.label ?? "—")}${an.count ? ` · ${an.count} analysts` : ""}</dd></div>
      <div><dt>Mean target</dt><dd>${n2(an.mean)} <span class="${dirClass(an.upsidePercent)}">(${pct(an.upsidePercent, 1)})</span></dd></div>
      <div><dt>Target range</dt><dd>${n2(an.low)} – ${n2(an.high)}</dd></div>
    </div>
    ${marker !== null ? `
      <div class="target-scale">
        <div class="ts-track">
          ${meanPos !== null ? `<span class="ts-mean" style="left:${meanPos}%"></span>` : ""}
          <span class="ts-now" style="left:${marker}%"></span>
        </div>
        <div class="ts-labels"><span>low ${n2(an.low)}</span><span>now ${n2(a.price)}</span><span>high ${n2(an.high)}</span></div>
      </div>` : ""}
    ${total ? `
      <div class="ratings-bar" title="${an.buy} buy · ${an.hold} hold · ${an.sell} sell">
        ${seg(an.buy, "rb-buy")}${seg(an.hold, "rb-hold")}${seg(an.sell, "rb-sell")}
      </div>
      <div class="ratings-key">
        <span><i class="rb-buy"></i>${an.buy} buy</span>
        <span><i class="rb-hold"></i>${an.hold} hold</span>
        <span><i class="rb-sell"></i>${an.sell} sell</span>
      </div>` : ""}
    <p class="caveat">Analyst targets update slowly and can lag a sharp price move,
      so a very large gap often reflects stale targets rather than opportunity.</p>`;
}

function earningsSection(a) {
  const rows = a.earnings?.history ?? [];
  if (!rows.length) return `<p class="muted">No earnings history available.</p>`;
  return `
    <table class="mini">
      <thead><tr><th>Quarter</th><th>Reported</th><th class="r">Actual</th><th class="r">Estimate</th><th class="r">Surprise</th></tr></thead>
      <tbody>${rows.map((r) => `
        <tr>
          <td>${esc(r.quarter ?? "—")}</td>
          <td class="muted">${esc(r.reported ?? "—")}</td>
          <td class="r">${n2(r.actual)}</td>
          <td class="r muted">${n2(r.estimate)}</td>
          <td class="r ${dirClass(r.surprisePercent)}">${pct(r.surprisePercent, 1)}</td>
        </tr>`).join("")}</tbody>
    </table>`;
}

function insiderSection(a) {
  const ins = a.insiders;
  if (!ins) return `<p class="muted">No insider filings available.</p>`;
  const c = ins.counts ?? {};
  return `
    <div class="kv">
      <div><dt>Open-market buys</dt><dd class="${c.buy ? "up" : ""}">${n0(c.buy)}</dd></div>
      <div><dt>Open-market sells</dt><dd class="${c.sell ? "down" : ""}">${n0(c.sell)}</dd></div>
      <div><dt>Net discretionary</dt><dd class="${dirClass(ins.netDiscretionary)}">${usd(ins.netDiscretionary)}</dd></div>
      <div><dt>Preset-plan sales</dt><dd class="muted">${usd(ins.plannedSells)}</dd></div>
    </div>
    <p class="caveat">Only <strong>Buy</strong> and <strong>Sell</strong> are discretionary decisions.
      Grants, vesting, tax withholding and 10b5-1 plan sales are shown for context but excluded
      from the score — they run on fixed schedules and say nothing about conviction.</p>
    <table class="mini">
      <thead><tr><th>Insider</th><th>Role</th><th>Date</th><th>Action</th><th class="r">Shares</th><th class="r">Value</th></tr></thead>
      <tbody>${ins.trades.map((t) => `
        <tr class="${t.discretionary ? "" : "routine"}">
          <td>${esc((t.name ?? "").toLowerCase().replace(/\b\w/g, (m) => m.toUpperCase()))}</td>
          <td class="muted">${esc(t.relation ?? "—")}</td>
          <td class="muted">${esc(t.date ?? "—")}</td>
          <td><span class="tag tag-${t.kind}">${esc(t.kindLabel)}</span></td>
          <td class="r">${n0(t.shares)}</td>
          <td class="r">${usd(t.value)}</td>
        </tr>`).join("")}</tbody>
    </table>`;
}

function riskSection(a) {
  const r = a.risk ?? {}, f = a.fundamentals ?? {}, m = a.momentum ?? {};
  return `
    <div class="kv kv-wide">
      <div><dt>Annualised volatility (30d)</dt><dd>${pctPlain(r.volatility)}</dd></div>
      <div><dt>Beta</dt><dd>${n2(r.beta)}</dd></div>
      <div><dt>Max drawdown (6m)</dt><dd class="down">${pctPlain(r.maxDrawdown)}</dd></div>
      <div><dt>Debt / equity</dt><dd>${pctPlain(f.debtToEquity)}</dd></div>
      <div><dt>1-month return</dt><dd class="${dirClass(m.return1m)}">${pct(m.return1m, 1)}</dd></div>
      <div><dt>3-month return</dt><dd class="${dirClass(m.return3m)}">${pct(m.return3m, 1)}</dd></div>
      <div><dt>52-week position</dt><dd>${pctPlain(r.rangePosition, 0)}</dd></div>
      <div><dt>Short interest days to cover</dt><dd>${n2(a.shortInterest?.daysToCover)}</dd></div>
    </div>`;
}

function fundamentalsSection(a) {
  const f = a.fundamentals;
  if (!f) return `<p class="muted">No fundamentals available.</p>`;
  return `
    <div class="kv kv-wide">
      <div><dt>Market cap</dt><dd>${usd(f.marketCap)}</dd></div>
      <div><dt>Revenue (TTM)</dt><dd>${usd(f.revenue)}</dd></div>
      <div><dt>P/E</dt><dd>${n2(f.pe)}</dd></div>
      <div><dt>Forward P/E</dt><dd>${n2(f.forwardPe)}</dd></div>
      <div><dt>Price / sales</dt><dd>${n2(f.priceToSales)}</dd></div>
      <div><dt>EPS (TTM)</dt><dd>${n2(f.eps)}</dd></div>
      <div><dt>Return on equity</dt><dd>${pctPlain(f.roe)}</dd></div>
      <div><dt>Net margin</dt><dd>${pctPlain(f.netMargin)}</dd></div>
      <div><dt>Gross margin</dt><dd>${pctPlain(f.grossMargin)}</dd></div>
      <div><dt>Dividend yield</dt><dd>${pctPlain(f.dividendYield)}</dd></div>
    </div>`;
}

function newsSection(a) {
  if (!a.news?.length) return `<p class="muted">No recent headlines found.</p>`;
  return `<ul class="news">${a.news.map((n) => `
    <li>
      ${n.url ? `<a href="${esc(n.url)}" target="_blank" rel="noopener noreferrer">${esc(n.title)}</a>`
              : esc(n.title)}
      <span class="news-meta">${esc(n.publisher ?? "")} · ${esc(n.created ?? "")}</span>
    </li>`).join("")}</ul>`;
}

/* ---------- panel ---------- */

export function renderDetail(a, scored, prefs, rank) {
  const band = scoreBand(scored.overall);
  const failed = Object.entries(a.sources ?? {}).filter(([, v]) => v !== "ok").map(([k]) => k);

  return `
    <header class="dp-head">
      <div>
        <h2>${esc(a.symbol)} <span class="dp-name">${esc(a.name)}</span></h2>
        <p class="dp-sub">
          ${esc(a.sector ?? "Sector unknown")}${a.industry ? ` · ${esc(a.industry)}` : ""}
          ${a.exchange ? ` · ${esc(a.exchange)}` : ""}
        </p>
      </div>
      <button class="dp-close" data-close aria-label="Close">×</button>
    </header>

    <div class="dp-price">
      <span class="dp-last">${n2(a.price)}<small>${esc(a.currency)}</small></span>
      <span class="pill ${dirClass(a.change)}">${pct(a.changePercent)}</span>
    </div>

    <section class="dp-score">
      ${ring(scored.overall)}
      <div class="dp-score-meta">
        <strong class="tone-${band.tone}">${band.label}</strong>
        <p>Weighted for <em>${esc(PRESETS[prefs.preset]?.label ?? "custom weights")}</em>
           over a ${scored.horizonDays}-day horizon.</p>
        ${rank && rank.total > 1
          ? `<p class="rank">Ranked <strong>#${rank.position}</strong> of ${rank.total} on your watchlist</p>`
          : ""}
        <p class="confidence">Confidence ${Math.round(scored.confidence * 100)}%${
          failed.length ? ` — ${esc(failed.join(", "))} unavailable` : ""}</p>
      </div>
    </section>

    <section><h3>Score breakdown</h3>
      <p class="section-hint">Each factor is scored 0–100 on its own, then weighted. Open one to see the inputs behind it.</p>
      ${scored.factors.map(factorRow).join("")}
    </section>

    <section><h3>Catalyst</h3>${catalystSection(a)}</section>
    <section><h3>Analyst coverage</h3>${analystSection(a)}</section>
    <section><h3>Earnings history</h3>${earningsSection(a)}</section>
    <section><h3>Insider activity</h3>${insiderSection(a)}</section>
    <section><h3>Risk</h3>${riskSection(a)}</section>
    <section><h3>Fundamentals</h3>${fundamentalsSection(a)}</section>
    <section><h3>Recent news</h3>${newsSection(a)}</section>

    <p class="disclaimer">Assembled from public data (CNBC, Nasdaq). Figures may be
      delayed or incomplete. The rating is a weighted summary of the factors above,
      not a forecast or a recommendation.</p>`;
}

export { FACTORS };
