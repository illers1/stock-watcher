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

/** The Blobs store, behind the two calls handleGroup actually needs. */
function blobBackend() {
  const store = getStore(STORE_NAME);
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
