/* Filter explanations, written out rather than hidden in tooltips.

   Every window here filters on something with consequences — a market-cap floor
   is not a preference, it decides whether a position can be opened at all — and
   a one-line hint under a label has room to say what a control is called, not
   what it does or which setting you want. This renders the longer version:
   what each filter does, what the options mean, and where a choice quietly
   biases what you end up looking at. */

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/**
 * @param entries [{ name, what, options?: [[label, meaning]], note? }]
 */
export function renderFilterGuide(entries, { title = "What these filters do" } = {}) {
  return `
    <details class="guide">
      <summary><span>${esc(title)}</span><span class="guide-hint">read once, then ignore</span></summary>
      <dl class="guide-body">
        ${entries.map((e) => `
          <div class="guide-row">
            <dt>${esc(e.name)}</dt>
            <dd>
              <p>${esc(e.what)}</p>
              ${e.options?.length ? `<ul class="guide-options">${e.options.map(([label, meaning]) =>
                `<li><b>${esc(label)}</b> — ${esc(meaning)}</li>`).join("")}</ul>` : ""}
              ${e.note ? `<p class="guide-note">${esc(e.note)}</p>` : ""}
            </dd>
          </div>`).join("")}
      </dl>
    </details>`;
}

/** Mount the guide immediately after a page's filter form. */
export function mountFilterGuide(entries, options = {}) {
  const form = document.getElementById(options.after ?? "filters");
  if (!form) return;
  const holder = document.createElement("div");
  holder.innerHTML = renderFilterGuide(entries, options);
  form.insertAdjacentElement("afterend", holder.firstElementChild);
}

/* ---------------- per-window copy ---------------- */

export const SHORT_FILTERS = [
  {
    name: "Lens",
    what: "How the six weakness factors are weighted. The factors are the same either way; the lens decides which ones move the score.",
    options: [
      ["Balanced", "spreads weight across price, valuation, fundamentals, coverage, insiders and earnings"],
      ["Breaking down", "weights price action and turning sentiment — companies sliding now, whatever they cost"],
      ["Overpriced", "weights valuation and weak fundamentals — expensive companies that have not fallen yet"],
    ],
  },
  {
    name: "Universe",
    what: "What gets screened. The whole market is the useful setting for finding shorts; your watchlist is likelier to be companies you already like.",
    options: [
      ["Whole market", "every US-listed stock, narrowed by the filters below"],
      ["My watchlist", "only what you are already tracking"],
      ["Watchlist + symbols I add", "the above plus specific tickers you type in"],
    ],
  },
  {
    name: "Extra symbols",
    what: "Tickers to screen alongside your watchlist, comma separated. Only appears when the universe is set to include them.",
  },
  {
    name: "Size",
    what: "A market-capitalisation band. This is not a taste — it decides whether a short is workable. Shares must be borrowed to be sold short, and in smaller companies the borrow is scarcer, dearer, and likelier to be recalled early.",
    options: [
      ["Small cap", "$300M to $2B — where weakness is easiest to find and hardest to trade"],
      ["Mid cap", "$2B to $10B"],
      ["Large cap", "$10B to $200B"],
      ["Mega cap", "above $200B — covered by dozens of analysts and rarely mispriced for long"],
    ],
    note: "Sub-$5 prices and thinly traded lines are excluded regardless, along with warrants and preference lines.",
  },
  {
    name: "Sector",
    what: "Restricts the screen to one sector. Worth using, because the measures do not mean the same thing everywhere: a biotech with no product has a meaningless margin, and a bank's debt-to-equity is not comparable to a software company's.",
  },
  {
    name: "Examine first",
    what: "Which slice of the matches gets its fundamentals pulled. Thousands of stocks can match, and only a few hundred are examined, so this decides what you actually see — the one filter here that shapes the answer rather than narrowing it.",
    options: [
      ["Biggest fallers today", "already-moving names; finds breaks in progress, but biases towards momentum"],
      ["Most traded", "the most liquid matches; the least biased starting sample"],
      ["Smallest", "the small end of the band, where borrow is hardest"],
      ["Largest", "the biggest matches, usually the safest to trade and the least mispriced"],
    ],
    note: "The line under the filters always says how many matched and how many were examined.",
  },
  {
    name: "Hide high squeeze risk",
    what: "Drops candidates where a lot of the stock is already sold short. Those are the ones that can rise violently on no news, because closing a crowded short means buying.",
    note: "Squeeze risk is never folded into the score — a warning averaged into a number stops warning anyone.",
  },
];

export const INSIDER_FILTERS = [
  {
    name: "Show",
    what: "Which filings count. Most of a Form 4 tape is not a decision by anyone: shares vest on schedules set years ago, options are exercised near expiry, and stock is surrendered to cover tax automatically.",
    options: [
      ["Decisions only", "open-market buys and sells the insider chose to make, excluding pre-arranged plans"],
      ["Open-market buys", "purchases with the insider's own money — the rarest filing and the strongest signal"],
      ["Open-market sells", "sales; weaker in the other direction, since people sell for reasons unrelated to the company"],
      ["Everything filed", "the raw tape, grants and tax withholding included"],
    ],
  },
  {
    name: "Minimum value",
    what: "Ignores token trades. A director buying $8,000 of stock is a gesture; the same director buying $800,000 is a position.",
    note: "Grants and gifts often carry no price, so they have no value and disappear at any threshold above zero.",
  },
  {
    name: "Ticker",
    what: "Restricts the tape to one company. Leave it blank to watch everything being filed.",
  },
  {
    name: "My watchlist only",
    what: "Shows filings only for companies you already track.",
  },
];

export const CATALYST_FILTERS = [
  {
    name: "Window",
    what: "How far ahead to look. It governs earnings, dividends, splits and listings.",
    note: "FDA decisions ignore it and always show up to a year out, because they are set six to twelve months in advance — clipping them to a month would hide every one.",
  },
  {
    name: "Kind",
    what: "The chips switch each type of event on and off. Each is explained in the panel above, with a count of how many are currently showing.",
  },
  {
    name: "My watchlist only",
    what: "Hides events for companies you do not track. Useful once the list is long, and worth switching off when you are looking for something new.",
  },
];

export const EARNINGS_FILTERS = [
  {
    name: "Window",
    what: "How far ahead the calendar is read. Dates within a week or two are mostly confirmed; further out, more of them are projections from the company's past reporting pattern.",
  },
  {
    name: "Session",
    what: "Whether the company reports before the market opens or after it closes. Almost none report during the session, which is why results arrive as an overnight gap rather than a move you can trade into.",
    options: [
      ["Before the open", "the move lands at the next opening bell"],
      ["After the close", "the move lands the following morning"],
      ["Time not announced", "usually means the date itself is an estimate rather than confirmed"],
    ],
  },
  {
    name: "Minimum size",
    what: "A market-capitalisation floor. Very small companies are often covered by one analyst or none, so the consensus estimate a surprise is measured against is unreliable or missing entirely.",
  },
  {
    name: "Minimum price",
    what: "Excludes low-priced stocks, where a one-cent move is a large percentage move and the spread can be wider than the day's range.",
  },
  {
    name: "Filter",
    what: "Free text matched against ticker and company name.",
  },
];
