#!/usr/bin/env python3
"""Stock Watcher - a tiny local server + web UI for a live stock watchlist.

Standard library only. The server exists because browsers block direct calls to
the quote endpoints (CORS), so it proxies and normalises them.

    python3 server.py               # http://localhost:8765
    python3 server.py --port 9000 --no-open

Quotes come from CNBC's public quote service, which returns the whole watchlist
in a single request. Symbol search uses Yahoo's lookup as a best-effort extra;
when it is unavailable the UI falls back to a built-in list of common symbols.
"""

import argparse
import datetime
import json
import os
import re
import socketserver
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from concurrent.futures import ThreadPoolExecutor
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")

QUOTE_URL = "https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol"
SEARCH_URL = "https://query1.finance.yahoo.com/v1/finance/search"
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/125.0 Safari/537.36")

SYMBOL_RE = re.compile(r"^[A-Za-z0-9.\-=^&:$]{1,24}$")
MAX_SYMBOLS = 60

_fetch_lock = threading.Lock()   # one upstream request at a time; be a good citizen
_last_fetch = [0.0]
MIN_GAP = 0.25

_cache = {"at": 0.0, "key": None, "quotes": {}}
_cache_lock = threading.Lock()
CACHE_TTL = 5.0

# Search is throttled harder upstream, so cache aggressively and back off on 429.
_search_cache = {}
_search_cooldown = [0.0]


def http_json(url, params=None, timeout=12):
    if params:
        url = url + ("&" if "?" in url else "?") + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    with _fetch_lock:
        gap = MIN_GAP - (time.time() - _last_fetch[0])
        if gap > 0:
            time.sleep(gap)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                body = resp.read()
        finally:
            _last_fetch[0] = time.time()
    return json.loads(body.decode("utf-8", "replace"))


def to_float(value):
    """Parse CNBC's display strings ('+8.28', '49,839,873', '2.61%') into floats."""
    if value is None:
        return None
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)
    text = str(value).strip().replace(",", "").replace("%", "").replace("+", "")
    text = text.replace("−", "-")  # unicode minus
    if not text or text in ("UNCH", "N/A", "--", "-"):
        return None
    try:
        return float(text)
    except ValueError:
        return None


def to_big(value):
    """Parse abbreviated magnitudes such as '4.745T' or '39.86M'."""
    if value is None:
        return None
    text = str(value).strip().replace(",", "")
    mult = {"K": 1e3, "M": 1e6, "B": 1e9, "T": 1e12}.get(text[-1:].upper())
    if mult:
        base = to_float(text[:-1])
        return base * mult if base is not None else None
    return to_float(text)


def normalise(raw):
    """Turn one CNBC quote record into the shape the front end expects."""
    symbol = str(raw.get("symbol") or "").upper()
    if str(raw.get("code")) != "0":
        return {"symbol": symbol, "error": "Symbol not found"}

    price = to_float(raw.get("last"))
    prev = to_float(raw.get("previous_day_closing"))
    change = to_float(raw.get("change"))
    pct = to_float(raw.get("change_pct"))
    if change is None and price is not None and prev is not None:
        change = price - prev
    if pct is None and change is not None and prev:
        pct = change / prev * 100.0
    # CNBC drops the sign from change_pct on down moves in some feeds.
    if pct is not None and change is not None and change < 0 and pct > 0:
        pct = -pct

    quote = {
        "symbol": symbol,
        "name": raw.get("name") or raw.get("shortName") or symbol,
        "exchange": raw.get("exchange") or "",
        "assetType": raw.get("type") or "",
        "currency": raw.get("currencyCode") or "USD",
        "price": price,
        "previousClose": prev,
        "change": change,
        "changePercent": pct,
        "open": to_float(raw.get("open")),
        "dayHigh": to_float(raw.get("high")),
        "dayLow": to_float(raw.get("low")),
        "yearHigh": to_float(raw.get("yrhiprice")),
        "yearLow": to_float(raw.get("yrloprice")),
        "volume": to_big(raw.get("volume_alt") or raw.get("volume")),
        "marketCap": to_big(raw.get("mktcapView")),
        "peRatio": to_float(raw.get("pe")),
        "dividendYield": to_float(raw.get("dividendyield")),
        "marketStatus": raw.get("curmktstatus") or "",
        "quoteTime": raw.get("last_timedate") or "",
        "extended": None,
    }

    ext = raw.get("ExtendedMktQuote")
    ext_price = to_float(ext.get("last")) if isinstance(ext, dict) else None
    if ext_price is not None:
        ext_change = to_float(ext.get("change"))
        ext_pct = to_float(ext.get("change_pct"))
        # The feed sometimes omits the extended move entirely; derive it from
        # the regular-session close, which is the base it is quoted against.
        if ext_change is None and price is not None:
            ext_change = ext_price - price
        if ext_pct is None and ext_change is not None and price:
            ext_pct = ext_change / price * 100.0
        if ext_pct is not None and ext_change is not None and ext_change < 0 and ext_pct > 0:
            ext_pct = -ext_pct
        quote["extended"] = {
            "type": ext.get("type") or "",
            "price": ext_price,
            "change": ext_change,
            "changePercent": ext_pct,
        }
    return quote


