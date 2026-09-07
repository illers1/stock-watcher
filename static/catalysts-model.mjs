/* One dated, company-specific event list from several unrelated feeds.

   Every item is normalised to the same shape so the page can sort the lot
   chronologically and filter by kind:

     { date, kind, symbol, name, title, detail, confirmed, url, source }

   `confirmed` carries the same meaning as on the earnings window: true when
   the date comes from the company or the exchange, false when something
   inferred it. Nothing is shown without a date. */

/* The feeds use several spellings of "no value"; all of them must be treated
   as absent rather than rendered, or a row reads "reported N/A a year ago". */
const BLANK = /^(n\/?a|--?|none|null|tbd)$/i;
const present = (v) => {
  const s = String(v ?? "").trim();
  return s && !BLANK.test(s) ? s : null;
};

const MONTHS = ["january","february","march","april","may","june",
                "july","august","september","october","november","december"];

export const KINDS = {
  earnings: {
    label: "Earnings",
    hint: "Quarterly results",
    blurb: "The company reports the quarter. For most stocks this is the largest " +
           "scheduled single-day move of the year, and it turns on the surprise " +
           "against consensus rather than the absolute number.",
  },
  regulatory: {
    label: "Regulatory",
    hint: "FDA decisions and advisory committee meetings",
    blurb: "An FDA decision date (PDUFA) or advisory committee meeting, read from " +
           "the company's own 8-K filing. Largely binary for small biotech: approval " +
           "and rejection point in opposite directions and move a long way.",
  },
  dividend: {
    label: "Ex-dividend",
    hint: "First day the stock trades without the next dividend",
    blurb: "Buy on or after this date and you do not receive the upcoming dividend. " +
           "The price typically opens lower by roughly the dividend, so it is a " +
           "mechanical move rather than news.",
  },
  split: {
    label: "Split",
    hint: "Share count and price change proportionally",
    blurb: "Share count and price change proportionally, so the value of a holding " +
           "does not change. It can still shift liquidity, index eligibility and " +
           "options pricing, and often follows a strong run.",
  },
  ipo: {
    label: "IPO",
    hint: "Expected pricing of a new listing",
    blurb: "A new listing expected to price. Dates move often and the shares have no " +
           "trading history, so there is nothing here to rate against.",
  },
};

