# Changelog

## [Unreleased]

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
