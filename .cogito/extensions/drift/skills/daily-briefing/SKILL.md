---
name: daily-briefing
description: 每天早晨推送一份简短日报：GitHub 热门仓库、Hacker News 头条、微博/B站热榜前几条，以及近期记忆里的待办提醒。适合早晨时段（本地 8:00-9:30）且今天还没发过时选择。
---

# 每日简报

## 目标

在早晨给用户推一条**紧凑、可读**的日报（一次 message_push），让用户醒来看一眼就知道今天发生了什么。每天最多一次。

## 何时使用

- 本地时间在 8:00-9:30 之间
- 今天还没有发过简报（查 skill_journal 的 last_briefing_date）
- 不是早晨时段 → 静默闭环，`finish_drift` 说明原因

## 工作流

1. **检查是否已发过**：读 skill_journal 里本 skill 的最近条目（或 journal_append 记录），若 `briefing_date` 等于今天 → 静默闭环。
2. **抓取素材**（并行，任一项失败不影响其他）：
   - GitHub 热门：`web_fetch https://github.com/trending?since=daily` 或 `https://api.github.com/search/repositories?q=created:>24h&sort=stars&order=desc&per_page=5`
   - HN 头条：`web_fetch https://hnrss.org/newest?count=5`（或 `https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=5`）
   - 热榜（本地 DailyHotApi 可用时）：`shell: curl -s 'http://127.0.0.1:6688/weibo?limit=5'` 与 `curl -s 'http://127.0.0.1:6688/bilibili?limit=5'`（失败就跳过）
3. **待办提醒**：`recall_memory` 检索近期日程/待办类记忆（如"提醒我""明天""待办"），有则加一节。
4. **组织内容**：分节输出，每节 3-5 条，每条一行（标题 + 链接），总长控制在 800 字内。格式：
   ```
   ☀️ 早报 (M月D日)
   📦 GitHub 热门
   • title (stars) url
   🌐 Hacker News
   • title url
   🔥 热榜速览
   • weibo/bilibili 各 2-3 条
   ⏰ 待办
   • 从记忆里捞到的提醒
   ```
5. `message_push` 发送。
6. `journal_append` 记录 `briefing_date: 今天`（供下次去重）。

## 约束

- 每天最多一条，绝不重复发送同一天简报
- 素材抓取失败就跳过该节，不整条放弃
- 只推事实和链接，不发表长篇评论
- 不要抓取本地服务以外的东西；任何一步失败都静默跳过

## 收尾

- 已发送 → `finish_drift(status="completed", briefing="推送了今日早报(N 节)", self_update={pattern:"daily", reflection:"...", next_tendency:"明天早晨继续"})`
- 非早晨时段/已发过 → `finish_drift(status="completed", briefing="未到早报时间或今日已发,静默", self_update={...})`