def fetch_quotes(symbols):
    """One upstream request for the whole watchlist."""
    params = {
        "symbols": "|".join(symbols),
        "requestMethod": "itv", "noform": "1", "partnerId": "2",
        "fund": "1", "exthrs": "1", "output": "json", "events": "1",
    }
    data = http_json(QUOTE_URL, params)
    records = ((data or {}).get("FormattedQuoteResult") or {}).get("FormattedQuote") or []
    if isinstance(records, dict):
        records = [records]

    found = {}
    for raw in records:
        if not isinstance(raw, dict):
            continue
        quote = normalise(raw)
        found[quote["symbol"]] = quote
    # A symbol the upstream simply omitted is still a miss, not a silent gap.
    for sym in symbols:
        found.setdefault(sym, {"symbol": sym, "error": "Symbol not found"})
    return found


def quotes_for(symbols):
    """Cached read-through, serving the last good data if upstream is down."""
    key = "|".join(symbols)
    now = time.time()
    with _cache_lock:
        if _cache["key"] == key and now - _cache["at"] < CACHE_TTL:
            return [_cache["quotes"][s] for s in symbols], _cache["at"], None

    error = None
    try:
        fresh = fetch_quotes(symbols)
        with _cache_lock:
            _cache["quotes"].update(fresh)
            _cache["key"] = key
            _cache["at"] = now
    except urllib.error.HTTPError as exc:
        error = "Quote service returned HTTP %s" % exc.code
    except Exception as exc:
        error = "Could not reach the quote service (%s)" % type(exc).__name__

    with _cache_lock:
        cached = _cache["quotes"]
        out = [cached.get(s) or {"symbol": s, "error": error or "No data"} for s in symbols]
        return out, _cache["at"], error


def search(query):
    key = query.lower()
    now = time.time()
    hit = _search_cache.get(key)
    if hit and now - hit[0] < 900:
        return hit[1], None
    if now < _search_cooldown[0]:
        return [], "search-unavailable"

    try:
        data = http_json(SEARCH_URL, {
            "q": query, "quotesCount": 8, "newsCount": 0,
            "listsCount": 0, "enableFuzzyQuery": "false",
        }, timeout=8)
    except urllib.error.HTTPError as exc:
        if exc.code == 429:
            _search_cooldown[0] = now + 300
        return [], "search-unavailable"
    except Exception:
        return [], "search-unavailable"

    allowed = ("EQUITY", "ETF", "INDEX", "MUTUALFUND", "CRYPTOCURRENCY", "CURRENCY", "FUTURE")
    results = []
    for item in (data or {}).get("quotes") or []:
        sym = item.get("symbol")
        if not sym or item.get("quoteType") not in allowed:
            continue
        results.append({
            "symbol": sym.upper(),
            "name": item.get("longname") or item.get("shortname") or sym,
            "exchange": item.get("exchDisp") or item.get("exchange") or "",
        })
    _search_cache[key] = (now, results)
    return results, None



# --------------------------------------------------------------------------
# Deep analysis. These mirror netlify/lib/sources.mjs: the server only fetches
# and bundles, and static/analyze.mjs does all the interpreting, so the two
# runtimes never drift apart on how a number is read.
# --------------------------------------------------------------------------

NASDAQ = "https://api.nasdaq.com/api"
CALENDAR_URL = NASDAQ + "/calendar/earnings"
NEWS_URL = NASDAQ + "/news/topic/articlebysymbol"
MARKETS_TOPIC = "Markets|4006"