const num = (v) => {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const t = String(v).replace(/[$,]/g, "").trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

/** M/D/YYYY (the feeds' format) or an ISO date, to ISO. Null if neither. */
export function toIso(value) {
  const s = String(value ?? "").trim();
  if (!s) return null;
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return s;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  return null;
}

/** "November 27, 2026" -> "2026-11-27". */
export function longDateToIso(value) {
  const m = /([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/.exec(String(value ?? ""));
  if (!m) return null;
  const month = MONTHS.indexOf(m[1].toLowerCase());
  if (month === -1) return null;
  return `${m[3]}-${String(month + 1).padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}

/** "Harmony Biosciences Holdings, Inc.  (HRMY)  (CIK 0001802665)"
    A company with several listed classes appears as "(BFRI, BFRIW)"; the
    common stock is listed first, so take the first ticker in the group. */
export function splitDisplayName(display) {
  const s = String(display ?? "");
  const group = /\(([A-Z][A-Z0-9.\-]{0,9}(?:\s*,\s*[A-Z][A-Z0-9.\-]{0,9})*)\)/
    .exec(s.replace(/\(CIK[^)]*\)/i, ""));
  const name = s.split("  (")[0].trim();
  return {
    name: name || null,
    symbol: group ? group[1].split(",")[0].trim() : null,
  };
}

/** Pull the decision date out of the sentence around the mention.
 *
 *  Filings write these several ways: "PDUFA date is November 14, 2026", but
 *  also "(PDUFA November 30)" with the year left implicit. A bare month and
 *  day is resolved to its first occurrence on or after the filing date.
 *
 *  A date earlier than the filing is a historical reference — pipeline slides
 *  often list past approvals beside forthcoming ones — so it is rejected
 *  rather than published as upcoming.
 *
 *  @param filedDate ISO date of the filing the context came from
 */
export function regulatoryDate(context, filedDate = null) {
  const text = String(context ?? "");
  const TERM = "(?:PDUFA|advisory committee)";
  const FULL = "([A-Za-z]+\\s+\\d{1,2},?\\s+\\d{4})";
  /* (?!\\d) stops the day from backtracking into a longer number: without it,
     "July 22, 2025" fails the year guard on "22", retries on "2", and invents
     a July 2nd that appears nowhere in the filing. */
  const BARE = "([A-Za-z]+\\s+\\d{1,2})(?!\\d)(?!\\s*,?\\s*\\d{4})";

  const candidates = [
    new RegExp(`${TERM}[^.]{0,140}?${FULL}`, "i"),
    new RegExp(`${FULL}[^.]{0,100}?${TERM}`, "i"),
  ];
  for (const re of candidates) {
    const m = re.exec(text);
    const iso = m ? longDateToIso(m[1]) : null;
    if (iso && (!filedDate || iso >= filedDate)) return iso;
  }

  // Year omitted: "(PDUFA November 30)".
  const bare = new RegExp(`${TERM}[^.]{0,60}?${BARE}`, "i").exec(text);
  if (bare && filedDate) {
    const month = MONTHS.findIndex((m) =>
      m.startsWith(String(bare[1]).split(/\s+/)[0].toLowerCase().replace(/\.$/, "")));
    const day = Number(String(bare[1]).split(/\s+/)[1]);
    if (month !== -1 && day >= 1 && day <= 31) {
      const filedYear = Number(filedDate.slice(0, 4));
      for (const year of [filedYear, filedYear + 1]) {
        const iso = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
        if (iso >= filedDate) return iso;
      }
    }
  }
  return null;
}

/** A readable slice of the filing around the mention, for showing verbatim. */
export function excerptAround(context, term, width = 150) {
  const text = String(context ?? "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  const i = text.toUpperCase().indexOf(String(term).toUpperCase());
  const from = i === -1 ? 0 : Math.max(0, i - Math.floor(width / 2));
  let slice = text.slice(from, from + width * 2).trim();
  // Trim to word boundaries so the quote does not start or end mid-word.
  if (from > 0) slice = slice.replace(/^\S+\s/, "");
  if (from + width * 2 < text.length) slice = slice.replace(/\s\S+$/, "");
  return (from > 0 ? "… " : "") + slice + (from + width * 2 < text.length ? " …" : "");
}

const daysFrom = (iso, today) => {
  const d = new Date(iso + "T00:00:00");
  if (Number.isNaN(+d)) return null;
  const base = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((d - base) / 864e5);
};

/* ---------------- per-source mapping ---------------- */

function fromEarnings(events, today) {
  return Object.entries(events ?? {}).map(([symbol, e]) => {
    const date = toIso(e?.date);
    if (!date) return null;
    const confirmed = !!(e?.time && !/not-supplied/i.test(e.time));
    const when = /after/i.test(e?.time ?? "") ? "after the close"
      : /pre|before/i.test(e?.time ?? "") ? "before the open" : "time of day not announced";
    const eps = num(e?.epsForecast);
    const ests = num(e?.estimateCount);
    const facts = [when];
    if (eps !== null) {
      facts.push(`consensus EPS ${eps.toFixed(2)}${ests ? ` from ${ests} analyst${ests === 1 ? "" : "s"}` : ""}`);
    }
    const quarter = present(e?.fiscalQuarterEnding);
    const priorYear = present(e?.lastYearReported);
    if (quarter) facts.push(`quarter ending ${quarter}`);
    if (priorYear) facts.push(`reported ${priorYear} a year ago`);
    return {
      date, kind: "earnings", symbol, name: e?.name ?? null,
      title: "Quarterly earnings",
      facts,
      confirmed, url: null, source: "Nasdaq earnings calendar",
      // Only an announced date carries a session time; the rest are projected
      // from past cadence and can move.
      note: confirmed ? null : "Date projected from past reporting cadence, not announced",
      daysAway: daysFrom(date, today),
    };
  }).filter(Boolean);
}

function fromDividends(rows, today) {
  return (rows ?? []).map((r) => {
    const date = toIso(r?.dividend_Ex_Date ?? r?._date);
    const symbol = String(r?.symbol ?? "").toUpperCase();
    if (!date || !symbol) return null;
    const rate = num(r?.dividend_Rate);
    const pay = toIso(r?.payment_Date);
    const record = toIso(r?.record_Date);
    const annual = num(r?.indicated_Annual_Dividend);
    const declared = toIso(r?.announcement_Date);
    const facts = [];
    if (rate !== null) facts.push(`${rate.toFixed(2)} per share this quarter`);
    if (annual !== null) facts.push(`${annual.toFixed(2)} indicated annually`);
    if (record) facts.push(`record date ${record}`);
    if (pay) facts.push(`paid ${pay}`);
    if (declared) facts.push(`declared ${declared}`);
    return {
      date, kind: "dividend", symbol, name: r?.companyName ?? null,
      title: rate !== null ? `Goes ex-dividend, ${rate.toFixed(2)} per share` : "Goes ex-dividend",
      facts,
      // Declared by the company and carried by the exchange.
      confirmed: true, url: null, source: "Nasdaq dividend calendar",
      note: "Price typically opens lower by about the dividend — mechanical, not news",
      daysAway: daysFrom(date, today),
    };
  }).filter(Boolean);
}

function fromSplits(rows, today) {
  return (rows ?? []).map((r) => {
    const date = toIso(r?.executionDate);
    const symbol = String(r?.symbol ?? "").toUpperCase();
    if (!date || !symbol) return null;
    const ratio = r?.ratio ? String(r.ratio).replace(/\s+/g, "") : null;
    const parts = ratio ? ratio.split(":").map((n) => num(n)) : [];
    const facts = [];
    if (parts.length === 2 && parts[0] && parts[1]) {
      const forward = parts[0] > parts[1];
      facts.push(forward
        ? `${parts[0]} shares for every ${parts[1]} held`
        : `1 share for every ${parts[1] / parts[0]} held (reverse split)`);
      facts.push(forward
        ? `price divided by about ${(parts[0] / parts[1]).toFixed(2)}`
        : `price multiplied by about ${(parts[1] / parts[0]).toFixed(2)}`);
    }
    return {
      date, kind: "split", symbol, name: r?.name ?? null,
      title: ratio ? `Share split ${ratio}` : "Share split",
      facts, confirmed: true, url: null, source: "Nasdaq split calendar",
      note: "Holding value is unchanged; liquidity and options pricing can shift",
      daysAway: daysFrom(date, today),
    };
  }).filter(Boolean);
}

function fromIpos(rows, today) {
  return (rows ?? []).map((r) => {
    const date = toIso(r?.expectedPriceDate);
    const symbol = String(r?.proposedTickerSymbol ?? "").toUpperCase();
    if (!date || !symbol) return null;
    const shares = num(r?.sharesOffered);
    const price = num(r?.proposedSharePrice);
    const value = num(r?.dollarValueOfSharesOffered);
    const facts = [];
    const exchange = present(r?.proposedExchange);
    if (exchange) facts.push(exchange);
    if (shares) facts.push(`${shares.toLocaleString()} shares offered`);
    if (price !== null) facts.push(`around ${price.toFixed(2)} per share`);
    if (value) facts.push(`raising about ${(value / 1e6).toFixed(1)}M`);
    return {
      date, kind: "ipo", symbol, name: r?.companyName ?? null,
      title: "Expected IPO pricing",
      facts,
      // Pricing dates slip routinely.
      confirmed: false, url: null, source: "Nasdaq IPO calendar",
      note: "No trading history yet, so this cannot be rated",
      daysAway: daysFrom(date, today),
    };
  }).filter(Boolean);
}

function fromRegulatory(rows, today) {
  return (rows ?? []).map((r) => {
    const date = regulatoryDate(r?.context, r?.filedDate ?? null);
    if (!date) return null;
    const { name, symbol } = splitDisplayName(r?.displayName);
    if (!symbol) return null;
    const isPdufa = /PDUFA/i.test(r?.query ?? "") || /PDUFA/i.test(r?.context ?? "");
    const facts = [];
    if (r?.filedDate) facts.push(`disclosed in an 8-K filed ${r.filedDate}`);
    facts.push(isPdufa
      ? "The date by which the FDA must decide on the application"
      : "An expert panel reviews the application and votes; the FDA usually follows");
    return {
      date, kind: "regulatory", symbol, name,
      title: isPdufa ? "FDA decision date (PDUFA)" : "FDA advisory committee meeting",
      facts,
      // The company disclosed it, but the filing may be describing a partner's
      // programme rather than its own, so the sentence and the filing both travel
      // with the row for checking.
      confirmed: true, url: r?.url ?? null, source: "SEC 8-K filing",
      note: "Read the filing — it occasionally describes a partner's programme",
      excerpt: excerptAround(r?.context, isPdufa ? "PDUFA" : "advisory committee"),
      daysAway: daysFrom(date, today),
    };
  }).filter(Boolean);
}

/* ---------------- assembly ---------------- */

/**
 * @param bundle  { dividends, splits, ipos, regulatory } from /api/catalysts
 * @param events  the symbol -> earnings event map from /api/calendar
 */
/* FDA decision dates are set six to twelve months ahead, so clipping them to
   the same window as earnings and ex-dividend dates would hide every one of
   them. Regulatory events therefore keep their own, much longer horizon; the
   window control governs the short-dated kinds. */
export const REGULATORY_HORIZON_DAYS = 365;

export function buildCatalysts(bundle, events, { today = new Date(), days = 45 } = {}) {
  const b = bundle ?? {};
  const items = [
    ...fromEarnings(events, today),
    ...fromDividends(b.dividends, today),
    ...fromSplits(b.splits, today),
    ...fromIpos(b.ipos, today),
    ...fromRegulatory(b.regulatory, today),
  ];

  // Past events are not catalysts; the horizon depends on the kind.
  const upcoming = items.filter((i) => {
    if (i.daysAway === null || i.daysAway < 0) return false;
    const horizon = i.kind === "regulatory" ? Math.max(days, REGULATORY_HORIZON_DAYS) : days;
    return i.daysAway <= horizon;
  });

  // One entry per symbol per kind per date; the feeds overlap on re-runs.
  const seen = new Set();
  const unique = [];
  for (const i of upcoming) {
    const key = `${i.symbol}|${i.kind}|${i.date}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(i);
  }

  unique.sort((a, b2) =>
    a.date.localeCompare(b2.date) ||
    a.kind.localeCompare(b2.kind) ||
    a.symbol.localeCompare(b2.symbol));
  return unique;
}

/** Counts per kind, for the filter chips. */
export function countByKind(items) {
  const out = Object.fromEntries(Object.keys(KINDS).map((k) => [k, 0]));
  for (const i of items ?? []) if (i.kind in out) out[i.kind]++;
  return out;
}
