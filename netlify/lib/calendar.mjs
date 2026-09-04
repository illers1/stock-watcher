/* Walking Nasdaq's earnings calendar.

   The upstream is indexed by date, not by symbol: one request returns every
   company reporting on one day. Both endpoints built on it therefore walk a
   window of trading days and fan out a request per day, and differ only in
   what they keep. `/api/calendar` collapses the window to the soonest date per
   symbol, so a watchlist of any size resolves from one map. `/api/earnings`
   keeps the day-by-day listing, because there the calendar *is* the subject.

   `server.py` mirrors this for local use. */

import { BROWSER_UA } from "./sources.mjs";

export const CALENDAR_URL = "https://api.nasdaq.com/api/calendar/earnings";
export const MAX_DAYS = 60;
export const CONCURRENCY = 10;

/* Local Y-M-D rather than `toISOString().slice(0, 10)`: the latter converts to
   UTC first, which moves the date back a day for anyone east of Greenwich. */
export const iso = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** ISO dates for the next `days` weekdays starting at `from`, weekends skipped. */
export function tradingDays(from, days, max = MAX_DAYS) {
  const start = from instanceof Date ? from : new Date(String(from) + "T00:00:00");
  const cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const out = [];
  for (let n = 0; out.length < Math.min(days, max) && n < days + 2 * max; n++) {
    const d = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + n);
    if (d.getDay() !== 0 && d.getDay() !== 6) out.push(iso(d));
  }
  return out;
}

/** One day of the calendar. A failed day is an empty day, never a failed window. */
export async function fetchDay(dateStr, doFetch = fetch, timeoutMs = 7000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await doFetch(`${CALENDAR_URL}?date=${dateStr}`, {
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

/** Run tasks with a cap on how many are in flight at once, preserving order. */
export async function pooled(items, limit, worker) {
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

/* The fields carried forward, left exactly as the upstream formats them
   ("$1.46", "($0.04)", "time-pre-market"). Reading them into numbers is
   static/earnings-model.mjs's job, so the browser, the deployed function and
   the local Python server all share one interpretation. */
export const pickRow = (r, date) => ({
  symbol: String(r?.symbol ?? "").toUpperCase(),
  name: r?.name ?? null,
  date,
  time: r?.time ?? null,
  marketCap: r?.marketCap ?? null,
  epsForecast: r?.epsForecast ?? null,
  noOfEsts: r?.noOfEsts ?? null,
  fiscalQuarterEnding: r?.fiscalQuarterEnding ?? null,
  lastYearEPS: r?.lastYearEPS ?? null,
  lastYearRptDt: r?.lastYearRptDt ?? null,
});
