/* Scheduled, dated, company-specific events other than earnings.

   Earnings already have their own window, so this gathers the rest: ex-dividend
   dates, stock splits, upcoming IPOs, and regulatory decisions.

   Regulatory dates are the awkward one. No free feed publishes forthcoming FDA
   decisions, so this goes to the companies' own filings instead: EDGAR
   full-text search finds recent 8-Ks that mention a PDUFA date or an advisory
   committee meeting, and the surrounding sentence travels back with the hit so
   the date can be read out of it. That makes the primary source the company's
   own disclosure, which is the only authoritative one there is.

   As everywhere else here, this module only fetches and trims. The parsing
   lives in static/catalysts-model.mjs so the browser, the deployed function
   and server.py all share one implementation. */

import { BROWSER_UA } from "./sources.mjs";
import { tradingDays, pooled } from "./calendar.mjs";

const NASDAQ = "https://api.nasdaq.com/api";
const EDGAR_FTS = "https://efts.sec.gov/LATEST/search-index";

/* The SEC asks automated clients to identify themselves with a contact address
   and refuses browser-like strings outright. */
export const SEC_UA = "StockWatcher/1.0 (personal research tool) contact@example.com";

export const DIVIDEND_DAYS = 20;   // one upstream request per day; keep it bounded
export const MAX_FILINGS = 10;     // documents fetched for date context
export const REG_QUERIES = ['"PDUFA date"', '"advisory committee meeting"'];

const jsonOrNull = async (res) => {
  if (!res?.ok) return null;
  try { return await res.json(); } catch { return null; }
};

async function get(url, ua, doFetch, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await doFetch(url, {
      headers: { "User-Agent": ua, Accept: "application/json" },
      signal: controller.signal,
      redirect: "follow",
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Ex-dividend dates across the window, one request per trading day. */
async function fetchDividends(days, doFetch) {
  const dates = tradingDays(new Date(), Math.min(days, DIVIDEND_DAYS), DIVIDEND_DAYS);
  const pages = await pooled(dates, 10, async (d) => {
    const body = await jsonOrNull(await get(`${NASDAQ}/calendar/dividends?date=${d}`, BROWSER_UA, doFetch));
    const rows = body?.data?.calendar?.rows ?? [];
    return rows.map((r) => ({ ...r, _date: d }));
  });
  return pages.flat();
}

async function fetchSplits(doFetch) {
  const body = await jsonOrNull(await get(`${NASDAQ}/calendar/splits`, BROWSER_UA, doFetch));
  return body?.data?.rows ?? [];
}

/** This month's and next month's IPO calendar. */
async function fetchIpos(doFetch, today = new Date()) {
  const months = [0, 1].map((n) => {
    const d = new Date(today.getFullYear(), today.getMonth() + n, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  });
  const pages = await pooled(months, 2, async (m) => {
    const body = await jsonOrNull(await get(`${NASDAQ}/ipo/calendar?date=${m}`, BROWSER_UA, doFetch));
    return body?.data?.upcoming?.upcomingTable?.rows ?? [];
  });
  return pages.flat();
}

/** The sentence around the first mention, which is where the date sits. */
export function extractContext(html, term = "PDUFA", radius = 260) {
  const text = String(html ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#?\w+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const i = text.toUpperCase().indexOf(term.toUpperCase());
  if (i === -1) return text.slice(0, radius * 2);
  return text.slice(Math.max(0, i - radius), i + radius);
}

/** Recent 8-Ks disclosing a regulatory date, with the surrounding sentence. */
async function fetchRegulatory(doFetch, today = new Date()) {
  const end = today.toISOString().slice(0, 10);
  const start = new Date(today.getTime() - 120 * 864e5).toISOString().slice(0, 10);

  const searches = await pooled(REG_QUERIES, 2, async (q) => {
    const url = `${EDGAR_FTS}?q=${encodeURIComponent(q)}&forms=8-K&startdt=${start}&enddt=${end}`;
    const body = await jsonOrNull(await get(url, SEC_UA, doFetch, 10000));
    return (body?.hits?.hits ?? []).map((h) => ({ ...h, _query: q }));
  });

  // Newest first, one entry per company: a single filing is enough to date it.
  const hits = searches.flat().sort((a, b) =>
    String(b?._source?.file_date ?? "").localeCompare(String(a?._source?.file_date ?? "")));
  const seen = new Set();
  const picked = [];
  for (const h of hits) {
    const cik = (h?._source?.ciks ?? [])[0];
    if (!cik || seen.has(cik)) continue;
    seen.add(cik);
    picked.push(h);
    if (picked.length >= MAX_FILINGS) break;
  }

  return pooled(picked, 5, async (h) => {
    const src = h._source ?? {};
    const [accession, doc] = String(h._id ?? "").split(":");
    const cik = (src.ciks ?? [])[0];
    const url = accession && doc && cik
      ? `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replace(/-/g, "")}/${doc}`
      : null;
    let context = "";
    if (url) {
      const res = await get(url, SEC_UA, doFetch, 12000);
      if (res?.ok) {
        const term = h._query.includes("PDUFA") ? "PDUFA" : "advisory committee";
        context = extractContext(await res.text(), term);
      }
    }
    return {
      displayName: (src.display_names ?? [])[0] ?? null,
      filedDate: src.file_date ?? null,
      query: h._query,
      url,
      context,
    };
  });
}

/** Every non-earnings source, gathered in parallel. */
export async function fetchCatalysts(days, doFetch = fetch, today = new Date()) {
  const [dividends, splits, ipos, regulatory] = await Promise.all([
    fetchDividends(days, doFetch).catch(() => []),
    fetchSplits(doFetch).catch(() => []),
    fetchIpos(doFetch, today).catch(() => []),
    fetchRegulatory(doFetch, today).catch(() => []),
  ]);
  return { dividends, splits, ipos, regulatory };
}
