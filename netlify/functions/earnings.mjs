/* GET /api/earnings?from=2026-09-03&days=5

   The earnings calendar itself, day by day: every company reporting inside the
   window, with the consensus estimate, the estimate count and last year's
   figure that Nasdaq publishes alongside. Where /api/calendar answers "when
   does this symbol report", this answers "who reports this week" — the list the
   Earnings window is built from.

   Rows are passed through with their upstream formatting intact; reading them
   into numbers is static/earnings-model.mjs's job, shared with the tests. */

import { tradingDays, fetchDay, pooled, pickRow, CONCURRENCY } from "../lib/calendar.mjs";

const MAX_DAYS = 30;
const MAX_ROWS = 2500;   // a month of full days is ~4000 rows; cap the payload

const json = (body, headers = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      ...headers,
    },
  });

export async function buildEarnings(from, days, doFetch = fetch) {
  const dates = tradingDays(from, days, MAX_DAYS);
  const pages = await pooled(dates, CONCURRENCY, (d) => fetchDay(d, doFetch));

  const seen = new Set();
  const out = [];
  let total = 0;
  let truncated = false;

  for (let i = 0; i < dates.length; i++) {
    const rows = [];
    for (const r of pages[i] ?? []) {
      const row = pickRow(r, dates[i]);
      // A confirmed date supersedes a later provisional one, so the first
      // sighting as the window is walked forward is the one that counts.
      if (!row.symbol || seen.has(row.symbol)) continue;
      if (total >= MAX_ROWS) { truncated = true; break; }
      seen.add(row.symbol);
      rows.push(row);
      total++;
    }
    out.push({ date: dates[i], count: rows.length, rows });
  }

  return {
    days: out,
    total,
    truncated,
    from: dates[0] ?? null,
    to: dates[dates.length - 1] ?? null,
  };
}

export default async (req) => {
  const params = new URL(req.url).searchParams;
  const rawDays = Number(params.get("days"));
  const days = Number.isFinite(rawDays) ? Math.max(1, Math.min(MAX_DAYS, Math.round(rawDays))) : 5;

  const rawFrom = (params.get("from") ?? "").trim();
  const from = /^\d{4}-\d{2}-\d{2}$/.test(rawFrom) ? rawFrom : null;

  try {
    const result = await buildEarnings(from ?? new Date(), days);
    return json(
      { ...result, asOf: Date.now() / 1000, error: null },
      {
        // The schedule barely moves within a day; the per-company numbers on
        // top of it come from /api/analysis on its own, faster cycle.
        "Cache-Control": "public, max-age=1800",
        "Netlify-CDN-Cache-Control": "public, max-age=21600, stale-while-revalidate=86400",
      }
    );
  } catch (err) {
    return json({ days: [], total: 0, asOf: null, error: `Calendar failed (${err?.name ?? "error"})` });
  }
};

export const config = { path: "/api/earnings" };
