/* GET /api/quotes?symbols=AAPL,MSFT
   Proxies the upstream quote feed, which the browser cannot call directly
   because of CORS, and normalises it for the front end. */

import { parseSymbols, buildQuotes } from "../lib/format.mjs";

const QUOTE_URL = "https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
           "(KHTML, like Gecko) Chrome/125.0 Safari/537.36";

const json = (body, extraHeaders = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      ...extraHeaders,
    },
  });

export default async (req) => {
  const symbols = parseSymbols(new URL(req.url).searchParams.get("symbols"));
  if (!symbols.length) {
    return json({ quotes: [], asOf: Date.now() / 1000, error: null });
  }

  const upstream = new URL(QUOTE_URL);
  upstream.search = new URLSearchParams({
    symbols: symbols.join("|"),
    requestMethod: "itv", noform: "1", partnerId: "2",
    fund: "1", exthrs: "1", output: "json", events: "1",
  }).toString();

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    let payload;
    try {
      const res = await fetch(upstream, {
        headers: { "User-Agent": UA, Accept: "application/json" },
        signal: controller.signal,
      });
      if (!res.ok) {
        return json({ quotes: [], asOf: null, error: `Quote service returned HTTP ${res.status}` });
      }
      payload = await res.json();
    } finally {
      clearTimeout(timeout);
    }

    return json(
      { quotes: buildQuotes(payload, symbols), asOf: Date.now() / 1000, error: null },
      {
        // Let the CDN absorb repeat visitors so the upstream sees one call
        // per symbol set per 15s, however many people have the page open.
        "Cache-Control": "public, max-age=5",
        "Netlify-CDN-Cache-Control": "public, max-age=15, stale-while-revalidate=60",
      }
    );
  } catch (err) {
    const reason = err?.name === "AbortError" ? "timed out" : (err?.name ?? "network error");
    return json({ quotes: [], asOf: null, error: `Could not reach the quote service (${reason})` });
  }
};

export const config = { path: "/api/quotes" };
