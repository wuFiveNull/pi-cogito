# @cogito/chat

IM 聊天模块,以 `@cogito/host` 为底座:gateway 收到用户消息后直接交给本模块,
每个会话一个 `AgentSession`,回复经 channel SDK 出站。

等价职责:akashic 的 `PassiveMessageWorker` + 聊天工具集。

## 用法

```ts
import { runChatModule } from "@cogito/chat";

const module = await runChatModule({
	configPath: "./config.json",
	projectDir: process.cwd(),
});
// SIGINT/SIGTERM 时:
await module.stop();
```

`scripts/cogito-gateway.ts` 就是上述调用的薄入口(`npm run gateway`)。

## 功能

- 每 chat 一个 `AgentSession`(持久化、空闲回收、并发上限)
- 回复 + 流式 delta(thinking/content,支持流式的 channel)
- 工具(默认启用核心集):
  - `message_push` — 向任意已注册渠道发消息/文件
  - `web_fetch` / `web_search` — 复用 `@cogito/gate` 的 SSRF 策略
  - `memorize` / `recall_memory` / `forget_memory` — 长期记忆(按 channel/chat 隔离)
  - `fetch_messages` / `search_messages` — 渠道消息历史
  - `schedule` / `list_schedules` / `cancel_schedule` — 定时任务(默认关闭,需在
    `chat.tools.allowed` 中显式启用)
- 每轮自动检索相关记忆并注入上下文(context 事件)
- 定时任务持久化到 `agentDir/chat-schedules.json`,重启后恢复
- web 面板挂载(sessions / proactive / memory / drift / mcp / settings)

## 配置(config.json 的 chat 节)

```json
{
  "chat": {
    "model": "deepseek-v4-flash",
    "thinkingLevel": "medium",
    "streaming": true,
    "tools": { "allowed": [], "excluded": [] },
    "memory": { "enabled": true, "dbPath": "memory/memory.sqlite" },
    "web": {
      "enabled": true,
      "fetch": { "maxChars": 8000, "maxRedirectHops": 0, "timeoutMs": 60000 },
      "search": { "url": "", "apiKey": "" }
    },
    "sessions": { "maxIdleMinutes": 30, "maxSessions": 50 },
    "schedule": { "enabled": true },
    "extensionsDir": "chat/extensions",
    "persona": ""
  }
}
```

- `tools.allowed` 提供时作为工具白名单(只有列出的工具对模型可见);缺省时内置工具 +
  上述默认工具集启用,`chat/extensions` 目录与用户扩展注册的工具同样自动启用。
- `schedule.enabled` 注册定时任务工具(`schedule`/`list_schedules`/`cancel_schedule`),
  默认关闭;也可通过在 `tools.allowed` 中列出这三个工具名启用。
- `persona` 追加到 system prompt(等价 akashic 的 VEDA)。
- `extensionsDir` 里的 TS 扩展可用 `registerTool` / `on("context")` 等全部扩展 API。
- 流式增量需要通道自身开启流式能力(web 通道:`channels.web.streaming: true`),
  `chat.streaming` 控制是否转发增量,缺省开启。
