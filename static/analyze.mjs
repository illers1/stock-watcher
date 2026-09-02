/* Turns the raw bundle from /api/analysis into one clean model.

   Every upstream is fetched server-side and passed through untouched, so all
   the interpretation lives here — one place, testable in a browser, and shared
   by the local Python server and the deployed functions alike.

   Every field is optional by design: any single upstream can fail without
   taking the analysis down, so callers must treat nulls as normal. */

const num = (v) => {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const t = String(v).trim()
    .replace(/[$,%]/g, "").replace(/,/g, "").replace(/−/g, "-").replace(/^\+/, "");
  if (!t || ["UNCH", "N/A", "--", "-", "NA"].includes(t.toUpperCase())) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

const big = (v) => {
  if (v === null || v === undefined) return null;
  const t = String(v).trim().replace(/[$,]/g, "");
  const mult = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 }[t.slice(-1).toUpperCase()];
  if (mult) { const b = num(t.slice(0, -1)); return b === null ? null : b * mult; }
  return num(t);
};

/** US-format date string -> Date, or null. */
const mdy = (s) => {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(s ?? "").trim());
  if (!m) { const d = new Date(s); return Number.isNaN(+d) ? null : d; }
  return new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2]));
};
const daysBetween = (a, b) => Math.round((b - a) / 864e5);
const ok = (o) => o && typeof o === "object" && !o.error;

/* ---------------- individual sources ---------------- */

function parseQuote(raw) {
  const rec = raw?.FormattedQuoteResult?.FormattedQuote;
  const q = Array.isArray(rec) ? rec[0] : rec;
  if (!q || String(q.code) !== "0") return null;
  return {
    name: q.name || q.shortName || null,
    exchange: q.exchange || null,
    currency: q.currencyCode || "USD",
    last: num(q.last),
    change: num(q.change),
    changePercent: num(q.change_pct),
    previousClose: num(q.previous_day_closing),
    dayHigh: num(q.high), dayLow: num(q.low),
    yearHigh: num(q.yrhiprice), yearLow: num(q.yrloprice),
    marketStatus: q.curmktstatus || "",
    fundamentals: {
      marketCap: big(q.mktcapView),
      pe: num(q.pe), forwardPe: num(q.fpe),
      eps: num(q.eps), forwardEps: num(q.feps),
      priceToSales: num(q.psales), forwardPs: num(q.fpsales),
      roe: num(q.ROETTM), netMargin: num(q.NETPROFTTM), grossMargin: num(q.GROSMGNTTM),
      debtToEquity: num(q.DEBTEQTYQ), ebitda: big(q.TTMEBITD),
      revenue: big(q.revenuettm), sharesOut: big(q.sharesout),
      dividendYield: num(q.dividendyield), beta: num(q.beta),
      avgVolume10d: big(q.tendayavgvol), volume: big(q.volume_alt || q.volume),
    },
  };
}

function parseSector(summary, profile) {
  const sd = summary?.data?.summaryData ?? {};
  const val = (k) => (sd[k]?.value ?? "").toString().trim() || null;
  return {
    sector: val("Sector") || profile?.data?.Sector?.value || null,
    industry: val("Industry") || profile?.data?.Industry?.value || null,
    oneYearTarget: num(val("OneYrTarget")),
  };
}

function parseAnalysts(target, ratings, price) {
  const c = target?.data?.consensusOverview;
  if (!c && !ratings?.data) return null;
  const mean = num(c?.priceTarget);
  const buy = num(c?.buy) ?? 0, hold = num(c?.hold) ?? 0, sell = num(c?.sell) ?? 0;
  const total = buy + hold + sell;

  // Is coverage getting more bullish? Compare the newest consensus snapshot
  // with one from roughly three months back.
  let trend = null;
  const hist = target?.data?.historicalConsensus;
  if (Array.isArray(hist) && hist.length >= 4) {
    const share = (p) => {
      const z = p?.z ?? {};
      const b = num(z.buy) ?? 0, h = num(z.hold) ?? 0, s = num(z.sell) ?? 0;
      const t = b + h + s;
      return t ? (b - s) / t : null;
    };
    const now = share(hist[hist.length - 1]);
    const then = share(hist[Math.max(0, hist.length - 4)]);
    if (now !== null && then !== null) trend = now - then;
  }

  return {
    count: total || num((/(\d+)\s+analysts/.exec(ratings?.data?.ratingsSummary ?? "") ?? [])[1]),
    mean, low: num(c?.lowPriceTarget), high: num(c?.highPriceTarget),
    buy, hold, sell,
    label: ratings?.data?.meanRatingType ?? null,
    upsidePercent: mean !== null && price ? ((mean - price) / price) * 100 : null,
    bullishShare: total ? buy / total : null,
    trend,
    brokers: Array.isArray(ratings?.data?.brokerNames) ? ratings.data.brokerNames.length : null,
  };
}

