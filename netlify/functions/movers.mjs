/* GET /api/movers?period=day|week|month&cap=any&minPrice=3&count=15 */

import { fetchMovers } from "../lib/movers.mjs";
import { MIN_PRICE } from "../lib/screener.mjs";

const json = (body, headers = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8",
               "Access-Control-Allow-Origin": "*", ...headers },
  });

const int = (v, d) => { const n = Number(v); return Number.isFinite(n) ? Math.round(n) : d; };

export default async (req) => {
  const p = new URL(req.url).searchParams;
  const period = p.get("period");
  const opts = {
    period: period === "week" || period === "month" ? period : "day",
    cap: p.get("cap") || "any",
    sector: p.get("sector") || "any",
    minPrice: Math.max(MIN_PRICE, int(p.get("minPrice"), MIN_PRICE)),
    count: int(p.get("count"), 15),
  };
  try {
    const result = await fetchMovers(opts);
    return json({ ...result, filters: opts, asOf: Date.now() / 1000, error: null }, {
      "Cache-Control": "public, max-age=120",
      "Netlify-CDN-Cache-Control": "public, max-age=600, stale-while-revalidate=3600",
    });
  } catch (err) {
    return json({ gainers: [], losers: [], sectors: {}, filters: opts, asOf: null,
                  error: opts.period === "day"
                    ? `Movers failed (${err?.name ?? "error"})`
                    : `Weekly and monthly changes are unavailable right now (${err?.name ?? "error"})` });
  }
};

export const config = { path: "/api/movers" };
