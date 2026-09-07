/* Ranking a screened slice on structural weakness.

   This runs on the batched quote feed rather than the full analysis, so it
   sees valuation, margins, leverage and where a price sits in its own
   twelve-month range — enough to sort a few hundred companies into an order
   worth investigating, and not enough to conclude anything. Whatever surfaces
   here still has to go through the full screen before it means much.

   Deliberately absent: anything that rewards a stock simply for having fallen.
   A price near its low is where broken companies and bargains both sit, so the
   range position counts only alongside the fundamentals that say which it is. */

import { band } from "./score.mjs";

const num = (v) => {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const t = String(v).replace(/[$,%\s]/g, "").replace(/−/g, "-");
  if (!t || ["N/A", "UNCH", "--", "-"].includes(t.toUpperCase())) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

const big = (v) => {
  if (v === null || v === undefined) return null;
  const t = String(v).replace(/[$,\s]/g, "");
  const mult = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 }[t.slice(-1).toUpperCase()];
  if (mult) { const b = num(t.slice(0, -1)); return b === null ? null : b * mult; }
  return num(t);
};

const avg = (xs) => {
  const v = xs.filter((x) => x !== null && Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};

/** One screened company, from its universe row and its batched quote. */
export function buildCandidate(row, quote) {
  const last = num(quote?.last) ?? row?.price ?? null;
  const hi = num(quote?.yrhiprice);
  const lo = num(quote?.yrloprice);
  const rangePosition = (last !== null && hi !== null && lo !== null && hi > lo)
    ? ((last - lo) / (hi - lo)) * 100 : null;
  const offHigh = (last !== null && hi) ? ((last - hi) / hi) * 100 : null;

  return {
    symbol: row.symbol,
    name: quote?.name || row.name,
    sector: row.sector,
    industry: row.industry,
    price: last,
    changePercent: num(quote?.change_pct) ?? row.changePercent,
    marketCap: big(quote?.mktcapView) ?? row.marketCap,
    volume: big(quote?.volume_alt || quote?.volume) ?? row.volume,
    avgVolume10d: big(quote?.tendayavgvol),
    rangePosition,
    offHigh,
    yearHigh: hi,
    yearLow: lo,
    pe: num(quote?.pe),
    forwardPe: num(quote?.fpe),
    priceToSales: num(quote?.psales),
    roe: num(quote?.ROETTM),
    netMargin: num(quote?.NETPROFTTM),
    grossMargin: num(quote?.GROSMGNTTM),
    debtToEquity: num(quote?.DEBTEQTYQ),
    beta: num(quote?.beta),
    enriched: !!quote,
  };
}

/**
 * A first-pass weakness score. Higher means more of the things a short thesis
 * usually rests on, with each component reported so the ranking can be argued
 * with rather than taken on trust.
 */
export function weaknessScore(c) {
  const parts = [];
  const add = (label, raw, score, format) => {
    if (score !== null && score !== undefined) parts.push({ label, raw, score, format });
  };

  /* Both of these peak part-way down rather than at the bottom. A monotonic
     curve ranks a company that has already lost 95% above one that is 30% off
     its high and still falling, which is backwards: the first has had its move
     and is where borrow is scarcest and squeezes are sharpest, while the second
     still has somewhere to go. Weakness here means a break in progress, not a
     wreck. */
  add("Position in 52-week range", c.rangePosition,
      band(c.rangePosition, [[0, 52], [10, 66], [25, 84], [40, 78], [60, 50], [80, 30], [95, 14]]), "pct0");
  add("Below its 52-week high", c.offHigh,
      band(c.offHigh, [[-90, 38], [-70, 54], [-45, 80], [-25, 74], [-10, 46], [0, 22]]), "pct");
  add("Net profit margin", c.netMargin,
      band(c.netMargin, [[-25, 96], [-5, 84], [0, 72], [6, 52], [15, 30], [28, 12]]), "pct");
  add("Return on equity", c.roe,
      band(c.roe, [[-25, 94], [0, 78], [8, 58], [18, 36], [35, 15]]), "pct");
  add("Debt / equity", c.debtToEquity,
      band(c.debtToEquity, [[0, 12], [50, 30], [110, 52], [220, 76], [400, 92]]), "pct");
  add("Price / sales", c.priceToSales,
      band(c.priceToSales, [[0.5, 14], [2, 34], [5, 55], [12, 78], [25, 93]]), "num");
  add("Forward P/E", c.forwardPe,
      band(c.forwardPe, [[8, 16], [15, 34], [26, 54], [45, 74], [90, 92]]), "num");

  return {
    score: avg(parts.map((p) => p.score)),
    parts,
    // How much of the picture was actually available for this name.
    completeness: parts.length / 7,
    // Most of the move may be behind it — flagged rather than folded into the
    // score, because it changes what the number means rather than its size.
    alreadyFallen: c.offHigh !== null && c.offHigh <= -60,
    lossMaking: c.netMargin !== null && c.netMargin < 0,
  };
}

/** Rank a screened slice, worst-looking first. */
export function rankCandidates(rows, quotes, options = {}) {
  const minCompleteness = options.minCompleteness ?? 0.5;
  return (rows ?? [])
    .map((row) => {
      const candidate = buildCandidate(row, quotes?.[row.symbol]);
      const weakness = weaknessScore(candidate);
      return { ...candidate, weakness: weakness.score, parts: weakness.parts,
               completeness: weakness.completeness,
               alreadyFallen: weakness.alreadyFallen, lossMaking: weakness.lossMaking };
    })
    // A company with almost no fundamentals reported is not evidence of
    // anything; ranking it against fully described peers would be noise.
    .filter((c) => c.weakness !== null && c.completeness >= minCompleteness)
    .sort((a, b) => b.weakness - a.weakness);
}

export const SECTORS = [
  "Basic Materials", "Communication Services", "Consumer Discretionary",
  "Consumer Staples", "Energy", "Finance", "Health Care", "Industrials",
  "Miscellaneous", "Real Estate", "Technology", "Telecommunications", "Utilities",
];
