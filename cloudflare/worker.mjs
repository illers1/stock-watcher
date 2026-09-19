/* Stock Watcher on Cloudflare Workers.

   The pages are static assets, served by Cloudflare straight from static/. The
   API is the same set of functions the site ran on Netlify: each one in
   netlify/functions/ is a plain (Request) => Response handler, so this file
   routes to them rather than copying them. Only two things here are specific
   to Cloudflare.

   Caching. The free plan gives each request 10 ms of CPU, and the heavier
   endpoints — movers and the screen parse a 2 MB market-wide list — can come
   close. Workers Cache serves a cached response without running the Worker at
   all, so a hit costs no CPU. Each function already states two policies, one
   for the browser (Cache-Control) and one for a CDN (Netlify-CDN-Cache-Control);
   they are combined into the single header Cloudflare reads, with the CDN's
   figures as s-maxage and stale-while-revalidate, so a refresh happens in the
   background after a stale answer has already gone out. A response that states
   no policy — every error path — is marked no-store, so a failure is never
   cached and served back as if it were data.

   The group lists, which live in D1; see groups-d1.mjs. */

import analysis from "../netlify/functions/analysis.mjs";
import calendar from "../netlify/functions/calendar.mjs";
import catalysts from "../netlify/functions/catalysts.mjs";
import earnings from "../netlify/functions/earnings.mjs";
import insiderFeed from "../netlify/functions/insider-feed.mjs";
import moverWhy from "../netlify/functions/mover-why.mjs";
import movers from "../netlify/functions/movers.mjs";
import news from "../netlify/functions/news.mjs";
import quotes from "../netlify/functions/quotes.mjs";
import screen from "../netlify/functions/screen.mjs";
import search from "../netlify/functions/search.mjs";
import { handleGroup, fail } from "../netlify/lib/group-api.mjs";
import { d1Backend, ensureSchema, Conflict, MAX_ATTEMPTS } from "./groups-d1.mjs";

export const ROUTES = {
  "/api/analysis": analysis,
  "/api/calendar": calendar,
  "/api/catalysts": catalysts,
  "/api/earnings": earnings,
  "/api/insider-feed": insiderFeed,
  "/api/mover-why": moverWhy,
  "/api/movers": movers,
  "/api/news": news,
  "/api/quotes": quotes,
  "/api/screen": screen,
  "/api/search": search,
};

/* The free plan allows 50 outbound requests per request. Two endpoints fetch
   one page per item and accept more items than that: the calendar reads one
   page per trading day, and the insider feed one filing per entry. They are
   held under the ceiling here, and both already report how far they got. */
export const REQUEST_CEILINGS = {
  "/api/calendar": { param: "days", max: 45 },
  "/api/insider-feed": { param: "limit", max: 45 },
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
               "X-Content-Type-Options": "nosniff" },
  });

/** The request, with any count held under the outbound-request ceiling. */
export function withinCeiling(request, url) {
  const ceiling = REQUEST_CEILINGS[url.pathname];
  if (!ceiling) return request;
  const asked = Number(url.searchParams.get(ceiling.param));
  if (!Number.isFinite(asked) || asked <= ceiling.max) return request;
  const capped = new URL(url);
  capped.searchParams.set(ceiling.param, String(ceiling.max));
  return new Request(capped, request);
}

const seconds = (header, name) => {
  const m = new RegExp(`(?:^|[,\\s])${name}=(\\d+)`, "i").exec(header ?? "");
  return m ? Number(m[1]) : null;
};

/** One Cache-Control header, for the browser and for Cloudflare's cache. */
export function cachePolicy(response) {
  const headers = new Headers(response.headers);
  const browser = headers.get("Cache-Control");
  const cdn = headers.get("Netlify-CDN-Cache-Control");
  headers.delete("Netlify-CDN-Cache-Control");
  headers.set("X-Content-Type-Options", "nosniff");

  if (!browser || /no-store|private/i.test(browser) || response.status !== 200) {
    headers.set("Cache-Control", "no-store");
  } else {
    const maxAge = seconds(browser, "max-age") ?? 0;
    const edge = seconds(cdn, "max-age") ?? maxAge;
    const stale = seconds(cdn, "stale-while-revalidate");
    headers.set("Cache-Control", [
      "public", `max-age=${maxAge}`, `s-maxage=${edge}`,
      stale !== null ? `stale-while-revalidate=${stale}` : null,
      // A refresh that fails keeps serving the last good answer.
      stale !== null ? `stale-if-error=${stale}` : null,
    ].filter(Boolean).join(", "));
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/** POST /api/group, against D1, retrying an edit that lost a race. */
export async function group(request, env) {
  if (request.method !== "POST") return fail("POST required", 405);
  if (!env.GROUPS) return fail("Group storage is not configured");
  let body;
  try { body = await request.json(); } catch { return fail("Expected a JSON body"); }
  try {
    await ensureSchema(env.GROUPS);
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        return await handleGroup(body, d1Backend(env.GROUPS));
      } catch (err) {
        if (!(err instanceof Conflict)) throw err;
        // Somebody else edited the list between our read and write; redo it.
      }
    }
    return fail("The list was being edited by someone else at the same moment — try again");
  } catch (err) {
    return fail(`Group storage is unavailable (${err?.name ?? "error"})`);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    if (url.pathname === "/api/group") return group(request, env);

    const handler = ROUTES[url.pathname];
    if (!handler) return json({ error: "Not found" }, 404);
    if (request.method !== "GET" && request.method !== "HEAD") return json({ error: "GET required" }, 405);

    try {
      return cachePolicy(await handler(withinCeiling(request, url)));
    } catch (err) {
      return json({ error: `Request failed (${err?.name ?? "error"})` }, 500);
    }
  },
};