def source_urls(symbol):
    enc = urllib.parse.quote(symbol)
    today = datetime.date.today()
    start = today - datetime.timedelta(days=180)
    quote_qs = urllib.parse.urlencode({
        "symbols": symbol, "requestMethod": "itv", "noform": "1", "partnerId": "2",
        "fund": "1", "exthrs": "1", "output": "json", "events": "1",
    })
    history_qs = urllib.parse.urlencode({
        "assetclass": "stocks", "fromdate": start.isoformat(),
        "todate": today.isoformat(), "limit": "130",
    })
    news_qs = urllib.parse.urlencode({
        "q": "%s|stocks" % symbol, "offset": "0", "limit": "8", "fallback": "true",
    })
    return {
        "quote": QUOTE_URL + "?" + quote_qs,
        "summary": "%s/quote/%s/summary?assetclass=stocks" % (NASDAQ, enc),
        "profile": "%s/company/%s/company-profile" % (NASDAQ, enc),
        "target": "%s/analyst/%s/targetprice" % (NASDAQ, enc),
        "ratings": "%s/analyst/%s/ratings" % (NASDAQ, enc),
        "earnings": "%s/company/%s/earnings-surprise" % (NASDAQ, enc),
        "insiders": "%s/company/%s/insider-trades?limit=15&type=ALL"
                    "&sortname=lastDate&sorttype=DESC" % (NASDAQ, enc),
        "short": "%s/quote/%s/short-interest?assetClass=stocks" % (NASDAQ, enc),
        "news": "%s/news/topic/articlebysymbol?%s" % (NASDAQ, news_qs),
        "history": "%s/quote/%s/historical?%s" % (NASDAQ, enc, history_qs),
    }


def raw_json(url, timeout=10):
    """Unthrottled fetch used for the analysis fan-out."""
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8", "replace"))


def fetch_source(item):
    key, url = item
    try:
        return key, raw_json(url)
    except urllib.error.HTTPError as exc:
        return key, {"error": "HTTP %s" % exc.code}
    except Exception as exc:
        return key, {"error": type(exc).__name__}


def fetch_analysis(symbol):
    urls = source_urls(symbol)
    with ThreadPoolExecutor(max_workers=len(urls)) as pool:
        return dict(pool.map(fetch_source, urls.items()))


CALENDAR_FIELDS = ("time", "marketCap", "epsForecast", "noOfEsts",
                   "fiscalQuarterEnding", "lastYearEPS", "lastYearRptDt")
MAX_EARNINGS_ROWS = 2500


def trading_days(days, start=None):
    """The next `days` weekdays, as ISO dates. Mirrors netlify/lib/calendar.mjs."""
    today = start or datetime.date.today()
    out = []
    n = 0
    while len(out) < days:
        d = today + datetime.timedelta(days=n)
        if d.weekday() < 5:
            out.append(d.isoformat())
        n += 1
    return out


def calendar_pages(dates):
    """One request per day, in order. A failed day is an empty day."""
    def one(date_str):
        try:
            data = raw_json("%s?date=%s" % (CALENDAR_URL, date_str), timeout=8)
            return date_str, (data.get("data") or {}).get("rows") or []
        except Exception:
            return date_str, []

    with ThreadPoolExecutor(max_workers=6) as pool:
        return sorted(pool.map(one, dates))


def fetch_earnings(days):
    """The calendar kept day by day, for the Earnings window."""
    dates = trading_days(days)
    seen = set()
    out = []
    total = 0
    truncated = False

    for date_str, rows in calendar_pages(dates):
        kept = []
        for row in rows:
            sym = str(row.get("symbol") or "").upper()
            # The first sighting wins: a confirmed date beats a later provisional one.
            if not sym or sym in seen:
                continue
            if total >= MAX_EARNINGS_ROWS:
                truncated = True
                break
            seen.add(sym)
            entry = {"symbol": sym, "name": row.get("name"), "date": date_str}
            entry.update({k: row.get(k) for k in CALENDAR_FIELDS})
            kept.append(entry)
            total += 1
        out.append({"date": date_str, "count": len(kept), "rows": kept})

    return {
        "days": out, "total": total, "truncated": truncated,
        "from": dates[0] if dates else None, "to": dates[-1] if dates else None,
    }


def fetch_news(limit):
    """Nasdaq's general markets headlines, for the foot of the Earnings page."""
    qs = urllib.parse.urlencode({
        "q": MARKETS_TOPIC, "offset": "0", "limit": str(limit), "fallback": "true",
    })
    try:
        # urllib follows the 301 this endpoint answers with; without it the
        # body comes back empty.
        data = raw_json("%s?%s" % (NEWS_URL, qs), timeout=9)
        return (data.get("data") or {}).get("rows") or [], None
    except urllib.error.HTTPError as exc:
        return [], "HTTP %s" % exc.code
    except Exception as exc:
        return [], type(exc).__name__


