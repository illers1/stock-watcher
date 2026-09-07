/* A market-wide feed of Form 4 filings.

   Per-symbol insider history is fetched elsewhere; this is the other
   direction — everything being filed right now, across every company, which is
   how insider activity is usually read: you watch the tape and notice the
   purchases.

   EDGAR's "current filings" feed lists Form 4s newest-first across all
   issuers. Each filing appears twice, once under the issuer and once under the
   reporting person, so entries are deduplicated by accession number. The full
   submission text carries the ownership XML inline, so one request per filing
   yields the issuer, the insider and every transaction — no second lookup to
   discover the document's filename. */

export const SEC_UA = "StockWatcher/1.0 (personal research tool) contact@example.com";
export const MAX_FEED = 60;

const CURRENT = "https://www.sec.gov/cgi-bin/browse-edgar";

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

/** Accession number and CIK out of an EDGAR filing-index URL. */
export function parseFilingHref(href) {
  /* The path carries the accession twice: once undashed as the directory, then
     dashed in the filename — .../data/2006392/000149315226041638/0001493152-26-041638-index.htm
     Expecting it straight after the CIK matched nothing at all. */
  const m = /\/Archives\/edgar\/data\/(\d+)\/(?:\d+\/)?(\d{10}-?\d{2}-?\d{6})-index/
    .exec(String(href ?? ""));
  if (!m) return null;
  const accession = m[2].includes("-") ? m[2]
    : `${m[2].slice(0, 10)}-${m[2].slice(10, 12)}-${m[2].slice(12)}`;
  return { cik: m[1], accession };
}

/** The ownership XML embedded in a full submission text file. */
export function extractOwnershipXml(text) {
  const body = String(text ?? "");
  const start = body.indexOf("<ownershipDocument");
  const end = body.indexOf("</ownershipDocument>");
  if (start === -1 || end === -1) return null;
  return body.slice(start, end + "</ownershipDocument>".length);
}

/** Recent Form 4 filings across the whole market, as raw ownership XML. */
export async function fetchInsiderFeed(limit = 30, doFeed = fetch, today = new Date()) {
  const capped = Math.max(1, Math.min(MAX_FEED, limit));
  // Each filing is listed twice, so ask for more entries than filings wanted.
  const url = `${CURRENT}?action=getcurrent&type=4&company=&dateb=&owner=include` +
              `&count=${Math.min(100, capped * 2 + 20)}&output=atom`;
  const res = await get(url, doFeed, 12000);
  if (!res?.ok) return { filings: [], asOf: null };

  const feed = await res.text();
  const entries = feed.split("<entry>").slice(1);
  const seen = new Set();
  const wanted = [];
  for (const entry of entries) {
    const href = /href="([^"]+)"/.exec(entry)?.[1];
    const parsed = href ? parseFilingHref(href) : null;
    if (!parsed || seen.has(parsed.accession)) continue;
    seen.add(parsed.accession);
    wanted.push({
      ...parsed,
      updated: /<updated>([^<]+)<\/updated>/.exec(entry)?.[1] ?? null,
      indexUrl: href,
      url: `https://www.sec.gov/Archives/edgar/data/${Number(parsed.cik)}/${parsed.accession}.txt`,
    });
    if (wanted.length >= capped) break;
  }

  // Five at a time keeps well inside the SEC's ten-per-second guidance.
  const filings = [];
  for (let i = 0; i < wanted.length; i += 5) {
    const batch = await Promise.all(wanted.slice(i, i + 5).map(async (f) => {
      const doc = await get(f.url, doFeed, 10000);
      if (!doc?.ok) return null;
      const xml = extractOwnershipXml(await doc.text());
      return xml ? { ...f, xml, filingDate: (f.updated ?? "").slice(0, 10) || null } : null;
    }));
    filings.push(...batch.filter(Boolean));
  }
  return { filings, asOf: today.toISOString() };
}