function parseEarnings(raw) {
  const rows = raw?.data?.earningsSurpriseTable?.rows;
  if (!Array.isArray(rows) || !rows.length) return null;
  const history = rows.map((r) => ({
    quarter: r.fiscalQtrEnd ?? null,
    reported: r.dateReported ?? null,
    actual: num(r.eps),
    estimate: num(r.consensusForecast),
    surprisePercent: num(r.percentageSurprise),
  })).filter((r) => r.actual !== null);
  if (!history.length) return null;
  const withSurprise = history.filter((r) => r.surprisePercent !== null);
  const beats = withSurprise.filter((r) => r.surprisePercent > 0).length;
  return {
    history: history.slice(0, 8),
    beatRate: withSurprise.length ? beats / withSurprise.length : null,
    avgSurprise: withSurprise.length
      ? withSurprise.reduce((a, r) => a + r.surprisePercent, 0) / withSurprise.length : null,
    quarters: withSurprise.length,
  };
}

/* Insider filings use a small, fixed vocabulary, and most of it carries no
   signal at all. Only `Buy` and `Sell` are discretionary open-market decisions.
   `Acquisition (Non Open Market)` is RSU vesting, `Disposition (Non Open
   Market)` is usually tax withholding, `Option Execute` is an exercise, and
   `Automatic Sell` runs off a 10b5-1 plan set months earlier. Counting a grant
   as a purchase would make routine compensation look like conviction, so each
   category is tracked separately and only the discretionary ones are scored. */

export function classifyInsiderTrade(type) {
  const t = String(type ?? "").toLowerCase().trim();
  if (!t) return "other";
  if (t === "buy" || t === "purchase" || t === "open market buy") return "buy";
  if (t === "sell" || t === "open market sell") return "sell";
  if (t.includes("automatic")) return "planned-sell";
  if (t.includes("option") || t.includes("exercise")) return "exercise";
  if (t.includes("non open market")) return t.includes("acquisition") ? "grant" : "withholding";
  if (t.includes("buy") || t.includes("purchase")) return "buy";
  if (t.includes("sell") || t.includes("sale")) return "sell";
  return "other";
}

const SIGNAL = { buy: "Discretionary buy", sell: "Discretionary sell",
                 "planned-sell": "Preset-plan sale", exercise: "Option exercise",
                 grant: "Share grant / vesting", withholding: "Tax withholding",
                 other: "Other" };

function parseInsiders(raw) {
  const rows = raw?.data?.transactionTable?.table?.rows;
  if (!Array.isArray(rows) || !rows.length) return null;

  const trades = rows.map((r) => {
    const kind = classifyInsiderTrade(r.transactionType);
    const shares = big(r.sharesTraded);
    const price = num(r.lastPrice);
    return {
      name: r.insider ?? null,
      relation: r.relation ?? null,
      date: r.lastDate ?? null,
      type: r.transactionType ?? null,
      kind,
      kindLabel: SIGNAL[kind],
      discretionary: kind === "buy" || kind === "sell",
      shares, price,
      held: big(r.sharesHeld),
      value: shares !== null && price !== null ? shares * price : null,
    };
  });

  const valueOf = (kind) => trades.filter((t) => t.kind === kind)
    .reduce((a, t) => a + (t.value ?? 0), 0);
  const countOf = (kind) => trades.filter((t) => t.kind === kind).length;

  const discretionaryBuys = valueOf("buy");
  const discretionarySells = valueOf("sell");
  const counts = Object.fromEntries(Object.keys(SIGNAL).map((k) => [k, countOf(k)]));

  return {
    trades: trades.slice(0, 12),
    counts,
    buyCount: counts.buy,
    sellCount: counts.sell,
    discretionaryBuys,
    discretionarySells,
    plannedSells: valueOf("planned-sell"),
    netDiscretionary: discretionaryBuys - discretionarySells,
    hasDiscretionary: counts.buy + counts.sell > 0,
    // How much of the recent activity is routine compensation rather than a decision.
    routineShare: trades.length
      ? trades.filter((t) => !t.discretionary).length / trades.length : null,
  };
}

function parseNews(raw) {
  const rows = raw?.data?.rows;
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => ({
    title: r.title ?? null,
    publisher: r.publisher ?? null,
    created: r.created ?? null,
    url: r.url ? (String(r.url).startsWith("http") ? r.url : "https://www.nasdaq.com" + r.url) : null,
  })).filter((n) => n.title);
}

function parseShort(raw) {
  const rows = raw?.data?.shortInterestTable?.rows;
  if (!Array.isArray(rows) || !rows.length) return null;
  const latest = rows[0], prior = rows[1];
  const interest = big(latest.interest), priorInterest = prior ? big(prior.interest) : null;
  return {
    settlementDate: latest.settlementDate ?? null,
    interest,
    daysToCover: num(latest.daysToCover),
    changePercent: interest !== null && priorInterest ? ((interest - priorInterest) / priorInterest) * 100 : null,
  };
}