def fetch_calendar(days):
    """Walk the earnings calendar forward and index it by symbol."""
    dates = trading_days(days)
    events = {}
    for date_str, rows in calendar_pages(dates):
        for row in rows:
            sym = str(row.get("symbol") or "").upper()
            if not sym or sym in events:
                continue  # keep the soonest date per symbol
            events[sym] = {
                "date": date_str,
                "time": row.get("time"),
                "epsForecast": row.get("epsForecast"),
                "fiscalQuarterEnding": row.get("fiscalQuarterEnding"),
                "name": row.get("name"),
            }
    return {
        "events": events, "daysScanned": len(dates),
        "from": dates[0] if dates else None, "to": dates[-1] if dates else None,
    }


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=STATIC_DIR, **kwargs)

    def log_message(self, fmt, *args):
        if VERBOSE[0]:
            super().log_message(fmt, *args)

    def end_headers(self):
        # A plain static handler sends no cache headers at all, so browsers
        # apply heuristic caching and quietly keep serving the script you just
        # edited. Locally that is never what anyone wants.
        if not self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def send_json(self, payload, status=200):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        params = urllib.parse.parse_qs(parsed.query)

        if parsed.path == "/api/quotes":
            raw = (params.get("symbols") or [""])[0]
            symbols, seen = [], set()
            for part in raw.split(","):
                part = part.strip().upper()
                if part and part not in seen and SYMBOL_RE.match(part):
                    seen.add(part)
                    symbols.append(part)
            symbols = symbols[:MAX_SYMBOLS]
            if not symbols:
                return self.send_json({"quotes": [], "asOf": time.time(), "error": None})
            quotes, as_of, error = quotes_for(symbols)
            return self.send_json({"quotes": quotes, "asOf": as_of, "error": error})

        if parsed.path == "/api/search":
            query = (params.get("q") or [""])[0].strip()
            if not query:
                return self.send_json({"results": [], "error": None})
            results, error = search(query[:40])
            return self.send_json({"results": results, "error": error})

        if parsed.path == "/api/analysis":
            symbol = (params.get("symbol") or [""])[0].strip().upper()
            if not symbol or not SYMBOL_RE.match(symbol):
                return self.send_json({"symbol": symbol, "sources": {},
                                       "error": "A valid symbol is required"})
            sources = fetch_analysis(symbol)
            failed = [k for k, v in sources.items() if isinstance(v, dict) and v.get("error")]
            return self.send_json({"symbol": symbol, "sources": sources,
                                   "asOf": time.time(), "failed": failed, "error": None})

        if parsed.path == "/api/calendar":
            try:
                days = int((params.get("days") or ["30"])[0])
            except ValueError:
                days = 30
            days = max(1, min(60, days))
            result = fetch_calendar(days)
            result.update({"asOf": time.time(), "error": None})
            return self.send_json(result)

        if parsed.path == "/api/news":
            try:
                limit = int((params.get("limit") or ["9"])[0])
            except ValueError:
                limit = 9
            limit = max(1, min(24, limit))
            rows, error = fetch_news(limit)
            return self.send_json({"rows": rows, "asOf": time.time(), "error": error})

        if parsed.path == "/api/earnings":
            try:
                days = int((params.get("days") or ["5"])[0])
            except ValueError:
                days = 5
            days = max(1, min(30, days))
            result = fetch_earnings(days)
            result.update({"asOf": time.time(), "error": None})
            return self.send_json(result)

        if parsed.path == "/":
            self.path = "/index.html"
        return super().do_GET()


VERBOSE = [False]


def main():
    ap = argparse.ArgumentParser(description="Stock Watcher local server")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--no-open", action="store_true", help="don't open a browser")
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args()
    VERBOSE[0] = args.verbose

    socketserver.TCPServer.allow_reuse_address = True
    try:
        httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    except OSError as exc:
        sys.exit("Could not bind %s:%s (%s). Try --port %d."
                 % (args.host, args.port, exc, args.port + 1))

    url = "http://%s:%d/" % (args.host, args.port)
    print("Stock Watcher running at %s   (Ctrl+C to stop)" % url)
    if not args.no_open:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
        httpd.server_close()


if __name__ == "__main__":
    main()
