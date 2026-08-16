# -*- coding: utf-8 -*-
"""Web — read any URL as readable text.

Extracted from Agent-Reach (MIT, https://github.com/Panniantong/Agent-Reach)
channels/web.py. Jina Reader first, local HTML extraction as fallback
(anonymous Jina access can be blocked by network reputation).
"""

import html
import re
import urllib.request
from html.parser import HTMLParser

_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
_TIMEOUT = 30


def _fetch(url: str, headers: dict[str, str]) -> str:
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=_TIMEOUT) as resp:
        return resp.read().decode("utf-8", errors="replace")


def _read_via_jina(url: str) -> str:
    """Jina Reader: third-party service that converts any URL to Markdown."""
    if not url.startswith(("http://", "https://")):
        url = "https://" + url
    jina_url = f"https://r.jina.ai/{url}"
    return _fetch(jina_url, {"User-Agent": _UA, "Accept": "text/plain"})


class _TextExtractor(HTMLParser):
    """Minimal HTML -> readable text extractor (body content only)."""

    _SKIP = {"script", "style", "noscript", "svg", "head", "iframe", "nav", "footer", "form"}
    _BLOCK = {"p", "div", "br", "li", "h1", "h2", "h3", "h4", "h5", "h6",
              "pre", "blockquote", "tr", "section", "article", "hr", "ul", "ol", "table"}

    def __init__(self) -> None:
        super().__init__()
        self._skip_depth = 0
        self._parts: list[str] = []
        self._buf: list[str] = []

    def handle_starttag(self, tag, attrs):
        if tag in self._SKIP:
            self._skip_depth += 1
        if self._skip_depth == 0 and tag in self._BLOCK:
            self._flush()

    def handle_endtag(self, tag):
        if tag in self._SKIP and self._skip_depth > 0:
            self._skip_depth -= 1
        if self._skip_depth == 0 and tag in self._BLOCK:
            self._flush()

    def handle_data(self, data):
        if self._skip_depth == 0:
            self._buf.append(data)

    def _flush(self):
        text = " ".join("".join(self._buf).split())
        if text:
            self._parts.append(text)
        self._buf = []

    def text(self) -> str:
        self._flush()
        return "\n".join(self._parts)


def _read_via_local_html(url: str) -> str:
    """Fallback: fetch raw HTML and extract readable text locally."""
    if not url.startswith(("http://", "https://")):
        url = "https://" + url
    raw = _fetch(url, {"User-Agent": _UA, "Accept": "text/html"})
    # Content-type sniffing: if the server already gave us plain text, keep it.
    if not re.search(r"<(html|body|p|div|h1|article)[\s>]", raw[:4000], re.I):
        return html.unescape(raw).strip()
    parser = _TextExtractor()
    parser.feed(raw)
    return parser.text()


def read(url: str) -> str:
    """Read any URL as readable text. Jina Reader first, local fallback."""
    try:
        return _read_via_jina(url)
    except Exception:
        return _read_via_local_html(url)
