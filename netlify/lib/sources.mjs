/* The upstream endpoints an analysis is assembled from.

   Everything here is a fixed template: a request names a source by key and
   supplies a symbol, never a URL. That keeps the proxy from becoming an open
   relay for arbitrary hosts. `server.py` mirrors this table for local use. */

export const SYMBOL_RE = /^[A-Za-z0-9.\-=^&:$]{1,24}$/;

const NASDAQ = "https://api.nasdaq.com/api";
const iso = (d) => d.toISOString().slice(0, 10);

/** Each entry: (symbol) => absolute URL. `critical` sources fail the request. */
export const SOURCES = {
  quote: {
    critical: true,
    url: (s) => "https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?" +
      new URLSearchParams({
        symbols: s, requestMethod: "itv", noform: "1", partnerId: "2",
        fund: "1", exthrs: "1", output: "json", events: "1",
      }),
  },
  summary:  { url: (s) => `${NASDAQ}/quote/${enc(s)}/summary?assetclass=stocks` },
  profile:  { url: (s) => `${NASDAQ}/company/${enc(s)}/company-profile` },
  target:   { url: (s) => `${NASDAQ}/analyst/${enc(s)}/targetprice` },
  ratings:  { url: (s) => `${NASDAQ}/analyst/${enc(s)}/ratings` },
  earnings: { url: (s) => `${NASDAQ}/company/${enc(s)}/earnings-surprise` },
  insiders: { url: (s) => `${NASDAQ}/company/${enc(s)}/insider-trades?limit=15&type=ALL&sortname=lastDate&sorttype=DESC` },
  short:    { url: (s) => `${NASDAQ}/quote/${enc(s)}/short-interest?assetClass=stocks` },
  news: {
    url: (s) => `${NASDAQ}/news/topic/articlebysymbol?` +
      new URLSearchParams({ q: `${s}|stocks`, offset: "0", limit: "8", fallback: "true" }),
  },
  history: {
    url: (s) => {
      const to = new Date();
      const from = new Date(to.getTime() - 180 * 864e5);
      return `${NASDAQ}/quote/${enc(s)}/historical?` + new URLSearchParams({
        assetclass: "stocks", fromdate: iso(from), todate: iso(to), limit: "130",
      });
    },
  },
};

function enc(symbol) {
  return encodeURIComponent(symbol);
}

export const SOURCE_KEYS = Object.keys(SOURCES);

/* Nasdaq rejects an unadorned client; the SEC, used elsewhere, rejects a
   browser string and wants a contact instead. */
export const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/125.0 Safari/537.36";

/** Fetch every source for one symbol, tolerating individual failures. */
export async function fetchAll(symbol, doFetch = fetch, timeoutMs = 9000) {
  const entries = await Promise.all(SOURCE_KEYS.map(async (key) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(SOURCES[key].url(symbol), {
        headers: { "User-Agent": BROWSER_UA, Accept: "application/json" },
        signal: controller.signal,
        redirect: "follow",
      });
      if (!res.ok) return [key, { error: `HTTP ${res.status}` }];
      return [key, await res.json()];
    } catch (err) {
      return [key, { error: err?.name === "AbortError" ? "timeout" : (err?.name ?? "error") }];
    } finally {
      clearTimeout(timer);
    }
  }));
  return Object.fromEntries(entries);
}
