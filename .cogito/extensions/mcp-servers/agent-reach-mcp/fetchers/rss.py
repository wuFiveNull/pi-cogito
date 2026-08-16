# -*- coding: utf-8 -*-
"""RSS/Atom — parse feeds with the Python standard library only.

Functionally equivalent to Agent-Reach's feedparser backend (MIT,
https://github.com/Panniantong/Agent-Reach) without the dependency.
"""

import urllib.request
import xml.etree.ElementTree as ET

_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
_TIMEOUT = 15
_NS = {"atom": "http://www.w3.org/2005/Atom"}


def _fetch(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": _UA, "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml"})
    with urllib.request.urlopen(req, timeout=_TIMEOUT) as resp:
        return resp.read().decode("utf-8", errors="replace")


def _localname(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _text(el: ET.Element | None) -> str:
    if el is None:
        return ""
    return "".join(el.itertext()).strip()


def read(url: str, limit: int = 10) -> list:
    """读取 RSS/Atom 源，返回最近条目列表。"""
    root = ET.fromstring(_fetch(url))
    entries: list[dict] = []

    if _localname(root.tag) == "rss":
        for item in root.iter("item"):
            title = _text(item.find("title"))
            link = _text(item.find("link"))
            desc = _text(item.find("description"))
            pub = _text(item.find("pubDate"))
            entries.append({"title": title, "url": link, "summary": desc[:300], "published": pub})
            if len(entries) >= limit:
                break
    else:
        for item in root.iter("{http://www.w3.org/2005/Atom}entry"):
            title = _text(item.find("{http://www.w3.org/2005/Atom}title"))
            link_el = item.find("{http://www.w3.org/2005/Atom}link")
            link = (link_el.get("href") if link_el is not None else "") or ""
            summary = _text(item.find("{http://www.w3.org/2005/Atom}summary")) or _text(
                item.find("{http://www.w3.org/2005/Atom}content")
            )
            pub = _text(item.find("{http://www.w3.org/2005/Atom}updated"))
            entries.append({"title": title, "url": link, "summary": summary[:300], "published": pub})
            if len(entries) >= limit:
                break

    if not entries:
        return [{"error": "未解析到条目（可能不是有效的 RSS/Atom 源）"}]
    return entries
