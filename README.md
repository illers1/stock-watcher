# Stock Watcher

A web app for watching stocks, in three windows that share one rating engine:

- **Watchlist** — a cumulative list you choose: live price, dollar change and
  percentage change, colour-coded green for up and red for down.
- **Earnings** — everyone reporting inside a window you choose, taken from
  Nasdaq's earnings calendar and put through the same analysis, so a week of
  scheduled reports can be ranked rather than merely listed.
- **Group** — one list several people share through a link, where anyone can
  add or remove a stock and everybody sees it.

The first two keep everything in your own browser. Runs two ways from the same
front end — as a public website on Netlify, or locally from a single Python
file.

## The watchlist window

- **Add** — type a ticker or company name in the box. A suggestion list appears;
  pick one with the mouse or the arrow keys, or type the symbol and press Enter.
  Works for stocks and ETFs (`AAPL`, `VOO`), indices (`.SPX`, `.DJI`, `.VIX`)
  and crypto (`BTC.CM=`, `ETH.CM=`).
- **Remove** — the `×` at the end of each row.
- **Sort** — click any column header; click again to reverse.
- **Refresh** — pick an interval in the header (manual, 15s, 30s, 1m, 5m) or
  press Refresh. A price that moved since the last update flashes green or red.
- **Keyboard** — `/` jumps to the add box, `R` refreshes.

Watchlist, sort order and refresh interval are saved in the browser's local
storage, so they survive a reload. There are no accounts and no server-side
state: one person's list is invisible to everyone else, and clearing browser
data clears the list.

Each row shows the symbol and company name, market value (last traded price)
with the pre/after-hours price beneath it when the market is closed, the dollar
and percentage change on the day, where the price sits within the day's range,
market capitalisation, and volume.


## Analysis and the 0-100 rating

Clicking any row opens a full analysis: sector and industry, a score breakdown,
the next earnings date, analyst targets and rating split, four quarters of
earnings against consensus, insider filings, risk metrics, fundamentals, and
recent headlines.

The rating combines seven factors, each scored 0-100 on its own and then
weighted:

| Factor | What it reads |
| --- | --- |
| Momentum | 1- and 3-month returns, price against its 20- and 50-day averages, position in the 52-week range |
| Catalyst | Earnings falling inside your horizon, gap to the mean analyst target, days-to-cover |
| Sentiment | Share of Buy ratings, how coverage has shifted over three months, breadth, news volume |
| Insider | Net discretionary buying and selling |
| Valuation | P/E, forward P/E, price-to-sales |
| Quality | Return on equity, net and gross margin, debt-to-equity |
| Safety | Annualised volatility, beta, six-month maximum drawdown |

Weights are yours to set. Five presets ship — **1-Month Sprint** (the default,
weighted toward momentum and near-term catalysts), Balanced, Value, Growth and
Quality — and every factor has a slider. Changing a weight re-scores instantly
without refetching anything, and the horizon slider changes which earnings
dates count as "inside the window".

Three things the score deliberately does:

- **Shows its work.** Open any factor to see the individual inputs, their raw
  values, and the points each contributed. Nothing is hidden.
- **Drops what it cannot see.** A factor with no data is removed and the
  remaining weights renormalise, so an ETF with no earnings or insiders is not
  punished for it. The `confidence` figure reports how much of the weighted
  picture actually loaded, and a dashed badge in the table flags a thin one.
- **Ignores routine insider activity.** Only `Buy` and `Sell` are discretionary
  decisions. Share grants, vesting, tax withholding and 10b5-1 plan sales run on
  fixed schedules and are shown for context but excluded from the score.
  Counting a grant as a purchase would make ordinary compensation look like
  conviction.

### What it is not

A one-month horizon is mostly noise. This ranks stocks on stated, visible
factors; it does not predict returns, and no weighting makes a short holding
period more predictable than it is. It is a research tool, not advice.

## The earnings window

`earnings.html`, linked from the tabs in the header. The watchlist starts from
symbols you picked; this starts from the calendar.

- **Window** — today, today and tomorrow, the trading week, a fortnight or a
  month. Weekends are skipped, and a company that appears twice is held at the
  earliest date it is listed for.
