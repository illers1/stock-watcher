/* GET /api/catalysts?days=45

   Non-earnings catalysts, fetched and bundled raw. Earnings come from
   /api/calendar, which the page requests separately so both stay on their own
   cache cycle. Interpretation lives in static/catalysts-model.mjs. */

import { fetchCatalysts } from "../lib/catalysts.mjs";

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
  const raw = Number(new URL(req.url).searchParams.get("days"));
  const days = Number.isFinite(raw) ? Math.max(1, Math.min(90, Math.round(raw))) : 45;
  try {
    const sources = await fetchCatalysts(days);
    return json(
      { sources, days, asOf: Date.now() / 1000, error: null },
      {
        // Corporate actions and filings change daily at most.
        "Cache-Control": "public, max-age=900",
        "Netlify-CDN-Cache-Control": "public, max-age=21600, stale-while-revalidate=86400",
      }
    );
  } catch (err) {
    return json({ sources: {}, days, asOf: null, error: `Catalysts failed (${err?.name ?? "error"})` });
  }
};

export const config = { path: "/api/catalysts" };
