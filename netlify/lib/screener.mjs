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

/** Market-cap bands, in the terms people actually use. */
export const CAP_BANDS = {
  any:    { label: "Any size",   min: 0,    max: Infinity },
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

export async function fetchUniverse(doFetch = fetch) {
  const [res, session] = await Promise.all([
    get(`${SCREENER}?tableonly=true&limit=8000&offset=0&download=true`, doFetch, 25000),
    fetchSessionDate(doFetch),
  ]);
  if (!res?.ok) return { rows: [], sessionDate: null, asOfLabel: null };
  let body;
  try { body = await res.json(); } catch { return { rows: [], sessionDate: null, asOfLabel: null }; }
  const rows = body?.data?.rows ?? body?.data?.table?.rows ?? [];
  const asOfLabel = body?.data?.asOf ?? body?.data?.asof ?? session.asOfLabel;
  const mapped = rows.map((r) => ({
    symbol: String(r.symbol ?? "").toUpperCase(),
    name: r.name ?? null,
    price: money(r.lastsale),
    changePercent: money(r.pctchange),
    marketCap: money(r.marketCap),
    volume: money(r.volume),
    sector: r.sector || null,
    industry: r.industry || null,
    country: r.country || null,
  })).filter((r) => r.symbol);
  return { rows: mapped, sessionDate: parseAsOf(asOfLabel) ?? session.sessionDate, asOfLabel };
}

/**
 * Narrow the universe on the fields that decide whether a short is workable at
 * all: too small or too thin and the borrow is scarce, expensive, or the
 * position cannot be closed without moving the price.
 */
export function filterUniverse(rows, opts = {}) {
  const band = CAP_BANDS[opts.cap] ?? CAP_BANDS.any;
  const minPrice = opts.minPrice ?? 5;
  const minVolume = opts.minVolume ?? 300000;
  const sector = opts.sector && opts.sector !== "any" ? String(opts.sector).toLowerCase() : null;

  return (rows ?? []).filter((r) => {
    if (r.marketCap === null || r.marketCap < band.min || r.marketCap > band.max) return false;
    if (r.price === null || r.price < minPrice) return false;
    if (r.volume !== null && r.volume < minVolume) return false;
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
  const { rows: universe, sessionDate, asOfLabel } = await fetchUniverse(doFetch);
  const matched = filterUniverse(universe, opts);
  const ordering = ORDERINGS[opts.order] ?? ORDERINGS.decliners;
  const ordered = matched.slice().sort(ordering.sort);
  const budget = Math.max(BATCH_SIZE, Math.min(MAX_ENRICHED, opts.limit ?? MAX_ENRICHED));
  const slice = ordered.slice(0, budget);
  const quotes = await enrich(slice.map((r) => r.symbol), doFetch);

  return {
    universeSize: universe.length,
    sessionDate, asOfLabel,
    matched: matched.length,
    examined: slice.length,
    order: opts.order ?? "decliners",
    orderLabel: ordering.label,
    rows: slice,
    quotes,
  };
}