- **Filters** — session (before the open, after the close, time not announced),
  minimum market capitalisation ($25M through $50B), minimum share price ($1
  through $20), and a free-text filter over symbol and name. The default cap
  floor of $2B is deliberate: a typical day is dominated by companies too small
  to carry a consensus estimate at all. Dropping to $25M roughly triples the
  list, which is what the price floor is for.

  Size, session and text come off the calendar row, so they apply the instant
  the calendar lands. Price cannot: it comes from the quote feed, which is
  fetched for whatever the other filters leave. A company is therefore held
  back until its price is known to clear the floor — never shown on trust — and
  a line under the filters says how many are hidden and why.
- **Columns** — the day and session, live price and change, market cap, the
  consensus EPS estimate with the number of analysts behind it, and the
  expected move against the same quarter last year. Growth off a prior-year
  loss is shown as blank rather than as an enormous percentage.
- **Rating** — the same 0-100 score, the same seven factors, the same sliders.
  Weights and horizon are shared with the watchlist window through the same
  browser storage, so changing them in one changes both.
- **Ranking** — the analysis panel ranks a company against the others rated in
  the window, which is the comparison the page exists to make.
- **`+`** adds a company to your watchlist without leaving the page.
- **Market news** — a wall of headline cards at the foot of the page, from
  Nasdaq's markets feed. A card whose ticker reports inside the current window
  is flagged, since on this page that is the one worth reading. The wall is
  fetched independently of the calendar and still renders if the schedule feed
  is the part that is down.

Scoring is not free: each company is a full analysis fan-out, so rows are rated
a batch at a time — the first twelve automatically, then more on request. The
count of what is rated so far is in the header stats.

A scheduled report is a known risk, not a known direction. A high rating going
into earnings says the visible factors line up, not that the print will be good.

## The group window

`group.html`. The other two windows are private to your browser; this one is a
list several people edit together.

- **Starting one** — press *Create a group*. You get a ten-character code and a
  link. Send the link; anyone who opens it is in.
- **Using it** — add and remove symbols exactly as on your own watchlist. Each
  row is credited to whoever added it, everyone sees the same live prices, and
  the analysis panel ranks a stock against the rest of the group's list.
- **Staying in sync** — the page polls every twenty seconds and catches up the
  moment you switch back to the tab, so a friend's addition appears without
  anybody reloading. Edits are not serialised, and a reply that arrives out of
  order is discarded by revision number rather than applied.
- **What is yours alone** — the rating weights, the horizon, and the name you
  type in. Only the symbols and their credits are shared.

### What the code protects, and what it does not

The group code is the only credential. It is ten characters from a 30-letter
alphabet with no look-alikes, so it will not be found by guessing, and it is
kept out of the places URLs leak from: it lives in the URL fragment, which
browsers never transmit, and every call to `/api/group` is a POST, so the code
never reaches a query string, an access log or a `Referer` header. The page is
`noindex` in case a link is posted somewhere public.

Past that, be clear-eyed. Anyone holding the link can read and edit the list,
there is no way to remove someone short of starting a new group, and the name
against each row is typed in rather than authenticated — anybody can claim to
be anybody. That is a fair trade for a few friends swapping tickers and the
wrong one for anything that matters.

Two people adding in the same instant can cost one of the two adds: the store
does a read-modify-write with no compare-and-swap. The window is a single round
trip and the fix is to add it again. Nothing is destroyed by it — a lost add is
visible on screen, and a remove cannot go missing this way.

## Deploying it as a website

The repository is ready to deploy — there is no build step and no dependencies
to install.

1. Push this folder to a GitHub repository.
2. In Netlify: **Add new site → Import an existing project**, pick the repo, and
   deploy. `netlify.toml` already sets the publish directory and functions
   directory, so leave the build settings untouched.

