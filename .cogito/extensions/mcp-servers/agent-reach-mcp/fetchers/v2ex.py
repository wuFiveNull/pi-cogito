# -*- coding: utf-8 -*-
"""V2EX — public API data fetchers.

Extracted from Agent-Reach (MIT, https://github.com/Panniantong/Agent-Reach)
channels/v2ex.py — data-fetching methods only.
"""

import json
import urllib.request

_UA = "agent-reach/1.0"
_TIMEOUT = 10
_BASE = "https://www.v2ex.com/api"


def _get_json(url: str):
    req = urllib.request.Request(url, headers={"User-Agent": _UA})
    with urllib.request.urlopen(req, timeout=_TIMEOUT) as resp:
        return json.loads(resp.read().decode("utf-8"))


def hot_topics(limit: int = 20) -> list:
    """V2EX 热门帖子列表。"""
    data = _get_json(f"{_BASE}/topics/hot.json")
    results = []
    for item in data[:limit]:
        node = item.get("node") or {}
        results.append({
            "id": item.get("id", 0),
            "title": item.get("title", ""),
            "url": item.get("url", ""),
            "replies": item.get("replies", 0),
            "node_name": node.get("name", ""),
            "node_title": node.get("title", ""),
            "content": (item.get("content") or "")[:200],
            "created": item.get("created", 0),
        })
    return results


def node_topics(node_name: str, limit: int = 20) -> list:
    """V2EX 指定节点的最新帖子。node_name 如 python / tech / jobs。"""
    url = f"{_BASE}/topics/show.json?node_name={node_name}&page=1"
    data = _get_json(url)
    results = []
    for item in data[:limit]:
        node = item.get("node") or {}
        results.append({
            "id": item.get("id", 0),
            "title": item.get("title", ""),
            "url": item.get("url", ""),
            "replies": item.get("replies", 0),
            "node_name": node.get("name", node_name),
            "node_title": node.get("title", ""),
            "content": (item.get("content") or "")[:200],
            "created": item.get("created", 0),
        })
    return results


def topic(topic_id: int) -> dict:
    """V2EX 单个帖子详情和回复列表。"""
    data = _get_json(f"{_BASE}/topics/show.json?id={topic_id}")
    if not data:
        return {"error": f"topic {topic_id} not found"}
    item = data[0]
    node = item.get("node") or {}
    replies = _get_json(f"{_BASE}/replies/show.json?topic_id={topic_id}")
    return {
        "id": item.get("id", 0),
        "title": item.get("title", ""),
        "url": item.get("url", ""),
        "content": item.get("content", ""),
        "replies_count": item.get("replies", 0),
        "node_name": node.get("name", ""),
        "node_title": node.get("title", ""),
        "created": item.get("created", 0),
        "replies": [
            {
                "author": r.get("member", {}).get("username", ""),
                "content": r.get("content", ""),
                "created": r.get("created", 0),
            }
            for r in replies[:50]
        ],
    }
