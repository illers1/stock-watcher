/* GET /api/search?q=apple
   Best-effort symbol lookup. The upstream rate-limits aggressively, so any
   failure returns an empty list and the page falls back to its built-in
   list of common symbols rather than showing an error. */

const SEARCH_URL = "https://query1.finance.yahoo.com/v1/finance/search";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
           "(KHTML, like Gecko) Chrome/125.0 Safari/537.36";
const ALLOWED = new Set(["EQUITY", "ETF", "INDEX", "MUTUALFUND", "CRYPTOCURRENCY", "CURRENCY", "FUTURE"]);

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
  const query = (new URL(req.url).searchParams.get("q") ?? "").trim().slice(0, 40);
  if (!query) return json({ results: [], error: null });

  const upstream = new URL(SEARCH_URL);
  upstream.search = new URLSearchParams({
    q: query, quotesCount: "8", newsCount: "0",
    listsCount: "0", enableFuzzyQuery: "false",
  }).toString();

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    let payload;
    try {
      const res = await fetch(upstream, {
        headers: { "User-Agent": UA, Accept: "application/json" },
        signal: controller.signal,
      });
      if (!res.ok) return json({ results: [], error: "search-unavailable" });
      payload = await res.json();
    } finally {
      clearTimeout(timeout);
    }

    const results = (payload?.quotes ?? [])
      .filter((item) => item?.symbol && ALLOWED.has(item.quoteType))
      .map((item) => ({
        symbol: String(item.symbol).toUpperCase(),
        name: item.longname || item.shortname || item.symbol,
        exchange: item.exchDisp || item.exchange || "",
      }));

    return json({ results, error: null }, {
      "Cache-Control": "public, max-age=900",
      "Netlify-CDN-Cache-Control": "public, max-age=3600",
    });
  } catch {
    return json({ results: [], error: "search-unavailable" });
  }
};

export const config = { path: "/api/search" };
