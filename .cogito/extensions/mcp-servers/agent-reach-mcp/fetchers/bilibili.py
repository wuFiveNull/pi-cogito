# -*- coding: utf-8 -*-
"""Bilibili — public search API data fetcher (no login required).

Based on Agent-Reach (MIT, https://github.com/Panniantong/Agent-Reach)
channels/bilibili.py search-API fallback backend.
"""

import html
import json
import re
import urllib.request
import urllib.parse

_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
_TIMEOUT = 10


def _search_api(query: str, page: int = 1) -> dict:
    url = (
        "https://api.bilibili.com/x/web-interface/search/all/v2"
        f"?keyword={urllib.parse.quote(query)}&page={page}"
    )
    req = urllib.request.Request(url, headers={"User-Agent": _UA})
    with urllib.request.urlopen(req, timeout=_TIMEOUT) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _clean_title(title: str) -> str:
    """B站标题里高亮关键词带 <em> 标签，去掉。"""
    return html.unescape(re.sub(r"<[^>]+>", "", title or ""))


def search(query: str, limit: int = 10) -> list:
    """B站全站搜索（无登录），返回视频、UP主、番剧等结果。"""
    data = _search_api(query)
    if data.get("code") != 0:
        return [{"error": f"B站搜索失败: {data.get('message')}"}]

    results = []
    for group in (data.get("data") or {}).get("result") or []:
        result_type = group.get("result_type", "")
        for item in (group.get("data") or [])[:limit]:
            entry = {
                "type": result_type,
                "title": _clean_title(item.get("title")),
                "author": item.get("author", ""),
            }
            if result_type == "video":
                entry.update({
                    "bvid": item.get("bvid", ""),
                    "play": item.get("play"),
                    "danmaku": item.get("video_review"),
                    "duration": item.get("duration", ""),
                    "url": f"https://www.bilibili.com/video/{item.get('bvid', '')}",
                })
            elif result_type == "bili_user":
                entry.update({
                    "mid": item.get("mid", ""),
                    "fans": item.get("fans"),
                    "url": f"https://space.bilibili.com/{item.get('mid', '')}",
                })
            elif result_type == "media_bangumi":
                entry.update({"url": item.get("url", "")})
            results.append(entry)
            if len(results) >= limit:
                return results
    return results
