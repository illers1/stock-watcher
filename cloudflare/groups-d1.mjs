/* Shared group lists, stored in Cloudflare D1.

   netlify/functions/group.mjs explains why eventually consistent storage is
   wrong here: a read can return a list as it was a minute ago, and an edit
   computed from it is written back over somebody else's. That rules out KV.
   D1 reads go to the database's primary, so a read always sees the latest
   write.

   D1 also fixes the half that strong reads alone never did. Every add and
   remove is a read-modify-write, and two people editing at the same moment
   could both read the same list, each add a symbol, and the second write would
   quietly drop the first addition. So each row carries a version, a write only
   lands if nobody has written since it was read, and otherwise the whole edit
   is recomputed from the fresh list. Both additions survive.

   The rules for an edit are unchanged: they live in ../netlify/lib/group-api.mjs,
   and this file supplies only the two calls that module needs. */

export const SCHEMA =
  "CREATE TABLE IF NOT EXISTS groups (" +
  "code TEXT PRIMARY KEY, state TEXT NOT NULL, version INTEGER NOT NULL)";

/** Somebody else wrote between this edit's read and its write. */
export class Conflict extends Error {
  constructor() { super("group changed during the edit"); this.name = "Conflict"; }
}

/**
 * The backend handleGroup() expects: read(code) and write(code, state). It
 * remembers the version each read saw, which is what each write is checked
 * against.
 */
export function d1Backend(db) {
  const seen = new Map();
  return {
    async read(code) {
      const row = await db.prepare("SELECT state, version FROM groups WHERE code = ?").bind(code).first();
      seen.set(code, row ? Number(row.version) : 0);
      return row ? JSON.parse(row.state) : null;
    },
    async write(code, state) {
      const version = seen.get(code) ?? 0;
      const body = JSON.stringify(state);
      const result = version === 0
        ? await db.prepare("INSERT OR IGNORE INTO groups (code, state, version) VALUES (?, ?, 1)")
            .bind(code, body).run()
        : await db.prepare("UPDATE groups SET state = ?, version = version + 1 WHERE code = ? AND version = ?")
            .bind(body, code, version).run();
      if (!result?.meta?.changes) throw new Conflict();
      seen.set(code, version + 1);
    },
  };
}

/* The table is created on first use, so a fresh database needs no setup step.
   Only the fact that it worked is remembered, never the call in flight: a
   Worker may not wait on I/O another request began. Two first requests at
   once both run CREATE TABLE IF NOT EXISTS, which is harmless. */
let schemaReady = false;
export async function ensureSchema(db) {
  if (schemaReady) return;
  await db.prepare(SCHEMA).run();
  schemaReady = true;
}
export const resetSchemaForTests = () => { schemaReady = false; };

export const MAX_ATTEMPTS = 4;
