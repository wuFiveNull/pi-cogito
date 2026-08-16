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
