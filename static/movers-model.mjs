/* Assembling an explanation for a move.

   Nothing here observes cause, and the wording never claims to. What it
   assembles is what else was happening at the time, ranked by how well each
   piece of evidence usually accounts for a large move:

     results   a company that reported hours earlier is nearly always the
               reason, and the surprise against consensus says how much of one
     coverage  headlines dated around the session, which describe the move more
               often than they explain it
     sector    if the whole sector moved, the company may have done nothing at
               all — the single most common false story about a mover

   Where none of that turns anything up it says so, rather than reaching for
   whatever headline happens to be nearest. */

const MONTHS = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];

const num = (v) => {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const t = String(v).replace(/[$,%\s]/g, "");
  if (!t || t.toUpperCase() === "N/A") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

/** "9/3/2026" or "Sep 3, 2026" to an ISO date. */
export function toIsoDate(value) {
  const s = String(value ?? "").trim();
  let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  m = /^([A-Za-z]{3})[a-z]*\s+(\d{1,2}),?\s+(\d{4})$/.exec(s);
  if (m) {
    const month = MONTHS.indexOf(m[1].toLowerCase());
    if (month !== -1) return `${m[3]}-${String(month + 1).padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  }
  return null;
}

const daysApart = (a, b) => {
  if (!a || !b) return null;
  return Math.round((new Date(a + "T00:00:00") - new Date(b + "T00:00:00")) / 864e5);
};

/**
 * @param mover    a row from /api/movers
 * @param why      the payload from /api/mover-why
 * @param sectors  sector medians from /api/movers
 * @param sessionDate ISO date of the session the move describes
 */
export function explainMove(mover, why, sectors, sessionDate) {
  const evidence = [];
  const move = mover?.changePercent ?? null;

  /* Results, and how far they landed from consensus. A company that reported
     within a couple of days of the session is nearly always the explanation. */
  const rows = why?.earnings?.data?.earningsSurpriseTable?.rows ?? [];
  const latest = rows[0];
  const reported = latest ? toIsoDate(latest.dateReported) : null;
  const gap = reported && sessionDate ? daysApart(sessionDate, reported) : null;
  if (reported && gap !== null && gap >= 0 && gap <= 4) {
    const actual = num(latest.eps);
    const estimate = num(latest.consensusForecast);
    const surprise = num(latest.percentageSurprise);
    const beat = surprise !== null ? surprise > 0 : (actual !== null && estimate !== null && actual > estimate);
    evidence.push({
      kind: "results",
      strength: "strong",
      headline: `Reported results ${gap === 0 ? "that session" : gap === 1 ? "the day before" : `${gap} days earlier`}`,
      detail: [
        actual !== null ? `EPS ${actual.toFixed(2)}` : null,
        estimate !== null ? `against ${estimate.toFixed(2)} expected` : null,
        surprise !== null ? `${surprise > 0 ? "beating" : "missing"} by ${Math.abs(surprise).toFixed(1)}%` : null,
      ].filter(Boolean).join(", "),
      // A beat alongside a fall is worth calling out rather than smoothing over.
      contradiction: (beat && move !== null && move < -3)
        ? "Beat consensus and fell anyway — the reaction is to something other than the headline number, usually guidance."
        : (!beat && move !== null && move > 3)
          ? "Missed consensus and rose anyway — the market was positioned for worse."
          : null,
      date: reported,
    });
  }

  /* Headlines around the session. These describe a move at least as often as
     they explain one, so they are offered as reading, not as a reason. */
  const articles = (why?.news?.data?.rows ?? []).map((r) => ({
    title: r.title ?? null,
    publisher: r.publisher ?? null,
    created: r.created ?? null,
    date: toIsoDate(r.created),
    url: r.url ? (String(r.url).startsWith("http") ? r.url : "https://www.nasdaq.com" + r.url) : null,
  })).filter((a) => a.title);
  const near = articles.filter((a) => {
    const d = a.date && sessionDate ? daysApart(sessionDate, a.date) : null;
    return d !== null && d >= -1 && d <= 3;
  });
  if (near.length) {
    evidence.push({
      kind: "coverage", strength: "moderate",
      headline: `${near.length} headline${near.length === 1 ? "" : "s"} around the session`,
      detail: null, articles: near.slice(0, 4),
    });
  }

  /* Sector context, which is what tells you the company may have done nothing.
     Computed from every tradeable stock in the sector, so it costs nothing. */
  const sector = mover?.sector ? sectors?.[mover.sector] : null;
  if (sector && move !== null) {
    const median = sector.median;
    const excess = move - median;
    const sectorLed = Math.abs(median) > 1.5 && Math.abs(excess) < Math.abs(median);
    evidence.push({
      kind: "sector",
      strength: sectorLed ? "strong" : "context",
      headline: sectorLed
        ? `${mover.sector} moved ${median.toFixed(1)}% as a whole`
        : `${mover.sector} was ${median >= 0 ? "up" : "down"} ${Math.abs(median).toFixed(1)}% overall`,
      detail: sectorLed
        ? "Most of this move came with the sector rather than from the company."
        : `This stock moved ${excess >= 0 ? "+" : "−"}${Math.abs(excess).toFixed(1)}% beyond its sector, so it is company-specific.`,
      median, excess, peers: sector.count,
    });
  }

  const substantive = evidence.filter((e) => e.kind !== "sector" || e.strength === "strong");
  return {
    evidence,
    // Said plainly rather than dressed up with whatever headline is nearest.
    unexplained: substantive.length === 0,
    articles,
  };
}

/** A one-line summary for the collapsed row. */
export function summariseCause(explanation) {
  if (!explanation || explanation.unexplained) return "No public cause found";
  const results = explanation.evidence.find((e) => e.kind === "results");
  if (results) return results.contradiction ? "Results — but read the detail" : "Results";
  const sector = explanation.evidence.find((e) => e.kind === "sector" && e.strength === "strong");
  if (sector) return "Moved with its sector";
  const coverage = explanation.evidence.find((e) => e.kind === "coverage");
  if (coverage) return "In the news";
  return "No public cause found";
}
