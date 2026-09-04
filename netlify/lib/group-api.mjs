/* The group endpoint's logic, kept clear of @netlify/blobs.

   The deployed function supplies a Blobs-backed store; the tests supply an
   in-memory one; server.py reimplements the same rules over a JSON file. This
   file is what they agree on, and it is importable in a browser, which is
   where the tests run.

   POST for every action, including reads, so the group code never lands in a
   URL — not in a query string, an access log, or a Referer header. The page
   keeps it in the location fragment for the same reason. It is the only thing
   standing between a group and a stranger, so it is kept out of the places
   URLs habitually leak into. */

import {
  newCode, parseCode, applyOp, emptyGroup, publicView,
} from "./group.mjs";

export const STORE_NAME = "watchlist-groups";
const CREATE_ATTEMPTS = 5;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      // Shared state is never worth serving stale, and a group code must not
      // be cached by anything between here and the browser.
      "Cache-Control": "no-store",
    },
  });

export const fail = (error, status = 200) => json({ error, symbols: null }, status);

const randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));

export async function handleGroup(body, backend, bytes = randomBytes, now = Date.now()) {
  const action = String(body?.action ?? "");

  if (action === "create") {
    for (let i = 0; i < CREATE_ATTEMPTS; i++) {
      const code = newCode(bytes);
      // 6e14 codes makes a collision a curiosity rather than a risk, but
      // overwriting somebody's list would be a bad way to find that out.
      if (await backend.read(code)) continue;
      const state = emptyGroup(now);
      await backend.write(code, state);
      return json(publicView(code, state));
    }
    return fail("Could not allocate a group code — try again");
  }

  const code = parseCode(body?.code);
  if (!code) return fail("That group code is not valid");

  const stored = await backend.read(code);
  if (!stored) return fail("No group with that code. Check the link, or make a new group.");

  if (action === "get") return json(publicView(code, stored));

  if (action === "add" || action === "remove") {
    const result = applyOp(stored, { action, symbol: body?.symbol, by: body?.by }, now);
    if (result.error) return fail(result.error);
    /* Read-modify-write, with no compare-and-swap: two people adding in the
       same instant can cost one of the two adds. The window is a single round
       trip and the fix is to add it again, which is a fair trade for keeping
       the store to two operations. Nothing is ever destroyed by it — a lost
       add is visible, a silently dropped remove is not possible. */
    if (result.changed) await backend.write(code, result.state);
    return json(publicView(code, result.state));
  }

  return fail("Unknown action");
}
