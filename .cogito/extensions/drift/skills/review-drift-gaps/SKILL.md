---
name: review-drift-gaps
description: 定期回顾 Drift 全局行动历史(drift.db),找出长期 paused 或反复失败的方向,生成轻量健康摘要。纯后台自我反思,不打扰用户。
---

# Drift 自我反思

## 目标

阅读 drift.db 里的 recent runs 与 skill_continuum,识别长期 paused、反复失败或
反复重复的 skill,生成轻量健康摘要并记录观察。不推送用户。

## 何时适合选择

- 已有多轮 drift 运行记录(本 skill 存在即意味着),适合定期做健康检查。
- 用户长时间未互动、无其他高价值活动时。

## 单次闭环

1. `read_journal`(skill_name=review-drift-gaps)读取上次反思结果,避免重复报告。
2. 读全局行动历史:
   - `read_file` 读取 `drift.db` 之前,先用 `list_dir` 确认路径;drift.db 是
     SQLite 文件,如工具无法直接查询,可用 `shell` 执行只读 sqlite3 查询
     (如 `sqlite3 drift.db "select skill_name,status from runs ..."`);
   - 没有 sqlite3 时退化为 `read_journal` + 本 skill 自身记录。
3. 找出:
   - 长期 `paused` 的 skill(连续多轮未闭环);
   - 最近反复失败的 skill(run_steps 错误率高);
   - 长期重复同一低价值路径的 skill。
4. 生成轻量健康摘要(哪些方向值得暂停/调整/继续)。
5. `journal_append` 记录本轮发现 `{"reviewed_at": "...", "findings": [...]}`。
6. `finish_drift` 收尾,`self_update.observation` 记录非 ordinary 的模式。

## 规则

- 显式跳过自身(review-drift-gaps),不反思自己。
- 不调用 `message_push`,纯后台记录。
- 不把各 skill 的工作文件当权威来源;权威是 drift.db 与 journal。

## 收尾

- `finish_drift(status="completed", briefing="健康摘要:N 个 paused, M 个反复失败",
  self_update={"pattern": "ordinary", "reflection": "本轮健康检查结果",
  "next_tendency": "下次是否继续检查或调整某 skill", "observation": <非 ordinary 时必填>})`。
- 没做完(查询中断)→ `finish_drift(status="paused", scratchpad_update="下次从 ... 继续")`。
