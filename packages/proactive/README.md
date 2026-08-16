# @cogito/proactive

Proactive push engine. A resident loop (adaptive energy scheduling) polls
data sources, judges candidates with an LLM agent tick (evidence-first),
writes delivery messages and hands them to an outlet (pi extension / IM).

When no candidates exist, the loop delegates to
`@cogito/drift` (idle-time background tasks driven by
user-written SKILL.md files).

```ts
import { runPusher } from "@cogito/proactive";

const { stop } = await runPusher({
  sources: { dailyhot: { enabled: true } },
  agentTick: { model: "deepseek-v4-flash", apiBaseUrl: "https://opencode.ai/zen/go/v1" },
  drift: { enabled: true },
});
```

## 生命周期

一次 tick 由生命周期模块图驱动(`src/ext/` 移植自 akashic proactive v2):

- `default`(默认):`proactive.run.start → proactive.admission.collect → proactive.sense
  → proactive.route → proactive.judge → proactive.resolve → proactive.commit
  → proactive.schedule`。gate 准入 → 感知 → 空候选转 drift 空闲分支 →
  LLM 判题(证据优先)→ 生成 → 投递 → 闭环调度。
- `wake`(蓄水池 + hazard 抽签):`wake.start → wake.ingest → wake.content.decide
  → wake.drift.decide → wake.schedule`。事件入蓄水池,新事件质量推动概率抽签,
  语义兴趣过滤,长时间无内容转 drift drive。经 `lifecycle: "wake"` 选择。

模块契约:每个模块声明 `slot` / `requires` / `produces` / `collects`,由
`ProactiveLifecycleBuilder` 做拓扑排序与依赖校验(数据 slot 含 `:`,模块 slot 含 `.`)。
`ProactiveKernel` 执行一次 tick:`newProactiveFrame(sessionKey, initialSlots)` →
按序 run 模块 → `frame.output`(base_score + next_interval_seconds)。

## 写一个 proactive 插件

插件文件放进数据源目录(`.cogito/extensions/proactive/`,或 `sourcesDir`),即可
贡献数据源、生命周期、模块、runtime 工厂。无需注册代码。

```ts
// my-plugin.ts — 插件可贡献数据源(旧格式「default 导出 source 类」仍兼容)
export const plugin = {
  name: "my-plugin",
  proactiveSources: () => [
    {
      id: "my-feed",
      label: "My Feed",
      defaultIntervalMs: 60000,
      channels: ["content"],
      async fetch() {
        return [{
          kind: "content",
          eventId: "item-1",
          preprocessScore: 0.6,
          source: "my-feed",
          title: "hello",
          url: "https://x/1",
        }];
      },
    },
  ],
  proactiveLifecycles: () => [],          // 自定义生命周期规格
  proactiveModules: () => [],             // 挂入所有生命周期的模块
  proactiveModuleFactories: () => [],     // 按 lifecycleId 提供模块
  proactiveRuntimeFactories: () => [],    // 按 lifecycleId 提供 runtime
};
```

`proactiveModules()` 会和选中生命周期的 module factory 结果一起装配。一个 lifecycle、runtime
factory 或 module factory 只能有一个 provider；重复 provider 会在启动时失败，而不是静默使用第一个。

一个文件即一个插件:导出 `plugin` 命名导出,或 default 导出插件对象/插件类。
加载失败(文件抛错/形状不符)只跳过该文件,不影响其余插件。

数据源可选实现 `ack(config, eventIds)`。通用 MCP source 支持如下 ACK 配置，Wake 会在外部确认失败时
保留 pending ACK 并在下一轮重试:

```json
{
  "sources": {
    "mcp": {
      "ack": {
        "server": "agent-reach",
        "tool": "ack_events",
        "eventIdsArg": "event_ids",
        "sourceIds": ["feed"]
      }
    }
  }
}
```

`sourceIds` 用于多个来源共享一个 MCP source 模块时，将事件里的 `ackSourceId` 路由到正确的 ACK handler；只有一个可 ACK source 时可省略。

### 宿主 runtime ports

嵌入 pi-cogito 时，可通过 `runtimePorts` 注入宿主的 session、presence、busy、memory、outbound
和 source ACK 实现。宿主实现优先于 standalone fallback；投递成功后，proactive 统一执行助手消息写入、
presence 更新和 source ACK。未注入时，`StandaloneRuntimeAdapter` 保留本地 presence 与 drift preference
读取能力。

