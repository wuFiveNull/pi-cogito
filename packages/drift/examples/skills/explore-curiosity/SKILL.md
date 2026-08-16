---
name: explore-curiosity
description: 补足用户画像中生活化信息的空白,一次只问一个轻量、自然的问题(音乐偏好、开源项目、运动习惯、食物口味、日常消遣)。适合用户长时间未互动、且记忆中没有答案时。
---

# 好奇心探索

## 目标

基于长期记忆与近期上下文,现场判断一个轻量、自然、像朋友随口一问的问题,
通过 `message_push` 发送;不适合打扰时静默闭环。

## 何时适合选择

- 用户长时间未互动(可经 fetch_messages / 运行时上下文判断)。
- 用户画像存在明确空白(如从未聊过音乐/运动/食物)。
- 记忆里已有明确答案的主题不要问。

## 单次闭环

1. `read_journal` 查看本 skill 最近问过的问题,避免短期重复。
2. `recall_memory` 检查用户画像:已有明确答案的主题直接排除。
3. 现场判断一个轻量自然的问题(只问一个)。
4. 判断是否适合打扰:
   - 适合 → `message_push` 发送问题;
   - 不适合(深夜、刚推过、无合适话题)→ 静默闭环。
5. `journal_append` 记录 `{"asked": "<问题主题>", "sent": true|false}`。
6. `finish_drift` 收尾。

## 规则

- 问题必须轻量、自然、像朋友随口一问;禁止太大、太虚、太像采访的问题。
- 优先:音乐偏好、开源项目、运动习惯、食物口味、日常消遣。
- 避开长期记忆里已经明确有答案的信息。
- `message_push` 成功后立即闭环,不保存"等待回答";用户以后真的回答时,
  由会话与记忆链路自然关联,不要在本 skill 里推断"用户没回"。

## 状态延续

- `journal_append`:已问过的问题主题 + 是否发送,防短期重复。
- 不用 cursor/scratchpad(每轮独立判断)。

## 收尾

- 已发送 → `finish_drift(status="completed", briefing="推送了 XX 话题的问题",
  self_update={"pattern": "ordinary", "reflection": "...", "next_tendency": "..."})`。
- 静默 → `finish_drift(status="completed", briefing="本轮无合适话题,静默闭环", self_update={...})`。
