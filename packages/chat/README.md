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

### 上下文与记忆增强(akashic 移植,全部默认开启、失败不影响回复)

```json
{
  "chat": {
    "memory": {
      "enabled": true,
      "injectProfile": true,
      "historyRoute": true
    },
    "context": {
      "budget": {
        "enabled": true,
        "hardPercent": 0.95,
        "keepRecentMessages": 40,
        "essentialTools": ["message_push", "web_fetch", "web_search", "memorize", "recall_memory"]
      }
    }
  }
}
```

- `memory.historyRoute`(默认 true):每轮用轻模型判断是否检索向量记忆
  (RETRIEVE/NO_RETRIEVE);命中 skip 时跳过检索但稳定档案(SELF/MEMORY/
  RECENT_CONTEXT)照常注入。决策按会话+查询缓存 10 分钟,LLM 失败自动回退为检索。
- 记忆注入块为富渲染:相对时间、证据可回源、procedure 步骤/触发词、低置信标注;
  `memorize`/`forget_memory` 写入后同一会话下一轮立即生效(缓存失效),无需等
  consolidation 轮询。
- 每轮对话结束后异步提取过程规则(procedure 记忆 + trigger_tags,按会话限流
  10 分钟);命中规则的工具调用返回规则文本(否定规则直接拦截,正向规则提示
  调整顺序)。仅覆盖 chat 注册工具,host 默认工具只记观察日志。
- `context.budget`(默认开启):上下文占用 ≥ `hardPercent` 时从最旧起成轮删除
  消息(保留最近 `keepRecentMessages` 条,不动最后一条 user);provider 请求
  仍超限时按 `essentialTools` 裁剪工具 schema(仅 OpenAI 兼容 payload)。
  裁剪后仍超限交 host 自动压缩兜底。