There is still no build step. `package.json` exists for one reason: the group
window keeps its lists in [Netlify Blobs](https://docs.netlify.com/blobs/overview/),
whose client has to be installed for the function bundle. Blobs needs no
account, no credentials and no configuration — the platform wires it up. Every
other page runs on plain static files.

That gives a `*.netlify.app` URL that anyone can open, on any device. To use
your own domain, add it under **Domain management**.

If you would rather deploy from the command line, install the Netlify CLI
(`npm i -g netlify-cli`, which needs Node) and run `netlify deploy --prod`.
The GitHub route needs no local tooling at all.

## Running it locally

```bash
python3 server.py
```

Starts on <http://localhost:8765> and opens a browser. Ctrl+C to stop. Needs
Python 3.7+ and nothing else. Options: `--port 9000`, `--no-open`,
`--host 0.0.0.0` to reach it from another device on your network, `--verbose`.

## How it works

- `static/` — the whole front end, no build step and no frameworks.
  `app.js` drives the watchlist, `earnings.js` the earnings window and
  `group.js` the shared one;
  `analyze.mjs` turns raw upstream payloads into one model and
  `earnings-model.mjs` does the same for calendar rows; `score.mjs` holds the
  rating (pure functions, no DOM); `detail.mjs` renders the analysis panel for
  both windows.
- `netlify/functions/quotes.mjs`, `search.mjs`, `analysis.mjs`, `calendar.mjs`,
  `earnings.mjs`, `news.mjs`, `group.mjs` — the deployed API, as serverless functions routed to
  `/api/quotes`, `/api/search` and so on by their own `config.path` exports.
- `netlify/lib/group.mjs` — the rules for a shared list: code generation and
  validation, and `applyOp`, the one place that decides what an edit means.
  `netlify/lib/group-api.mjs` builds the responses around it and takes its
  store as an argument, so the tests drive the whole endpoint against an
  in-memory one; `netlify/functions/group.mjs` is only the Blobs wiring.
- `static/news-model.mjs` — the headline parsing for `/api/news`, kept apart
  from the per-symbol news in `analyze.mjs` because the markets feed carries a
  standfirst and a relative timestamp the other one does not.
- `netlify/lib/calendar.mjs` — the walk over Nasdaq's date-indexed calendar,
  shared by `/api/calendar` (which collapses it to one date per symbol) and
  `/api/earnings` (which keeps the day-by-day listing).
- `netlify/lib/format.mjs` — the quote parsing, kept separate from the
  functions so it stays testable on its own.
- `tests/` — 286 assertions over the parsing, the API handlers, the analysis
  model, the earnings calendar, the news feed, the group endpoint and the
  scoring engine, run in a
  browser with no test runner to install. Serve the repository root and open
  `/tests/`:

  ```bash
  python3 -m http.server 8000
  ```

  then visit <http://localhost:8000/tests/>. The handlers are exercised with
  `fetch` stubbed, so the tests need no network and cover the failure paths
  (rate limiting, timeouts, malformed responses) as well as the happy one.
  `tests/` sits outside the publish directory, so it is never deployed.
- `server.py` — the local equivalent: serves `static/` and exposes the same
  endpoints. Group lists go to `.data/groups.json` rather than Netlify Blobs,
  so the shared window works offline; the rules for an edit are mirrored from
  `netlify/lib/group.mjs`, so change the two together. Only the quote endpoint duplicates parsing logic in Python; the
  analysis endpoints just fetch and bundle, leaving every interpretation to
  `static/analyze.mjs`, which both runtimes share. If you change how a *quote*
  field is parsed, change it in both `format.mjs` and `server.py`.

A proxy is required either way because browsers block direct cross-origin calls
to the quote service.

Quotes come from CNBC's public feed, which returns the whole watchlist in a
single request no matter how many symbols are on it. The analysis draws on
Nasdaq's public API for fundamentals, analyst coverage, earnings, insider
filings, short interest, news and price history. The earnings calendar is
indexed by date upstream, so both calendar endpoints walk the window once: a
day that fails is an empty day rather than a failed window. On Netlify the responses
are cached at the CDN for 15 seconds, so the upstream sees one call per distinct
watchlist per 15s regardless of how many people have the page open.

Symbol search uses Yahoo's lookup as a best-effort extra. When it is
rate-limited the add box falls back to a built-in list of common symbols, and
any symbol can still be typed in by hand.

Prices may be delayed. This is for information only, not investment advice.
