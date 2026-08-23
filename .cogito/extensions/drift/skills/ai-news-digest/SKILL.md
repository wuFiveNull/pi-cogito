---
name: ai-news-digest
description: 隔天整理一份 AI/编程主题的深度摘要：从 Hacker News、GitHub、热榜候选里挑 3-5 条与 AI/编程/开源相关的内容，各写 2-3 句要点后推送。适合早晨或傍晚空闲时段，且距上次发送超过 24 小时时选择。
---

# AI 资讯摘要

## 目标

围绕用户关注的 AI / 编程 / 开源主题，从各源挑 3-5 条**真正值得读**的内容，每条附 2-3 句"为什么值得看"，推送给用户。隔天一次，宁缺毋滥。

## 何时使用

- 距上次发送（skill_journal 的 last_digest_at）超过 24 小时
- 与 `daily-briefing` 错开：若本小时刚发过早报，静默跳过

## 工作流

1. **去重检查**：读 skill_journal，若 24 小时内发过 → 静默闭环。
2. **收集候选**（并行，逐项失败跳过）：
   - HN：`web_fetch https://hn.algolia.com/api/v1/search?query=AI OR LLM OR agent&tags=story&hitsPerPage=10`
   - GitHub：`web_fetch https://api.github.com/search/repositories?q=topic:llm+topic:agent+created:>7d&sort=stars&per_page=10`
   - 热榜（本地服务可用时）：`shell: curl -s 'http://127.0.0.1:6688/hackernews?limit=10'`、`curl -s 'http://127.0.0.1:6688/juejin?limit=10'`（失败跳过）
   - 若候选里能读到 proactive 候选池：`shell: sqlite3 .run/agent/wake_proactive.db "SELECT title FROM reservoir_events WHERE title LIKE '%AI%' OR title LIKE '%LLM%' OR title LIKE '%agent%' ORDER BY first_seen_at DESC LIMIT 10"`（sqlite3 不可用就跳过）
3. **筛选**：按与 AI/编程/开源的相关度挑 3-5 条，排除旧闻（>3 天）、广告、纯娱乐。
4. **组织输出**：
   ```
   📡 AI 摘要 (M月D日)
   • 标题 (来源)
     要点 2-3 句,说明这条为什么值得看
   ...
   ```
   总长 600-900 字。
5. `message_push` 发送。
6. `journal_append` 记录 `last_digest_at: 现在`。

## 约束

- 宁缺毋滥：凑不够 3 条相关内容就少发或静默（<3 条时静默闭环）
- 每条必须写"为什么值得看"，不复制原文
- 只读公开信息源，不登录、不采集用户私有数据

## 收尾

- 已发送 → `finish_drift(status="completed", briefing="推送了 AI 摘要(N 条)", self_update={pattern:"digest", reflection:"...", next_tendency:"隔天继续"})`
- 内容不足 → `finish_drift(status="completed", briefing="候选不足(N 条),静默等待下一轮", self_update={...})`
