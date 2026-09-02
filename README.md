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

- `static/` — the whole front end: `index.html`, `styles.css`, `app.js`. No
  build step, no frameworks.
- `netlify/functions/quotes.mjs`, `search.mjs` — the deployed API, as
  serverless functions routed to `/api/quotes` and `/api/search` by their own
  `config.path` exports.
- `netlify/lib/format.mjs` — the quote parsing, kept separate from the
  functions so it stays testable on its own.
- `tests/` — 73 assertions over the parsing and both API handlers, run in a
  browser with no test runner to install. Serve the repository root and open
  `/tests/`:

  ```bash
  python3 -m http.server 8000
  ```

  then visit <http://localhost:8000/tests/>. The handlers are exercised with
  `fetch` stubbed, so the tests need no network and cover the failure paths
  (rate limiting, timeouts, malformed responses) as well as the happy one.
  `tests/` sits outside the publish directory, so it is never deployed.
- `server.py` — the local equivalent: serves `static/` and exposes the same two
  endpoints. It reimplements the parsing in Python so that running locally
  needs no Node; if you change how a field is parsed, change it in both
  `format.mjs` and `server.py`.

A proxy is required either way because browsers block direct cross-origin calls
to the quote service.

Quotes come from CNBC's public feed, which returns the whole watchlist in a
single request no matter how many symbols are on it. On Netlify the responses
are cached at the CDN for 15 seconds, so the upstream sees one call per distinct
watchlist per 15s regardless of how many people have the page open.

Symbol search uses Yahoo's lookup as a best-effort extra. When it is
rate-limited the add box falls back to a built-in list of common symbols, and
any symbol can still be typed in by hand.

Prices may be delayed. This is for information only, not investment advice.