/** Daily closes drive every momentum and volatility number below. */
function parseHistory(raw) {
  const rows = raw?.data?.tradesTable?.rows;
  if (!Array.isArray(rows) || rows.length < 10) return null;
  // Nasdaq returns newest first; work oldest-first.
  const series = rows.map((r) => ({ date: mdy(r.date), close: num(r.close) }))
    .filter((p) => p.date && p.close !== null)
    .sort((a, b) => a.date - b.date);
  if (series.length < 10) return null;

  const closes = series.map((p) => p.close);
  const last = closes[closes.length - 1];
  const back = (n) => closes[Math.max(0, closes.length - 1 - n)];
  const pct = (from) => (from ? ((last - from) / from) * 100 : null);
  const sma = (n) => {
    if (closes.length < n) return null;
    const w = closes.slice(-n);
    return w.reduce((a, c) => a + c, 0) / w.length;
  };

  // Annualised volatility from daily log returns.
  const rets = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0) rets.push(Math.log(closes[i] / closes[i - 1]));
  }
  const window = rets.slice(-30);
  const mean = window.reduce((a, r) => a + r, 0) / (window.length || 1);
  const variance = window.reduce((a, r) => a + (r - mean) ** 2, 0) / (window.length > 1 ? window.length - 1 : 1);
  const volatility = window.length > 5 ? Math.sqrt(variance) * Math.sqrt(252) * 100 : null;

  let peak = -Infinity, maxDrawdown = 0;
  for (const c of closes) {
    if (c > peak) peak = c;
    if (peak > 0) maxDrawdown = Math.min(maxDrawdown, ((c - peak) / peak) * 100);
  }

  const sma20 = sma(20), sma50 = sma(50);
  return {
    points: closes.slice(-90),
    last,
    return1w: pct(back(5)), return1m: pct(back(21)),
    return3m: pct(back(63)), return6m: pct(back(126)),
    sma20, sma50,
    vsSma20: sma20 ? ((last - sma20) / sma20) * 100 : null,
    vsSma50: sma50 ? ((last - sma50) / sma50) * 100 : null,
    volatility,
    maxDrawdown,
    days: closes.length,
  };
}

/* ---------------- assembly ---------------- */

/**
 * @param bundle  raw payloads keyed by source, from /api/analysis
 * @param symbol  the ticker requested
 * @param earningsEvent  optional {date, time, epsForecast} from /api/calendar
 */
export function parseAnalysis(bundle, symbol, earningsEvent = null) {
  const b = bundle ?? {};
  const quote = ok(b.quote) ? parseQuote(b.quote) : null;
  const price = quote?.last ?? null;
  const history = ok(b.history) ? parseHistory(b.history) : null;
  const sector = parseSector(ok(b.summary) ? b.summary : null, ok(b.profile) ? b.profile : null);
  const earnings = ok(b.earnings) ? parseEarnings(b.earnings) : null;

  let next = null;
  if (earningsEvent?.date) {
    const d = new Date(earningsEvent.date + "T00:00:00");
    if (!Number.isNaN(+d)) {
      next = {
        date: earningsEvent.date,
        time: earningsEvent.time ?? null,
        epsForecast: num(earningsEvent.epsForecast),
        daysAway: daysBetween(new Date(new Date().toDateString()), d),
      };
    }
  }

  // 52-week position: 0 at the low, 100 at the high.
  const hi = quote?.yearHigh, lo = quote?.yearLow;
  const rangePosition = (price !== null && hi !== null && lo !== null && hi > lo)
    ? ((price - lo) / (hi - lo)) * 100 : null;

  const sources = {};
  for (const [k, v] of Object.entries(b)) sources[k] = v?.error ? `failed: ${v.error}` : "ok";

  return {
    symbol,
    name: quote?.name ?? symbol,
    exchange: quote?.exchange ?? null,
    currency: quote?.currency ?? "USD",
    price, change: quote?.change ?? null, changePercent: quote?.changePercent ?? null,
    marketStatus: quote?.marketStatus ?? "",
    sector: sector.sector, industry: sector.industry,
    fundamentals: quote?.fundamentals ?? null,
    analysts: parseAnalysts(ok(b.target) ? b.target : null, ok(b.ratings) ? b.ratings : null, price),
    earnings: earnings ? { ...earnings, next } : (next ? { history: [], next } : null),
    insiders: ok(b.insiders) ? parseInsiders(b.insiders) : null,
    news: ok(b.news) ? parseNews(b.news) : [],
    shortInterest: ok(b.short) ? parseShort(b.short) : null,
    momentum: history,
    risk: {
      beta: quote?.fundamentals?.beta ?? null,
      volatility: history?.volatility ?? null,
      maxDrawdown: history?.maxDrawdown ?? null,
      debtToEquity: quote?.fundamentals?.debtToEquity ?? null,
      rangePosition,
    },
    sources,
  };
}