```ts
await runPusher({
  runtimePorts: {
    session: {
      recentMessages: ({ sessionKey, limit, now }) => hostSession.recent(sessionKey, limit, now),
      appendAssistantMessage: ({ sessionKey, content, timestamp, proactive }) =>
        hostSession.append(sessionKey, { content, timestamp, proactive }),
    },
    outbound: {
      send: ({ sessionKey, message, sourceRefs, deliveryKey }) =>
        hostTransport.send({ sessionKey, message, sourceRefs, deliveryKey }),
    },
  },
});
```

source ACK 由默认与 Wake 生命周期共用 durable coordinator；失败会保留在
`source_ack_queue`，下次启动或 tick 前重试。可通过
`/api/dashboard/proactive/source_ack_queue` 查看队列及失败次数。重试使用持久化
`next_attempt_at` 和指数退避，可通过 `sourceAck.retryBaseDelayMs` 与
`sourceAck.retryMaxDelayMs` 调整；运维可用
`/api/dashboard/proactive/metrics` 同时查看 source 熔断状态、抓取统计和 ACK 队列。

### Source contract 与恢复语义

source 声明 `channels` 后进入严格 contract：`alert/content` 事件必须提供稳定的
`eventId`（或 `id`），`preprocessScore` 必须在 `[0,1]`，时间戳必须可解析且带 timezone，
`kind` 必须属于声明的 channel。单条非法记录会进入可查询 quarantine，同批合法记录继续处理；
source fetch 异常不会被伪装成空结果。Wake 只有在所有启用 source 都失败时才将本轮标记为整体失败，
部分成功和空结果分别记录在 `health.source.*`。默认 source 健康检查在连续 3 次失败后熔断，
5 分钟后执行半开探测；可通过 `sourceHealth.failureThreshold` 与 `sourceHealth.cooldownMs` 调整。

未声明 `channels` 的旧 source 视为 legacy content source：系统会生成按 source 隔离的确定性
identity，并在 health 中记录 synthetic identity 次数。新 source 应直接声明 `channels` 并由上游
提供 `eventId`。

Wake reservoir 的 consume、expire、ACK 提交使用 SQLite 事务；pending ACK 暴露 action/item identity，
过期 ACK 在 payload 丢失后仍会写 tombstone，避免事件重新入池。默认 source scheduler 持久化
last-fetch/backoff 状态，Feishu outlet 启动时默认 replay 未确认的 pending/partial/failed deliveries。

声明 `channels: ["context"]` 的 source 也可以返回一个 context object，Wake 会把它包装成单个
context snapshot；`alert/content` 仍必须返回 array。MCP source 支持有界 offset/cursor 分页，配置
示例：

```json
{
  "servers": [{
    "name": "feed",
    "calls": [{
      "tool": "news",
      "pagination": {
        "mode": "cursor",
        "pageSize": 50,
        "maxPages": 16,
        "cursorArg": "cursor",
        "nextCursorPath": "meta.next_cursor"
      }
    }]
  }]
}
```

分页 checkpoint 先写 pending，source batch 成功入库后才提交；进程异常会从 committed cursor 重放，
不会跳过尚未落库的页面。外部投递使用持久化 `idempotency_key`，重试复用相同逻辑消息 ID，并保存
provider message ID 与每目标 receipt。

### Fetch 调度与回放

默认 source fetch 由 proactive tick 驱动：gate 通过后，tick 在 sense 前执行当前到期的 source，
因此 source、候选读取和 tick 审计属于同一轮生命周期。scheduler 仍持久化每个 source 的
last-fetch/backoff 状态，重启不会重复绕过退避。需要独立后台轮询时可显式配置：

```json
{ "fetch": { "mode": "background" } }
```

配置 `replay.clockPath` 后使用持久化 `ReplayClock`，可通过 `clock.set()` / `clock.advance()`
推进模拟时间；`replay.journalPath` 保存 snapshot、lease、pause/resume、commit/abort/drain 事件。
配置 `replay.eventsPath` 后会把 Akashic 格式的 JSON/JSONL 历史事件作为
`historical-replay` source 接入 tick。需要离线完整重放时使用
`HistoricalTickReplayRunner`：它按 `available_at`（或固定间隔）推进时钟、批量入库、执行真实 tick，
并把每个 tick 的事件、入库统计、结果和错误写入 `replay.reportPath` JSONL；
`runHistoricalReplay` 是连接真实 `Pipeline` + `ProactiveEngine.runOnce()` 的便捷入口。
monitor 的 `/api/dashboard/proactive/runtime/replay?limit=100` 查询 runtime transition，
`/api/dashboard/proactive/runtime/replay/ticks?limit=100` 查询历史 tick 审计。

