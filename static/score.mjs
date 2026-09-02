/* The 0-100 rating.

   A single number over a one-month horizon is a heuristic, not a forecast, so
   nothing here is hidden: every factor exposes the inputs that produced it and
   the points each one contributed, and every weight is adjustable in the UI.

   Factors a stock has no data for are dropped and the remaining weights are
   renormalised, so a missing upstream lowers `confidence` rather than silently
   scoring zero. */

/** Piecewise-linear map from a raw value to 0-100 through labelled points. */
export function band(value, points) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const pts = [...points].sort((a, b) => a[0] - b[0]);
  if (value <= pts[0][0]) return pts[0][1];
  if (value >= pts[pts.length - 1][0]) return pts[pts.length - 1][1];
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
    if (value <= x1) return y0 + ((value - x0) / (x1 - x0)) * (y1 - y0);
  }
  return null;
}

const avg = (xs) => {
  const v = xs.filter((x) => x !== null && x !== undefined && Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};
const clamp = (n) => Math.max(0, Math.min(100, n));

/** One scored input line, shown in the UI under its factor. */
const input = (label, raw, score, format) => ({ label, raw, score, format: format ?? null });

/* ---------------- the seven factors ---------------- */

function momentum(a) {
  const m = a.momentum;
  if (!m) return null;
  const inputs = [
    input("1-month return", m.return1m,
      band(m.return1m, [[-15, 0], [-5, 25], [0, 45], [10, 80], [25, 100]]), "pct"),
    input("3-month return", m.return3m,
      band(m.return3m, [[-25, 0], [-8, 25], [0, 45], [20, 85], [50, 100]]), "pct"),
    input("Price vs 20-day avg", m.vsSma20,
      band(m.vsSma20, [[-10, 0], [-3, 30], [0, 50], [5, 80], [12, 100]]), "pct"),
    input("Price vs 50-day avg", m.vsSma50,
      band(m.vsSma50, [[-15, 0], [-5, 30], [0, 50], [8, 85], [20, 100]]), "pct"),
    input("Position in 52-week range", a.risk?.rangePosition,
      band(a.risk?.rangePosition, [[0, 15], [30, 40], [50, 55], [85, 90], [100, 95]]), "pct0"),
  ];
  return { inputs, score: avg(inputs.map((i) => i.score)) };
}

/* Earnings inside the window is the single biggest scheduled mover, but it is
   a two-sided one. Proximity is scaled by how reliably the company has beaten,
   so a serial beater reporting next week rates above a serial misser. */
function catalyst(a, horizonDays) {
  const next = a.earnings?.next;
  const beatRate = a.earnings?.beatRate;
  const inputs = [];

  if (next?.daysAway !== null && next?.daysAway !== undefined) {
    const inWindow = next.daysAway >= 0 && next.daysAway <= horizonDays;
    const proximity = inWindow
      ? band(next.daysAway, [[0, 100], [3, 95], [7, 88], [14, 74], [30, 58], [60, 35]])
      : 25;
    const reliability = beatRate === null || beatRate === undefined ? 0.5 : beatRate;
    inputs.push(input(
      inWindow ? `Earnings in ${next.daysAway} days (inside window)` : "Earnings outside window",
      next.daysAway, clamp(proximity * (0.55 + reliability * 0.45)), "days"));
  }

  if (a.analysts?.upsidePercent !== null && a.analysts?.upsidePercent !== undefined) {
    inputs.push(input("Upside to mean analyst target", a.analysts.upsidePercent,
      band(a.analysts.upsidePercent, [[-20, 5], [-5, 30], [0, 45], [10, 68], [25, 90], [50, 100]]), "pct"));
  }
  if (a.shortInterest?.daysToCover !== null && a.shortInterest?.daysToCover !== undefined) {
    inputs.push(input("Days to cover (squeeze potential)", a.shortInterest.daysToCover,
      band(a.shortInterest.daysToCover, [[0.5, 45], [2, 50], [4, 62], [7, 78], [12, 92]]), "num"));
  }

  // With nothing at all to go on the factor is absent, not neutral: inventing a
  // score here would let an empty analysis produce a confident-looking rating.
  if (!inputs.length) return null;

  // An unknown earnings date alongside real data is genuinely neutral, though.
  if (!next) inputs.unshift(input("Earnings date unknown", null, 45, null));
  return { inputs, score: avg(inputs.map((i) => i.score)) };
}

function sentiment(a) {
  const an = a.analysts;
  if (!an) return null;
  const inputs = [
    input("Share of analysts rating Buy", an.bullishShare === null ? null : an.bullishShare * 100,
      band(an.bullishShare, [[0, 10], [0.25, 32], [0.4, 48], [0.6, 72], [0.85, 95], [1, 100]]), "pct0"),
    input("Coverage trend vs 3 months ago", an.trend === null ? null : an.trend * 100,
      band(an.trend, [[-0.25, 12], [-0.05, 40], [0, 50], [0.08, 72], [0.2, 92]]), "pct0"),
    input("Analysts covering", an.count,
      band(an.count, [[0, 30], [3, 45], [10, 62], [25, 78], [40, 88]]), "num0"),
  ];
  const n = (a.news ?? []).length;
  if (n) inputs.push(input("Recent news volume", n, band(n, [[0, 40], [2, 52], [5, 65], [8, 74]]), "num0"));
  return { inputs, score: avg(inputs.map((i) => i.score)) };
}

/* Only discretionary trades carry signal. Grants, vesting, tax withholding and
   preset-plan sales are all excluded: penalising a CEO for an RSU vesting on a
   fixed schedule would be noise, not information. A company with no
   discretionary activity at all scores a flat 50 rather than a zero. */
function insider(a) {
  const ins = a.insiders;
  if (!ins) return null;
  const inputs = [];

  if (ins.hasDiscretionary) {
    inputs.push(input("Net discretionary insider buying", ins.netDiscretionary,
      band(ins.netDiscretionary,
        [[-2e7, 12], [-2e6, 30], [-2e5, 44], [0, 50], [2e5, 58], [2e6, 74], [2e7, 92], [1e8, 100]]),
      "usd"));
    inputs.push(input("Open-market buys", ins.buyCount,
      band(ins.buyCount, [[0, 42], [1, 62], [3, 80], [6, 92]]), "num0"));
    inputs.push(input("Open-market sells", ins.sellCount,
      band(ins.sellCount, [[0, 60], [1, 50], [4, 38], [10, 25]]), "num0"));
  } else {
    inputs.push(input("No discretionary insider trades on file", null, 50, null));
  }

  // Context lines, shown but deliberately not scored.
  inputs.push(input("Preset-plan sales", ins.plannedSells || 0, null, "usd"));
  if (ins.routineShare !== null && ins.routineShare !== undefined) {
    inputs.push(input("Share of filings that are routine comp", ins.routineShare * 100, null, "pct0"));
  }
  return { inputs, score: avg(inputs.map((i) => i.score)) };
}

function valuation(a) {
  const f = a.fundamentals;
  if (!f) return null;
  const inputs = [
    input("P/E ratio", f.pe,
      band(f.pe, [[5, 98], [10, 92], [15, 80], [25, 60], [40, 36], [60, 20], [100, 6]]), "num"),
    input("Forward P/E", f.forwardPe,
      band(f.forwardPe, [[5, 98], [10, 90], [15, 78], [25, 58], [40, 34], [60, 18], [100, 5]]), "num"),
    input("Price / sales", f.priceToSales,
      band(f.priceToSales, [[0.5, 96], [1, 90], [3, 70], [8, 42], [15, 22], [25, 6]]), "num"),
  ];
  const scored = inputs.map((i) => i.score);
  // A company with no positive P/E is expensive-by-absence, not unrated.
  if (scored.every((s) => s === null) && f.priceToSales === null) return null;
  return { inputs, score: avg(scored) };
}

function quality(a) {
  const f = a.fundamentals;
  if (!f) return null;
  const inputs = [
    input("Return on equity", f.roe,
      band(f.roe, [[-10, 5], [0, 18], [10, 45], [20, 70], [35, 90], [60, 100]]), "pct"),
    input("Net profit margin", f.netMargin,
      band(f.netMargin, [[-10, 5], [0, 18], [5, 40], [15, 70], [25, 88], [40, 100]]), "pct"),
    input("Gross margin", f.grossMargin,
      band(f.grossMargin, [[10, 20], [20, 35], [30, 50], [50, 75], [70, 92]]), "pct"),
    input("Debt / equity", f.debtToEquity,
      band(f.debtToEquity, [[0, 100], [30, 88], [50, 80], [100, 60], [200, 35], [400, 10]]), "pct"),
  ];
  const scored = inputs.map((i) => i.score);
  return scored.some((s) => s !== null) ? { inputs, score: avg(scored) } : null;
}

/** Scored as safety: a high score means calmer, not more promising. */
function risk(a) {
  const r = a.risk;
  if (!r) return null;
  const inputs = [
    input("Annualised volatility (30d)", r.volatility,
      band(r.volatility, [[12, 98], [20, 88], [30, 70], [45, 48], [60, 30], [90, 10]]), "pct"),
    input("Beta", r.beta,
      band(r.beta, [[0.4, 98], [0.7, 90], [1, 72], [1.5, 45], [2, 25], [3, 8]]), "num"),
    input("Max drawdown (6m)", r.maxDrawdown,
      band(r.maxDrawdown, [[-60, 8], [-40, 28], [-25, 50], [-15, 72], [-7, 90], [0, 98]]), "pct"),
  ];
  const scored = inputs.map((i) => i.score);
  return scored.some((s) => s !== null) ? { inputs, score: avg(scored) } : null;
}

/* ---------------- weights ---------------- */

export const FACTORS = [
  { key: "momentum",  label: "Momentum",     hint: "Price trend over 1-3 months and position in the 52-week range" },
  { key: "catalyst",  label: "Catalyst",     hint: "Scheduled movers inside your window — earnings, target gap, squeeze potential" },
  { key: "sentiment", label: "Sentiment",    hint: "Analyst ratings, how coverage has shifted, and news flow" },
  { key: "insider",   label: "Insider",      hint: "Discretionary insider buying and selling, excluding preset plans" },
  { key: "valuation", label: "Valuation",    hint: "P/E, forward P/E and price-to-sales — higher score means cheaper" },
  { key: "quality",   label: "Quality",      hint: "Margins, return on equity and leverage" },
  { key: "risk",      label: "Safety",       hint: "Volatility, beta and drawdown — higher score means calmer" },
];

export const PRESETS = {
  sprint:   { label: "1-Month Sprint", weights: { momentum: 30, catalyst: 25, sentiment: 20, insider: 10, quality: 8, valuation: 4, risk: 3 } },
  balanced: { label: "Balanced",       weights: { momentum: 14, catalyst: 14, sentiment: 14, insider: 15, quality: 15, valuation: 14, risk: 14 } },
  value:    { label: "Value",          weights: { momentum: 5,  catalyst: 5,  sentiment: 10, insider: 5,  quality: 25, valuation: 35, risk: 15 } },
  growth:   { label: "Growth",         weights: { momentum: 28, catalyst: 15, sentiment: 20, insider: 8,  quality: 17, valuation: 5,  risk: 7 } },
  quality:  { label: "Quality",        weights: { momentum: 8,  catalyst: 5,  sentiment: 10, insider: 7,  quality: 30, valuation: 15, risk: 25 } },
};

export const DEFAULT_HORIZON_DAYS = 30;

/**
 * Score one parsed analysis.
 * @returns {{overall:number|null, factors:Array, confidence:number}}
 */
export function scoreAnalysis(analysis, weights = PRESETS.sprint.weights, horizonDays = DEFAULT_HORIZON_DAYS) {
  const computed = {
    momentum: momentum(analysis),
    catalyst: catalyst(analysis, horizonDays),
    sentiment: sentiment(analysis),
    insider: insider(analysis),
    valuation: valuation(analysis),
    quality: quality(analysis),
    risk: risk(analysis),
  };

  const factors = FACTORS.map((f) => {
    const c = computed[f.key];
    const score = c?.score ?? null;
    return {
      ...f,
      score: score === null ? null : clamp(score),
      weight: Number(weights[f.key] ?? 0),
      inputs: c?.inputs ?? [],
      available: score !== null,
    };
  });

  // Renormalise over the factors that actually have data.
  const live = factors.filter((f) => f.available && f.weight > 0);
  const totalWeight = live.reduce((a, f) => a + f.weight, 0);
  const overall = totalWeight
    ? clamp(live.reduce((a, f) => a + f.score * f.weight, 0) / totalWeight)
    : null;

  for (const f of factors) {
    f.effectiveWeight = totalWeight && f.available && f.weight > 0 ? f.weight / totalWeight : 0;
    f.contribution = f.available && f.score !== null ? f.score * f.effectiveWeight : 0;
  }

  // Confidence reflects how much of the picture actually loaded.
  const weightedAvailable = FACTORS.reduce(
    (a, f) => a + (computed[f.key] ? Number(weights[f.key] ?? 0) : 0), 0);
  const weightedTotal = FACTORS.reduce((a, f) => a + Number(weights[f.key] ?? 0), 0);
  const confidence = weightedTotal ? weightedAvailable / weightedTotal : 0;

  return { overall, factors, confidence, horizonDays };
}

/** Label for a score, used for colour and the one-word summary. */
export function scoreBand(score) {
  if (score === null || score === undefined) return { label: "No data", tone: "flat" };
  if (score >= 75) return { label: "Strong", tone: "up" };
  if (score >= 60) return { label: "Favourable", tone: "up" };
  if (score >= 45) return { label: "Neutral", tone: "flat" };
  if (score >= 30) return { label: "Weak", tone: "down" };
  return { label: "Poor", tone: "down" };
}
