#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dailyhot-mcp — 今日热榜（DailyHotApi 本地服务）独立 MCP server。

启动: .venv/bin/python server.py   (stdio transport, 供 pi-mcp-adapter 消费)
依赖: DailyHotApi 常驻服务 http://localhost:6688
"""

from fastmcp import FastMCP

from fetchers import dailyhot

mcp = FastMCP(
    "dailyhot",
    instructions=(
        "今日热榜聚合工具（DailyHotApi 本地服务 localhost:6688）。"
        "dailyhot 获取任意平台热榜（微博/B站/知乎/掘金/HackerNews/GitHub/历史上的今天等 56+ 源）；"
        "dailyhot_sources 列出可用数据源。"
    ),
)


@mcp.tool()
def dailyhot(source: str, limit: int = 20, type: str | None = None, day: str | None = None, month: str | None = None) -> dict:
    """获取指定平台热榜。source 如 weibo/bilibili/zhihu/baidu/douyin/juejin/36kr/v2ex/hackernews/producthunt/github/history/ithome/hupu 等 56+ 个；github 支持 type=daily|weekly|monthly，history 支持 month/day。"""
    return dailyhot.hot(source, limit, type=type, day=day, month=month)


@mcp.tool()
def dailyhot_sources() -> str:
    """列出 DailyHotApi 支持的热榜数据源。"""
    return dailyhot.list_sources()


if __name__ == "__main__":
    mcp.run()
