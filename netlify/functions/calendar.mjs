/* GET /api/calendar?days=30

   Upcoming earnings dates, as a symbol -> event map. The upstream is indexed
   by date rather than by symbol, so this walks forward over the window once
   and caches the result hard; every symbol on a watchlist then resolves from
   the same map instead of costing a request of its own. */

import { BROWSER_UA } from "../lib/sources.mjs";

const CALENDAR = "https://api.nasdaq.com/api/calendar/earnings";
const MAX_DAYS = 60;
const CONCURRENCY = 10;

const json = (body, headers = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      ...headers,
    },
  });

const iso = (d) => d.toISOString().slice(0, 10);

async function fetchDay(dateStr, doFetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 7000);
  try {
    const res = await doFetch(`${CALENDAR}?date=${dateStr}`, {
      headers: { "User-Agent": BROWSER_UA, Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) return [];
    const body = await res.json();
    return (body?.data?.rows ?? []).map((r) => ({ ...r, _date: dateStr }));
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** Run tasks with a cap on how many are in flight at once. */
async function pooled(items, limit, worker) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await worker(items[idx]);
    }
  }));
  return out;
}

export async function buildCalendar(days, doFetch = fetch, today = new Date()) {
  const dates = [];
  const cursor = new Date(today.toDateString());
  for (let n = 0; n < days && dates.length < MAX_DAYS; n++) {
    const d = new Date(cursor.getTime() + n * 864e5);
    if (d.getDay() !== 0 && d.getDay() !== 6) dates.push(iso(d));  // skip weekends
  }

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
