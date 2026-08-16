# -*- coding: utf-8 -*-
"""Xiaohongshu (小红书) — result cleaning helpers.

Extracted from Agent-Reach (MIT, https://github.com/Panniantong/Agent-Reach)
channels/xiaohongshu.py — format_xhs_result / _clean_note only.
"""


def _clean_note(note):
    """Extract useful fields from a single XHS note/feed item."""
    if not isinstance(note, dict):
        return note

    inner = note.get("note_card") or note.get("note") or note
    result = {}

    for key in ("id", "note_id", "xsec_token", "title", "desc", "type", "time"):
        if key in inner:
            result[key] = inner[key]

    if "content" in inner and "desc" not in result:
        result["content"] = inner["content"]

    user = inner.get("user") or inner.get("author")
    if isinstance(user, dict):
        result["user"] = {k: user[k] for k in ("nickname", "user_id", "nick_name") if k in user}

    interact = inner.get("interact_info") or inner.get("note_interact_info") or {}
    if isinstance(interact, dict):
        for key in ("liked_count", "collected_count", "comment_count", "share_count"):
            if key in interact:
                result[key] = interact[key]
    for key in ("liked_count", "collected_count", "comment_count", "share_count"):
        if key in inner and key not in result:
            result[key] = inner[key]

    images = inner.get("image_list") or inner.get("images")
    if isinstance(images, list):
        urls = []
        for img in images[:9]:
            if isinstance(img, dict):
                urls.append(img.get("url_default") or img.get("url") or "")
            elif isinstance(img, str):
                urls.append(img)
        result["images"] = [u for u in urls if u]

    return result


def format_xhs_result(data):
    """Clean XHS API response, keeping only useful fields (reduces tokens)."""
    if isinstance(data, list):
        return [_clean_note(item) for item in data]
    if isinstance(data, dict):
        items = None
        if "items" in data:
            items = data["items"]
        elif "data" in data and isinstance(data.get("data"), dict):
            items = data["data"].get("items") or data["data"].get("notes")
        if items and isinstance(items, list):
            return [_clean_note(item) for item in items]
        return _clean_note(data)
    return data
