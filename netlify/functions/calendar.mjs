/* GET /api/calendar?days=30

   Upcoming earnings dates, as a symbol -> event map. The upstream is indexed
   by date rather than by symbol, so this walks forward over the window once
   and caches the result hard; every symbol on a watchlist then resolves from
   the same map instead of costing a request of its own.

   The day-by-day listing behind the Earnings window is /api/earnings; both sit
   on the same walk in ../lib/calendar.mjs. */

import { tradingDays, fetchDay, pooled, MAX_DAYS, CONCURRENCY } from "../lib/calendar.mjs";

const json = (body, headers = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      ...headers,
    },
  });

export async function buildCalendar(days, doFetch = fetch, today = new Date()) {
  const dates = tradingDays(today, days, MAX_DAYS);
  const pages = await pooled(dates, CONCURRENCY, (d) => fetchDay(d, doFetch));
  const events = {};
  for (const rows of pages) {
    for (const r of rows) {
      const sym = String(r?.symbol ?? "").toUpperCase();
      if (!sym || events[sym]) continue;   // keep the soonest date per symbol
      events[sym] = {
        date: r._date,
        time: r.time ?? null,
        epsForecast: r.epsForecast ?? null,
        fiscalQuarterEnding: r.fiscalQuarterEnding ?? null,
        name: r.name ?? null,
      };
    }
  }
  return { events, daysScanned: dates.length, from: dates[0] ?? null, to: dates[dates.length - 1] ?? null };
}

export default async (req) => {
  const raw = Number(new URL(req.url).searchParams.get("days"));
  const days = Number.isFinite(raw) ? Math.max(1, Math.min(MAX_DAYS, Math.round(raw))) : 30;
  try {
    const result = await buildCalendar(days);
    return json(
      { ...result, asOf: Date.now() / 1000, error: null },
      {
        "Cache-Control": "public, max-age=1800",
        "Netlify-CDN-Cache-Control": "public, max-age=21600, stale-while-revalidate=86400",
      }
    );
  } catch (err) {
    return json({ events: {}, asOf: null, error: `Calendar failed (${err?.name ?? "error"})` });
  }
};

export const config = { path: "/api/calendar" };
