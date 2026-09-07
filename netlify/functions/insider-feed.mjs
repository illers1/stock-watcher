/* GET /api/insider-feed?limit=30

   Recent Form 4 filings across the whole market, as raw ownership XML.
   static/insider-model.mjs parses them, the same code the per-stock panel uses. */

import { fetchInsiderFeed } from "../lib/insider-feed.mjs";

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
  const raw = Number(new URL(req.url).searchParams.get("limit"));
  const limit = Number.isFinite(raw) ? Math.max(1, Math.min(60, Math.round(raw))) : 30;
  try {
    const feed = await fetchInsiderFeed(limit);
    return json({ ...feed, error: null }, {
      // Form 4s arrive continuously but a few minutes stale costs nothing.
      "Cache-Control": "public, max-age=180",
      "Netlify-CDN-Cache-Control": "public, max-age=600, stale-while-revalidate=3600",
    });
  } catch (err) {
    return json({ filings: [], asOf: null, error: `Insider feed failed (${err?.name ?? "error"})` });
  }
};

export const config = { path: "/api/insider-feed" };