### Persona / VEDA 与被动 turn

配置 `persona.workspaceDir` 后默认读取 `memory/VEDA.md`；`persona.required: true` 会在缺失、空文件或
非法 UTF-8 时阻断 prompt，并可用 `resetVeda()` 原子重置且保留备份。VEDA 与行为规则会进入 default
proactive prompt，Drift 使用同一 VEDA 路径和行为规则。

`runPusher()` 返回的 `passiveTurn` 提供 `beforeTurn → beforeReasoning → afterReasoning → afterTurn`，
并通过 EventBus 发布四类事件；`createPassiveTurnLifecycleModules()` 可直接接到
`@cogito/agent-core` 的 lifecycle runner。

### 生命周期装配

`runPusher` 把目录插件注册进 `PluginRegistry`,再按 `lifecycle` 配置装配:
选 spec(`proactiveLifecycles`)→ runtime factory(`proactiveRuntimeFactories`,
按 `lifecycleId` 匹配)→ module factory(`proactiveModuleFactories`)→
`ProactiveKernel` 编译。内置 `default_proactive` / `wake_proactive` 插件同样
经注册表装配,因此自定义生命周期与内置生命周期走同一条路径:

```ts
// custom-lifecycle.ts — 完整自定义生命周期(贡献 spec + runtime + 模块)
export const plugin = {
  name: "custom",
  proactiveSources: () => [{ id: "src", label: "S", fetch: async () => [] }],
  proactiveLifecycles: () => [
    { id: "custom", modules: [], initialSlots: [], terminalSlots: ["run:next_wakeup"] },
  ],
  proactiveRuntimeFactories: () => [
    { lifecycleId: "custom", create() { return {}; } },
  ],
  proactiveModuleFactories: () => [
    {
      lifecycleId: "custom",
      create(runtime) {
        return [{
          slot: "custom.tick",
          produces: ["run:next_wakeup"],
          run(frame) {
            frame.output = { baseScore: 0.5, nextIntervalSeconds: 3600 };
            return frame;
          },
        }];
      },
    },
  ],
};
```

```json
{ "lifecycle": "custom" }
```

- default 生命周期用 `ProactiveEngine`(闭环调度 + rate trace);
- 其他生命周期(wake/自定义)用 `ProactiveLoop`(首轮立即 tick,按返回间隔休眠);
- runtime 若提供 `abortError`,自动挂到 `kernel.onTickError` 做 tick 异常收口;
  若提供 `close`,stop 时调用。

## 宿主接入、恢复与清理

需要接入自有消息渠道时，使用 `buildPusher()` 注入运行时 `DeliveryOutlet`。投递记录会先写入
`deliveries` outbox；outlet 必须把 `delivery.idempotency_key` 传给渠道提供方，并在已接受但进程中断
时让下一次 `send()` 使用同一个 key。这样可以恢复本地 pending 状态；是否真正只发送一次仍取决于渠道
提供方是否按 key 做幂等。

```ts
import { buildPusher, type DeliveryOutlet } from "@cogito/proactive";

const outlet: DeliveryOutlet = {
  async send(delivery) {
    const response = await hostTransport.send({
      text: delivery.message,
      idempotencyKey: delivery.idempotency_key,
    });
    return { status: "success", providerMessageId: response.messageId };
  },
};

const pusher = await buildPusher({
  delivery: { outlet },
  retention: { maxDeliveryAgeDays: 30, maxDeliveries: 1000, driftMaxRuns: 1000 },
});
await pusher.start();
// 宿主关闭时：await pusher.stop();
```

`delivery.outlet` 是 TypeScript 宿主运行时选项，不写入 JSON；JSON 配置仍可使用
`delivery.enabled` 和 `delivery.configPath` 选择内置 Feishu outlet。`buildPusher()` 每次组装时执行一次
保留清理：已确认 delivery、已结束 tick、过期候选、source failure/quarantine、context-only 时间戳和
daily count 可按天数清理；`maxDeliveries`、`maxTickLogs` 和 `driftMaxRuns` 限制保留数量。新候选、未确认
delivery、未完成 tick，以及 Drift 的 staged delivery/active run 都受保护。清理由 SQLite
`BEGIN IMMEDIATE` 串行化，不应绕过 pending outbox 直接删除数据库文件。

