/* Screening for short candidates.

   This is deliberately not the long rating with a minus sign in front. Shorting
   is not the mirror image of buying, and three differences are built in here:

   1. The loss is unbounded. A long position can fall to zero; a short can lose
      many times the stake, so a candidate that looks weak on fundamentals and
      is heavily shorted is a worse idea than one that looks weak and is not.

   2. Crowding matters more than conviction. Short interest and days-to-cover
      are treated as a hazard to be flagged, never as evidence for the trade —
      the opposite of the long side, where a crowded short is upside.

   3. Being right is not enough; the timing has to work. A short must be
      financed until the thesis plays out, and dividends paid while short come
      out of the shorter's pocket.

   The output is a ranked list of candidates with the evidence behind each. It
   is a screen, not a recommendation, and the squeeze assessment is reported
   beside the score rather than folded into it — a hazard that averages away
   into a number stops being a warning. */

import { band } from "./score.mjs";

const avg = (xs) => {
  const v = xs.filter((x) => x !== null && x !== undefined && Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};
const clamp = (n) => Math.max(0, Math.min(100, n));
const line = (label, raw, score, format) => ({ label, raw, score, format: format ?? null });

export const SHORT_FACTORS = [
  { key: "breakdown",    label: "Price breakdown",  hint: "Falling on its own and against its averages, low in the 52-week range" },
  { key: "overvaluation",label: "Overvaluation",    hint: "Expensive on earnings and sales, and trading above where analysts put it" },
  { key: "deterioration",label: "Weak fundamentals",hint: "Thin or negative margins, poor returns on equity, heavy leverage" },
  { key: "sentimentTurn",label: "Sentiment turning",hint: "Few Buy ratings and coverage drifting away over recent months" },
  { key: "insiderSelling",label: "Insider selling", hint: "Discretionary open-market sales, excluding scheduled plans" },
  { key: "earningsRisk", label: "Earnings risk",    hint: "A record of missing consensus, with a report due inside the window" },
];

export const SHORT_PRESETS = {
  balanced:  { label: "Balanced", weights: { breakdown: 22, overvaluation: 20, deterioration: 18, sentimentTurn: 16, insiderSelling: 12, earningsRisk: 12 } },
  momentum:  { label: "Breaking down", weights: { breakdown: 38, sentimentTurn: 22, earningsRisk: 16, deterioration: 12, overvaluation: 8, insiderSelling: 4 } },
  valuation: { label: "Overpriced", weights: { overvaluation: 38, deterioration: 24, insiderSelling: 14, sentimentTurn: 12, breakdown: 8, earningsRisk: 4 } },
};

/* ---------------- factors ---------------- */

function breakdown(a) {
  const m = a.momentum;
  if (!m) return null;
  const inputs = [
    line("1-month return", m.return1m,
      band(m.return1m, [[-30, 100], [-15, 88], [-5, 68], [0, 50], [8, 26], [20, 8]]), "pct"),
    line("3-month return", m.return3m,
      band(m.return3m, [[-45, 100], [-20, 86], [-8, 66], [0, 50], [15, 25], [40, 6]]), "pct"),
    line("Price vs 50-day average", m.vsSma50,
      band(m.vsSma50, [[-25, 100], [-10, 82], [-3, 62], [0, 50], [6, 28], [18, 8]]), "pct"),
    line("Position in 52-week range", a.risk?.rangePosition,
      band(a.risk?.rangePosition, [[0, 92], [20, 78], [45, 55], [70, 32], [95, 10]]), "pct0"),
  ];
  return { inputs, score: avg(inputs.map((i) => i.score)) };
}

function overvaluation(a) {
  const f = a.fundamentals;
  if (!f) return null;
  const inputs = [
    line("P/E ratio", f.pe,
      band(f.pe, [[8, 6], [15, 22], [25, 45], [40, 68], [70, 88], [120, 98]]), "num"),
    line("Forward P/E", f.forwardPe,
      band(f.forwardPe, [[8, 6], [15, 22], [25, 46], [40, 70], [70, 90], [120, 98]]), "num"),
    line("Price / sales", f.priceToSales,
      band(f.priceToSales, [[0.6, 5], [2, 22], [5, 48], [12, 76], [25, 94]]), "num"),
  ];
  // Trading above the analyst mean is the market pricing in more than coverage sees.
  if (a.analysts?.upsidePercent !== null && a.analysts?.upsidePercent !== undefined) {
    inputs.push(line("Premium to mean analyst target", -a.analysts.upsidePercent,
      band(-a.analysts.upsidePercent, [[-30, 6], [-10, 26], [0, 50], [10, 74], [30, 94]]), "pct"));
  }
  const scored = inputs.map((i) => i.score);
  return scored.some((s) => s !== null) ? { inputs, score: avg(scored) } : null;
}

function deterioration(a) {
  const f = a.fundamentals;
  if (!f) return null;
  const inputs = [
    line("Return on equity", f.roe,
      band(f.roe, [[-20, 98], [0, 82], [8, 62], [18, 38], [35, 15], [60, 5]]), "pct"),
    line("Net profit margin", f.netMargin,
      band(f.netMargin, [[-15, 98], [0, 80], [5, 60], [15, 32], [28, 10]]), "pct"),
    line("Gross margin", f.grossMargin,
      band(f.grossMargin, [[8, 90], [20, 70], [35, 50], [55, 28], [75, 10]]), "pct"),
    line("Debt / equity", f.debtToEquity,
      band(f.debtToEquity, [[0, 8], [50, 26], [110, 50], [220, 76], [400, 94]]), "pct"),
  ];
  const scored = inputs.map((i) => i.score);
  return scored.some((s) => s !== null) ? { inputs, score: avg(scored) } : null;
}

function sentimentTurn(a) {
  const an = a.analysts;
  if (!an) return null;
  const inputs = [
    line("Share of analysts rating Buy",
      an.bullishShare === null ? null : an.bullishShare * 100,
      band(an.bullishShare, [[0, 95], [0.25, 78], [0.45, 55], [0.65, 32], [0.9, 10]]), "pct0"),
    line("Coverage trend vs 3 months ago",
      an.trend === null ? null : an.trend * 100,
      band(an.trend, [[-0.25, 92], [-0.08, 72], [0, 50], [0.08, 28], [0.25, 8]]), "pct0"),
  ];
  const scored = inputs.map((i) => i.score);
  return scored.some((s) => s !== null) ? { inputs, score: avg(scored) } : null;
}

function insiderSelling(a) {
  const ins = a.insiders;
  if (!ins) return null;
  const inputs = [];
  if (ins.hasDiscretionary) {
    inputs.push(line("Net discretionary insider selling", -(ins.netDiscretionary ?? 0),
      band(-(ins.netDiscretionary ?? 0),
        [[-2e7, 10], [-2e6, 28], [0, 50], [2e6, 70], [2e7, 88], [1e8, 97]]), "usd"));
    const move = ins.largestStakeMove;
    if (move && move.percent !== null && move.kind === "sell") {
      inputs.push(line("Largest sale as a share of the stake", move.percent,
        band(move.percent, [[0, 50], [3, 62], [10, 80], [25, 94]]), "pct"));
    }
  } else {
    inputs.push(line("No discretionary insider trades on file", null, 50, null));
  }
  return { inputs, score: avg(inputs.map((i) => i.score)) };
}

function earningsRisk(a, horizonDays) {
  const e = a.earnings;
  if (!e) return null;
  const inputs = [];
  if (e.beatRate !== null && e.beatRate !== undefined) {
    inputs.push(line("Consensus beat rate", e.beatRate * 100,
      band(e.beatRate, [[0, 92], [0.25, 78], [0.5, 58], [0.75, 38], [1, 22]]), "pct0"));
  }
  if (e.avgSurprise !== null && e.avgSurprise !== undefined) {
    inputs.push(line("Average surprise", e.avgSurprise,
      band(e.avgSurprise, [[-20, 92], [-5, 74], [0, 55], [5, 38], [15, 20]]), "pct"));
  }
  const next = e.next;
  if (next?.daysAway !== null && next?.daysAway !== undefined) {
    const inWindow = next.daysAway >= 0 && next.daysAway <= horizonDays;
    /* An imminent report cuts both ways for a short, so it raises the score
       only where the company has been missing. */
    const weak = e.beatRate === null || e.beatRate === undefined ? 0.5 : 1 - e.beatRate;
    inputs.push(line(
      inWindow ? `Reports in ${next.daysAway} days${next.confirmed ? "" : " (estimated date)"}`
               : "No report inside the window",
      next.daysAway,
      inWindow ? clamp(45 + weak * 55 * (next.confirmed ? 1 : 0.6)) : 45, "days"));
  }
  return inputs.length ? { inputs, score: avg(inputs.map((i) => i.score)) } : null;
}

/* ---------------- squeeze hazard ---------------- */

/**
 * Crowding, judged separately from the thesis. A stock can deserve to fall and
 * still be a ruinous short: when a lot of the float is already sold short, the
 * buying needed to close those positions can overwhelm the selling that the
 * fundamentals justify.
 */
export function squeezeRisk(a) {
  const dtc = a.shortInterest?.daysToCover ?? null;
  const interest = a.shortInterest?.interest ?? null;
  const shares = a.fundamentals?.sharesOut ?? null;
  const percentOfShares = interest !== null && shares ? (interest / shares) * 100 : null;
  const cap = a.fundamentals?.marketCap ?? null;
  const reasons = [];
  let level = "unknown";

  if (dtc !== null || percentOfShares !== null) {
    /* Calibrated against what these numbers normally look like. Most large caps
       sit near two days to cover and under 3% of shares short; a first pass
       treated 2.5 days as elevated, which flagged every ordinary stock and so
       warned about none of them. Genuine crowding starts around five days and
       5% of shares, and the famous squeezes ran far past both. */
    let severity = 0;
    if (dtc !== null) {
      if (dtc >= 10) { severity = Math.max(severity, 3); reasons.push(`${dtc.toFixed(1)} days of average volume to cover — a crowded exit`); }
      else if (dtc >= 6) { severity = Math.max(severity, 2); reasons.push(`${dtc.toFixed(1)} days to cover`); }
      else if (dtc >= 3) { severity = Math.max(severity, 1); reasons.push(`${dtc.toFixed(1)} days to cover`); }
      else reasons.push(`${dtc.toFixed(1)} days to cover — easily unwound`);
    }
    if (percentOfShares !== null) {
      if (percentOfShares >= 20) { severity = Math.max(severity, 3); reasons.push(`${percentOfShares.toFixed(1)}% of shares already short`); }
      else if (percentOfShares >= 10) { severity = Math.max(severity, 2); reasons.push(`${percentOfShares.toFixed(1)}% of shares short`); }
      else if (percentOfShares >= 5) { severity = Math.max(severity, 1); reasons.push(`${percentOfShares.toFixed(1)}% of shares short`); }
      else reasons.push(`${percentOfShares.toFixed(1)}% of shares short — lightly held`);
    }
    level = ["low", "elevated", "high", "severe"][severity];
  } else {
    reasons.push("No short-interest data — crowding unknown, not absent");
  }

  // A small company is easier to move and harder to borrow.
  if (cap !== null && cap < 2e9) {
    reasons.push("Small cap: borrow is likelier to be scarce or expensive");
    if (level === "low") level = "elevated";
    else if (level === "unknown") level = "unknown";
  }
  // Something already rising is the wrong moment regardless of the thesis.
  if ((a.momentum?.return1m ?? 0) > 12) {
    reasons.push(`Up ${a.momentum.return1m.toFixed(0)}% in a month — rising into the trade`);
    if (level === "low") level = "elevated";
  }
  return { level, daysToCover: dtc, percentOfShares, reasons };
}

/* ---------------- assembly ---------------- */

export function scoreShort(analysis, weights = SHORT_PRESETS.balanced.weights, horizonDays = 30) {
  const computed = {
    breakdown: breakdown(analysis),
    overvaluation: overvaluation(analysis),
    deterioration: deterioration(analysis),
    sentimentTurn: sentimentTurn(analysis),
    insiderSelling: insiderSelling(analysis),
    earningsRisk: earningsRisk(analysis, horizonDays),
  };

  const factors = SHORT_FACTORS.map((f) => {
    const c = computed[f.key];
    const score = c?.score ?? null;
    return { ...f, score: score === null ? null : clamp(score),
             weight: Number(weights[f.key] ?? 0), inputs: c?.inputs ?? [], available: score !== null };
  });

  const live = factors.filter((f) => f.available && f.weight > 0);
  const total = live.reduce((a, f) => a + f.weight, 0);
  const overall = total ? clamp(live.reduce((a, f) => a + f.score * f.weight, 0) / total) : null;
  for (const f of factors) {
    f.effectiveWeight = total && f.available && f.weight > 0 ? f.weight / total : 0;
  }

  const weightedAvailable = SHORT_FACTORS.reduce(
    (a, f) => a + (computed[f.key] ? Number(weights[f.key] ?? 0) : 0), 0);
  const weightedTotal = SHORT_FACTORS.reduce((a, f) => a + Number(weights[f.key] ?? 0), 0);

  return {
    overall,
    factors,
    confidence: weightedTotal ? weightedAvailable / weightedTotal : 0,
    squeeze: squeezeRisk(analysis),
    horizonDays,
  };
}

/** Wording for a score, kept plainer than the long side's on purpose. */
export function shortBand(score) {
  if (score === null || score === undefined) return { label: "No data", tone: "flat" };
  if (score >= 72) return { label: "Weak on every measure", tone: "down" };
  if (score >= 58) return { label: "Several weak signals", tone: "down" };
  if (score >= 45) return { label: "Mixed", tone: "flat" };
  if (score >= 32) return { label: "Mostly holding up", tone: "up" };
  return { label: "Strong — a poor short", tone: "up" };
}

export const SQUEEZE_TONE = {
  low: "up", elevated: "flat", high: "down", severe: "down", unknown: "flat",
};
