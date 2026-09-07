/* Parsing SEC Form 4 filings.

   A Form 4 is filed whenever a director, officer or 10% owner's holding
   changes. Most of what it reports is not a decision: grants vest on a
   schedule, shares are withheld to cover tax, options are exercised on expiry.
   The signal is the small subset that is discretionary — an open-market
   purchase or sale the insider chose to make.

   Three fields decide that, and all three come from the filing itself rather
   than from anyone's summary of it. */

/** SEC transaction codes, from the Form 4 instructions. */
export const CODES = {
  P: { label: "Open-market buy",   kind: "buy",       discretionary: true },
  S: { label: "Open-market sale",  kind: "sell",      discretionary: true },
  A: { label: "Grant or award",    kind: "grant",     discretionary: false },
  M: { label: "Option exercise",   kind: "exercise",  discretionary: false },
  F: { label: "Tax withholding",   kind: "tax",       discretionary: false },
  G: { label: "Gift",              kind: "gift",      discretionary: false },
  D: { label: "Sale to issuer",    kind: "issuer",    discretionary: false },
  C: { label: "Conversion",        kind: "convert",   discretionary: false },
  X: { label: "Option exercise",   kind: "exercise",  discretionary: false },
  W: { label: "Inherited",         kind: "inherited", discretionary: false },
};

const num = (v) => {
  if (v === null || v === undefined) return null;
  const n = Number(String(v).replace(/[$,]/g, "").trim());
  return Number.isFinite(n) ? n : null;
};

const text = (root, path) => {
  const el = root?.querySelector(path);
  if (!el) return null;
  const value = el.querySelector("value");
  return ((value ?? el).textContent ?? "").trim() || null;
};

const flagged = (el) => {
  const v = ((el?.querySelector("value") ?? el)?.textContent ?? "").trim().toLowerCase();
  return v === "1" || v === "true";
};

/** One Form 4 document -> its reporting owner and their transactions. */
export function parseForm4(xml, meta = {}) {
  let doc;
  try {
    doc = new DOMParser().parseFromString(String(xml ?? ""), "application/xml");
  } catch {
    return null;
  }
  if (!doc || doc.querySelector("parsererror")) return null;
  const root = doc.querySelector("ownershipDocument");
  if (!root) return null;

  const owner = root.querySelector("reportingOwner");
  const rel = owner?.querySelector("reportingOwnerRelationship");
  const roles = [];
  if (flagged(rel?.querySelector("isDirector"))) roles.push("Director");
  if (flagged(rel?.querySelector("isOfficer"))) roles.push("Officer");
  if (flagged(rel?.querySelector("isTenPercentOwner"))) roles.push("10% owner");
  if (flagged(rel?.querySelector("isOther"))) roles.push("Other");

  /* The filer states on the form whether the trade ran off a Rule 10b5-1 plan
     arranged in advance. Older filings predate the checkbox, in which case a
     footnote is the only clue — read as a hint, never as a denial. */
  const planEl = root.querySelector("aff10b5One");
  const planFlag = planEl ? flagged(planEl) : null;
  const planMentioned = /10b5-1/i.test(String(xml ?? ""));

  const transactions = [];
  for (const [selector, security] of [
    ["nonDerivativeTable > nonDerivativeTransaction", "equity"],
    ["derivativeTable > derivativeTransaction", "derivative"],
  ]) {
    for (const tr of root.querySelectorAll(selector)) {
      const code = (text(tr, "transactionCoding > transactionCode") ?? "").toUpperCase();
      const spec = CODES[code] ?? { label: `Code ${code || "?"}`, kind: "other", discretionary: false };
      const shares = num(text(tr, "transactionAmounts > transactionShares"));
      const price = num(text(tr, "transactionAmounts > transactionPricePerShare"));
      const disposed = (text(tr, "transactionAmounts > transactionAcquiredDisposedCode") ?? "") === "D";
      const heldAfter = num(text(tr, "postTransactionAmounts > sharesOwnedFollowingTransaction"));

      transactions.push({
        security,
        code,
        label: spec.label,
        kind: spec.kind,
        discretionary: spec.discretionary,
        date: text(tr, "transactionDate"),
        shares,
        price,
        disposed,
        heldAfter,
        value: shares !== null && price ? shares * price : null,
        /* Sold shares are added back to reconstruct the holding beforehand,
           which turns a bare share count into a share of the stake. */
        stakePercent: (heldAfter !== null && shares)
          ? (disposed
              ? (shares / (heldAfter + shares)) * 100
              : (shares / Math.max(heldAfter, 1)) * 100)
          : null,
      });
    }
  }

  return {
    owner: text(owner, "reportingOwnerId > rptOwnerName"),
    ownerCik: text(owner, "reportingOwnerId > rptOwnerCik"),
    title: text(rel, "officerTitle"),
    roles,
    issuer: text(root, "issuer > issuerName"),
    symbol: (text(root, "issuer > issuerTradingSymbol") ?? "").toUpperCase() || null,
    planned: planFlag === null ? planMentioned : planFlag,
    planStated: planFlag !== null,
    filingDate: meta.filingDate ?? text(root, "periodOfReport"),
    url: meta.url ?? null,
    indexUrl: meta.indexUrl ?? null,
    transactions,
  };
}

