/* GET /api/analysis?symbol=AAPL

   Fans out to every upstream for one symbol and returns the raw payloads
   bundled together. Deliberately no interpretation here: the parsing lives in
   static/analyze.mjs so that the browser, the deployed function and the local
   Python server all share one implementation instead of three. */

import { SYMBOL_RE, fetchAll } from "../lib/sources.mjs";

const json = (body, headers = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      ...headers,
    },
  });

export default async (req) => {
  const symbol = (new URL(req.url).searchParams.get("symbol") ?? "").trim().toUpperCase();
  if (!symbol || !SYMBOL_RE.test(symbol)) {
    return json({ symbol, sources: {}, error: "A valid symbol is required" });
  }

  try {
    const sources = await fetchAll(symbol);
    const failed = Object.entries(sources).filter(([, v]) => v?.error).map(([k]) => k);
    return json(
      { symbol, sources, asOf: Date.now() / 1000, failed, error: null },
      {
        // Fundamentals, filings and analyst data move slowly; the live price
        // still comes from /api/quotes on its own faster cycle.
        "Cache-Control": "public, max-age=60",
        "Netlify-CDN-Cache-Control": "public, max-age=600, stale-while-revalidate=3600",
      }
    );
  } catch (err) {
    return json({ symbol, sources: {}, asOf: null, error: `Analysis failed (${err?.name ?? "error"})` });
  }
};

export const config = { path: "/api/analysis" };
