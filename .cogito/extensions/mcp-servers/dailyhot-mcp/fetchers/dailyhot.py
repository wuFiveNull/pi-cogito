# -*- coding: utf-8 -*-
"""DailyHotApi — 今日热榜聚合服务客户端。

调本机常驻服务 http://localhost:6688（项目: /home/wu/projects/DailyHotApi）。
56+ 个数据源（微博/B站/知乎/掘金/GitHub/历史上的今天...），支持 JSON 与 RSS。
"""

import json
import urllib.parse
import urllib.request

_BASE = "http://localhost:6688"
_TIMEOUT = 20

# 常用源（用于工具描述；完整列表以服务返回为准）
COMMON = (
    "weibo bilibili zhihu baidu douyin juejin 36kr v2ex hackernews producthunt "
    "github history ithome hupu sspai nodeseek linuxdo douban-movie huxiu coolapk"
)


def hot(source: str, limit: int = 20, **extra) -> dict:
    """获取指定平台热榜。extra 可传 type/day/month 等源特有参数。"""
    query = [("limit", str(limit))]
    for key in ("type", "day", "month"):
        if extra.get(key):
            query.append((key, str(extra[key])))
    url = f"{_BASE}/{urllib.parse.quote(source)}"
    if query:
        url += "?" + urllib.parse.urlencode(query)
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "agent-reach-mcp", "Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=_TIMEOUT) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        return {"error": f"DailyHotApi 不可用（服务是否在 localhost:6688 运行？）: {e}"}

    if data.get("code") not in (None, 200):
        return {"error": f"DailyHotApi 返回错误: {data}"}

    items = []
    for item in (data.get("data") or [])[:limit]:
        items.append({
            "title": item.get("title", ""),
            "author": item.get("author"),
            "hot": item.get("hot"),
            "url": item.get("url", ""),
            "desc": (item.get("desc") or "")[:100],
        })
    return {
        "source": data.get("name", source),
        "title": data.get("title", ""),
        "type": data.get("type", ""),
        "total": data.get("total", len(items)),
        "updateTime": str(data.get("updateTime", ""))[:20],
        "items": items,
    }


def list_sources() -> list:
    """服务支持的数据源列表。"""
    try:
        req = urllib.request.Request(f"{_BASE}/", headers={"User-Agent": "agent-reach-mcp"})
        with urllib.request.urlopen(req, timeout=_TIMEOUT) as resp:
            return ["(服务首页可达)"] + COMMON.split()
    except Exception as e:
        return [f"服务不可达: {e}"]
