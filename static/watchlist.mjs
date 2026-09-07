/* The watchlist itself: one definition, shared by every window.

   Each page previously read the same localStorage key with its own fallback,
   and they disagreed — the watchlist page seeded four symbols when the key was
   absent, while the others fell back to an empty list. A page whose whole
   subject is the watchlist then had nothing to show on a first visit, despite
   the watchlist page being about to invent four symbols. */

export const STORE_KEY = "stockwatcher.symbols.v1";

/** Shown before anyone has chosen anything: two mega caps, a chip, an index. */
export const DEFAULT_SYMBOLS = ["AAPL", "MSFT", "NVDA", "SPY"];

export const SYMBOL_RE = /^[A-Z0-9.\-=^&:$]{1,24}$/;

/** The saved watchlist, or the default when nothing has been saved yet. */
export function loadWatchlist() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw === null) return DEFAULT_SYMBOLS.slice();
    const parsed = JSON.parse(raw);
    // An explicitly emptied list is a choice, and must survive a reload.
    return Array.isArray(parsed) ? parsed : DEFAULT_SYMBOLS.slice();
  } catch {
    return DEFAULT_SYMBOLS.slice();
  }
}

export function saveWatchlist(symbols) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(symbols));
  } catch {
    /* private browsing */
  }
}
