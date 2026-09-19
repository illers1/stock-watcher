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
- **Ignores routine insider activity.** Insider trades are read from the Form 4
  filings on SEC EDGAR rather than from a summary of them, which means the SEC
  transaction code itself decides: only **P** (open-market buy) and **S**
  (open-market sale) are discretionary. Grants, option exercises, tax
  withholding and gifts run on fixed schedules. The filing also carries the
  filer's own **Rule 10b5-1** flag, so a sale arranged months in advance is
  shown but excluded — the decision was not taken at today's price. And because
  the filing reports the holding afterwards, a sale is scored as a share of the
  insider's stake, not a bare dollar amount: selling 8% of a position says
  something a $1m figure does not.

  Filings are read over a 90-day lookback rather than a fixed count, because
  companies file in bursts — one issuer's eight most recent Form 4s were all
  lodged on a single morning. Where a company files often enough to hit the cap,
  the panel says so, since a quiet window is not the same as quiet trading.

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

That window is only a round trip because the Blobs store is opened with
`consistency: "strong"`. Blobs defaults to eventual consistency, where a write
lands in one region and takes up to sixty seconds to reach the edge everywhere
else, and opening the store without that option was a real bug: friends' additions
took a minute to appear, and — because every edit is a read-modify-write — an
edit computed from a stale read could be written back over somebody else's,
silently undoing it long after the fact. If you add another shared store, open
it the same way.

The page also says when it is not syncing. A poll that fails twice in a row
raises a banner naming how long ago the list was last confirmed, because the
failure mode this replaced was invisible: the list simply sat there looking
current while nothing reached it.


## Catalysts

A third window, at `catalysts.html`. The watchlist starts from symbols you
chose and the earnings window starts from the calendar; this starts from
events. Everything dated and company-specific is merged into one timeline, so a
month can be read forwards rather than a stock at a time.

| Kind | Source | Confirmed? |
| --- | --- | --- |
| Earnings | Nasdaq earnings calendar | when the calendar carries a session time |
| Regulatory | The company's own 8-K, via SEC full-text search | yes, but read the filing |
| Ex-dividend | Nasdaq dividend calendar | declared by the company |
| Split | Nasdaq split calendar | declared by the company |
| IPO | Nasdaq IPO calendar | no, pricing dates slip routinely |

Filter by kind, narrow to your watchlist, or add a symbol straight from a row.

### Where FDA dates come from

No free feed publishes forthcoming FDA decisions. Rather than guess, this goes
to the companies themselves: SEC full-text search finds recent 8-Ks mentioning
a PDUFA date or an advisory committee meeting, and the sentence around the
mention travels back with the hit so the date can be read out of it. The
primary source is therefore the filer's own disclosure, and every row links to
the filing. That link is worth opening — a filing occasionally describes a
partner's programme rather than the filer's own.

Two things this deliberately gets wrong in the safe direction:

- **Vague wording yields nothing.** "A PDUFA date in late September of this
  year" produces no row at all, because inventing a day would be worse than
  omitting the event.
- **Past dates are rejected.** Pipeline slides list historical approvals beside
  forthcoming ones, and a date earlier than the filing that mentions it is
  dropped.

FDA decisions are set six to twelve months ahead, so they keep their own
one-year horizon; the window control governs the short-dated kinds. Clipping
them to the same window as ex-dividend dates hid every one.


## Insider Trades

A market-wide Form 4 tape at `insiders.html`, alongside the per-stock insider
section in the watchlist panel. The panel answers "what have insiders done at
this company"; this answers the other question — what is being filed right now,
anywhere — which is how insider activity is usually read.

Filter to decisions only, to buys or sells, by minimum value, by ticker, or to
your watchlist. Every row links to the filing, and shows the trade as a share
of the insider's own holding as well as in dollars.

The legend explains each SEC transaction code and why most of them are not
signals: **P** is a purchase with the insider's own money and the rarest filing
on the tape, **S** a sale and a weaker signal in the other direction, while
**A** (grants), **M** (option exercises), **F** (tax withholding) and **G**
(gifts) are scheduled events in which no decision was taken.

Data comes from SEC EDGAR directly. Trackers such as browseSEC read the same
filings; going to the source removes a dependency and keeps every row anchored
to the document it came from.


## Short Screen

`shorts.html` reads the same data the other way: which names look weak on
price, valuation, fundamentals, coverage and insider behaviour. Three lenses —
Balanced, Breaking down, Overpriced — weight those differently.

It is deliberately not the long rating with a minus sign in front, because
shorting is not the mirror image of buying:

