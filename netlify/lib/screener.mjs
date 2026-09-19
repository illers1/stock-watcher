/* Screening the whole market instead of a watchlist.

   The per-stock analysis costs about ten upstream requests, so it cannot be
   pointed at seven thousand companies. This is the funnel that comes first:

     1. One request returns every US-listed stock with its sector, market cap,
        price and volume. That is the universe.
     2. The universe is filtered on those cheap fields — size, liquidity, price,
        sector — which is what actually decides whether a short is practical.
     3. A bounded slice of what survives is enriched through the batched quote
        feed, seventy symbols per request, which carries the 52-week range,
        valuation, margins, returns and leverage.
     4. Only the handful that rank worst are worth the full analysis.

   The slice is bounded on purpose, and the caller is told how many matched
   versus how many were examined. A screen that quietly looks at the first
   couple of hundred rows and presents the result as "the market" is worse than
   one that admits where it stopped. */

import { BROWSER_UA } from "./sources.mjs";

const SCREENER = "https://api.nasdaq.com/api/screener/stocks";
const QUOTE = "https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol";

export const BATCH_SIZE = 70;      // symbols the quote feed takes at once
export const MAX_ENRICHED = 280;   // four batches: the examination budget

/* Floors applied everywhere, on every window. Below them a listing is not
   really tradeable: a sub-$3 price makes a one-cent tick a percentage move,
   and under $25M of market value there is rarely enough company to analyse.
   There is deliberately no volume floor — a thin day is not a reason to hide
   a stock, and screening one out on volume hides exactly the small names a
   screen exists to surface. */
export const MIN_PRICE = 3;
export const MIN_MARKET_CAP = 25e6;

/** Market-cap bands, in the terms people actually use. */
export const CAP_BANDS = {
  any:    { label: "Any size",   min: MIN_MARKET_CAP, max: Infinity },
  mega:   { label: "Mega cap",   min: 200e9, max: Infinity },
  large:  { label: "Large cap",  min: 10e9,  max: 200e9 },
  mid:    { label: "Mid cap",    min: 2e9,   max: 10e9 },
  small:  { label: "Small cap",  min: 300e6, max: 2e9 },
  smallmid: { label: "Small and mid cap", min: 300e6, max: 10e9 },
};

