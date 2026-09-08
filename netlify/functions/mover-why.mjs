/* GET /api/mover-why?symbol=AOUT

   The raw evidence around one move — results and headlines. What it adds up to
   is decided in static/movers-model.mjs, alongside the sector context. */

import { fetchWhy } from "../lib/movers.mjs";
import { SYMBOL_RE } from "../lib/sources.mjs";

const json = (body, headers = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8",
               "Access-Control-Allow-Origin": "*", ...headers },
  });

export default async (req) => {
  const symbol = (new URL(req.url).searchParams.get("symbol") ?? "").trim().toUpperCase();
  if (!symbol || !SYMBOL_RE.test(symbol)) {
    return json({ symbol, earnings: null, news: null, error: "A valid symbol is required" });
  }
  try {
    return json({ ...(await fetchWhy(symbol)), error: null }, {
      "Cache-Control": "public, max-age=300",
      "Netlify-CDN-Cache-Control": "public, max-age=900, stale-while-revalidate=3600",
    });
  } catch (err) {
    return json({ symbol, earnings: null, news: null, error: `Lookup failed (${err?.name ?? "error"})` });
  }
};

export const config = { path: "/api/mover-why" };