- **The loss is unbounded.** A long can fall to zero; a short can lose several
  times the stake. The page says so before it shows a single score.
- **Crowding is a hazard, not evidence.** On the long side a heavily shorted
  stock is potential upside. Here it is the thing that ruins the trade, so
  short interest and days-to-cover are reported *beside* the score rather than
  inside it — a warning averaged into a number stops warning anyone. Absent
  short-interest data reads as "unknown, not absent", never as safe.
- **Being right is not enough.** Borrow costs run while you wait, dividends
  paid while short come out of your pocket, and a lender can recall the stock.

The squeeze thresholds are calibrated against what the numbers normally look
like: most large caps sit near two days to cover and under 3% of shares short.
An early version called 2.5 days "elevated", which flagged every ordinary stock
and so warned about none of them.

### Screening the whole market

A watchlist of mega caps is a poor hunting ground for shorts, so the page also
screens every US-listed stock. The full analysis costs about ten requests a
symbol and cannot be pointed at seven thousand companies, so it runs as a
funnel:

1. One request returns the whole market with sector, size, price and volume.
2. That is filtered on the cheap fields — size, price, sector. Two floors apply
   on every window: **$3 a share** and **$25M of market value**. Below those a
   listing is not really tradeable — a one-cent tick is a percentage move, and
   there is rarely enough company to analyse. Warrant and preference lines are
   excluded too.
3. A bounded slice of what survives is enriched through the batched quote feed,
   seventy symbols per request, and ranked on structural weakness.
4. Only the names worth it get the full analysis, one click each.

The page states how many stocks matched, how many were actually examined, and
in what order the slice was taken. A screen that quietly looks at the first few
hundred rows and calls the result "the market" is worse than one that admits
where it stopped.

The first-pass ranking peaks part-way down rather than at the bottom. Rewarding
whatever has fallen furthest puts a company already down 95% above one 30% off
its high and still sliding, which is backwards — the first has had its move,
and is exactly where borrow is scarcest and squeezes sharpest. Names already
down more than 60% are flagged rather than promoted.

The two stages disagreeing is the point. SBET topped the first pass on
weakness, then the full analysis returned a middling score with high squeeze
risk: 18% of its shares were already short and it was up 38% in a month. The
cheap screen finds weak companies; the full one asks whether shorting them is
survivable.

## Filter explanations

Every window with filters carries a collapsible **What these filters do** panel
beneath the controls, from `static/filter-guide.mjs`. It says what each filter
does, what the individual options mean, and where a choice biases the result
rather than merely narrowing it — the Shorts page's "Examine first" being the
clearest case, since it decides which slice of thousands of matches actually
gets looked at.

A test walks each page's filter form and fails if a control has no entry, so a
filter added later cannot quietly go undocumented.


## Movers

`movers.html` lists the largest moves over the **last completed session, the
past week or the past month**, gainers and losers side by side, and opens each
row to show why the stock moved.

The daily figures come from the same universe feed as everything else. Weekly
and monthly figures come from a market scanner that returns every US listing in
one request, joined onto that universe by symbol, so the $3 price and $25M
market-value floors apply identically whichever period is chosen. A few
listings — units, preference lines, very recent listings — carry no weekly
figure; they are dropped, counted, and the count is stated on the page rather
than quietly narrowing the field.

### Why a stock moved

Each row opens with **one plain reading of what happened**, labelled *most
likely*, *possible* or *no clear reason*, followed by the evidence behind it.
The reading is chosen from:

- **Results** — a company that reported just before the move is nearly always
  the reason, and the surprise against consensus says how much of one.
- **SEC filings** — the deeper source. Most of a day's biggest movers are small
  companies with nothing written about them at all, but they are obliged to
  disclose: a material agreement, an offering, a restructuring, a delisting
  notice, a 13D from an activist. The filing is read by its 8-K item numbers,
  which the SEC fixes and which say what kind of event it is before a word is
  read, and then by the document itself — the attached press release where
  there is one, or the first "On <date>, the Company ..." sentence where there
  is not. Foreign issuers file 6-Ks, which have no item numbers but usually
  head each section with the same title an 8-K item carries, so those are read
  too. Each filing is dated by the session it first reached the market in: one
  accepted after the 4pm close belongs to the next day, and one over a weekend
  to Monday.
- **A catalyst in the headlines** — a takeover, a trial result or approval, a
  guidance change, a share sale, an index inclusion, an analyst call, a legal
  problem. Each kind carries a line saying *why that sort of news moves a
  price*, because "FDA approval" means something quite different for a
  one-drug biotech than a contract win does for a large manufacturer.
