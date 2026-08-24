# Changelog

## [Unreleased]

### Changed

- Web dashboard drift skills path now points at `<projectDir>/.cogito/extensions/drift/skills` (drift mount unified under the project extensions tree).

### Added

- Post-response memory invalidation: `createChatMessageHandler` gained an `afterTurn` hook fired on `agent_end`; `runChatModule` wires `PostResponseMemoryWorker` (host) with the shared chat model — when a user explicitly rejects a past agent behavior, related `procedure`/`preference` memories are superseded automatically; `extractToolChain` is exported for tool-result mapping.
- Memory injection is budget-aware (akashic trim-plan equivalent): `memoryInjectionMode` degrades the injected block stepwise from full (stable profile + vector recall) to stable-only to SELF-only to none based on `ctx.getContextUsage()` percentages (0.7 / 0.85 / 0.95), and `buildStableMemoryBlock` supports a `"self"` level; injection no longer pushes an overloaded context into provider overflow.
- Rich memory injection block (M3, akashic `_format_relative_age` / `_format_source_tag` / `_procedure_steps` equivalent): `buildRichInjectionBlock` renders each recall hit with a relative age, evidence tag, procedure steps/trigger tags, and low-confidence labels under per-type quotas and a char budget; `createMemoryInjectionExtension` uses `ChatMemory.recall()` + the rich block, and subscribes to `memory_written` events so `memorize`/`forget_memory` take effect on the next turn without waiting for the consolidation loop (M4-lite cache invalidation).
- History route gate (C4, akashic RETRIEVE/NO_RETRIEVE equivalent): `HistoryRouteGate` decides per user message whether to run the vector recall with a light model (JSON output, cached per session+query for 10 min, fail-open to retrieve); on `skip` the recall is skipped while the stable profile (SELF/MEMORY/RECENT_CONTEXT) is still injected; toggle via `chat.memory.historyRoute` (default true).
- Context budget gate (C1/C3, akashic ContextTrimPlan equivalent): the `context` event trims oldest whole turns (never splitting assistant+toolResult batches or dropping the last user message) when usage crosses `chat.context.budget.hardPercent` (default 0.95); `before_provider_request` trims tool schemas to `essentialTools` (default CHAT_DEFAULT_TOOLS) for OpenAI-compatible payloads only; any failure passes the request through untouched.
- Procedure memory tagging + tool interception (M1, akashic `procedure_tagger.py` / `keyword_match_procedures` equivalent): `ProcedureTagger` runs after each turn (rate-limited per conversation, fail-open) to extract explicit process rules and write `procedure` memories with `trigger_tags`; `createProcedureInterceptorExtension` wraps chat tools so a matched procedure with a negative prefix blocks the call with the rule text and a positive rule returns a hint, while non-chat (host) tool matches are observed in logs only.
- `ChatMemory` write path: `remember()` passes `extra`/`happenedAt` through to the memorizer, emits `memory_written` events (`onMemoryWritten`), and adds `matchProcedure(scope, toolName, args)` for trigger-tag matching.
- Memory injection now uses an akashic-style context frame: the stable profile + vector recall block is inserted as a dedicated `<system-reminder data-system-context-frame="true">` user message right before the last user message (explicitly "candidate context, not user statement") instead of being appended to the user message text; `createMemoryInjectionExtension` / `buildContextFrameContent` are exported for tests and reuse.

### Added

- `@cogito/chat` 初始版本:IM 聊天模块,以 `@cogito/host` 为底座。
  - `runChatModule()`:替换 `scripts/cogito-gateway.ts` 的全部胶水(通道 SDK 装配、
    每会话 `AgentSession` 池、turn 桥接、web 面板、readiness/锁/停机),入口脚本
    保留为薄调用。
  - `ChatSessionPool`:每 chat 一个 `AgentSession`(持久化复用、空闲回收、并发上限)。
  - 流式回复:向支持流式的 channel 转发 thinking/content delta(`sendDelta`)。
  - 聊天工具集:`message_push`、`web_fetch`/`web_search`(复用 `@cogito/gate`
    SSRF 策略)、`memorize`/`recall_memory`/`forget_memory`(host `MemoryEngine`,
    按 channel/chat 隔离)、`fetch_messages`/`search_messages`(gateway 消息库)、
    `schedule`/`list_schedules`/`cancel_schedule`(at/after/every + instant/soft,
    持久化到 `chat-schedules.json`)。
  - 记忆注入:每轮经扩展 `context` 事件检索并注入相关记忆(per-turn 缓存)。
  - chat 扩展目录与 persona(`chat.extensionsDir` / `chat.persona`,等价 akashic VEDA)。
  - 配置:config.json `chat` 节(model/thinkingLevel/streaming/tools/memory/web/
    sessions/extensionsDir/persona)。
  - 子任务委派:每会话挂载 host `SubagentManager` 扩展,注册 `spawn`/`spawn_manage`
    工具(共享 runner 跟随主会话模型,默认只读工具集;同步模式结果作为 tool_result
    返回,后台模式完成后以新消息回投原会话,并发上限每会话 3)。
  - 工具目录接入:全部聊天工具补充 `searchHint` 触发词(记忆/定时/推送/消息/技能/
    网页等),经 host `ToolCatalog` 索引,`tool_search` 可跨内置/扩展/聊天工具集按
    自然语言查询并激活匹配工具。
  - 记忆注入增强:每轮按 SELF.md 全文 → MEMORY.md 全文 → RECENT_CONTEXT.md
    (只取 Compression/Ongoing Threads,裁掉 Recent Turns)→ 向量召回块的顺序注入
    稳定档案(akashic prompt-block 优先级移植),文件缺失时跳过该段;新增
    `chat.memory.injectProfile` 开关(默认 true)控制稳定档案注入。

### Fixed

- `message_push` 不再强制要求 `target_channel`/`target_chat_id`:省略时回落到当前会话
  所在渠道(per-session scope),避免推送到未指定的目标。
- 每日 `every` 定时任务(如 `09:00`)补触发后按 `when` 重锚定到下一个固定时刻,不再
  按 `now + 24h` 顺延——网关晚启动/晚补跑不会再让每日推送窗口漂移。