推荐从以下配置起步：

```json
{
  "delivery": { "enabled": false },
  "drift": {
    "enabled": true,
    "webPolicy": {
      "allowPrivateNetwork": false,
      "maxRedirectHops": 0,
      "allowedHosts": ["example.com", "*.trusted.example"]
    }
  },
  "retention": {
    "maxItemAgeDays": 30,
    "maxDeliveryAgeDays": 30,
    "maxDeliveries": 1000,
    "maxTickLogAgeDays": 30,
    "maxTickLogs": 1000,
    "maxSourceFailureAgeDays": 30,
    "maxSourceFailures": 2000,
    "maxQuarantineAgeDays": 30,
    "maxContextOnlyAgeDays": 30,
    "maxDailyCountAgeDays": 90,
    "driftMaxAgeDays": 90,
    "driftMaxRuns": 1000
  }
}
```

内置 `web_fetch` / `web_search` 默认拒绝 loopback、私网、链路本地、保留地址和本地域名；原生 HTTP
请求会解析全部 DNS 地址，拒绝其中任一不安全地址，并连接已校验的具体 IP，避免 DNS 重绑定窗口。
每一跳 redirect 都重新校验 host、DNS 和 allowlist；`maxRedirectHops` 默认 `0`，最多允许配置为 `5`。
如果宿主注入 `webFetchFn` 或 `webSearchFn`，宿主自己的 HTTP 客户端也必须执行同样的 redirect 与 DNS
策略；`webDnsLookupFn` 可用于宿主测试和 preflight 校验。

### 监控页接入

`@cogito/ui` 的宿主只需把两个数据库路径传给 `createWebApi()`：

```ts
createWebApi({
  sessionsDir,
  proactiveDbPath,
  driftDbPath,
});
```

Dashboard 的 Drift tab 会列出 active runs，并显示选中 run 的 stage、skill、tool steps 和历史结果。
对应 HTTP 端点是 `GET /api/dashboard/proactive/drift/active` 与
`GET /api/dashboard/proactive/drift/diagnostics/<run_id>`；未配置或数据库不存在时返回空列表/空结果，
不会阻塞其他监控页。

## 基础设施

- `src/clock.ts`:可注入 `Clock`(编排层与策略层统一取时间;测试用固定时钟)。
- `src/bus.ts`:类型化 `EventBus`。tick 终局发布 `ProactiveFinished`,投递成功发布
  `Delivered`。订阅返回退订函数;handler 异常不影响分发。monitor 在进程内订阅 EventBus
  实时事件，独立启动时自动降级为 SQLite 查询。
- `src/monitor.ts`:只读 HTTP 观测面(akashic dashboard API 移植),直接查询
  proactive.sqlite；可选查询 Wake tick、quarantine、source failure、source ACK retry、pending ACK 和 pending delivery。
  Wake 生命周期也会启动同一 monitor。
- rate trace 输出信封行:`{ trace_type, source, subject, ts, payload }`。
- delivery 表是持久 outbox。未配置外部出口时本地写入立即确认；配置 Feishu 时先写 pending，只有
  Feishu 接受后才标记候选 pushed、delivery acked 和 `lastDelivery`，失败记录会延迟重试；异步重试成功也会更新 presence、anyaction 配额和 `Delivered` 事件。

配置文件缺失仍按空配置处理；JSON 损坏或关键字段类型错误会直接报错。

主要新增观测端点：`/api/dashboard/proactive/source_quarantine`、
`/api/dashboard/proactive/source_failures`、`/api/dashboard/proactive/deliveries/pending`；配置
Wake 数据库后还可访问 `/api/dashboard/proactive/wake/tick_logs`、`wake/tick_errors`、
`wake/quarantine` 与 `wake/pending_acknowledgements`。

## 热重载

`runReloadablePusher` watch 源目录与配置文件。支持 pause/resume 的实例会先暂停旧 snapshot、等待
活动 lease 结束，再启动并校验候选；commit 后旧 snapshot 进入 retired 状态，所有 lease 释放后才 stop。
候选失败会 abort 并 resume 旧实例。带 `start/stop` 但没有 pause/resume 的旧式插件会自动适配为
幂等 pause/resume；只有 stop-only、无法重新启动的插件仍使用兼容回载路径。`EADDRINUSE`
(monitor 端口冲突)时停旧实例重试一次。
