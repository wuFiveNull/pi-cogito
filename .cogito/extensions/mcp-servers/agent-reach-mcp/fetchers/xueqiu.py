# -*- coding: utf-8 -*-
"""Xueqiu (雪球) — stock quotes, search, hot posts.

Extracted from Agent-Reach (MIT, https://github.com/Panniantong/Agent-Reach)
channels/xueqiu.py — data-fetching methods only.

Anonymous access works for hot posts; quotes/search may require a session.
Set XUEQIU_COOKIE to a cookie string (e.g. from browser) to unlock them.
"""

import http.cookiejar
import json
import os
import re
import urllib.parse
import urllib.request

_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
_REFERER = "https://xueqiu.com/"
_TIMEOUT = 10
_XUEQIU_HOME = "https://xueqiu.com"

_cookie_jar = http.cookiejar.CookieJar()
_opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(_cookie_jar))


def _inject_cookie_string(cookie_str: str) -> None:
    for part in cookie_str.split(";"):
        part = part.strip()
        if not part or "=" not in part:
            continue
        name, _, value = part.partition("=")
        _cookie_jar.set_cookie(
            http.cookiejar.Cookie(
                version=0, name=name.strip(), value=value.strip(),
                port=None, port_specified=False,
                domain=".xueqiu.com", domain_specified=True, domain_initial_dot=True,
                path="/", path_specified=True,
                secure=False, expires=None, discard=True,
                comment=None, comment_url=None, rest={},
            )
        )


def _ensure_cookies() -> None:
    env_cookie = os.environ.get("XUEQIU_COOKIE", "")
    if env_cookie:
        _inject_cookie_string(env_cookie)
    # Warm up a session cookie by visiting the home page (anonymous path).
    req = urllib.request.Request(_XUEQIU_HOME, headers={"User-Agent": _UA})
    try:
        with _opener.open(req, timeout=_TIMEOUT):
            pass
    except Exception:
        pass


def _get_json(url: str):
    _ensure_cookies()
    req = urllib.request.Request(url, headers={"User-Agent": _UA, "Referer": _REFERER})
    with _opener.open(req, timeout=_TIMEOUT) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _strip_html(text: str) -> str:
    text = re.sub(r"<[^>]+>", "", text)
    for entity, char in (("&nbsp;", " "), ("&amp;", "&"), ("&lt;", "<"), ("&gt;", ">")):
        text = text.replace(entity, char)
    return text.strip()


def stock_quote(symbol: str) -> dict:
    """实时股票行情。symbol 如 SH600519（沪）、SZ000858（深）、AAPL（美）、00700（港）。"""
    try:
        encoded = urllib.parse.quote(symbol, safe="")
        data = _get_json(
            "https://stock.xueqiu.com/v5/stock/quote.json"
            f"?symbol={encoded}&extend=detail"
        )
    except Exception as e:
        return {"error": f"雪球行情不可用（可能需要 XUEQIU_COOKIE 登录会话）: {e}"}
    q = (data.get("data") or {}).get("quote") or {}
    if not q:
        return {"error": "雪球行情返回空（可能需要 XUEQIU_COOKIE）"}
    return {
        "symbol": q.get("symbol", symbol),
        "name": q.get("name", ""),
        "current": q.get("current"),
        "percent": q.get("percent"),
        "chg": q.get("chg"),
        "high": q.get("high"),
        "low": q.get("low"),
        "open": q.get("open"),
        "last_close": q.get("last_close"),
        "volume": q.get("volume"),
        "amount": q.get("amount"),
        "market_capital": q.get("market_capital"),
        "turnover_rate": q.get("turnover_rate"),
        "pe_ttm": q.get("pe_ttm"),
        "pe_forecast": q.get("pe_forecast"),
        "pb": q.get("pb"),
        "eps": q.get("eps"),
        "timestamp": q.get("timestamp"),
    }


def search_stock(query: str, limit: int = 10) -> list:
    """搜索股票（代码或中文名，如 茅台 / 600519）。"""
    try:
        data = _get_json(
            "https://xueqiu.com/stock/search.json"
            f"?code={urllib.parse.quote(query)}&size={limit}"
        )
    except Exception as e:
        return [{"error": f"雪球搜索不可用（可能需要 XUEQIU_COOKIE）: {e}"}]
    stocks = data.get("stocks") or []
    return [
        {"symbol": s.get("code", ""), "name": s.get("name", ""), "exchange": s.get("exchange", "")}
        for s in stocks[:limit]
    ]


def hot_posts(limit: int = 20) -> list:
    """雪球热门帖子（匿名可用）。"""
    try:
        data = _get_json(
            "https://xueqiu.com/v4/statuses/public_timeline_by_category.json"
            "?since_id=-1&max_id=-1&count=20&category=-1"
        )
    except Exception as e:
        return [{"error": f"雪球热帖不可用: {e}"}]
    items = data.get("list") or []
    results = []
    for item in items[:limit]:
        try:
            post = json.loads(item["data"]) if isinstance(item.get("data"), str) else {}
        except (json.JSONDecodeError, KeyError):
            post = {}
        user = post.get("user") or {}
        text = _strip_html(post.get("text") or post.get("description") or "")
        target = post.get("target", "")
        results.append({
            "id": post.get("id") or item.get("id"),
            "title": _strip_html(post.get("title") or "")[:100],
            "text": text[:200],
            "author": user.get("screen_name", ""),
            "likes": post.get("like_count"),
            "url": target if isinstance(target, str) else "",
        })
    return results
