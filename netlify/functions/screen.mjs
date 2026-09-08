/* GET /api/screen?cap=smallmid&sector=any&order=decliners&minPrice=3

   The market-wide funnel: filter every US-listed stock on cheap fields, then
   enrich a bounded slice. Ranking lives in static/screen-model.mjs. */

import { runScreen, CAP_BANDS, ORDERINGS, MAX_ENRICHED, MIN_PRICE } from "../lib/screener.mjs";

const json = (body, headers = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      ...headers,
    },
  });

const int = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : fallback;
};

export default async (req) => {
  const p = new URL(req.url).searchParams;
  const opts = {
    cap: CAP_BANDS[p.get("cap")] ? p.get("cap") : "smallmid",
    sector: p.get("sector") || "any",
    order: ORDERINGS[p.get("order")] ? p.get("order") : "decliners",
    minPrice: Math.max(MIN_PRICE, int(p.get("minPrice"), MIN_PRICE)),
    limit: Math.min(MAX_ENRICHED, Math.max(70, int(p.get("limit"), MAX_ENRICHED))),
  };
  try {
    const result = await runScreen(opts);
    return json({ ...result, filters: opts, asOf: Date.now() / 1000, error: null }, {
      // The universe barely moves intraday and the quotes are a first pass.
      "Cache-Control": "public, max-age=300",
      "Netlify-CDN-Cache-Control": "public, max-age=1800, stale-while-revalidate=21600",
    });
  } catch (err) {
    return json({ rows: [], quotes: {}, filters: opts, asOf: null,
                  error: `Screen failed (${err?.name ?? "error"})` });
  }
};

export const config = { path: "/api/screen" };