- **Where in the period it happened** — for a week or a month, the daily closes
  say whether the move was one violent session or a steady drift. One session
  points at an event that can be dated, and headlines are then weighed against
  *that* day rather than the whole window; a drift usually means sentiment or
  money flowing in and out, which no headline explains.
- **Sector and market** — how the rest of the sector did, and the typical
  stock. A stock down 17% on a day its sector fell 0.3% is a company story; the
  same stock down 8% while the sector fell 6% is not. The bar rises with the
  window, since a sector drifts further over a month than over a day.

Four things it does deliberately.

**It says when it does not know — and what it searched.** Where no results,
filing, catalyst or sector move turn up, the row says so instead of reaching for
the nearest headline, and says whether the SEC was actually checked. On a
typical day that is still well over half the list: the largest moves belong to
small companies, many of which have nothing filed and nothing written about
them. Large moves with no visible cause are common in small companies and are
not evidence of anything on their own.

A few things are read carefully because they mislead otherwise. "Determined
not to proceed with the previously announced offering" is the opposite of an
offering, and a weekly "did not sell any shares under its at-the-market
program" is not one at all. A headline saying a stock jumped cannot explain a
day it fell; it is about some other session. And "Material Definitive
Agreement" is an 8-K item title, not the language of a takeover.

**Nothing appears under a ticker unless it belongs to it.** This is the rule
the window is most careful about, because breaking it is worse than saying
nothing: an M-tron story once appeared under PSIG.

Asked about a symbol it has no coverage for, the news feed answers with other
companies' stories anyway — the same list for every such symbol, which reads as
if it were about the stock you asked about. So a piece has to earn its place.
Filed under companies and not this one, it is dropped. Filed under more than
five, it is a digest rather than a story. Led by an ETF, it is a fund's flows
and not the news of what the fund holds. Filed under several with no lead
named, the title decides whose story it is. What fails those tests is not shown
at all — not as the reason, and not in the reading list either. Law-firm
class-action notices, market wraps, daily insider digests and stock listicles
go the same way, being things that follow a move rather than explain one.

The other feeds are checked too, rather than taken on trust: results and daily
closes are read only when the payload names this company, so a feed that
answers about someone else contributes nothing rather than something wrong.
And because explanations are fetched per row while the list can be reloaded
underneath them, a reply that arrives after the period has been switched is
discarded instead of being folded into rows it was not about.

**It flags the cases that contradict themselves.** Lululemon fell 17% having
beaten consensus by 15%; Guidewire fell 20% having beaten by 12%. Both rows say
"Results — but read the detail" and explain that the reaction is to something
other than the headline number, usually guidance. A tool that reported "beat
expectations" against a 17% fall would be worse than useless. The same check
runs the other way: a share offering usually pushes a price down, so one quoted
against a rise is flagged rather than presented as the reason.

**It distinguishes background from trigger.** A takeover announced five days
before the session the price actually moved on is named, but only as a
possibility, with the gap spelled out.

The session date comes from the data feed rather than the clock. Working back
from today over weekends alone gets every public holiday wrong — the first
version captioned Friday's moves as Monday's, because that Monday was Labor Day.

## Deploying it on Cloudflare

The site also runs on Cloudflare Workers' free plan, from the same code:
`cloudflare/worker.mjs` routes `/api/*` to the functions in `netlify/functions/`
unchanged, and Cloudflare serves `static/` directly. `wrangler.jsonc` is the
whole configuration.

1. Cloudflare dashboard → **Workers & Pages** → **Create application** →
   **Import a repository**, and pick this repository. When Cloudflare asks for
   access to GitHub, choose *Only select repositories*.
2. Keep the project name **stock-watcher** — it must match `wrangler.jsonc` —
   and leave the build settings as they are (deploy command
   `npx wrangler deploy`). **Save and Deploy.**

Every push to `main` deploys from then on. The D1 database behind the shared
group lists is created on the first deploy; nothing is set up by hand.

Three things differ from Netlify, all because of the free plan's limits:

- **CPU.** A request gets 10 ms of CPU; waiting on the network does not
  count, parsing does. Movers and the screen read a 2 MB market-wide list, so
  that list is parsed once and shared across requests for a few minutes, rows
  below the $3 / $25M floors are counted rather than built, and the ranking
  sorts only its two ends. A cold call went from about 12.7 ms to 7 ms on the
  machine this was measured on, against 3 ms for just reading the list; the
  output was checked identical to the previous code across 180 filter
  combinations on real data. **Workers Cache** is on, so a cached answer is
  served without running the Worker at all, and refreshes happen in the
  background (stale-while-revalidate). The movers page retries once if a cold
  request still runs out.
