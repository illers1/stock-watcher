/* GET /api/news?limit=9

   Nasdaq's general markets headlines, for the strip at the foot of the
   Earnings window. The per-symbol feed under /api/analysis answers "what is
   being said about this company"; this answers "what is going on today", which
   is the context a calendar of scheduled reports is read against.

   Same split as everywhere else: fetched and passed through here, interpreted
   in static/news-model.mjs. */

import { BROWSER_UA } from "../lib/sources.mjs";

const NEWS_URL = "https://api.nasdaq.com/api/news/topic/articlebysymbol";
const TOPIC = "Markets|4006";
const MAX_LIMIT = 24;

const json = (body, headers = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      ...headers,
    },
  });

export async function fetchNews(limit, doFetch = fetch, timeoutMs = 8000) {
  const url = `${NEWS_URL}?` + new URLSearchParams({
    q: TOPIC, offset: "0", limit: String(limit), fallback: "true",
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await doFetch(url, {
      headers: { "User-Agent": BROWSER_UA, Accept: "application/json" },
      signal: controller.signal,
      // The topic endpoint answers 301 to its canonical form and returns an
      // empty body if the redirect is not followed.
      redirect: "follow",
    });
    if (!res.ok) return { rows: [], error: `HTTP ${res.status}` };
    const body = await res.json();
    return { rows: body?.data?.rows ?? [], error: null };
  } catch (err) {
    return { rows: [], error: err?.name === "AbortError" ? "timeout" : (err?.name ?? "error") };
  } finally {
    clearTimeout(timer);
  }
}

export default async (req) => {
  const raw = Number(new URL(req.url).searchParams.get("limit"));
  const limit = Number.isFinite(raw) ? Math.max(1, Math.min(MAX_LIMIT, Math.round(raw))) : 9;

  try {
    const { rows, error } = await fetchNews(limit);
    return json(
      { rows, asOf: Date.now() / 1000, error },
      {
        // Headlines are worth a few minutes of staleness; nobody needs the
        // page to re-fetch them on every visit.
        "Cache-Control": "public, max-age=300",
        "Netlify-CDN-Cache-Control": "public, max-age=600, stale-while-revalidate=3600",
      }
    );
  } catch (err) {
    return json({ rows: [], asOf: null, error: `News failed (${err?.name ?? "error"})` });
  }
};

export const config = { path: "/api/news" };
