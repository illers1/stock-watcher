/* Form 4 insider filings, straight from SEC EDGAR.

   The watchlist previously took insider activity from an aggregator, which
   flattened each trade into a label like "Automatic Sell". EDGAR carries the
   real filing, and with it three things the label cannot express:

     - the SEC transaction code (P purchase, S sale, A grant, F tax withheld,
       M option exercise, G gift), rather than a phrase to pattern-match;
     - the `aff10b5One` flag, the filer's own statement of whether the trade
       ran off a pre-arranged Rule 10b5-1 plan — the authoritative answer to a
       question that was previously being inferred;
     - shares held after the transaction, so a sale can be read as a share of
       the insider's stake rather than a bare dollar amount.

   As elsewhere, this only fetches. Parsing lives in static/insider-model.mjs,
   which uses the browser's own XML parser, so there is one implementation
   rather than one per runtime. */

export const SEC_UA = "StockWatcher/1.0 (personal research tool) contact@example.com";
/* A bare count is the wrong bound. Companies file in bursts — Ford's eight
   most recent Form 4s were all lodged on a single day, while Costco's spanned
   five months — so a fixed count can silently reduce the evidence to one
   morning's paperwork. Filings are taken over a fixed lookback instead, with a
   cap to bound the request count, and the window actually covered is reported
   so a thin one is visible rather than being read as an absence of trading. */
export const MAX_FILINGS = 15;
export const LOOKBACK_DAYS = 90;

const ATOM = "https://www.sec.gov/cgi-bin/browse-edgar";

async function get(url, doFetch, timeoutMs = 9000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await doFetch(url, {
      headers: { "User-Agent": SEC_UA, Accept: "*/*" },
      signal: controller.signal,
      redirect: "follow",
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** EDGAR accepts a ticker here and answers with the company's CIK. */
export async function resolveCik(symbol, doFetch = fetch) {
  const url = `${ATOM}?action=getcompany&CIK=${encodeURIComponent(symbol)}` +
              `&type=4&dateb=&owner=include&count=1&output=atom`;
  const res = await get(url, doFetch);
  if (!res?.ok) return null;
  const m = /<cik>(\d+)<\/cik>/i.exec(await res.text());
  return m ? m[1].padStart(10, "0") : null;
}

/* The submissions feed names the rendered document, "xslF345X06/form4.xml";
   the machine-readable original sits beside it without the prefix. */
export const rawDocumentName = (primaryDocument) => {
  const name = String(primaryDocument ?? "");
  return name.includes("/") ? name.slice(name.indexOf("/") + 1) : name;
};

/** Recent Form 4 filings for one symbol, as raw XML for the parser. */
export async function fetchInsiderFilings(symbol, doFetch = fetch, options = {}) {
  const limit = options.limit ?? MAX_FILINGS;
  const sinceDays = options.sinceDays ?? LOOKBACK_DAYS;
  const today = options.today ?? new Date();
  const cutoff = new Date(today.getTime() - sinceDays * 864e5).toISOString().slice(0, 10);
  const empty = { cik: null, filings: [], coveredFrom: null, coveredTo: null, truncated: false, sinceDays };

  const cik = await resolveCik(symbol, doFetch);
  if (!cik) return empty;

  const subs = await get(`https://data.sec.gov/submissions/CIK${cik}.json`, doFetch, 12000);
  if (!subs?.ok) return { ...empty, cik };

  let recent;
  try {
    recent = (await subs.json())?.filings?.recent;
  } catch {
    return { ...empty, cik };
  }
  if (!recent?.form) return { ...empty, cik };

  const wanted = [];
  let truncated = false;
  for (let i = 0; i < recent.form.length; i++) {
    if (recent.form[i] !== "4") continue;
    const filed = recent.filingDate?.[i] ?? "";
    if (filed && filed < cutoff) break;          // the feed is newest-first
    if (wanted.length >= limit) { truncated = true; break; }
    const accession = String(recent.accessionNumber[i] ?? "");
    const doc = rawDocumentName(recent.primaryDocument?.[i]);
    if (!accession || !doc) continue;
    wanted.push({
      accession,
      filingDate: filed || null,
      url: `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replace(/-/g, "")}/${doc}`,
      indexUrl: `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replace(/-/g, "")}/${accession}-index.htm`,
    });
  }

  // The SEC asks for no more than ten requests a second; a handful at a time
  // stays comfortably inside that.
  const filings = [];
  for (let i = 0; i < wanted.length; i += 4) {
    const batch = await Promise.all(wanted.slice(i, i + 4).map(async (f) => {
      const res = await get(f.url, doFetch, 10000);
      if (!res?.ok) return null;
      const xml = await res.text();
      return xml.includes("<ownershipDocument") ? { ...f, xml } : null;
    }));
    filings.push(...batch.filter(Boolean));
  }

  const dates = filings.map((f) => f.filingDate).filter(Boolean).sort();
  return {
    cik,
    filings,
    coveredFrom: dates[0] ?? null,
    coveredTo: dates[dates.length - 1] ?? null,
    truncated,
    sinceDays,
  };
}
