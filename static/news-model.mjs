/* Turns the raw rows from /api/news into headline cards.

   Kept apart from earnings-model.mjs because it is a different subject, and
   from analyze.mjs's parseNews because the markets feed carries more than the
   per-symbol one does: a standfirst, a relative timestamp, and the ticker the
   piece is mainly about.

   As everywhere else, every field is optional. A headline with no description
   is a headline, not a broken row. */

const NASDAQ = "https://www.nasdaq.com";

const text = (v) => {
  const s = String(v ?? "").trim();
  return s || null;
};

/* Nasdaq returns article paths relative to the site root. Anything already
   absolute is passed through, and anything else is dropped rather than
   guessed at — a card without a link still reads fine. */
export function articleUrl(url) {
  const s = text(url);
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  return s.startsWith("/") ? NASDAQ + s : null;
}

/* The feed's standfirst often opens with "Key Points" run straight into the
   first sentence, which reads as a typo once it is out of Nasdaq's own layout.
   Strip that lead-in and give the sentence back its space. */
export function standfirst(description, max = 150) {
  let s = text(description);
  if (!s) return null;
  s = s.replace(/^key\s*points/i, "").replace(/\s+/g, " ").trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s;
}

export function parseArticle(row) {
  return {
    title: text(row?.title),
    summary: standfirst(row?.description),
    publisher: text(row?.publisher),
    // `ago` is a ready-made relative time ("14 minutes ago"); `created` is the
    // date. Prefer the relative one, which is what makes a feed feel live.
    when: text(row?.ago) ?? text(row?.created),
    symbol: (text(row?.primarysymbol) ?? "").toUpperCase() || null,
    url: articleUrl(row?.url),
  };
}

/** Parse a payload into cards, dropping anything with no headline. */
export function parseNewsFeed(payload) {
  const rows = Array.isArray(payload?.rows) ? payload.rows : [];
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const article = parseArticle(row);
    // The feed repeats a story when it is filed under several topics.
    const key = (article.title ?? "").toLowerCase();
    if (!article.title || seen.has(key)) continue;
    seen.add(key);
    out.push(article);
  }
  return out;
}
