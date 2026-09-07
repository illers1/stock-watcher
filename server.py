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
import secrets
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
DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".data")

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
                # Lets the UI corroborate a date against last year's cadence.
                "lastYearReported": row.get("lastYearRptDt"),
                "estimateCount": row.get("noOfEsts"),
            }
    return {
        "events": events, "daysScanned": len(dates),
        "from": dates[0] if dates else None, "to": dates[-1] if dates else None,
    }


# --------------------------------------------------------------------------
# Shared watchlists. The deployed site keeps these in Netlify Blobs; locally a
# JSON file does the same job. The rules for what an edit means live in
# netlify/lib/group.mjs and are mirrored here — keep the two in step.
# --------------------------------------------------------------------------

CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ"
CODE_LENGTH = 10
GROUP_MAX_SYMBOLS = 60
GROUP_MAX_NAME = 24
GROUPS_PATH = os.path.join(DATA_DIR, "groups.json")

_groups_lock = threading.Lock()


def _read_groups():
    try:
        with open(GROUPS_PATH, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (FileNotFoundError, ValueError):
        return {}


def _write_groups(groups):
    os.makedirs(DATA_DIR, exist_ok=True)
    tmp = GROUPS_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(groups, fh)
    os.replace(tmp, GROUPS_PATH)   # never leave a half-written file behind


def parse_code(raw):
    text = str(raw or "").upper()
    for ch in " -_":
        text = text.replace(ch, "")
    if len(text) != CODE_LENGTH or any(c not in CODE_ALPHABET for c in text):
        return None
    return text


def clean_symbol(raw):
    text = str(raw or "").strip().upper()
    return text if text and SYMBOL_RE.match(text) else None


def clean_name(raw):
    text = " ".join(str(raw or "").split())[:GROUP_MAX_NAME]
    return text or None


def public_view(code, state):
    return {
        "code": code,
        "symbols": [{"symbol": e["symbol"], "addedBy": e.get("addedBy"),
                     "at": e.get("at")} for e in state.get("symbols", [])],
        "revision": state.get("revision", 0),
        "updatedAt": state.get("updatedAt"),
        "error": None,
    }


def group_action(body):
    """One edit, under a lock so concurrent local requests cannot interleave."""
    action = str(body.get("action") or "")
    now = int(time.time() * 1000)

    with _groups_lock:
        groups = _read_groups()

        if action == "create":
            for _ in range(5):
                code = "".join(secrets.choice(CODE_ALPHABET) for _ in range(CODE_LENGTH))
                if code in groups:
                    continue
                groups[code] = {"symbols": [], "revision": 0,
                                "createdAt": now, "updatedAt": now}
                _write_groups(groups)
                return public_view(code, groups[code])
            return {"error": "Could not allocate a group code - try again", "symbols": None}

        code = parse_code(body.get("code"))
        if not code:
            return {"error": "That group code is not valid", "symbols": None}
        state = groups.get(code)
        if state is None:
            return {"error": "No group with that code. Check the link, or make a new group.",
                    "symbols": None}

        if action == "get":
            return public_view(code, state)

        if action in ("add", "remove"):
            symbol = clean_symbol(body.get("symbol"))
            if not symbol:
                return {"error": "That is not a valid symbol", "symbols": None}
            entries = state.get("symbols", [])
            changed = False

            if action == "add":
                if not any(e["symbol"] == symbol for e in entries):
                    if len(entries) >= GROUP_MAX_SYMBOLS:
                        return {"error": "A group holds at most %d symbols" % GROUP_MAX_SYMBOLS,
                                "symbols": None}
                    entries = entries + [{"symbol": symbol,
                                          "addedBy": clean_name(body.get("by")), "at": now}]
                    changed = True
            else:
                kept = [e for e in entries if e["symbol"] != symbol]
                changed = len(kept) != len(entries)
                entries = kept

            if changed:
                state = dict(state, symbols=entries,
                             revision=state.get("revision", 0) + 1, updatedAt=now)
                groups[code] = state
                _write_groups(groups)
            return public_view(code, state)

        return {"error": "Unknown action", "symbols": None}



# --------------------------------------------------------------------------
# Catalysts. Mirrors netlify/lib/catalysts.mjs: fetch and trim only, with
# static/catalysts-model.mjs doing every bit of interpretation.
# --------------------------------------------------------------------------

EDGAR_FTS = "https://efts.sec.gov/LATEST/search-index"
SEC_UA = "StockWatcher/1.0 (personal research tool) contact@example.com"
DIVIDEND_DAYS = 20
MAX_FILINGS = 10
REG_QUERIES = ('"PDUFA date"', '"advisory committee meeting"')


def raw_json_ua(url, ua, timeout=10):
    req = urllib.request.Request(url, headers={"User-Agent": ua, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8", "replace"))


def extract_context(html, term="PDUFA", radius=260):
    """The sentence around the first mention, which is where the date sits."""
    text = re.sub(r"<[^>]+>", " ", html)
    text = re.sub(r"&#?\w+;", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    i = text.upper().find(term.upper())
    if i == -1:
        return text[:radius * 2]
    return text[max(0, i - radius):i + radius]


def fetch_catalysts(days):
    today = datetime.date.today()

    def dividends():
        dates = [d.isoformat() for d in
                 (today + datetime.timedelta(days=n) for n in range(min(days, DIVIDEND_DAYS)))
                 if d.weekday() < 5]

        def one(date_str):
            try:
                data = raw_json_ua("%s/calendar/dividends?date=%s" % (NASDAQ, date_str), UA, 8)
                rows = ((data.get("data") or {}).get("calendar") or {}).get("rows") or []
                return [dict(r, _date=date_str) for r in rows]
            except Exception:
                return []
        out = []
        with ThreadPoolExecutor(max_workers=10) as pool:
            for rows in pool.map(one, dates):
                out.extend(rows)
        return out

    def splits():
        try:
            return (raw_json_ua("%s/calendar/splits" % NASDAQ, UA, 8).get("data") or {}).get("rows") or []
        except Exception:
            return []

    def ipos():
        out = []
        for n in (0, 1):
            month = (today.replace(day=1) + datetime.timedelta(days=32 * n)).strftime("%Y-%m")
            try:
                data = raw_json_ua("%s/ipo/calendar?date=%s" % (NASDAQ, month), UA, 8)
                out.extend(((data.get("data") or {}).get("upcoming") or {})
                           .get("upcomingTable", {}).get("rows") or [])
            except Exception:
                pass
        return out

    def regulatory():
        end = today.isoformat()
        start = (today - datetime.timedelta(days=120)).isoformat()
        hits = []
        for q in REG_QUERIES:
            url = "%s?q=%s&forms=8-K&startdt=%s&enddt=%s" % (
                EDGAR_FTS, urllib.parse.quote(q), start, end)
            try:
                body = raw_json_ua(url, SEC_UA, 12)
                for h in ((body.get("hits") or {}).get("hits") or []):
                    h["_query"] = q
                    hits.append(h)
            except Exception:
                pass
        hits.sort(key=lambda h: (h.get("_source") or {}).get("file_date") or "", reverse=True)

        picked, seen = [], set()
        for h in hits:  # newest first, one filing per company
            ciks = (h.get("_source") or {}).get("ciks") or []
            if not ciks or ciks[0] in seen:
                continue
            seen.add(ciks[0])
            picked.append(h)
            if len(picked) >= MAX_FILINGS:
                break

        def context_for(h):
            src = h.get("_source") or {}
            parts = str(h.get("_id") or "").split(":")
            cik = (src.get("ciks") or [None])[0]
            url = None
            context = ""
            if len(parts) == 2 and cik:
                url = "https://www.sec.gov/Archives/edgar/data/%d/%s/%s" % (
                    int(cik), parts[0].replace("-", ""), parts[1])
                try:
                    req = urllib.request.Request(url, headers={"User-Agent": SEC_UA})
                    with urllib.request.urlopen(req, timeout=12) as resp:
                        html = resp.read().decode("utf-8", "replace")
                    term = "PDUFA" if "PDUFA" in h["_query"] else "advisory committee"
                    context = extract_context(html, term)
                except Exception:
                    context = ""
            return {
                "displayName": (src.get("display_names") or [None])[0],
                "filedDate": src.get("file_date"),
                "query": h["_query"],
                "url": url,
                "context": context,
            }

        with ThreadPoolExecutor(max_workers=5) as pool:
            return list(pool.map(context_for, picked))

    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = {k: pool.submit(f) for k, f in
                   (("dividends", dividends), ("splits", splits),
                    ("ipos", ipos), ("regulatory", regulatory))}
        return {k: fut.result() for k, fut in futures.items()}



# --------------------------------------------------------------------------
# Form 4 insider filings from EDGAR. Mirrors netlify/lib/insiders.mjs: fetch
# the raw XML only, leaving static/insider-model.mjs to parse it.
# --------------------------------------------------------------------------

EDGAR_ATOM = "https://www.sec.gov/cgi-bin/browse-edgar"
INSIDER_MAX_FILINGS = 15
INSIDER_LOOKBACK_DAYS = 90


def resolve_cik(symbol):
    url = ("%s?action=getcompany&CIK=%s&type=4&dateb=&owner=include&count=1&output=atom"
           % (EDGAR_ATOM, urllib.parse.quote(symbol)))
    req = urllib.request.Request(url, headers={"User-Agent": SEC_UA})
    with urllib.request.urlopen(req, timeout=10) as resp:
        body = resp.read().decode("utf-8", "replace")
    found = re.search(r"<cik>(\d+)</cik>", body, re.I)
    return found.group(1).zfill(10) if found else None


def raw_document_name(primary_document):
    """The submissions feed names the rendered doc; the original sits beside it."""
    name = str(primary_document or "")
    return name.split("/", 1)[1] if "/" in name else name


def fetch_insider_filings(symbol):
    cutoff = (datetime.date.today() - datetime.timedelta(days=INSIDER_LOOKBACK_DAYS)).isoformat()
    empty = {"cik": None, "filings": [], "coveredFrom": None, "coveredTo": None,
             "truncated": False, "sinceDays": INSIDER_LOOKBACK_DAYS}
    try:
        cik = resolve_cik(symbol)
    except Exception:
        return empty
    if not cik:
        return empty

    try:
        subs = raw_json_ua("https://data.sec.gov/submissions/CIK%s.json" % cik, SEC_UA, 12)
        recent = (subs.get("filings") or {}).get("recent") or {}
    except Exception:
        return dict(empty, cik=cik)

    wanted = []
    truncated = False
    forms = recent.get("form") or []
    dates = recent.get("filingDate") or [None] * len(forms)
    for i, form in enumerate(forms):
        if form != "4":
            continue
        filed = dates[i] or ""
        if filed and filed < cutoff:
            break  # the feed is newest-first
        if len(wanted) >= INSIDER_MAX_FILINGS:
            truncated = True
            break
        accession = str((recent.get("accessionNumber") or [None] * len(forms))[i] or "")
        doc = raw_document_name((recent.get("primaryDocument") or [None] * len(forms))[i])
        if not accession or not doc:
            continue
        stem = "https://www.sec.gov/Archives/edgar/data/%d/%s" % (int(cik), accession.replace("-", ""))
        wanted.append({
            "accession": accession,
            "filingDate": filed or None,
            "url": "%s/%s" % (stem, doc),
            "indexUrl": "%s/%s-index.htm" % (stem, accession),
        })

    def one(item):
        try:
            req = urllib.request.Request(item["url"], headers={"User-Agent": SEC_UA})
            with urllib.request.urlopen(req, timeout=10) as resp:
                xml = resp.read().decode("utf-8", "replace")
            if "<ownershipDocument" not in xml:
                return None
            return dict(item, xml=xml)
        except Exception:
            return None

    with ThreadPoolExecutor(max_workers=4) as pool:
        filings = [f for f in pool.map(one, wanted) if f]
    got = sorted(f["filingDate"] for f in filings if f.get("filingDate"))
    return {"cik": cik, "filings": filings,
            "coveredFrom": got[0] if got else None,
            "coveredTo": got[-1] if got else None,
            "truncated": truncated, "sinceDays": INSIDER_LOOKBACK_DAYS}



CURRENT_FEED = "https://www.sec.gov/cgi-bin/browse-edgar"
FEED_MAX = 60


def parse_filing_href(href):
    # The accession appears twice in the path: undashed as the directory, then
    # dashed in the filename. Expecting it straight after the CIK matched nothing.
    m = re.search(r"/Archives/edgar/data/(\d+)/(?:\d+/)?(\d{10}-?\d{2}-?\d{6})-index",
                  str(href or ""))
    if not m:
        return None
    acc = m.group(2)
    if "-" not in acc:
        acc = "%s-%s-%s" % (acc[:10], acc[10:12], acc[12:])
    return {"cik": m.group(1), "accession": acc}


def extract_ownership_xml(text):
    body = str(text or "")
    start = body.find("<ownershipDocument")
    end = body.find("</ownershipDocument>")
    if start == -1 or end == -1:
        return None
    return body[start:end + len("</ownershipDocument>")]


def fetch_insider_feed(limit):
    """Recent Form 4s across the market. Each filing is listed twice, under the
    issuer and under the reporting person, so entries are deduplicated."""
    capped = max(1, min(FEED_MAX, limit))
    url = ("%s?action=getcurrent&type=4&company=&dateb=&owner=include&count=%d&output=atom"
           % (CURRENT_FEED, min(100, capped * 2 + 20)))
    try:
        req = urllib.request.Request(url, headers={"User-Agent": SEC_UA})
        with urllib.request.urlopen(req, timeout=12) as resp:
            feed = resp.read().decode("utf-8", "replace")
    except Exception:
        return {"filings": [], "asOf": None}

    seen, wanted = set(), []
    for entry in feed.split("<entry>")[1:]:
        href = re.search(r'href="([^"]+)"', entry)
        parsed = parse_filing_href(href.group(1)) if href else None
        if not parsed or parsed["accession"] in seen:
            continue
        seen.add(parsed["accession"])
        updated = re.search(r"<updated>([^<]+)</updated>", entry)
        wanted.append({
            "cik": parsed["cik"],
            "accession": parsed["accession"],
            "updated": updated.group(1) if updated else None,
            "indexUrl": href.group(1),
            "url": "https://www.sec.gov/Archives/edgar/data/%d/%s.txt" % (
                int(parsed["cik"]), parsed["accession"]),
        })
        if len(wanted) >= capped:
            break

    def one(item):
        try:
            req = urllib.request.Request(item["url"], headers={"User-Agent": SEC_UA})
            with urllib.request.urlopen(req, timeout=10) as resp:
                xml = extract_ownership_xml(resp.read().decode("utf-8", "replace"))
            if not xml:
                return None
            return dict(item, xml=xml, filingDate=(item.get("updated") or "")[:10] or None)
        except Exception:
            return None

    with ThreadPoolExecutor(max_workers=5) as pool:
        filings = [f for f in pool.map(one, wanted) if f]
    return {"filings": filings, "asOf": datetime.datetime.utcnow().isoformat() + "Z"}



# --------------------------------------------------------------------------
# Market-wide screening. Mirrors netlify/lib/screener.mjs: fetch, filter on the
# cheap fields, enrich a bounded slice. Ranking lives in
# static/screen-model.mjs so both runtimes agree on it.
# --------------------------------------------------------------------------

SCREENER_URL = "https://api.nasdaq.com/api/screener/stocks"
SCREEN_BATCH = 70
SCREEN_MAX_ENRICHED = 280

CAP_BANDS = {
    "any": (0, float("inf")),
    "mega": (200e9, float("inf")),
    "large": (10e9, 200e9),
    "mid": (2e9, 10e9),
    "small": (300e6, 2e9),
    "smallmid": (300e6, 10e9),
}


def screen_money(v):
    if v is None:
        return None
    t = re.sub(r"[$,%\s]", "", str(v))
    t = re.sub(r"^\((.*)\)$", r"-\1", t)
    if not t or t.upper() == "N/A":
        return None
    try:
        return float(t)
    except ValueError:
        return None


def fetch_universe():
    data = raw_json("%s?tableonly=true&limit=8000&offset=0&download=true" % SCREENER_URL, timeout=25)
    rows = (data.get("data") or {}).get("rows") or []
    out = []
    for r in rows:
        sym = str(r.get("symbol") or "").upper()
        if not sym:
            continue
        out.append({
            "symbol": sym, "name": r.get("name"),
            "price": screen_money(r.get("lastsale")),
            "changePercent": screen_money(r.get("pctchange")),
            "marketCap": screen_money(r.get("marketCap")),
            "volume": screen_money(r.get("volume")),
            "sector": r.get("sector") or None,
            "industry": r.get("industry") or None,
            "country": r.get("country") or None,
        })
    return out


def run_screen(opts):
    universe = fetch_universe()
    lo, hi = CAP_BANDS.get(opts["cap"], CAP_BANDS["any"])
    sector = opts["sector"].lower() if opts["sector"] and opts["sector"] != "any" else None

    matched = []
    for r in universe:
        cap = r["marketCap"]
        if cap is None or cap < lo or cap > hi:
            continue
        if r["price"] is None or r["price"] < opts["minPrice"]:
            continue
        if r["volume"] is not None and r["volume"] < opts["minVolume"]:
            continue
        if sector and str(r.get("sector") or "").lower() != sector:
            continue
        if re.search(r"[.^]", r["symbol"]):  # warrants, units, preference lines
            continue
        matched.append(r)

    orderings = {
        "decliners": lambda r: r["changePercent"] if r["changePercent"] is not None else 0,
        "smallest": lambda r: r["marketCap"] or 0,
        "largest": lambda r: -(r["marketCap"] or 0),
        "liquid": lambda r: -(r["volume"] or 0),
    }
    labels = {"decliners": "Biggest fallers today", "smallest": "Smallest first",
              "largest": "Largest first", "liquid": "Most traded first"}
    key = orderings.get(opts["order"], orderings["decliners"])
    ordered = sorted(matched, key=key)
    budget = max(SCREEN_BATCH, min(SCREEN_MAX_ENRICHED, opts["limit"]))
    sliced = ordered[:budget]

    quotes = {}
    for i in range(0, len(sliced), SCREEN_BATCH):
        batch = [r["symbol"] for r in sliced[i:i + SCREEN_BATCH]]
        qs = urllib.parse.urlencode({
            "symbols": "|".join(batch), "requestMethod": "itv", "noform": "1",
            "partnerId": "2", "fund": "1", "exthrs": "1", "output": "json", "events": "1",
        })
        try:
            body = raw_json(QUOTE_URL + "?" + qs, timeout=20)
        except Exception:
            continue
        recs = (body.get("FormattedQuoteResult") or {}).get("FormattedQuote") or []
        if isinstance(recs, dict):
            recs = [recs]
        for rec in recs:
            sym = str(rec.get("symbol") or "").upper()
            if sym and str(rec.get("code")) == "0":
                quotes[sym] = rec

    return {
        "universeSize": len(universe), "matched": len(matched), "examined": len(sliced),
        "order": opts["order"], "orderLabel": labels.get(opts["order"], ""),
        "rows": sliced, "quotes": quotes,
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

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path != "/api/group":
            return self.send_json({"error": "Not found"}, status=404)
        try:
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(length).decode("utf-8", "replace"))
        except Exception:
            return self.send_json({"error": "Expected a JSON body", "symbols": None})
        return self.send_json(group_action(body if isinstance(body, dict) else {}))

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
            try:
                sources["insiderFilings"] = fetch_insider_filings(symbol)
            except Exception:
                sources["insiderFilings"] = {"cik": None, "filings": []}
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

        if parsed.path == "/api/catalysts":
            try:
                days = int((params.get("days") or ["45"])[0])
            except ValueError:
                days = 45
            days = max(1, min(90, days))
            try:
                sources = fetch_catalysts(days)
                return self.send_json({"sources": sources, "days": days,
                                       "asOf": time.time(), "error": None})
            except Exception as exc:
                return self.send_json({"sources": {}, "days": days, "asOf": None,
                                       "error": "Catalysts failed (%s)" % type(exc).__name__})

        if parsed.path == "/api/insider-feed":
            try:
                limit = int((params.get("limit") or ["30"])[0])
            except ValueError:
                limit = 30
            feed = fetch_insider_feed(max(1, min(60, limit)))
            feed["error"] = None
            return self.send_json(feed)

        if parsed.path == "/api/screen":
            def as_int(name, default):
                try:
                    return int((params.get(name) or [str(default)])[0])
                except ValueError:
                    return default
            cap = (params.get("cap") or ["smallmid"])[0]
            order = (params.get("order") or ["decliners"])[0]
            opts = {
                "cap": cap if cap in CAP_BANDS else "smallmid",
                "sector": (params.get("sector") or ["any"])[0],
                "order": order if order in ("decliners", "smallest", "largest", "liquid") else "decliners",
                "minPrice": max(0, as_int("minPrice", 5)),
                "minVolume": max(0, as_int("minVolume", 300000)),
                "limit": min(SCREEN_MAX_ENRICHED, max(70, as_int("limit", SCREEN_MAX_ENRICHED))),
            }
            try:
                result = run_screen(opts)
                result.update({"filters": opts, "asOf": time.time(), "error": None})
                return self.send_json(result)
            except Exception as exc:
                return self.send_json({"rows": [], "quotes": {}, "filters": opts,
                                       "asOf": None, "error": "Screen failed (%s)" % type(exc).__name__})

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
