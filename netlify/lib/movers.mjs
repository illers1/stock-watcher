/* The biggest movers over a session, a week or a month, and what coincided
   with them.

   Two things are worth being careful about here.

   The first is the word "today". Markets are shut most of the time, so the
   freshest figures are the last completed session's — which on a Sunday means
   Friday. The date the data actually describes travels with it rather than
   being called today.

   The second is "why". Nothing here observes cause. What it can do is gather
   what else was happening around the same time — a results announcement, the
   headlines, how the rest of the sector moved — and let that be read as
   coincidence. A stock down 17% on a day its sector fell 0.3% is a company
   story; the same stock down 8% while the sector fell 6% is not. */

import { fetchUniverse, filterUniverse, CAP_BANDS, MIN_PRICE } from "./screener.mjs";
import { BROWSER_UA } from "./sources.mjs";

const NASDAQ = "https://api.nasdaq.com/api";
const SCANNER = "https://scanner.tradingview.com/america/scan";
export const DEFAULT_COUNT = 15;

/* The universe feed only carries the day's change. Weekly and monthly changes
   come from a scanner that returns every US listing in one request; they are
   joined onto the same universe, so the floors and filters are identical
   whichever period is chosen. */
export const PERIOD_COLUMNS = { week: "Perf.W", month: "Perf.1M" };
export const HISTORY_DAYS = 45;

async function get(url, doFetch, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await doFetch(url, {
      headers: { "User-Agent": BROWSER_UA, Accept: "application/json" },
      signal: controller.signal, redirect: "follow",
    });
  } catch { return null; } finally { clearTimeout(timer); }
}

const median = (values) => {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

/** Average move per sector, which separates a company story from a sector one. */
export function sectorMoves(rows) {
  const buckets = new Map();
  for (const r of rows ?? []) {
    if (r.changePercent === null || !r.sector) continue;
    if (!buckets.has(r.sector)) buckets.set(r.sector, []);
    buckets.get(r.sector).push(r.changePercent);
  }
  const out = {};
  for (const [sector, values] of buckets) {
    const sorted = values.slice().sort((a, b) => a - b);
    out[sector] = {
      count: values.length,
      // The median, because a handful of 40% moves would drag a mean around.
      median: sorted[Math.floor(sorted.length / 2)],
      mean: values.reduce((a, b) => a + b, 0) / values.length,
    };
  }
  return out;
}

/** Week and month % change for every US listing, keyed by symbol. */
export async function fetchPerformance(doFetch = fetch, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await doFetch(SCANNER, {
      method: "POST",
      headers: { "User-Agent": BROWSER_UA, Accept: "application/json",
                 "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        columns: ["name", PERIOD_COLUMNS.week, PERIOD_COLUMNS.month],
        filter: [
          { left: "type", operation: "in_range", right: ["stock", "dr"] },
          { left: "exchange", operation: "in_range", right: ["NASDAQ", "NYSE", "AMEX"] },
        ],
        range: [0, 20000],
      }),
    });
    if (!res?.ok) return null;
    return performanceMap(await res.json());
  } catch { return null; } finally { clearTimeout(timer); }
}

export function performanceMap(body) {
  const out = {};
  for (const row of body?.data ?? []) {
    const [name, week, month] = row?.d ?? [];
    if (!name) continue;
    const fin = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    out[String(name).toUpperCase()] = { week: fin(week), month: fin(month) };
  }
  return out;
}

/** Swap the day's change for the period's, keeping the day's alongside. */
export function applyPeriod(rows, perf, period) {
  if (!PERIOD_COLUMNS[period]) return rows;
  return rows.map((r) => ({
    ...r, dayChange: r.changePercent,
    changePercent: perf?.[r.symbol]?.[period] ?? null,
  }));
}

export async function fetchMovers(opts = {}, doFetch = fetch) {
  const period = PERIOD_COLUMNS[opts.period] ? opts.period : "day";
  const [{ rows: raw, sessionDate, asOfLabel }, perf] = await Promise.all([
    fetchUniverse(doFetch),
    period === "day" ? null : fetchPerformance(doFetch),
  ]);
  if (period !== "day" && !perf) throw new Error("performance feed unavailable");
  const universe = applyPeriod(raw, perf, period);
  const matched = filterUniverse(universe, {
    cap: CAP_BANDS[opts.cap] ? opts.cap : "any",
    minPrice: opts.minPrice ?? MIN_PRICE,
    sector: opts.sector,
  });
  /* A handful of listings — units, preference lines, recent listings — carry no
     weekly or monthly figure. They are dropped, and counted so the page can say
     so rather than quietly narrowing the field. */
  const tradeable = matched.filter((r) => r.changePercent !== null);

  const count = Math.max(1, Math.min(50, opts.count ?? DEFAULT_COUNT));
  const byMove = tradeable.slice().sort((a, b) => b.changePercent - a.changePercent);

  return {
    // Taken from the feed rather than inferred: holidays make any guess wrong.
    sessionDate, asOfLabel, period,
    gainers: byMove.slice(0, count),
    losers: byMove.slice(-count).reverse(),
    sectors: sectorMoves(tradeable),
    // The whole market's median, so a move can be set against everything.
    market: median(tradeable.map((r) => r.changePercent)),
    tradeable: tradeable.length,
    unpriced: matched.length - tradeable.length,
    universeSize: universe.length,
  };
}

/** The evidence for one mover: did they report, what is being written, and on
    which days the price actually moved. Enough history and headlines are
    fetched to cover a monthly move as well as a daily one. */
export async function fetchWhy(symbol, doFetch = fetch) {
  const enc = encodeURIComponent(symbol);
  const to = new Date();
  const from = new Date(to.getTime() - HISTORY_DAYS * 864e5);
  const iso = (d) => d.toISOString().slice(0, 10);
  const [earnings, news, history] = await Promise.all([
    get(`${NASDAQ}/company/${enc}/earnings-surprise`, doFetch)
      .then((r) => (r?.ok ? r.json() : null)).catch(() => null),
    /* Asked about a symbol it has no coverage for, this feed answers with
       general market stories anyway — the same list for every such symbol. They
       are dropped in movers-model.mjs by the symbols the publisher tagged,
       which is the only thing that actually distinguishes them. */
    get(`${NASDAQ}/news/topic/articlebysymbol?q=${enc}%7Cstocks&offset=0&limit=20&fallback=false`, doFetch)
      .then((r) => (r?.ok ? r.json() : null)).catch(() => null),
    get(`${NASDAQ}/quote/${enc}/historical?assetclass=stocks&fromdate=${iso(from)}&todate=${iso(to)}&limit=60`, doFetch)
      .then((r) => (r?.ok ? r.json() : null)).catch(() => null),
  ]);
  return { symbol, earnings, news, history };
}
