/* GET /api/mover-why?symbol=AOUT&since=2026-09-10

   The raw evidence around one move — results, headlines, SEC filings since
   `since`, and recent daily closes. What it adds up to is decided in
   static/movers-model.mjs, alongside the sector context. */

import { fetchWhy } from "../lib/movers.mjs";
import { SYMBOL_RE } from "../lib/sources.mjs";

const json = (body, headers = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8",
               "Access-Control-Allow-Origin": "*", ...headers },
  });

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export default async (req) => {
  const params = new URL(req.url).searchParams;
  const symbol = (params.get("symbol") ?? "").trim().toUpperCase();
  const since = ISO_DATE.test(params.get("since") ?? "") ? params.get("since") : null;
  if (!symbol || !SYMBOL_RE.test(symbol)) {
    return json({ symbol, earnings: null, news: null, history: null, filings: null, error: "A valid symbol is required" });
  }
  try {
    return json({ ...(await fetchWhy(symbol, fetch, since)), error: null }, {
      "Cache-Control": "public, max-age=300",
      "Netlify-CDN-Cache-Control": "public, max-age=900, stale-while-revalidate=3600",
    });
  } catch (err) {
    return json({ symbol, earnings: null, news: null, history: null, filings: null, error: `Lookup failed (${err?.name ?? "error"})` });
  }
};

export const config = { path: "/api/mover-why" };
