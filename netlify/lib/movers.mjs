/* The session's biggest movers, and what coincided with them.

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
export const DEFAULT_COUNT = 15;

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

export async function fetchMovers(opts = {}, doFetch = fetch) {
  const { rows: universe, sessionDate, asOfLabel } = await fetchUniverse(doFetch);
  const tradeable = filterUniverse(universe, {
    cap: CAP_BANDS[opts.cap] ? opts.cap : "any",
    minPrice: opts.minPrice ?? MIN_PRICE,
    sector: opts.sector,
  }).filter((r) => r.changePercent !== null);

  const count = Math.max(1, Math.min(50, opts.count ?? DEFAULT_COUNT));
  const byMove = tradeable.slice().sort((a, b) => b.changePercent - a.changePercent);

  return {
    // Taken from the feed rather than inferred: holidays make any guess wrong.
    sessionDate, asOfLabel,
    gainers: byMove.slice(0, count),
    losers: byMove.slice(-count).reverse(),
    sectors: sectorMoves(tradeable),
    tradeable: tradeable.length,
    universeSize: universe.length,
  };
}

/** The evidence for one mover: did they report, and what is being written. */
export async function fetchWhy(symbol, doFetch = fetch) {
  const enc = encodeURIComponent(symbol);
  const [earnings, news] = await Promise.all([
    get(`${NASDAQ}/company/${enc}/earnings-surprise`, doFetch)
      .then((r) => (r?.ok ? r.json() : null)).catch(() => null),
    get(`${NASDAQ}/news/topic/articlebysymbol?q=${enc}%7Cstocks&offset=0&limit=6&fallback=true`, doFetch)
      .then((r) => (r?.ok ? r.json() : null)).catch(() => null),
  ]);
  return { symbol, earnings, news };
}
