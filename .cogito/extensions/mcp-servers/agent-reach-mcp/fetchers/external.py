# -*- coding: utf-8 -*-
"""External CLI backends — YouTube / Twitter / Reddit / XHS / FB / IG / LinkedIn / Exa / podcast.

Extracted from Agent-Reach (MIT, https://github.com/Panniantong/Agent-Reach).
Agent Reach routes to these upstream tools; this module wraps the exact
commands its SKILL.md documents. Missing tools return install guidance
instead of failing silently.
"""

import json
import os
import shutil
import subprocess

_TIMEOUT = 120
_MAX_OUTPUT = 20000


def _run(cmd: list[str], env_extra: dict[str, str] | None = None, timeout: int = _TIMEOUT) -> str:
    env = os.environ.copy()
    if env_extra:
        env.update(env_extra)
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, env=env)
    out = (proc.stdout or "") + (proc.stderr or "")
    if len(out) > _MAX_OUTPUT:
        out = out[:_MAX_OUTPUT] + "\n...[已截断]"
    if proc.returncode != 0:
        raise RuntimeError(f"命令 {' '.join(cmd)} 退出码 {proc.returncode}: {out[-500:]}")
    return out


def _require(tool: str, install_hint: str) -> None:
    if shutil.which(tool) is None:
        raise RuntimeError(f"缺少工具 {tool}。{install_hint}")


def _yaml_to_json(yaml_text: str) -> str:
    """opencli 输出 YAML 时，尝试用 python -c yaml 转换；失败则原样返回。"""
    try:
        import yaml  # noqa: F401
        return json.dumps(yaml.safe_load(yaml_text), ensure_ascii=False)
    except Exception:
        return yaml_text


# --------------------------------------------------------------------------- #
# YouTube
# --------------------------------------------------------------------------- #

def youtube_subtitles(url: str) -> str:
    """YouTube 视频字幕（yt-dlp 提取）。返回字幕文本或文件路径说明。"""
    _require("yt-dlp", "安装: pip install yt-dlp")
    out = _run([
        "yt-dlp", "--write-sub", "--skip-download",
        "--sub-langs", "en,zh-Hans,zh,auto",
        "--write-auto-subs", "--sub-format", "vtt/txt",
        "-o", "/tmp/%(id)s.%(ext)s", url,
    ])
    return out or "字幕已下载到 /tmp/，可读取 .vtt 文件。"


# --------------------------------------------------------------------------- #
# Twitter / X
# --------------------------------------------------------------------------- #

def twitter_search(query: str, limit: int = 10) -> str:
    """Twitter/X 推文搜索（twitter-cli）。需 TWITTER_AUTH_TOKEN / TWITTER_CT0 环境变量。"""
    _require("twitter", "安装: npm install -g twitter-cli；配置: 通过 Cookie-Editor 导出后设置 TWITTER_AUTH_TOKEN 和 TWITTER_CT0")
    missing = [k for k in ("TWITTER_AUTH_TOKEN", "TWITTER_CT0") if not os.environ.get(k)]
    if missing:
        raise RuntimeError(f"缺少 Twitter 凭据环境变量: {', '.join(missing)}")
    return _run(["twitter", "search", query, "-n", str(limit)])


# --------------------------------------------------------------------------- #
# Reddit
# --------------------------------------------------------------------------- #

def reddit_search(query: str, limit: int = 10) -> str:
    """Reddit 搜索（opencli 优先，rdt-cli 兜底）。需桌面 Chrome 登录态或 rdt 配置。"""
    if shutil.which("opencli"):
        out = _run(["opencli", "reddit", "search", query, "-f", "yaml"])
        return _yaml_to_json(out)
    _require("rdt", "安装: pip install rdt-cli；并配置 Reddit 账号")
    return _run(["rdt", "search", query, "--limit", str(limit)])


# --------------------------------------------------------------------------- #
# Xiaohongshu (小红书)
# --------------------------------------------------------------------------- #

def xhs_search(query: str, limit: int = 10) -> str:
    """小红书搜索（opencli 首选，复用 Chrome 登录态）。"""
    _require("opencli", "安装: npm install -g opencli；需桌面 Chrome 登录小红书会话")
    out = _run(["opencli", "xiaohongshu", "search", query, "-f", "yaml"])
    return _yaml_to_json(out)


# --------------------------------------------------------------------------- #
# Facebook / Instagram
# --------------------------------------------------------------------------- #

def facebook_search(query: str, limit: int = 10) -> str:
    """Facebook 搜索（opencli，复用 Chrome 登录态）。"""
    _require("opencli", "安装: npm install -g opencli；需桌面 Chrome 登录 Facebook")
    return _run(["opencli", "facebook", "search", query, "-f", "yaml"])


def instagram_search(query: str, limit: int = 10) -> str:
    """Instagram 用户搜索（opencli，复用 Chrome 登录态）。"""
    _require("opencli", "安装: npm install -g opencli；需桌面 Chrome 登录 Instagram")
    return _run(["opencli", "instagram", "search", query, "-f", "yaml"])


# --------------------------------------------------------------------------- #
# LinkedIn
# --------------------------------------------------------------------------- #

def linkedin_search(query: str, limit: int = 10) -> str:
    """LinkedIn 搜索（linkedin-mcp via mcporter）。"""
    _require("mcporter", "安装: npm install -g mcporter；并配置 linkedin-mcp")
    return _run([
        "mcporter", "call",
        f'linkedin.search(query: "{query}", limit: {limit})',
    ])


# --------------------------------------------------------------------------- #
# Exa 全网搜索
# --------------------------------------------------------------------------- #

def exa_search(query: str, num_results: int = 5) -> dict:
    """全网语义搜索（Exa 直连，匿名免费，无需 mcporter）。"""
    from fetchers import exa
    return exa.search(query, num_results)


def exa_fetch(url: str, text_length: int = 1000) -> dict:
    """用 Exa 抓取单个网页正文。"""
    from fetchers import exa
    return exa.fetch(url, text_length)


# --------------------------------------------------------------------------- #
# 小宇宙播客
# --------------------------------------------------------------------------- #

def xiaoyuzhou_transcribe(url: str) -> str:
    """小宇宙播客音频转文字（whisper 转录）。需 GROQ_API_KEY。"""
    _require("whisper", "安装: pip install openai-whisper")
    if not os.environ.get("GROQ_API_KEY"):
        raise RuntimeError("缺少 GROQ_API_KEY 环境变量（转录模型 API key）")
    return _run(["whisper", url, "--model", "base", "--output_dir", "/tmp/xiaoyuzhou"])
