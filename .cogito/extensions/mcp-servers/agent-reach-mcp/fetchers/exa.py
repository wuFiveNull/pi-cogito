# -*- coding: utf-8 -*-
"""Exa — semantic web search via MCP streamable HTTP (no mcporter needed).

Direct minimal MCP client over urllib. Anonymous, no API key required.
"""

import json
import urllib.request

_URL = "https://mcp.exa.ai/mcp"
_TIMEOUT = 45
_ACCEPT = "application/json, text/event-stream"


def _post(payload: dict, session_id: str | None = None):
    headers = {
        "Content-Type": "application/json",
        "Accept": _ACCEPT,
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    }
    if session_id:
        headers["mcp-session-id"] = session_id
    # This machine needs the ambient HTTP(S)_PROXY to reach mcp.exa.ai.
    req = urllib.request.Request(
        _URL, data=json.dumps(payload).encode("utf-8"), headers=headers, method="POST"
    )
    with urllib.request.urlopen(req, timeout=_TIMEOUT) as resp:
        body = resp.read().decode("utf-8", errors="replace")
        return body, resp.headers.get("mcp-session-id")


def _parse(body: str):
    """Parse a streamable-HTTP response: SSE (event: message / data:) or plain JSON."""
    for line in body.splitlines():
        line = line.strip()
        if line.startswith("data: "):
            return json.loads(line[6:])
    return json.loads(body)


def _session():
    body, sid = _post({
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {
            "protocolVersion": "2025-03-26",
            "capabilities": {},
            "clientInfo": {"name": "agent-reach-mcp", "version": "1.0"},
        },
    })
    _parse(body)  # validate
    _post({"jsonrpc": "2.0", "method": "notifications/initialized"}, sid)
    return sid


def _call_tool(name: str, arguments: dict, session_id: str):
    body, _ = _post({
        "jsonrpc": "2.0", "id": 2, "method": "tools/call",
        "params": {"name": name, "arguments": arguments},
    }, session_id)
    msg = _parse(body)
    if msg.get("error"):
        return {"error": msg["error"]}
    result = msg.get("result") or {}
    if result.get("isError"):
        return {"error": result.get("content", [{}])[0].get("text", "Exa call failed")}
    texts = [c.get("text", "") for c in result.get("content", []) if c.get("type") == "text"]
    joined = "\n".join(texts).strip()
    if not joined:
        return {"error": "Exa 返回空结果"}
    try:
        return json.loads(joined)  # Exa returns structured JSON text
    except json.JSONDecodeError:
        return {"text": joined}


def search(query: str, num_results: int = 5) -> dict:
    """全网语义搜索（Exa）。返回结构化结果。"""
    sid = _session()
    try:
        return _call_tool("web_search_exa", {"query": query, "numResults": num_results}, sid)
    except Exception as e:
        return {"error": f"Exa 搜索失败: {e}"}


def fetch(url: str, text_length: int = 1000) -> dict:
    """抓取单个网页内容（Exa 抓取，返回正文文本）。"""
    sid = _session()
    try:
        return _call_tool("web_fetch_exa", {"url": url, "textLength": text_length}, sid)
    except Exception as e:
        return {"error": f"Exa 抓取失败: {e}"}
