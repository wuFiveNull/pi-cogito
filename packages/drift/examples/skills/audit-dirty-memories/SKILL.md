---
name: audit-dirty-memories
description: 随机抽检长期记忆,回溯原始消息判断记忆摘要是否准确;发现可疑条目时向用户报告。适合空闲时段、用户长时间未互动时执行。
---

# 记忆审计

## 目标

抽检长期记忆(memory.sqlite 的 preference/profile/event 条目),回溯来源消息,
判断摘要是否准确;可疑条目报告用户,干净条目静默记录。

## 何时适合选择

- 用户长时间未互动,且近期没有更紧急的 drift 活动时。
- 长期记忆里累积了较多带 source_ref 的条目,尚未系统审计过。

## 单次闭环

1. `recall_memory`(query 用"审计/偏好/规则"等宽主题,limit 8)取一批候选;
   或按上轮 `cursor_update` 记录的抽样游标继续。
2. `read_journal`(skill_name=audit-dirty-memories)读取已审计条目列表,跳过重复。
3. 对每条未审计候选:
   - `fetch_messages`(context 取最近 20 条)回溯来源上下文;
   - 对比记忆摘要与原文:内容不匹配、来源错位、数字/金额/地名错误 → 高置信可疑。
4. 干净条目 → `journal_append` 记录 `{"audited": "<memory_id>", "verdict": "clean"}`。
5. 可疑条目(每轮最多 1 条)→ `message_push` 说明哪条记忆为什么可疑,然后
   `journal_append` 记录 `{"audited": "<memory_id>", "verdict": "reported"}`。
6. `finish_drift` 收尾。

## 状态延续

- `journal_append`:已审计 memory_id + verdict,防止重复审计。
- `cursor_update`:抽样偏移 `{"next_offset": N}`,供脚本或下轮直接继续。

## 工具与脚本

- 无需脚本,只用 runtime 工具:`recall_memory` / `fetch_messages` / `read_journal` /
  `journal_append`(经 finish_drift)/ `message_push` / `finish_drift`。
- 如果以后要确定性抽样,可在 `scripts/` 放一个读取 memory.sqlite 的固定脚本,
  用 `shell` 调用,并从 `cursor_update` 读 `next_offset`。

## 收尾

- 全部审计完或已报告 → `finish_drift(status="completed", briefing="审计了 N 条,报告 X 条可疑",
  self_update={"pattern": "ordinary", "reflection": "本轮审计进展", "next_tendency": "..."})`。
- 中途被打断(工具失败/步数上限)→ `finish_drift(status="paused",
  scratchpad_update="下次从 cursor 的 next_offset 继续", self_update={...})`。
- 已审计事实必须走 `journal_append`,不要写 skill 目录下的并行状态文件。
