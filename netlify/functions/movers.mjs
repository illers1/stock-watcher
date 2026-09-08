/* GET /api/movers?cap=any&minPrice=5&minVolume=500000&count=15 */

import { fetchMovers } from "../lib/movers.mjs";

const json = (body, headers = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8",
               "Access-Control-Allow-Origin": "*", ...headers },
  });

const int = (v, d) => { const n = Number(v); return Number.isFinite(n) ? Math.round(n) : d; };

export default async (req) => {
  const p = new URL(req.url).searchParams;
  const opts = {
    cap: p.get("cap") || "any",
    sector: p.get("sector") || "any",
    minPrice: Math.max(0, int(p.get("minPrice"), 5)),
    minVolume: Math.max(0, int(p.get("minVolume"), 500000)),
    count: int(p.get("count"), 15),
  };
  try {
    const result = await fetchMovers(opts);
    return json({ ...result, filters: opts, asOf: Date.now() / 1000, error: null }, {
      "Cache-Control": "public, max-age=120",
      "Netlify-CDN-Cache-Control": "public, max-age=600, stale-while-revalidate=3600",
    });
  } catch (err) {
    return json({ gainers: [], losers: [], sectors: {}, filters: opts,
                  asOf: null, error: `Movers failed (${err?.name ?? "error"})` });
  }
};

export const config = { path: "/api/movers" };
