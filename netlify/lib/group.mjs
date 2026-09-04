/* Shared watchlists: codes, validation, and the rules for changing one.

   Everything here is pure. The Netlify function keeps state in Netlify Blobs
   and server.py keeps it in a JSON file, but both apply changes through
   `applyOp`, so the two runtimes cannot drift on what an edit means.

   There are no accounts. A group's code IS its credential: whoever holds the
   link can read and edit the list, and the `addedBy` name on each row is
   self-declared, not authenticated. That is the right trade for a handful of
   friends sharing tickers, and the wrong one for anything that matters. */

/* Crockford-style: no 0/O, no 1/I/L, so a code read aloud or copied off a
   screen survives the trip. 30^10 is about 6e14 — not guessable by poking. */
export const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
export const CODE_LENGTH = 10;
export const MAX_SYMBOLS = 60;   // one quote request covers the whole list
export const MAX_NAME = 24;

const SYMBOL_RE = /^[A-Z0-9.\-=^&:$]{1,24}$/;

/** Random code. `bytes(n)` must return n uniformly random bytes. */
export function newCode(bytes) {
  const out = [];
  while (out.length < CODE_LENGTH) {
    // Rejection sampling: 256 is not a multiple of 30, so the top 16 values
    // would otherwise make the first sixteen letters fractionally likelier.
    const limit = 256 - (256 % CODE_ALPHABET.length);
    for (const b of bytes(CODE_LENGTH)) {
      if (b >= limit) continue;
      out.push(CODE_ALPHABET[b % CODE_ALPHABET.length]);
      if (out.length === CODE_LENGTH) break;
    }
  }
  return out.join("");
}

/** Accepts what a person might paste: spaces, dashes, lower case. */
export function parseCode(raw) {
  const t = String(raw ?? "").toUpperCase().replace(/[\s\-_]/g, "");
  return isValidCode(t) ? t : null;
}

export function isValidCode(code) {
  const t = String(code ?? "");
  if (t.length !== CODE_LENGTH) return false;
  for (const c of t) if (!CODE_ALPHABET.includes(c)) return false;
  return true;
}

/** Grouped for reading aloud: FGHJK-MNPQR. */
export function formatCode(code) {
  const t = String(code ?? "");
  return t.length === CODE_LENGTH ? t.slice(0, 5) + "-" + t.slice(5) : t;
}

export function cleanName(raw) {
  const t = String(raw ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_NAME);
  return t || null;
}

export function cleanSymbol(raw) {
  const t = String(raw ?? "").trim().toUpperCase();
  return SYMBOL_RE.test(t) ? t : null;
}

export function emptyGroup(now = Date.now()) {
  return { symbols: [], revision: 0, createdAt: now, updatedAt: now };
}

/**
 * Apply one edit. Returns a NEW state — never mutates the argument — so a
 * caller that loses a write race can re-read and replay without surprises.
 *
 * @returns {{state: object, changed: boolean, error: string|null}}
 */
export function applyOp(state, op, now = Date.now()) {
  const base = state && Array.isArray(state.symbols) ? state : emptyGroup(now);
  const entries = base.symbols;
  const unchanged = (error = null) => ({ state: base, changed: false, error });

  if (op?.action === "add") {
    const symbol = cleanSymbol(op.symbol);
    if (!symbol) return unchanged("That is not a valid symbol");
    if (entries.some((e) => e.symbol === symbol)) return unchanged(null);
    if (entries.length >= MAX_SYMBOLS) {
      return unchanged(`A group holds at most ${MAX_SYMBOLS} symbols`);
    }
    return bump(base, entries.concat([{
      symbol, addedBy: cleanName(op.by), at: now,
    }]), now);
  }

  if (op?.action === "remove") {
    const symbol = cleanSymbol(op.symbol);
    if (!symbol) return unchanged("That is not a valid symbol");
    const kept = entries.filter((e) => e.symbol !== symbol);
    if (kept.length === entries.length) return unchanged(null);
    return bump(base, kept, now);
  }

  return unchanged("Unknown action");
}

function bump(base, symbols, now) {
  return {
    state: { ...base, symbols, revision: (base.revision ?? 0) + 1, updatedAt: now },
    changed: true,
    error: null,
  };
}

/** What the browser is sent. Kept separate so stored shape can grow freely. */
export function publicView(code, state) {
  const s = state && Array.isArray(state.symbols) ? state : emptyGroup();
  return {
    code,
    symbols: s.symbols.map((e) => ({
      symbol: e.symbol, addedBy: e.addedBy ?? null, at: e.at ?? null,
    })),
    revision: s.revision ?? 0,
    updatedAt: s.updatedAt ?? null,
    error: null,
  };
}
