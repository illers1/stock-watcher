# Stock Watcher

A web app for watching a cumulative list of stocks: live price, dollar change
and percentage change, colour-coded green for up and red for down. Each visitor
keeps their own watchlist in their own browser.

Runs two ways from the same front end — as a public website on Netlify, or
locally from a single Python file.

## Using it

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

## Deploying it as a website

The repository is ready to deploy — there is no build step and no dependencies
to install.

1. Push this folder to a GitHub repository.
2. In Netlify: **Add new site → Import an existing project**, pick the repo, and
   deploy. `netlify.toml` already sets the publish directory and functions
   directory, so leave the build settings untouched.

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
  `app.js` drives the page; `analyze.mjs` turns raw upstream payloads into one
  model; `score.mjs` holds the rating (pure functions, no DOM); `detail.mjs`
  renders the analysis panel.
- `netlify/functions/quotes.mjs`, `search.mjs` — the deployed API, as
  serverless functions routed to `/api/quotes` and `/api/search` by their own
  `config.path` exports.
- `netlify/lib/format.mjs` — the quote parsing, kept separate from the
  functions so it stays testable on its own.
- `tests/` — 121 assertions over the parsing, the API handlers, the analysis
  model and the scoring engine, run in a
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
  endpoints. Only the quote endpoint duplicates parsing logic in Python; the
  analysis endpoints just fetch and bundle, leaving every interpretation to
  `static/analyze.mjs`, which both runtimes share. If you change how a *quote*
  field is parsed, change it in both `format.mjs` and `server.py`.

A proxy is required either way because browsers block direct cross-origin calls
to the quote service.

Quotes come from CNBC's public feed, which returns the whole watchlist in a
single request no matter how many symbols are on it. The analysis draws on
Nasdaq's public API for fundamentals, analyst coverage, earnings, insider
filings, short interest, news and price history. The earnings calendar is
indexed by date upstream, so `/api/calendar` walks the window once and every
symbol resolves from that one map. On Netlify the responses
are cached at the CDN for 15 seconds, so the upstream sees one call per distinct
watchlist per 15s regardless of how many people have the page open.

Symbol search uses Yahoo's lookup as a best-effort extra. When it is
rate-limited the add box falls back to a built-in list of common symbols, and
any symbol can still be typed in by hand.

Prices may be delayed. This is for information only, not investment advice.