- **Outbound requests.** A request may make 50. The calendar (one page per
  trading day) and the insider feed (one filing per entry) are held to 45.
- **Group lists** are in D1 rather than a key-value store, which would bring
  back the stale-read bug described in `netlify/functions/group.mjs`. Each edit
  is also version-checked, so two people adding at the same instant both keep
  their additions.

## Deploying it on Netlify

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

## Installing it on a phone

The deployed site is also a Progressive Web App, so it installs from the
browser with no App Store, no signing and no download.

**iPhone and iPad** — open the site in Safari (it must be Safari; Chrome on iOS
cannot install), tap the Share button, then **Add to Home Screen**. It appears
as an icon called *Watcher*. Opening it from there gives a full screen with no
address bar and no browser toolbar, its own app switcher card, and its own
launch icon — the same thing an App Store download would give, arriving by a
different route.

**Android** — Chrome offers *Install app* in its menu, or prompts on its own.

**Mac and Windows** — Chrome and Edge show an install button in the address
bar, which gives it a dock or taskbar icon and its own window.

Two things worth knowing on iOS:

- The installed app has its **own storage**, separate from Safari's. A
  watchlist built up in Safari does not follow it onto the home screen, and
  the two drift apart afterwards. Build the list once inside the installed
  app, or use a group link, which lives on the server and so is the same
  everywhere.
- It **keeps working without a connection**: `sw.js` caches the pages, styles
  and scripts, so the app opens and shows the last list it had. Prices are
  never cached — `/api/` always goes to the network — so offline it opens and
  reports that the update failed rather than showing you a stale price as a
  live one.

A redeploy is picked up on the next launch: every request tries the network
first and falls back to the cache only when the network fails.

## The Mac app

The whole thing runs without Netlify. `server.py` mirrors every function the
site uses, so the Mac app is simply the same pages and the same server,
packaged: a native window that starts the server when it opens and stops it
when it quits. No browser, and nothing to install beyond the Python that
macOS already provides.

```
./desktop/mac/build.sh
```

That builds `dist/Stock Watcher.app` and a zip of it for moving to another Mac.
It needs the Command Line Tools (`xcode-select --install`), not Xcode. The app
carries its own copy of the pages, so run the build again after changing
anything.

A few details:

- **It keeps its own watchlist.** The watchlist lives in the page's storage,
  which belongs to one address, so the app's list starts separate from the
  website's. The port is fixed at 8790 for that reason — a new port each launch
  would mean an empty watchlist each launch.
- **Shared group lists** are stored in `~/Library/Application Support/Stock
  Watcher`, since an app must not write inside itself. The server log is at
  `~/Library/Logs/Stock Watcher.log` (Help → Show Server Log).
- **Links out** — articles, SEC filings — open in your normal browser.
- **It cleans up after itself.** A force quit or a crash skips the app's own
  shutdown, so the server also stops by itself once the app is gone, and a
  launch replaces any server an earlier run left behind.
- **On another Mac** the zip is unsigned by a developer account, so the first
  open is right-click → Open, then Open again.

### On a phone

**Stock Watcher → Open on Phone…** lets a phone on the same Wi-Fi use the app
through this Mac. It shows a QR code; scan it, then Add to Home Screen, and it
opens like an app whenever the Mac is awake and on that network. While it is on,
anyone on the network can reach it, so it is off by default, asks first, and
turns off on quit.

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
- `static/manifest.webmanifest`, `static/sw.js`, `static/register-sw.js` — what
  makes it installable: the manifest names and icons the app, the service
  worker serves it network-first with a cached fallback (and never touches
  `/api/`), and the registration script is the one line every page loads.
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

## Universal floors

Every window applies the same two floors and nothing else:

| Floor | Value | Why |
| --- | --- | --- |
| Price | $3 | below it a one-cent tick is a percentage move, and spreads can exceed the day's range |
| Market value | $25M | below it there is rarely enough company to analyse |

There is deliberately **no volume filter** anywhere. A thin day is not a reason
to hide a stock, and screening on volume removes exactly the small names a
screen exists to surface. The trade-off is real and worth knowing: without it,
a large percentage move printed on a few hundred shares will appear in the
movers list alongside a genuine one. Volume is shown on the row so the
difference is visible.
