/* POST /api/group — the shared watchlist.

   Body: {action, code?, symbol?, by?}
     create            -> a new empty group, returns its code
     get     {code}    -> the current list
     add     {code, symbol, by}
     remove  {code, symbol}

   State lives in Netlify Blobs, which the platform provides with no service to
   sign up for and no credentials to manage. Everything else — validation, the
   rules for an edit, the responses — is in ../lib/group-api.mjs, which the
   tests exercise against an in-memory store. This file is only the wiring.

   package.json exists solely so Netlify installs the Blobs client for this. */

import { getStore } from "@netlify/blobs";
import { handleGroup, STORE_NAME, fail } from "../lib/group-api.mjs";

/* The Blobs store, behind the two calls handleGroup actually needs.

   `consistency: "strong"` is not optional here, and leaving it off was a bug.
   Blobs defaults to eventual consistency: writes are stored in one region and
   cached at the edge, and a read elsewhere can return the old value for up to
   sixty seconds. For a list several people edit at once that is wrong twice
   over. The visible half is that a friend's addition does not show up. The
   dangerous half is that every add and remove is a read-modify-write, so an
   edit computed from a stale read is written back over somebody else's — one
   person's addition silently undoing another's, a minute after the fact.

   Strong reads cost latency. A shared list is worth it. */
function blobBackend() {
  const store = getStore({ name: STORE_NAME, consistency: "strong" });
  return {
    read: (code) => store.get(code, { type: "json" }),
    write: (code, state) => store.setJSON(code, state),
  };
}

export default async (req) => {
  if (req.method !== "POST") return fail("POST required", 405);

  let body;
  try {
    body = await req.json();
  } catch {
    return fail("Expected a JSON body");
  }

  try {
    return await handleGroup(body, blobBackend());
  } catch (err) {
    return fail(`Group storage is unavailable (${err?.name ?? "error"})`);
  }
};

export const config = { path: "/api/group" };
