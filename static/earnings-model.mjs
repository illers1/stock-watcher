/* Turns the raw calendar rows from /api/earnings into one clean model.

   Same split as analyze.mjs: the server fetches and passes upstream formatting
   through untouched, and every interpretation happens here — one place, shared
   by the page and the tests, so the Netlify function and the local Python
   server can never drift apart on how a figure is read.

   Nasdaq writes money as "$1.46", losses in accountants' brackets as "($0.04)",
   market caps as "$50,132,382,000", and the session as a CSS-ish class name. */

/** "$1.46" -> 1.46 · "($0.04)" -> -0.04 · "" / "N/A" -> null */
export function money(v) {
  if (v === null || v === undefined) return null;
  let t = String(v).trim();
  if (!t || ["N/A", "--", "-", "NA"].includes(t.toUpperCase())) return null;
  let sign = 1;
  if (/^\(.*\)$/.test(t)) { sign = -1; t = t.slice(1, -1); }   // (0.04) is a loss
  t = t.replace(/[$,\s]/g, "").replace(/−/g, "-");
  if (t.startsWith("-")) { sign *= -1; t = t.slice(1); }
  const n = Number(t);
  return Number.isFinite(n) ? sign * n : null;
}

export const SESSIONS = {
  "time-pre-market":   { key: "bmo", label: "Before open", short: "BMO" },
  "time-after-hours":  { key: "amc", label: "After close", short: "AMC" },
  "time-not-supplied": { key: "tba", label: "Time not announced", short: "TBA" },
};

export function session(time) {
  return SESSIONS[String(time ?? "").trim()] ?? SESSIONS["time-not-supplied"];
}

const dayStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

/** Whole days from today to an ISO date; negative once the date has passed. */
export function daysAway(isoDate, today = new Date()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDate ?? ""));
  if (!m) return null;
  const then = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Math.round((then - dayStart(today)) / 864e5);
}

/**
 * One company reporting on one day.
 * Every numeric field may be null: Nasdaq lists plenty of small caps with no
 * consensus at all, and an unloved name is not a broken row.
 */
export function parseRow(row, today = new Date()) {
  const symbol = String(row?.symbol ?? "").toUpperCase();
  const eps = money(row?.epsForecast);
  const lastYear = money(row?.lastYearEPS);
  const ests = money(row?.noOfEsts);

  // Expected year-on-year move in EPS. Scaled by the absolute prior figure so
  // a swing through zero still reads sensibly, and dropped when last year was
  // a loss — "+250% growth" off a negative base is arithmetic, not a fact.
  const epsGrowth = (eps !== null && lastYear !== null && lastYear > 0)
    ? ((eps - lastYear) / lastYear) * 100 : null;

  return {
    symbol,
    name: row?.name ?? symbol,
    date: row?.date ?? null,
    daysAway: daysAway(row?.date, today),
    session: session(row?.time),
    marketCap: money(row?.marketCap),
    epsForecast: eps,
    estimates: ests === null ? null : Math.round(ests),
    lastYearEPS: lastYear,
    lastYearReported: row?.lastYearRptDt ?? null,
    epsGrowth,
    quarterEnding: row?.fiscalQuarterEnding ?? null,
    // Shaped for parseAnalysis(), which takes the event straight from here.
    event: { date: row?.date ?? null, time: row?.time ?? null, epsForecast: eps },
  };
}

/** Flatten the day-by-day payload into one list, earliest date first. */
export function parseEarnings(payload, today = new Date()) {
  const days = Array.isArray(payload?.days) ? payload.days : [];
  const out = [];
  for (const day of days) {
    for (const row of day?.rows ?? []) {
      const parsed = parseRow({ ...row, date: row?.date ?? day.date }, today);
      if (parsed.symbol) out.push(parsed);
    }
  }
  return out;
}

/** Headline counts for the window, computed over whatever is on screen. */
export function summarise(rows) {
  const caps = rows.map((r) => r.marketCap).filter((v) => v !== null);
  return {
    count: rows.length,
    bmo: rows.filter((r) => r.session.key === "bmo").length,
    amc: rows.filter((r) => r.session.key === "amc").length,
    largeCaps: caps.filter((v) => v >= 1e10).length,
    totalCap: caps.reduce((a, v) => a + v, 0),
  };
}