/** Roll a set of filings into the shape the panel and the score expect. */
export function summariseInsiders(filings, coverage = {}) {
  const parsed = (filings ?? [])
    .map((f) => parseForm4(f.xml, f))
    .filter(Boolean);
  if (!parsed.length) return null;

  const trades = [];
  for (const f of parsed) {
    for (const t of f.transactions) {
      trades.push({
        name: f.owner,
        title: f.title,
        roles: f.roles,
        planned: f.planned,
        planStated: f.planStated,
        url: f.indexUrl ?? f.url,
        filingDate: f.filingDate,
        ...t,
      });
    }
  }

  /* A sale under a plan set months earlier carries no view on today's price,
     so only unplanned open-market trades count toward the signal. */
  const signal = trades.filter((t) => t.discretionary && !t.planned);
  const sum = (kind) => signal.filter((t) => t.kind === kind)
    .reduce((a, t) => a + (t.value ?? 0), 0);
  const buys = sum("buy");
  const sells = sum("sell");
  const buyCount = signal.filter((t) => t.kind === "buy").length;
  const sellCount = signal.filter((t) => t.kind === "sell").length;

  const stakeMoves = signal.filter((t) => t.stakePercent !== null);
  const largestStakeMove = stakeMoves.length
    ? stakeMoves.reduce((best, t) =>
        (t.stakePercent > (best?.stakePercent ?? -1) ? t : best), null)
    : null;

  const counts = {};
  for (const t of trades) counts[t.kind] = (counts[t.kind] ?? 0) + 1;

  return {
    source: "sec",
    trades: trades.slice(0, 14),
    filingCount: parsed.length,
    coveredFrom: coverage.coveredFrom ?? null,
    coveredTo: coverage.coveredTo ?? null,
    // True when the cap was reached before the lookback ran out, so the window
    // shown is shorter than intended and absence proves less than usual.
    truncated: !!coverage.truncated,
    sinceDays: coverage.sinceDays ?? null,
    counts,
    buyCount,
    sellCount,
    discretionaryBuys: buys,
    discretionarySells: sells,
    netDiscretionary: buys - sells,
    hasDiscretionary: buyCount + sellCount > 0,
    plannedSells: trades.filter((t) => t.kind === "sell" && t.planned)
      .reduce((a, t) => a + (t.value ?? 0), 0),
    routineShare: trades.length
      ? trades.filter((t) => !t.discretionary || t.planned).length / trades.length : null,
    largestStakeMove: largestStakeMove && {
      name: largestStakeMove.name,
      kind: largestStakeMove.kind,
      percent: largestStakeMove.stakePercent,
      value: largestStakeMove.value,
    },
  };
}
