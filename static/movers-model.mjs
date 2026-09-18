/* Assembling an explanation for a move — over a session, a week or a month.

   Nothing here observes cause, and the wording never claims to. What it
   assembles is what else was happening at the time, ranked by how well each
   piece of evidence usually accounts for a large move, and then says which
   reading is most likely and why:

     results   a company that reported just before the move is nearly always
               the reason, and the surprise against consensus says how much
     catalyst  a headline naming a specific event — a takeover, a trial result,
               a guidance change, a share sale — dated close to the move
     path      for a week or a month, which sessions the move actually happened
               on; one violent day points at an event, a steady drift does not
     coverage  headlines that only report the move, which describe it more
               often than they explain it
     sector    if the whole sector moved, the company may have done nothing at
               all — the single most common false story about a mover

   Where none of that turns anything up it says so, rather than reaching for
   whatever headline happens to be nearest. */

const MONTHS = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];

/* How far a sector has to move before it, rather than the company, is the
   likelier story. Longer windows drift further on nothing. */
export const PERIODS = {
  day:   { label: "Day",   noun: "session", adj: "daily",   span: "the session",    sectorBar: 1.5 },
  week:  { label: "Week",  noun: "week",    adj: "weekly",  span: "the past week",  sectorBar: 3 },
  month: { label: "Month", noun: "month",   adj: "monthly", span: "the past month", sectorBar: 5 },
};
export const periodKey = (p) => (PERIODS[p] ? p : "day");

const num = (v) => {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const t = String(v).replace(/[$,%\s]/g, "");
  if (!t || t.toUpperCase() === "N/A") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

/** "9/3/2026", "09/03/2026" or "Sep 3, 2026" to an ISO date. */
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
  return Math.round((new Date(a + "T00:00:00Z") - new Date(b + "T00:00:00Z")) / 864e5);
};

