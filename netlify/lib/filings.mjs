/* A company's recent SEC filings — the deeper source behind a move.

   News coverage of small companies is thin: most of the day's biggest movers
   have nothing written about them in the feed at all. What they do have is a
   legal obligation to disclose. A material agreement, an offering, a trial
   failure that leads to layoffs, a delisting notice — each has to be filed,
   usually within four business days and often before anyone writes about it.

   Filings are also the one source that cannot be mis-attributed. They are
   filed by the company, under its own CIK, so nothing here has to be matched
   against tags the way headlines do.

   As elsewhere, this only fetches and normalises. What a filing means — which
   8-K item is which, what the press release says — is decided in
   static/movers-model.mjs, so the browser, the function and the tests share one
   reading of it. server.py mirrors this for local use. */

import { SEC_UA, resolveCik } from "./insiders.mjs";

const TICKER_MAP = "https://www.sec.gov/files/company_tickers.json";
const DAY_MS = 864e5;

/* Forms worth reading for a move. Ownership reports (3, 4, 5, 144) are left to
   the insiders window, and passive 13Gs to nobody. */
export const MATERIAL_FORMS = new Set([
  "8-K", "6-K", "425",
  "424B1", "424B2", "424B3", "424B4", "424B5", "424B7",
  "S-1", "F-1", "S-3", "F-3", "EFFECT",
  "SC 13D", "SC 13D/A", "SCHEDULE 13D", "SCHEDULE 13D/A",
  "SC TO-T", "SC TO-C", "SC 14D9", "DEFM14A",
  "25", "25-NSE", "10-Q", "10-K", "20-F", "40-F", "NT 10-Q", "NT 10-K",
]);
/* The ones whose meaning is in the document rather than the form's name. */
export const READ_TEXT = new Set(["8-K", "6-K", "425", "SC TO-C", "SC 14D9"]);
export const MAX_TEXTS = 4;
export const TEXT_CHARS = 6000;

async function get(url, doFetch, timeoutMs = 9000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await doFetch(url, {
      headers: { "User-Agent": SEC_UA, Accept: "*/*" },
      signal: controller.signal, redirect: "follow",
    });
  } catch { return null; } finally { clearTimeout(timer); }
}

/* One request maps every listed ticker to its CIK. Kept for a day by a warm
   instance, so a row costs nothing to look up after the first. */
let tickerCache = { at: 0, map: null };
async function cikFor(symbol, doFetch) {
  const sym = String(symbol).toUpperCase();
  if (!tickerCache.map || Date.now() - tickerCache.at > DAY_MS) {
    const res = await get(TICKER_MAP, doFetch, 12000);
    if (res?.ok) {
      try {
        const map = {};
        for (const v of Object.values(await res.json())) {
          map[String(v.ticker).toUpperCase()] = String(v.cik_str).padStart(10, "0");
        }
        tickerCache = { at: Date.now(), map };
      } catch { /* fall through to the per-symbol lookup */ }
    }
  }
  return tickerCache.map?.[sym] ?? (await resolveCik(sym, doFetch));
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’",
                   lsquo: "‘", rdquo: "”", ldquo: "“", ndash: "–", mdash: "—", bull: "•",
                   reg: "®", trade: "™", copy: "©", hellip: "…" };

/** A filing document as plain text, one block per line. */
export function filingText(html, max = TEXT_CHARS) {
  return String(html ?? "")
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, " ")
    // Inline XBRL carries its tagged facts in a hidden header; they are data, not prose.
    .replace(/<ix:header[\s\S]*?<\/ix:header>/gi, " ")
    .replace(/<div[^>]*display:\s*none[^>]*>[\s\S]*?<\/div>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d|table|center)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m)
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n[ \n]*/g, "\n")
    .trim()
    .slice(0, max);
}

/**
 * Material filings since a date, newest first, with the text of the few whose
 * meaning is in the document. For an 8-K that is the attached press release
 * when there is one, since that is where the company says what happened.
 */
export async function fetchFilings(symbol, since, doFetch = fetch) {
  const empty = { symbol, cik: null, filings: [] };
  const cik = await cikFor(symbol, doFetch);
  if (!cik) return empty;

  const subs = await get(`https://data.sec.gov/submissions/CIK${cik}.json`, doFetch, 12000);
  if (!subs?.ok) return { ...empty, cik };
  let recent;
  try { recent = (await subs.json())?.filings?.recent; } catch { return { ...empty, cik }; }
  if (!recent?.form) return { ...empty, cik };

  const filings = [];
  for (let i = 0; i < recent.form.length; i++) {
    const date = recent.filingDate?.[i] ?? "";
    if (since && date && date < since) break;            // newest first
    const form = String(recent.form[i] ?? "");
    if (!MATERIAL_FORMS.has(form)) continue;
    const accession = String(recent.accessionNumber?.[i] ?? "");
    const folder = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replace(/-/g, "")}`;
    filings.push({
      form, date,
      accepted: recent.acceptanceDateTime?.[i] ?? null,
      items: String(recent.items?.[i] ?? "").split(",").map((s) => s.trim()).filter(Boolean),
      description: recent.primaryDocDescription?.[i] || null,
      url: `${folder}/${accession}-index.htm`,
      folder, primary: recent.primaryDocument?.[i] ?? null,
      text: null, exhibit: false,
    });
  }

  // Read the few that need reading, a couple at a time: the SEC asks for no
  // more than ten requests a second.
  const toRead = filings.filter((f) => READ_TEXT.has(f.form)).slice(0, MAX_TEXTS);
  for (let i = 0; i < toRead.length; i += 2) {
    await Promise.all(toRead.slice(i, i + 2).map(async (f) => {
      let doc = f.primary;
      const idx = await get(`${f.folder}/index.json`, doFetch, 8000);
      if (idx?.ok) {
        try {
          const names = ((await idx.json())?.directory?.item ?? []).map((it) => String(it.name));
          const ex = names.find((n) => /(^|[^a-z])(ex|exhibit)[-_ ]?99/i.test(n) && /\.(htm|html|txt)$/i.test(n));
          if (ex) { doc = ex; f.exhibit = true; }
        } catch { /* keep the primary document */ }
      }
      if (!doc) return;
      const res = await get(`${f.folder}/${doc}`, doFetch, 9000);
      if (res?.ok) f.text = filingText(await res.text());
    }));
  }

  return {
    symbol, cik,
    filings: filings.map(({ folder, primary, ...f }) => f),
  };
}
