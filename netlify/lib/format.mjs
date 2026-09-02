/* Shared quote normalisation. Pure functions, no platform dependencies, so the
   same logic can be unit-tested in a browser as well as run in a function. */

export const SYMBOL_RE = /^[A-Za-z0-9.\-=^&:$]{1,24}$/;
export const MAX_SYMBOLS = 60;

/** Parse the feed's display strings ('+8.28', '49,839,873', '2.61%') as numbers. */
export function toFloat(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const text = String(value).trim()
    .replace(/,/g, "").replace(/%/g, "").replace(/\+/g, "").replace(/−/g, "-");
  if (!text || ["UNCH", "N/A", "--", "-"].includes(text.toUpperCase())) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

/** Parse abbreviated magnitudes such as '4.745T' or '39.86M'. */
export function toBig(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim().replace(/,/g, "");
  const mult = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 }[text.slice(-1).toUpperCase()];
  if (mult) {
    const base = toFloat(text.slice(0, -1));
    return base === null ? null : base * mult;
  }
  return toFloat(text);
}

/** Turn one upstream quote record into the shape the front end expects. */
export function normalise(raw) {
  const symbol = String(raw?.symbol ?? "").toUpperCase();
  if (String(raw?.code) !== "0") return { symbol, error: "Symbol not found" };

  const price = toFloat(raw.last);
  const prev = toFloat(raw.previous_day_closing);
  let change = toFloat(raw.change);
  let pct = toFloat(raw.change_pct);

  if (change === null && price !== null && prev !== null) change = price - prev;
  if (pct === null && change !== null && prev) pct = (change / prev) * 100;
  // The feed sometimes drops the sign from change_pct on down moves.
  if (pct !== null && change !== null && change < 0 && pct > 0) pct = -pct;

  const quote = {
    symbol,
    name: raw.name || raw.shortName || symbol,
    exchange: raw.exchange || "",
    assetType: raw.type || "",
    currency: raw.currencyCode || "USD",
    price,
    previousClose: prev,
    change,
    changePercent: pct,
    open: toFloat(raw.open),
    dayHigh: toFloat(raw.high),
    dayLow: toFloat(raw.low),
    yearHigh: toFloat(raw.yrhiprice),
    yearLow: toFloat(raw.yrloprice),
    volume: toBig(raw.volume_alt || raw.volume),
    marketCap: toBig(raw.mktcapView),
    peRatio: toFloat(raw.pe),
    dividendYield: toFloat(raw.dividendyield),
    marketStatus: raw.curmktstatus || "",
    quoteTime: raw.last_timedate || "",
    extended: null,
  };

  const ext = raw.ExtendedMktQuote;
  const extPrice = ext ? toFloat(ext.last) : null;
  if (extPrice !== null) {
    let extChange = toFloat(ext.change);
    let extPct = toFloat(ext.change_pct);
    // Derive the extended move from the regular close when the feed omits it.
    if (extChange === null && price !== null) extChange = extPrice - price;
    if (extPct === null && extChange !== null && price) extPct = (extChange / price) * 100;
    if (extPct !== null && extChange !== null && extChange < 0 && extPct > 0) extPct = -extPct;
    quote.extended = {
      type: ext.type || "",
      price: extPrice,
      change: extChange,
      changePercent: extPct,
    };
  }
  return quote;
}

/** Clean a comma-separated `symbols` query value into a validated list. */
export function parseSymbols(raw) {
  const seen = new Set();
  const out = [];
  for (const part of String(raw ?? "").split(",")) {
    const sym = part.trim().toUpperCase();
    if (sym && !seen.has(sym) && SYMBOL_RE.test(sym)) {
      seen.add(sym);
      out.push(sym);
    }
  }
  return out.slice(0, MAX_SYMBOLS);
}

/** Map an upstream payload onto the requested symbols, in the requested order. */
export function buildQuotes(payload, symbols) {
  let records = payload?.FormattedQuoteResult?.FormattedQuote ?? [];
  if (!Array.isArray(records)) records = [records];

  const found = new Map();
  for (const raw of records) {
    if (raw && typeof raw === "object") {
      const q = normalise(raw);
      found.set(q.symbol, q);
    }
  }
  // A symbol the upstream simply omitted is a miss, not a silent gap.
  return symbols.map((s) => found.get(s) ?? { symbol: s, error: "Symbol not found" });
}