export function addDays(iso, n) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** "Tue 9 Sep" — these are calendar days, so read in UTC rather than local. */
export function shortDate(iso) {
  if (!iso) return "";
  return new Date(iso + "T00:00:00Z").toLocaleDateString("en-GB",
    { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
}

const signed = (v, dp = 1) => (v >= 0 ? "+" : "−") + Math.abs(v).toFixed(dp) + "%";

/** The sessions a period's move covers, inclusive. */
export function periodWindow(period, sessionDate) {
  if (!sessionDate) return { start: null, end: null };
  const p = periodKey(period);
  if (p === "day") return { start: sessionDate, end: sessionDate };
  if (p === "week") return { start: addDays(sessionDate, -6), end: sessionDate };
  const d = new Date(sessionDate + "T00:00:00Z");
  d.setUTCMonth(d.getUTCMonth() - 1);
  return { start: addDays(d.toISOString().slice(0, 10), 1), end: sessionDate };
}

/* ---------------- price path ---------------- */

/** Daily closes, oldest first. */
export function parseHistory(history) {
  const rows = history?.data?.tradesTable?.rows ?? [];
  return rows.map((r) => ({ date: toIsoDate(r.date), close: num(r.close) }))
    .filter((r) => r.date && r.close !== null && r.close > 0)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** Each session's % change, dated by the session it happened in. */
export function sessionMoves(points) {
  const out = [];
  for (let i = 1; i < points.length; i++) {
    out.push({ date: points[i].date, pct: (points[i].close / points[i - 1].close - 1) * 100 });
  }
  return out;
}

/**
 * Where within a week or month the move happened. Shares are measured in log
 * terms so that a +50% day and a −20% day add up the way prices do.
 */
export function pricePath(history, window, move) {
  if (move === null || Math.abs(move) < 1 || !window.start) return null;
  const moves = sessionMoves(parseHistory(history))
    .filter((m) => m.date >= window.start && m.date <= window.end);
  if (moves.length < 2) return null;
  const total = Math.log(1 + move / 100);
  if (!Number.isFinite(total) || total === 0) return null;
  /* The daily closes have to add up to the move before they can locate it: a
     recent listing, or a gap in the feed, leaves them covering only part of
     it, and the largest session on file would then be the wrong day. */
  const covered = moves.reduce((sum, m) => sum + Math.log(1 + m.pct / 100), 0) / total;
  if (covered < 0.6) return null;
  const ranked = moves.map((m) => ({ ...m, share: Math.log(1 + m.pct / 100) / total }))
    .sort((a, b) => b.share - a.share);
  const [top, second] = ranked;
  if (top.share >= 0.5) return { shape: "one-day", keyDates: [top.date], top, sessions: moves.length };
  if (second && top.share + second.share >= 0.65) {
    return { shape: "two-day", keyDates: [top.date, second.date], top, second, sessions: moves.length };
  }
  return { shape: "drift", keyDates: [], top, sessions: moves.length };
}

/* ---------------- headlines ---------------- */

/* Specific events, most decisive first. `why` is what a reader needs in order
   to judge whether the event could plausibly account for a move this size. */
export const CATALYSTS = [
  { key: "deal", label: "Takeover or merger news", short: "Deal news", base: 90,
    re: /\b(to acquire|acquir(e|es|ed|ing)|acquisition|buyout|take[- ]private|takeover|merger|merge with|(deal|agrees?) to buy|to buy .{2,40} (in|for) \$|\$[\d.]+ ?(mln|bln|million|billion) deal|to be bought|tender offer|definitive agreement|strategic alternatives)\b/i,
    why: "Takeover news reprices a target towards the offer price almost at once; a buyer can move either way, depending on what it is paying." },
  { key: "regulatory", label: "Regulatory or trial result", short: "FDA / trial news", base: 85,
    re: /\b(FDA|EMA|approv(al|es|ed)|clearance|cleared|phase ?(1|2|3|i{1,3})|clinical trial|trial (data|results)|topline|complete response letter|CRL|clinical hold|PDUFA|breakthrough therapy)\b/i,
    up: /\b(approv|clear|positive|met (its |the )?primary|breakthrough)/i,
    down: /\b(reject|complete response|CRL|clinical hold|fail|did not meet|missed (its |the )?primary|halt)/i,
    why: "For a drug or device developer, a single approval or trial readout can decide most of what the company is worth." },
  { key: "distress", label: "Bankruptcy or delisting risk", short: "Distress", base: 80,
    re: /\b(bankruptcy|chapter 11|delist(ing|ed)?|going concern|default(s|ed)? on|restructuring support)\b/i, dir: "down",
    why: "When bankruptcy or delisting is on the table, shareholders are last in line and the equity can lose most of its value." },
  { key: "offering", label: "Share sale or new financing", short: "Share offering", base: 75,
    re: /\b(public offering|registered direct|private placement|pric(es|ed|ing) (an? |its )?(upsized )?offering|at-the-market|convertible (senior )?notes|dilution|dilutive)\b/i, dir: "down",
    why: "New shares dilute existing holders, and offerings are usually priced below the last close, which drags the price towards the offer." },
  { key: "guidance", label: "Guidance change", short: "Guidance change", base: 70,
    re: /\b(guidance|outlook|full[- ]year forecast|raises (its )?forecast|cuts (its )?forecast|reaffirms|preliminary (results|revenue))\b/i,
    up: /\b(raise|lift|boost|above|increase|reaffirm)/i, down: /\b(cut|lower|below|withdraw|slash|reduce|warn)/i,
    why: "Guidance resets what the next few quarters are expected to earn, which often matters more to the price than the quarter just reported." },
  { key: "legal", label: "Legal or regulatory trouble", short: "Legal trouble", base: 65,
    re: /\b(lawsuit|sued|indict|investigation|probe|subpoena|SEC charges|fraud|short[- ]seller|short report|recall|antitrust)\b/i, dir: "down",
    why: "An investigation, a short-seller report or a recall puts a cost of unknown size on the company, and markets price that uncertainty quickly." },
  { key: "index", label: "Index inclusion", short: "Index change", base: 60,
    /* The index's name alone is not enough: every ETF is named after one and
       every market wrap quotes one. It takes the joining or the leaving. */
    re: /\b((added to|joins|joining|will join|to join|inclusion in|inclusion into|removed from|dropped from|deleted from)\s+(the\s+)?(S&P 500|S&P MidCap 400|S&P SmallCap 600|Russell (1000|2000|3000)|Nasdaq-100|[A-Z][\w&.\- ]{2,24}index)|index (inclusion|addition|rebalanc))/i, dir: "up",
    why: "Index funds have to buy a stock when it joins an index, which lifts demand in the days around the change." },
  { key: "analyst", label: "Analyst rating change", short: "Analyst call", base: 55,
    re: /\b(upgrade[sd]?|downgrade[sd]?|price target|initiat(es|ed|ing) coverage|outperform|underperform|overweight|underweight)\b/i,
    up: /\b(upgrade|raises? .{0,30}target|outperform|overweight)/i,
    down: /\b(downgrade|cuts? .{0,30}target|lowers? .{0,30}target|underperform|underweight)/i,
    why: "Rating changes move smaller, less-covered companies most; on their own they rarely account for a very large move." },
  { key: "contract", label: "Contract or partnership", short: "Contract / partnership", base: 50,
    re: /\b(contract|awarded|partnership|partners with|collaboration|strategic agreement|supply (deal|agreement)|licens(e|ing) (deal|agreement)|purchase order)\b/i,
    why: "A contract matters in proportion to the company's size — transformative for a small firm, noise for a large one." },
  { key: "leadership", label: "Leadership change", short: "Leadership change", base: 45,
    re: /\b(CEO|chief executive|CFO|chief financial officer|steps down|resign(s|ed|ation)|appoints|names new)\b/i,
    why: "A sudden departure, especially of a CEO or CFO, is often read as a warning; a well-regarded hire can do the opposite." },
  { key: "capital", label: "Buyback or dividend", short: "Buyback / dividend", base: 40,
    re: /\b(buyback|share repurchase|repurchase program|special dividend|dividend (hike|increase|raise)|raises (its )?dividend)\b/i, dir: "up",
    why: "Buybacks and higher dividends return cash and signal that management thinks the shares are cheap." },
  { key: "results", label: "Results coverage", short: "Results coverage", base: 35,
    re: /\b(earnings|quarterly results|(Q[1-4]|first[- ]quarter|second[- ]quarter|third[- ]quarter|fourth[- ]quarter) (results|revenue|earnings|EPS|profit|loss))\b/i,
    up: /\b(beat|beats|tops|top estimates|above|surpass)/i, down: /\b(miss|misses|below|falls short)/i,
    why: "Coverage of the company's results, which are the most common reason for a large move." },
];

/* Law-firm solicitations follow a fall; they never cause one. */
const NOISE_RE = /\b(class action|investors who (lost|purchased)|shareholder alert|investor alert|deadline (alert|reminder)|lead plaintiff|rosen law|pomerantz|bronstein|levi & korsinsky|faruqi|glancy|bragar|kessler topaz|securities fraud lawsuit)\b/i;
/* Listicles and market wraps mention hundreds of tickers in passing. */
const ROUNDUP_RE = /\b(\d+ (best|top|cheap|dividend|growth|ai|stocks)|stocks to (buy|watch|sell)|should you buy|is it time to|better buy|pre-?market movers|midday movers|market (today|wrap|update|close)|stock market news|top (gainers|losers|movers)|stocks? in focus|(stocks|shares|markets|futures) (rally|tumble|slip|climb|edge|push|slide|mixed|higher|lower)|closing bell|what to watch|things to know)\b/i;
/* Headlines that report the move itself. The reason may be in the body. */
const MOVE_RE = /\b(why .{0,60}(stock|shares)|(stock|shares) (is |are )?(soar|jump|surg|rall|plung|tumbl|sink|slid|drop|fall|climb|skyrocket|crash|pop|spike|rocket|dive)\w*|(soar|jump|surg|plung|tumbl|sink|skyrocket|crash|spike|rocket)(s|ed|ing)\b)/i;

/**
 * What kind of news an article is. The title is read first; the description is
 * consulted only when the title merely reports the move or names nothing.
 */
export function classifyHeadline(article, move = null) {
  const title = String(article?.title ?? "");
  const description = String(article?.description ?? "");
  if (NOISE_RE.test(title) || NOISE_RE.test(description.slice(0, 200))) return { key: "noise", base: 0 };
  if (ROUNDUP_RE.test(title)) return { key: "roundup", base: 0 };
  const describesMove = MOVE_RE.test(title);

  /* A headline naming two things leads with the one that matters: "Swings To
     Q2 Profit ... ; Advances Phase 3 Plans" is a results story, not a trial
     one. So the earliest match wins, and only a tie is settled by weight. */
  const match = (text) => CATALYSTS
    .map((c) => ({ c, at: c.re.exec(text)?.index ?? -1 }))
    .filter((m) => m.at !== -1)
    .sort((a, b) => a.at - b.at || b.c.base - a.c.base)[0]?.c ?? undefined;
  let cat = match(title);
  let fromBody = false;
  /* The body is only consulted for a headline that reports the move without
     saying why. Reading every description would tag a market wrap that happens
     to mention the S&P 500 as an index change. */
  if (!cat && describesMove && description) { cat = match(description); fromBody = !!cat; }
  if (!cat) {
    return describesMove
      ? { key: "move", label: "Reports the move", base: 22 }
      : { key: "general", label: "Company news", base: 10 };
  }

  const text = title + " " + description;
  const direction = cat.dir ?? (cat.down?.test(text) ? "down" : cat.up?.test(text) ? "up" : null);
  let base = fromBody ? Math.round(cat.base * 0.85) : cat.base;
  const mismatch = !!direction && move !== null && Math.abs(move) >= 2 &&
    ((direction === "up" && move < 0) || (direction === "down" && move > 0));
  if (mismatch) base = Math.round(base * 0.5);
  return { key: cat.key, label: cat.label, short: cat.short, why: cat.why, base, direction, mismatch };
}

/* Abbreviations that end in a full stop without ending the sentence — company
   suffixes above all, which is where most of these descriptions would break. */
const ABBREV_RE = /(?:^|\s)(?:[A-Z]|Inc|Corp|Co|Ltd|LLC|LP|plc|Jr|Sr|Dr|Mr|Mrs|Ms|St|No|vs|etc|approx|U\.S|U\.K)\.$/;

/**
 * Whether a headline is about this company rather than merely tagged with it.
 * The feed often files a piece under several companies and names no lead, and
 * then the title is what says whose story it is: "Why Is Techne (TECH) Down
 * Since Last Earnings Report?" is not news about Moderna.
 */
export function isSubject(article, symbol, companyName) {
  if (article?.primary === true) return true;          // filed under this company
  if ((article?.names?.length ?? 0) <= 1) return true;  // filed under nobody else
  const title = String(article?.title ?? "");
  const sym = String(symbol ?? "").toUpperCase();
  // Short symbols are matched exactly, so "T" does not match a stray capital.
  if (sym && new RegExp(`\\b${sym.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(title)) return true;
  const word = String(companyName ?? "").trim().split(/[\s,]+/)[0] ?? "";
  return word.length >= 4 && new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i").test(title);
}

/** The first whole sentence of a description, for quoting. */
export function excerpt(text, max = 220) {
  const t = String(text ?? "").replace(/\s+/g, " ").replace(/^\([^)]{2,40}\)\s*-\s*/, "").trim();
  if (!t) return null;
  let sentence = t;
  const ends = /[.!?](\s|$)/g;
  let m;
  while ((m = ends.exec(t))) {
    const head = t.slice(0, m.index + 1);
    // Too short to be a sentence, or the stop belongs to "Inc." or "U.S.".
    if (head.length < 25 || ABBREV_RE.test(head)) continue;
    sentence = head;
    break;
  }
  return sentence.length > max ? sentence.slice(0, max - 1).replace(/\s+\S*$/, "") + "…" : sentence;
}

/* ---------------- the explanation ---------------- */

/**
 * @param mover        a row from /api/movers
 * @param why          the payload from /api/mover-why
 * @param sectors      sector medians from /api/movers
 * @param sessionDate  ISO date of the last session the move includes
 * @param opts.period  "day" | "week" | "month"
 * @param opts.market  the median move of every ranked stock over the period
 */
export function explainMove(mover, why, sectors, sessionDate, opts = {}) {
  const period = periodKey(opts.period);
  const P = PERIODS[period];
  const window = periodWindow(period, sessionDate);
  const move = mover?.changePercent ?? null;
  const evidence = [];
  const candidates = [];

  /* Where in the period it happened. A single session is the whole move for a
     daily mover; over a week or a month it says which headlines can matter. */
  const path = period === "day" ? null : pricePath(why?.history, window, move);
  const keyDates = period === "day" ? (sessionDate ? [sessionDate] : []) : (path?.keyDates ?? []);
  const distance = (iso) => {
    if (!iso) return null;
    if (keyDates.length) return Math.min(...keyDates.map((k) => Math.abs(daysApart(k, iso))));
    if (!window.start) return null;
    return iso < window.start ? daysApart(window.start, iso)
         : iso > window.end ? daysApart(iso, window.end) : 0;
  };

  if (path) {
    const share = Math.min(100, Math.round(path.top.share * 100));
    if (path.shape === "one-day") {
      evidence.push({
        kind: "path", strength: "moderate",
        headline: `${path.top.share > 1.05 ? "More than the whole move" : "Most of the move"} came on ` +
          `${shortDate(path.top.date)} (${signed(path.top.pct)})`,
        detail: path.top.share > 1.05
          ? `That one session did all of it and the rest of the ${P.noun} gave some back. Whatever happened is most likely dated that day.`
          : `That session alone accounts for about ${share}% of the ${P.noun}'s move, so whatever happened is most likely dated that day.`,
        dates: path.keyDates,
      });
    } else if (path.shape === "two-day") {
      evidence.push({
        kind: "path", strength: "moderate",
        headline: `Two sessions did most of it: ${shortDate(path.top.date)} (${signed(path.top.pct)}) ` +
          `and ${shortDate(path.second.date)} (${signed(path.second.pct)})`,
        detail: "Two distinct jumps usually mean two pieces of news, or one piece of news and the market's second thoughts about it.",
        dates: path.keyDates,
      });
    } else {
      evidence.push({
        kind: "path", strength: "context",
        headline: `Built up gradually over ${path.sessions} sessions`,
        detail: `No single session contributed more than ${Math.max(0, share)}% of it — the largest was ` +
          `${signed(path.top.pct)} on ${shortDate(path.top.date)}. A steady drift usually reflects shifting ` +
          "sentiment or money moving in or out of the sector, rather than one piece of news.",
      });
    }
  }

  /* Results, and how far they landed from consensus. */
  const rows = why?.earnings?.data?.earningsSurpriseTable?.rows ?? [];
  const latest = rows[0];
  const reported = latest ? toIsoDate(latest.dateReported) : null;
  const inWindow = reported && window.start &&
    reported >= addDays(window.start, -4) && reported <= window.end;
  if (inWindow) {
    const actual = num(latest.eps);
    const estimate = num(latest.consensusForecast);
    const surprise = num(latest.percentageSurprise);
    const beat = surprise !== null ? surprise > 0 : (actual !== null && estimate !== null && actual > estimate);
    const gap = daysApart(sessionDate, reported);
    const near = distance(reported);
    const headline = period === "day"
      ? `Reported results ${gap === 0 ? "that session" : gap === 1 ? "the day before" : `${gap} days earlier`}`
      : `Reported results on ${shortDate(reported)}` +
        (keyDates.length && near !== null && near <= 1 ? ", right at the biggest day of the move" : "");
    const detail = [
      actual !== null ? `EPS ${actual.toFixed(2)}` : null,
      estimate !== null ? `against ${estimate.toFixed(2)} expected` : null,
      surprise !== null ? `${surprise > 0 ? "beating" : "missing"} by ${Math.abs(surprise).toFixed(1)}%` : null,
    ].filter(Boolean).join(", ");
    // A beat alongside a fall is worth calling out rather than smoothing over.
    const contradiction = (beat && move !== null && move < -3)
      ? "Beat consensus and fell anyway — the reaction is to something other than the headline number, usually guidance."
      : (!beat && move !== null && move > 3)
        ? "Missed consensus and rose anyway — the market was positioned for worse."
        : null;
    evidence.push({ kind: "results", strength: "strong", headline, detail, contradiction, date: reported });
    // Results dated well away from the day the price moved explain less of it.
    const score = keyDates.length && near !== null && near > 2 ? 60 : 100;
    candidates.push({ kind: "results", score, beat, surprise, detail, contradiction, date: reported });
  }

  /* Headlines, classified and weighed by how close they sit to the move. */
  const symbol = String(mover?.symbol ?? "").toLowerCase();
  const articles = (why?.news?.data?.rows ?? []).map((r) => ({
    title: r.title ?? null,
    publisher: r.publisher ?? null,
    created: r.created ?? null,
    date: toIsoDate(r.created),
    description: r.description ?? null,
    primary: r.primarysymbol ? String(r.primarysymbol).toLowerCase() === symbol : null,
    /* Every company the piece is filed under: the lead symbol and the related
       ones, which arrive as "nvda|stocks". The lead is often blank, so the two
       have to be read together — a story filed only under "mpti|stocks" with no
       lead symbol is about M-tron whatever the feed was asked for. */
    /* A piece led by an ETF is about the fund's flows; the companies it holds
       are listed, not written about. "Invesco S&P 500 Equal Weight ETF
       Experiences Big Inflow" is not news about Moderna. */
    fundLead: (() => {
      const lead = r.primarysymbol ? String(r.primarysymbol).toLowerCase() : null;
      if (!lead || lead === symbol) return false;
      const tags = Array.isArray(r.related_symbols) ? r.related_symbols : [];
      return tags.some((t) => {
        const [sym, type] = String(t).split("|");
        return sym.toLowerCase() === lead && String(type).toLowerCase() === "etf";
      });
    })(),
    names: [
      r.primarysymbol ? String(r.primarysymbol).toLowerCase() : null,
      ...(Array.isArray(r.related_symbols)
        ? r.related_symbols.map((t) => String(t).split("|")[0].toLowerCase())
        : []),
    ].filter(Boolean),
    url: r.url ? (String(r.url).startsWith("http") ? r.url : "https://www.nasdaq.com" + r.url) : null,
  })).filter((a) => a.title);

  const lo = window.start ? addDays(window.start, -3) : null;
  const hi = window.end ? addDays(window.end, 1) : null;
  let setAside = 0;
  const near = [];
  for (const a of articles) {
    if (!a.date || !lo || a.date < lo || a.date > hi) continue;
    /* Filed under companies, none of them this one: not evidence about it.
       Asked about a symbol it does not cover, the feed answers with other
       companies' stories, and they read as if they were about this one. */
    if (a.names.length && !a.names.includes(symbol)) { setAside++; continue; }
    /* Filed under a crowd of companies: a digest of every FDA approval last
       month, or a market wrap. It names this one, but it is not about it.
       Genuine single-company news carries one to three tags; a merger carries
       both sides. */
    if (a.names.length > 5) { setAside++; continue; }
    if (a.fundLead) { setAside++; continue; }
    const c = classifyHeadline(a, move);
    if (c.key === "noise" || c.key === "roundup") { setAside++; continue; }
    const d = distance(a.date);
    let score = c.base + (d === 0 ? 15 : d === 1 ? 10 : d !== null && d <= 3 ? 4 : 0);
    // An article about a dozen companies is weaker evidence about any one, and
    // so is one this company is merely mentioned in rather than the subject of.
    if (a.primary === false || a.names.length > 3) score = Math.round(score * 0.6);
    // Days from the session the price actually moved on; a headline from the
    // other end of the window is background, not the trigger.
    if (d !== null && d >= 4) score = Math.round(score * 0.6);
    const tagged = { ...a, tag: c.label ?? null, kind: c.key, score, excerpt: excerpt(a.description) };
    near.push(tagged);
    /* Only a piece that is about this company can be offered as the reason it
       moved. One that merely lists it stays in the reading list below. */
    if (!isSubject(a, mover?.symbol, mover?.name)) continue;
    candidates.push({ kind: "headline", score, days: d, catalyst: c, article: tagged });
  }
  near.sort((a, b) => b.score - a.score);
  if (near.length) {
    evidence.push({
      kind: "coverage", strength: "moderate",
      headline: `${near.length} headline${near.length === 1 ? "" : "s"} around the ${P.noun}`,
      detail: setAside
        ? `${setAside} more set aside: law-firm notices, market roundups and pieces about other companies, which follow a move rather than explain this one.`
        : null,
      articles: near.slice(0, 5),
    });
  }

  /* Sector context, which is what tells you the company may have done nothing. */
  const sector = mover?.sector ? sectors?.[mover.sector] : null;
  let sectorLed = false;
  if (sector && move !== null) {
    const median = sector.median;
    const excess = move - median;
    sectorLed = Math.abs(median) > P.sectorBar && Math.abs(excess) < Math.abs(median);
    const over = period === "day" ? "" : ` over ${P.span}`;
    const market = num(opts.market);
    evidence.push({
      kind: "sector",
      strength: sectorLed ? "strong" : "context",
      headline: sectorLed
        ? `${mover.sector} moved ${median.toFixed(1)}% as a whole${over}`
        : `${mover.sector} was ${median >= 0 ? "up" : "down"} ${Math.abs(median).toFixed(1)}% overall${over}`,
      detail: (sectorLed
        ? "Most of this move came with the sector rather than from the company."
        : `This stock moved ${excess >= 0 ? "+" : "−"}${Math.abs(excess).toFixed(1)}% beyond its sector, so it is company-specific.`) +
        (market !== null ? ` The typical stock moved ${signed(market)}.` : ""),
      median, excess, peers: sector.count,
    });
  }

  const verdict = decide({ candidates, sectorLed, sector: mover?.sector,
                           sectorMedian: sector?.median, path, period });
  return {
    evidence,
    verdict,
    // Said plainly rather than dressed up with whatever headline is nearest.
    unexplained: verdict.confidence === "unclear",
    articles,
  };
}

/** Pick the likeliest reading, and put it into words a reader can weigh. */
function decide({ candidates, sectorLed, sector, sectorMedian, path, period }) {
  const P = PERIODS[period];
  const best = candidates.slice().sort((a, b) => b.score - a.score)[0] ?? null;
  const sectorNote = sectorLed && sectorMedian !== undefined && sectorMedian !== null
    ? `The ${sector} sector moved ${signed(sectorMedian)} as a whole, so part of this is sector-wide.`
    : null;
  const pathNote = path?.shape === "drift"
    ? "The move built up gradually rather than on one day, which fits a change in sentiment better than a single event."
    : null;

  /* A named event carries an explanation of why that kind of news moves a
     price. A headline that merely reports the move carries none, and is
     offered as reading rather than as a reason. */
  const named = best?.kind === "results" || !!best?.catalyst?.why;
  if (best && named && best.score >= (best.kind === "results" ? 50 : 30)) {
    if (best.kind === "results") {
      const how = best.surprise !== null && best.surprise !== undefined
        ? `${best.beat ? "beat" : "missed"} expectations by ${Math.abs(best.surprise).toFixed(1)}%`
        : best.beat ? "beat expectations" : "missed expectations";
      return {
        confidence: best.score >= 90 ? "likely" : "possible",
        kind: "results",
        short: best.contradiction ? "Results — but read the detail" : `Results: ${how}`,
        title: `Quarterly results that ${how}`,
        text: `Reported on ${shortDate(best.date)}${best.detail ? ` — ${best.detail}` : ""}. ` +
          "A large move straight after results is nearly always the reaction to them: to the numbers, and just " +
          "as often to what management said about the quarters ahead.",
        warning: best.contradiction ?? null,
        note: sectorNote,
      };
    }
    const c = best.catalyst;
    const far = best.days !== null && best.days !== undefined && best.days >= 3;
    const distanceNote = far
      ? `This is dated ${best.days} days from the session the price actually moved on, so it may be background rather than the trigger.`
      : null;
    return {
      confidence: best.score >= 75 && !c.mismatch && !far ? "likely" : "possible",
      kind: c.key,
      short: c.short ?? c.label,
      title: c.label,
      text: c.why,
      warning: c.mismatch
        ? `News like this usually moves a stock ${c.direction}, and this one went the other way — read the article before taking it as the reason.`
        : null,
      source: best.article,
      note: distanceNote ?? sectorNote ?? pathNote,
    };
  }

  if (sectorLed) {
    return {
      confidence: "likely", kind: "sector", short: "Moved with its sector",
      title: `The whole ${sector} sector moved`,
      text: `The typical ${sector} stock moved ${signed(sectorMedian)} over ${P.span}, and this one moved with it. ` +
        "That usually means sector-wide news — interest rates, a commodity price, a large peer's results — " +
        "rather than anything this company did.",
      note: null,
    };
  }

  if (best && best.score >= 20) {
    const reportsMove = best.catalyst?.key === "move";
    return {
      confidence: "possible", kind: "coverage", short: "In the news",
      title: reportsMove ? "Written up as a move, with no event named" : "Covered in the news, but no clear catalyst",
      text: (reportsMove
        ? "The closest headline reports the move itself rather than naming what caused it. Pieces like this " +
          "usually give the reason in the first paragraph, so it is worth opening — but the feed gives nothing " +
          "dated around the move that names an event."
        : "Nothing dated around the move names a specific event — no results, deal, trial result or financing. " +
          "The company was written about, though; the closest headline is below, and the article itself may give a reason."),
      source: best.article,
      note: pathNote,
    };
  }

  const small = "Large moves with no visible cause are common in smaller companies, and are not evidence of anything by themselves.";
  const text = period === "day"
    ? `No results within four days, no headlines around the session, and the sector did not move with it. ${small}`
    : path?.shape === "one-day"
      ? `Most of it happened on ${shortDate(path.top.date)}, but no results, headlines or sector move are dated then. ${small}`
      : `No results, specific headlines or sector move line up with it. ${pathNote ? pathNote + " " : ""}${small}`;
  return { confidence: "unclear", kind: "none", short: "No public cause found",
           title: "No clear reason in the public record", text, note: null };
}

/** A one-line summary for the collapsed row. */
export function summariseCause(explanation) {
  if (!explanation) return "No public cause found";
  if (explanation.verdict) return explanation.verdict.short;
  return explanation.unexplained ? "No public cause found" : "In the news";
}