const money = (v) => {
  if (v === null || v === undefined) return null;
  const t = String(v).replace(/[$,%\s]/g, "").replace(/^\((.*)\)$/, "-$1");
  if (!t || t.toUpperCase() === "N/A") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

/* The same reading as money(), for the 28,000-odd fields in the market-wide
   list, without a regular expression per field — which was more than half the
   cost of mapping it. The usual forms ("$12.34", "1,234,567", "-2.5%") are read
   directly; anything else is handed to money(), so the answer never differs. */
export function quickMoney(v) {
  if (v === null || v === undefined) return null;
  let s = typeof v === "string" ? v : String(v);
  if (s.charCodeAt(0) === 36) s = s.slice(1);                       // "$"
  if (s.endsWith("%")) s = s.slice(0, -1);
  if (s.indexOf(",") !== -1) s = s.replaceAll(",", "");
  const t = s.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : money(v);
}
export const readMoney = money;

async function get(url, doFetch, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await doFetch(url, {
      headers: { "User-Agent": BROWSER_UA, Accept: "application/json" },
      signal: controller.signal,
      redirect: "follow",
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** "Last price as of Sep 4, 2026" -> "2026-09-04". */
const MONTHS = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];
export function parseAsOf(label) {
  const m = /([A-Za-z]{3})[a-z]*\s+(\d{1,2}),?\s+(\d{4})/.exec(String(label ?? ""));
  if (!m) return null;
  const month = MONTHS.indexOf(m[1].toLowerCase());
  if (month === -1) return null;
  return `${m[3]}-${String(month + 1).padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}

/**
 * Every US-listed stock, with the fields cheap enough to fetch in bulk.
 * The feed states which session it describes, which is worth taking over any
 * guess from the clock: a weekday is not necessarily a trading day, and
 * working back from "today" quietly captions Friday's moves as Monday's on
 * every public holiday.
 */
export async function fetchSessionDate(doFetch = fetch) {
  /* The bulk download carries an asOf key but leaves it null; the paged
     variant fills it in. One row is enough to ask. */
  const res = await get(`${SCREENER}?tableonly=true&limit=1&offset=0&download=false`, doFetch, 12000);
  if (!res?.ok) return { sessionDate: null, asOfLabel: null };
  try {
    const body = await res.json();
    const label = body?.data?.asof ?? body?.data?.asOf ?? null;
    return { sessionDate: parseAsOf(label), asOfLabel: label };
  } catch {
    return { sessionDate: null, asOfLabel: null };
  }
}

/* One parse of the market-wide list serves every request an instance handles
   for a few minutes, whatever the filters: movers and the screen both start
   from it, and parsing its 2 MB is most of what either costs. On Cloudflare's
   free plan, where a request gets 10 ms of CPU, that is the difference between
   working and not.

   Only a finished result is shared. A load in progress is not handed to a
   second request, because a Worker may not wait on I/O another request began.
   And only a real fetch is cached, so tests that pass their own never see
   another test's data. */
export const UNIVERSE_TTL_MS = 3 * 60 * 1000;
let universeCache = { at: 0, value: null };

export async function fetchUniverse(doFetch = fetch) {
  const shared = doFetch === globalThis.fetch;
  if (shared && universeCache.value && Date.now() - universeCache.at < UNIVERSE_TTL_MS) {
    return universeCache.value;
  }
  const value = await loadUniverse(doFetch);
  if (shared && value.rows.length) universeCache = { at: Date.now(), value };
  return value;
}

async function loadUniverse(doFetch) {
  const [res, session] = await Promise.all([
    get(`${SCREENER}?tableonly=true&limit=8000&offset=0&download=true`, doFetch, 25000),
    fetchSessionDate(doFetch),
  ]);
  if (!res?.ok) return { rows: [], total: 0, sessionDate: null, asOfLabel: null };
  let body;
  try { body = await res.json(); } catch { return { rows: [], total: 0, sessionDate: null, asOfLabel: null }; }
  const rows = body?.data?.rows ?? body?.data?.table?.rows ?? [];
  const asOfLabel = body?.data?.asOf ?? body?.data?.asof ?? session.asOfLabel;
  /* Every endpoint applies the universal floors before using a row, so a row
     below them is only ever counted. It is counted here and not built: that is
     about two rows in five, and building them was a large share of the cost. */
  let total = 0;
  const mapped = [];
  for (const r of rows) {
    const symbol = String(r.symbol ?? "").toUpperCase();
    if (!symbol) continue;
    total++;
    const price = quickMoney(r.lastsale);
    const marketCap = quickMoney(r.marketCap);
    if (price === null || price < MIN_PRICE || marketCap === null || marketCap < MIN_MARKET_CAP) continue;
    mapped.push({
      symbol,
      name: r.name ?? null,
      price,
      changePercent: quickMoney(r.pctchange),
      marketCap,
      volume: quickMoney(r.volume),
      sector: r.sector || null,
      industry: r.industry || null,
      country: r.country || null,
    });
  }
  return { rows: mapped, total, sessionDate: parseAsOf(asOfLabel) ?? session.sessionDate, asOfLabel };
}

/**
 * Narrow the universe on the fields that decide whether a short is workable at
 * all: too small or too thin and the borrow is scarce, expensive, or the
 * position cannot be closed without moving the price.
 */
export function filterUniverse(rows, opts = {}) {
  const band = CAP_BANDS[opts.cap] ?? CAP_BANDS.any;
  // A caller may ask for more than the floor, never less.
  const minPrice = Math.max(MIN_PRICE, opts.minPrice ?? MIN_PRICE);
  const minCap = Math.max(MIN_MARKET_CAP, band.min);
  const sector = opts.sector && opts.sector !== "any" ? String(opts.sector).toLowerCase() : null;

  return (rows ?? []).filter((r) => {
    if (r.marketCap === null || r.marketCap < minCap || r.marketCap > band.max) return false;
    if (r.price === null || r.price < minPrice) return false;
    if (sector && String(r.sector ?? "").toLowerCase() !== sector) return false;
    // Symbols carrying suffixes are warrants, units and preference lines.
    if (/[.\^]/.test(r.symbol)) return false;
    return true;
  });
}

/** How the bounded slice is chosen, stated rather than hidden. */
export const ORDERINGS = {
  decliners: { label: "Biggest fallers today", sort: (a, b) => (a.changePercent ?? 0) - (b.changePercent ?? 0) },
  smallest:  { label: "Smallest first", sort: (a, b) => (a.marketCap ?? 0) - (b.marketCap ?? 0) },
  largest:   { label: "Largest first", sort: (a, b) => (b.marketCap ?? 0) - (a.marketCap ?? 0) },
  liquid:    { label: "Most traded first", sort: (a, b) => (b.volume ?? 0) - (a.volume ?? 0) },
};

/** Fundamentals for a list of symbols, seventy at a time. */
export async function enrich(symbols, doFetch = fetch) {
  const out = {};
  for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
    const batch = symbols.slice(i, i + BATCH_SIZE);
    const url = `${QUOTE}?` + new URLSearchParams({
      symbols: batch.join("|"), requestMethod: "itv", noform: "1",
      partnerId: "2", fund: "1", exthrs: "1", output: "json", events: "1",
    });
    const res = await get(url, doFetch, 20000);
    if (!res?.ok) continue;
    let body;
    try { body = await res.json(); } catch { continue; }
    let records = body?.FormattedQuoteResult?.FormattedQuote ?? [];
    if (!Array.isArray(records)) records = [records];
    for (const rec of records) {
      const sym = String(rec?.symbol ?? "").toUpperCase();
      if (sym && String(rec?.code) === "0") out[sym] = rec;
    }
  }
  return out;
}

/** The whole funnel, for one set of filters. */
export async function runScreen(opts = {}, doFetch = fetch) {
  const { rows: universe, total, sessionDate, asOfLabel } = await fetchUniverse(doFetch);
  // An empty market is a failed feed, not a quiet day, and must not be cached as one.
  if (!universe.length) throw new Error("market list unavailable");
  const matched = filterUniverse(universe, opts);
  const ordering = ORDERINGS[opts.order] ?? ORDERINGS.decliners;
  const ordered = matched.slice().sort(ordering.sort);
  const budget = Math.max(BATCH_SIZE, Math.min(MAX_ENRICHED, opts.limit ?? MAX_ENRICHED));
  const slice = ordered.slice(0, budget);
  const quotes = await enrich(slice.map((r) => r.symbol), doFetch);

  return {
    universeSize: total,
    sessionDate, asOfLabel,
    matched: matched.length,
    examined: slice.length,
    order: opts.order ?? "decliners",
    orderLabel: ordering.label,
    rows: slice,
    quotes,
  };
}
