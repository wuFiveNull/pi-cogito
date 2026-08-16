#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""agent-reach-mcp — 提取自 Agent-Reach 的"获取数据"函数，包装为 MCP server。

启动: .venv/bin/python server.py   (stdio transport, 供 pi-mcp-adapter 消费)
"""

from fastmcp import FastMCP

from fetchers import bilibili, external, github, rss, v2ex, web, xueqiu

mcp = FastMCP(
    "agent-reach",
    instructions=(
        "互联网数据获取工具集（提取自 Agent-Reach）。"
        "web_read 读任意网页正文；v2ex_hot/v2ex_node_topics/v2ex_topic 查 V2EX；"
        "bili_search 搜 B站（无需登录）；rss_read 读任意 RSS/Atom 源。"
        "所有工具匿名只读，不需要 API Key。"
    ),
)


@mcp.tool()
def web_read(url: str) -> str:
    """读取任意网页正文，返回可读文本（Markdown 风格）。"""
    return web.read(url)


@mcp.tool()
def v2ex_hot(limit: int = 20) -> list:
    """V2EX 热门帖子列表。"""
    return v2ex.hot_topics(limit)


@mcp.tool()
def v2ex_node_topics(node_name: str, limit: int = 20) -> list:
    """V2EX 指定节点的最新帖子（node_name 如 python / tech / jobs）。"""
    return v2ex.node_topics(node_name, limit)


@mcp.tool()
def v2ex_topic(topic_id: int) -> dict:
    """V2EX 单个帖子详情和回复列表。"""
    return v2ex.topic(topic_id)


@mcp.tool()
def bili_search(query: str, limit: int = 10) -> list:
    """B站全站搜索（无需登录），返回视频/UP主/番剧结果。"""
    return bilibili.search(query, limit)


@mcp.tool()
def rss_read(url: str, limit: int = 10) -> list:
    """读取任意 RSS/Atom 订阅源，返回最近条目。"""
    return rss.read(url, limit)


@mcp.tool()
def github_repo(repo: str) -> dict:
    """GitHub 仓库信息（公开仓库，无需认证）。repo 形如 owner/name，如 microsoft/playwright-mcp。"""
    return github.repo_view(repo)


@mcp.tool()
def github_search(query: str, limit: int = 10) -> list:
    """搜索 GitHub 公开仓库（按相关度/star 排序）。"""
    return github.search_repos(query, limit)


@mcp.tool()
def github_issues(repo: str, limit: int = 10) -> list:
    """GitHub 公开仓库的 open issues 列表。"""
    return github.list_issues(repo, limit)


@mcp.tool()
def github_file(repo: str, path: str) -> str:
    """读取 GitHub 公开仓库的单个文件内容。path 如 README.md 或 src/index.ts。"""
    return github.get_file(repo, path)


# --------------------------------------------------------------------------- #
# 雪球（纯 urllib；行情/搜索需要 XUEQIU_COOKIE，热帖匿名可用）
# --------------------------------------------------------------------------- #

@mcp.tool()
def xueqiu_quote(symbol: str) -> dict:
    """雪球实时股票行情。symbol 如 SH600519（沪）、SZ000858（深）、AAPL（美）、00700（港）。"""
    return xueqiu.stock_quote(symbol)


@mcp.tool()
def xueqiu_search(query: str, limit: int = 10) -> list:
    """雪球搜索股票（代码或中文名，如 茅台 / 600519）。"""
    return xueqiu.search_stock(query, limit)


@mcp.tool()
def xueqiu_hot(limit: int = 20) -> list:
    """雪球热门帖子（匿名可用）。"""
    return xueqiu.hot_posts(limit)


# --------------------------------------------------------------------------- #
# 外部 CLI 渠道（缺工具时返回安装引导）
# --------------------------------------------------------------------------- #

def _guard(fn, *args, **kwargs):
    """把外部工具调用的异常转成可读的 MCP 返回。"""
    try:
        return fn(*args, **kwargs)
    except Exception as e:
        return f"[不可用] {e}"


def _guard_dict(fn, *args):
    """同 _guard，但错误返回 dict，匹配声明返回 dict 的工具。"""
    try:
        return fn(*args)
    except Exception as e:
        return {"error": f"[不可用] {e}"}


@mcp.tool()
def youtube_subtitles(url: str) -> str:
    """YouTube 视频字幕（需 yt-dlp：pip install yt-dlp）。"""
    return _guard(external.youtube_subtitles, url)


@mcp.tool()
def twitter_search(query: str, limit: int = 10) -> str:
    """Twitter/X 推文搜索（需 twitter-cli + TWITTER_AUTH_TOKEN/TWITTER_CT0）。"""
    return _guard(external.twitter_search, query, limit)


@mcp.tool()
def reddit_search(query: str, limit: int = 10) -> str:
    """Reddit 搜索（需 opencli 或 rdt-cli + 登录态）。"""
    return _guard(external.reddit_search, query, limit)


@mcp.tool()
def xhs_search(query: str, limit: int = 10) -> str:
    """小红书搜索（需 opencli + Chrome 登录态）。"""
    return _guard(external.xhs_search, query, limit)


@mcp.tool()
def facebook_search(query: str, limit: int = 10) -> str:
    """Facebook 搜索（需 opencli + Chrome 登录态）。"""
    return _guard(external.facebook_search, query, limit)


@mcp.tool()
def instagram_search(query: str, limit: int = 10) -> str:
    """Instagram 用户搜索（需 opencli + Chrome 登录态）。"""
    return _guard(external.instagram_search, query, limit)


@mcp.tool()
def linkedin_search(query: str, limit: int = 10) -> str:
    """LinkedIn 搜索（需 mcporter + linkedin-mcp 配置）。"""
    return _guard(external.linkedin_search, query, limit)


@mcp.tool()
def exa_search(query: str, num_results: int = 5) -> dict:
    """全网语义搜索（Exa 直连，匿名免费，无需 mcporter）。"""
    return _guard_dict(external.exa_search, query, num_results)


@mcp.tool()
def exa_fetch(url: str, text_length: int = 1000) -> dict:
    """用 Exa 抓取单个网页正文（比 web_read 更结构化，适合需要正文完整内容的场景）。"""
    return _guard_dict(external.exa_fetch, url, text_length)


@mcp.tool()
def xiaoyuzhou_transcribe(url: str) -> str:
    """小宇宙播客音频转文字（需 whisper + GROQ_API_KEY）。"""
    return _guard(external.xiaoyuzhou_transcribe, url)


if __name__ == "__main__":
    mcp.run()
