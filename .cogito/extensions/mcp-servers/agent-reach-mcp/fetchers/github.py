# -*- coding: utf-8 -*-
"""GitHub — anonymous REST API data fetchers.

No gh CLI / token required. Public endpoints only; rate-limited to
60 req/h per IP (search: 10/min) for anonymous requests.
"""

import base64
import json
import urllib.parse
import urllib.request

_UA = "agent-reach-mcp"
_TIMEOUT = 15
_API = "https://api.github.com"


def _get_json(url: str):
    req = urllib.request.Request(url, headers={"User-Agent": _UA, "Accept": "application/vnd.github+json"})
    with urllib.request.urlopen(req, timeout=_TIMEOUT) as resp:
        return json.loads(resp.read().decode("utf-8"))


def repo_view(repo: str) -> dict:
    """GitHub 仓库信息（公开仓库，无需认证）。repo 形如 owner/name。"""
    try:
        d = _get_json(f"{_API}/repos/{repo.strip('/')}")
    except Exception as e:
        return {"error": f"仓库不可访问（可能不存在或为私有）: {e}"}
    if isinstance(d, dict) and d.get("message") and "full_name" not in d:
        return {"error": d["message"]}
    return {
        "full_name": d.get("full_name", repo),
        "description": d.get("description"),
        "stars": d.get("stargazers_count"),
        "forks": d.get("forks_count"),
        "language": d.get("language"),
        "license": (d.get("license") or {}).get("spdx_id"),
        "open_issues": d.get("open_issues_count"),
        "topics": d.get("topics", [])[:10],
        "homepage": d.get("homepage"),
        "default_branch": d.get("default_branch"),
        "pushed_at": d.get("pushed_at"),
        "archived": d.get("archived"),
        "url": d.get("html_url", f"https://github.com/{repo}"),
    }


def search_repos(query: str, limit: int = 10) -> list:
    """搜索 GitHub 公开仓库。"""
    url = f"{_API}/search/repositories?q={urllib.parse.quote(query)}&per_page={min(limit, 50)}"
    d = _get_json(url)
    if isinstance(d, dict) and d.get("message") and "items" not in d:
        return [{"error": d["message"]}]
    results = []
    for i in (d.get("items") or [])[:limit]:
        results.append({
            "full_name": i.get("full_name"),
            "description": i.get("description"),
            "stars": i.get("stargazers_count"),
            "language": i.get("language"),
            "url": i.get("html_url"),
        })
    return results


def list_issues(repo: str, limit: int = 10) -> list:
    """GitHub 公开仓库的 open issues。"""
    url = f"{_API}/repos/{repo.strip('/')}/issues?state=open&per_page={min(limit, 50)}"
    try:
        d = _get_json(url)
    except Exception as e:
        return [{"error": f"issues 不可访问: {e}"}]
    if isinstance(d, dict) and d.get("message") and not isinstance(d, list):
        return [{"error": d["message"]}]
    results = []
    for i in d[:limit]:
        if not isinstance(i, dict) or "title" not in i:
            continue
        results.append({
            "number": i.get("number"),
            "title": i.get("title"),
            "state": i.get("state"),
            "comments": i.get("comments"),
            "created_at": i.get("created_at"),
            "user": (i.get("user") or {}).get("login"),
            "url": i.get("html_url"),
        })
    return results


def get_file(repo: str, path: str) -> str:
    """读取 GitHub 公开仓库的单个文件内容（文本）。"""
    url = f"{_API}/repos/{repo.strip('/')}/contents/{urllib.parse.quote(path.strip('/'))}"
    try:
        d = _get_json(url)
    except Exception as e:
        return f"[错误] 文件不可访问: {e}"
    if isinstance(d, dict) and d.get("message") and "content" not in d:
        return f"[错误] {d['message']}"
    if isinstance(d, dict) and d.get("type") == "dir":
        names = [x.get("name") for x in d.get("entries", [])]
        return f"[目录] 该路径是目录，包含: {', '.join(names[:50])}"
    try:
        content = base64.b64decode(d.get("content", "")).decode("utf-8", errors="replace")
    except Exception:
        return "[错误] 无法解码文件内容（可能不是文本文件）"
    if len(content) > 20000:
        content = content[:20000] + "\n...[已截断，文件较大]"
    return content
