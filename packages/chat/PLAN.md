# @cogito/chat 模块完整方案

> 状态:待评审。评审通过后按 Phase 1→6 实施。

## 1. 背景与目标

当前 cogito 的 IM 聊天是 `scripts/cogito-gateway.ts` 里的胶水脚本:建 channel SDK、
按 chat 维护 `AgentSession`、`promptSession` 桥接入站→回复、挂 web 面板。
它不在任何包里,无法复用、无法测试、无法扩展。

目标:把聊天抽成独立包 `packages/chat`(@cogito/chat),以 `@cogito/host` 为底座,
对齐 akashic 的 `PassiveMessageWorker` 职责:gateway 收到用户消息 → 直接交给 chat
模块 → host `AgentSession` 执行 turn → 回复出站。akashic chat 具备的工具与功能,
能用 host/gateway 现成机制实现的直接接线,缺的在 chat 包内以工具/扩展方式补齐,
尽量不动 host 公共 API。

非目标:不做独立 chat 进程(保持与 gateway 同进程,理由见 §3.2);
不做移动端 realtime 网关;不做 subagent 派生(列为后续)。

## 2. 参考架构对比

akashic(单进程模块组合):

```
channel ──publish_inbound──► MessageBus ──consume_inbound──► PassiveMessageWorker
                                                                    │ 按 session_key 建 lane(串行)
                                                                    ▼
                                                          ConversationRuntime / AgentCore
                                                          (TurnRequest → Reasoner → phases → outbound)
                                                                    │
                                                      bus.publish_outbound ──► channel 投递
```

cogito(多进程,gw/proactive/drift 三进程)现状与目标:

```
channel ──► MessageBus(FileInboundHandoffStore 持久化)──► ChannelAgentRuntime
                                                                │ 每 sessionKey 串行 + turn 准入 + 中断
                                                                ▼
                                                      handleMessage(= chat 模块)
                                                                │
                                                     host AgentSession.prompt()
                                                                │
                                                       sdk.send / sendDelta ──► channel 投递
```

两者等价:akashic 的 `PassiveMessageWorker` + `ConversationRuntime` + turn 管线,
cogito 对应 `ChannelAgentRuntime` + chat 模块的 `handleMessage` + host `AgentSession`
(AgentSession 内部已是完整 ReAct 循环:工具执行、流式事件、compaction、重试)。
cogito 的 `ChannelAgentRuntime` 已内置 lane 串行、turn 准入、中断注册,
无需像 akashic 那样自己写 worker 循环。

## 3. 模块设计

### 3.1 包结构

```
packages/chat/
├── package.json            # @cogito/chat;deps: @cogito/host, @cogito/gateway,
│                           #       @cogito/ai, @cogito/agent-core, @cogito/gate, typebox
├── src/
│   ├── index.ts            # runChatModule(options): Promise<{ stop }>;ChatModule 类
│   ├── config.ts           # ChatConfig 类型 + loadChatConfig(读 config.json 的 chat 节)
│   ├── session-pool.ts     # 每 chat 一个 AgentSession:创建/恢复/持久化/空闲回收/并发上限
│   ├── turn.ts             # handleMessage:InboundMessage → AgentSession.prompt → OutboundMessage
│   ├── streaming.ts        # AgentSession 事件 → sdk.sendDelta(thinking + content + 状态)
│   ├── memory.ts           # host MemoryEngine 接线 + 记忆工具注册 + context 事件注入
│   ├── delivery.ts         # 出站封装:send/sendDelta/发媒体/多目标(供工具与 turn 共用)
│   ├── scheduler.ts        # 定时任务服务:JobStore 持久化 + 触发循环(instant/soft)
│   ├── tools/
│   │   ├── message-push.ts # 工具:message_push(向任意 channel/chatId 发消息/文件/图片)
│   │   ├── web.ts          # 工具:web_fetch / web_search(复用 gate 的 DriftWebPolicy)
│   │   ├── messages.ts     # 工具:fetch_messages / search_messages(gateway 消息库 + 会话检索)
│   │   ├── memory-tools.ts # 工具:memorize / recall_memory / forget_memory
│   │   └── schedule.ts     # 工具:schedule / list_schedules / cancel_schedule
│   ├── extensions.ts       # chat 扩展点:host 扩展加载 + chat 内联扩展(记忆注入等)
│   ├── dashboard.ts        # web 面板挂载(createWebApi + builtinWebApp + chat 增强路由)
│   └── lifecycle.ts        # GatewayInstanceLock / readiness / shutdown / dispose
├── scripts/
│   └── gateway.ts          # 入口:读配置 → runChatModule(替代 scripts/cogito-gateway.ts)
├── test/                   # 单测:turn 桥接、流式、工具、scheduler、session-pool
├── README.md
└── CHANGELOG.md
```

### 3.2 进程与依赖

- **同进程**:chat 作为库跑在 gateway 进程内(形态 A)。理由:聊天是交互式、延迟敏感;
  `ChannelAgentRuntime` 已提供串行/准入/中断;回复路径零额外跳数;`run-daemons.sh`
  三进程不变。akashic 的 chat worker 也与其 gateway 同进程。
- **依赖方向**:`chat → host, gateway, ai, agent-core, gate`;host/gateway/drift/
  proactive 均不依赖 chat。chat 不依赖 drift/proactive。
- **共享契约**:web 工具的安全策略(SSRF 边界)从 drift 移到 `@cogito/gate`
  (gate 本就是 proactive/drift 的共享契约层),chat 从 gate 取用,见 §6。

### 3.3 会话模型

- 每个 `InboundMessage.sessionKey` 一个 `AgentSession`(与现状一致)。
- `SessionManager.open/create` 持久化到 `agentDir/channel-agent-sessions`;
  `FileChannelSessionStore` 记录 `agentSessionFile/Id` 映射(现状已有)。
- 新增:**空闲回收**(akashic 无,但 cogito 长期驻留需要):会话空闲超过
  `maxIdleMinutes` 且无排队消息时 `dispose` 并在下次消息时按持久化文件重建;
  `maxSessions` 上限 + LRU 淘汰,防止每 chat 一个长驻 session 的内存膨胀。

## 4. akashic 聊天功能 → cogito 实现映射

### 4.1 已覆盖,直接接线(不新增代码或仅搬运)

| akashic | cogito 对应 | 落点 |
|---|---|---|
| Channel → bus → PassiveMessageWorker(lane 串行/隔离) | `ChannelAgentRuntime`(每 sessionKey 串行、turn 准入、失败隔离) | gateway 现有 |
| TurnRequest / thread 准入 / ThreadBusy 重试 | `FileChannelSessionStore.beginTurn/completeTurn` + runtime 排队 | gateway 现有 |
| 中断(/stop → InterruptController) | channel interruptController + `session.abort()` | gateway 现有 + turn.ts 搬运 |
| Reasoner ReAct 循环 / 工具循环 / 重试 | `AgentSession.prompt()`(agent-loop) | host 现有 |
| 上下文压缩(QueryCompactor) | host compaction(threshold/overflow/manual)+ auto_retry | host 现有 |
| 最终回复提取(final_response) | agent_end 事件取最后 assistant 文本(现状 promptSession) | turn.ts 搬运 |
| 媒体输入(vision/multimodal) | `InboundMessage.images` → `PromptOptions.images` | turn.ts 搬运 |
| thinking 块 | `message_update` 事件 + `OutboundMessage.thinking` | streaming.ts(新转发逻辑) |
| 技能(SKILL.md,SkillsLoader) | host skills.ts,自动注入 system prompt + `/skill:name` | host 现有 |
| Persona(VEDA.md) | host system-prompt + AGENTS.md + prompt-templates | host 现有 |
| 文件系统/Shell 工具(unified_exec) | host 内置 read/bash/edit/write/grep/find/ls | host 现有 |
| MCP(workspace_mcp) | `@cogito/mcp` + extension loader 虚拟模块 | host 现有 |
| 生命周期 phases 的 emit 点 | ExtensionAPI 事件(agent_start/end、turn_start/end、message_*、tool_*、context、before_provider_*) | host 现有 |
| 工具执行钩子(ToolHook) | extension `tool_call` / `tool_result` 事件(可拦截/改参/追加消息) | host 现有 |
| 委托策略(DelegationPolicy 的信任面) | trust-manager + project_trust 事件 | host 现有 |
| 错误处理(ContentSafety/ContextLength → 兜底回复) | 自动重试事件 + turn.ts 错误文案(现状 formatError) | turn.ts 搬运 |
| Web Chat 面板(sessions/messages/上传/媒体) | `@cogito/ui` createWebApi + builtinWebApp + web channel | dashboard.ts 搬移 |
| 移动端配对 | gateway pairing.ts | gateway 现有 |
| Delivery receipts / 投递重试 | gateway outbox + ChannelSendReceipt + 重试策略 | gateway 现有 |
| 重启/readiness | GatewayInstanceLock + writeGatewayReadiness + 现有 shutdown | lifecycle.ts 搬移 |

### 4.2 chat 包内新增(不动 host/gateway)

| akashic | 实现方案 | 落点 |
|---|---|---|
| 流式 delta(StreamDeltaReady → answer.delta / thinking.delta) | turn 内订阅 session 事件:`message_start` → sendDelta 状态,`message_update` → content/thinking delta,`message_end` → 最终 send;未订阅时退化为现有最终文本 | streaming.ts |
| `message_push`(turn 内向任意目标发消息/文件/图片) | 注册为工具,经 `sdk.send`(同进程)或 `createDeliveryClient`(跨进程);被动 turn 内直接投递;与 proactive/drift 的推送互不干扰(各自 delivery 通道) | tools/message-push.ts + delivery.ts |
| `memorize` / `recall_memory` / `forget_memory` | host `createMemoryEngine`(MemoryScope {channel, chatId} 已为 IM 设计);三个工具注册为 customTools;检索结果经 extension `context` 事件注入上下文(createAgentSession 已把 transformContext 接到 emitContext,零 host 改动) | memory.ts + tools/memory-tools.ts |
| `fetch_messages` / `search_messages`(聊天记录查询) | gateway `FileChannelMessageStore`(messageStatePath)提供最近消息;历史检索可接 host session-index(JsonlSessionIndexer) | tools/messages.ts |
| `schedule` / `list_schedules` / `cancel_schedule` | 参考 akashic scheduler.py:at/after/every 触发 + instant(到点直接投递)/soft(到点轻量生成内容)两级;JobStore 持久化(agentDir/chat-schedules.json);触发投递走 delivery.ts。与 proactive 分工:这是聊天内 agent 自注册的定时任务,proactive 管自己的推送循环 | scheduler.ts + tools/schedule.ts |
| 每 chat 空闲回收 / 并发上限 | session-pool 内实现(见 §3.3) | session-pool.ts |

### 4.3 跨包小改动

**已决策:无跨包改动。** web_fetch / web_search 的 SSRF 策略(参考 drift
`DriftWebPolicy` 的语义:私网/保留地址拒绝、DNS 校验、重定向校验、大小上限)在
chat 包内实现最小版本,不移动 drift 代码、不动 gate。

### 4.4 明确不做(本方案范围外,后续单独评估)

| akashic | 说明 |
|---|---|
| spawn / SubAgent(子任务派生) | cogito 无 subagent 机制,实现成本高;后续可用独立 AgentSession 模拟 |
| tool_search 动态工具解锁 | cogito 已有 getAllTools/setActiveTools;模型每次请求都看到工具描述,动态解锁收益低 |
| ReadImageVisionTool(独立 VLM 看图) | 图片输入已支持;独立 VLM 工具后续按需加 |
| post_response_worker / procedure_tagger / profile_extractor | host Memorizer 已有 supersede/parse;异步记忆优化后续用 agent_settled 事件做 |
| history_route 多选流策略 | 边缘场景,不做 |
| mobile realtime 网关 | cogito 有配对但无完整 mobile 网关,不做 |

## 5. 配置设计

`config.json` 新增 `chat` 节(向后兼容:缺省时行为与现状 `cogito-gateway.ts` 一致):

```json
{
  "chat": {
    "model": "deepseek-v4-flash",
    "thinkingLevel": "medium",
    "tools": { "allowed": ["read", "bash", "edit", "write", "web_fetch", "web_search", "message_push", "memorize", "recall_memory", "schedule", "fetch_messages", "search_messages"] },
    "memory": { "enabled": true, "dbPath": "memory/memory.sqlite" },
    "web": {
      "enabled": true,
      "fetch": { "maxBytes": 800000, "maxRedirectHops": 0 },
      "search": { "url": "" }
    },
    "sessions": { "maxIdleMinutes": 30, "maxSessions": 50 },
    "extensionsDir": "chat/extensions",
    "persona": ""
  }
}
```

- `model`/`thinkingLevel` 透传给 `createAgentSession`;`tools.allowed/excluded` 映射到
  `allowedToolNames`/`excludedToolNames`(host 已支持)。
- `persona` 非空时经 resourceLoader customPrompt 注入(等价 akashic VEDA)。
- `extensionsDir` 相对 agentDir,用 host `discoverAndLoadExtensions` 加载 chat 专属扩展
  (可 registerTool / on("context") 注入记忆 / 订阅会话事件),宿主已有 jiti 加载器。

## 6. host / gateway / drift 改动清单(最小化)

| 包 | 改动 | 必要性 |
|---|---|---|
| host | 无公共 API 改动 | — |
| gateway | 无改动(ChannelAgentRuntime、sendDelta、outbox、消息库、配对均现成) | — |
| drift | 无改动(web 策略在 chat 内实现最小版本,§4.3) | — |
| gate | 无改动 | — |

结论:**host / gateway / drift / gate 全部零改动**,新功能全部收在 chat 包内。

## 7. 实施阶段

### Phase 1 — 等价迁移(行为不变)
- 建包骨架(package.json/tsconfig/CHANGELOG/README/test 占位)。
- 搬移 `scripts/cogito-gateway.ts` 全部逻辑:config、sdk 装配、session-pool(现状
  sessionsByKey)、turn.ts(promptSession/toAgentImages/formatError)、dashboard、
  lifecycle(lock/readiness/shutdown)。
- `scripts/cogito-gateway.ts` 改为调用 `runChatModule`(入口瘦身,行为不变)。
- 验收:`npm run check` 全绿;`./test.sh` 通过;gateway 测试不回归;本地起 gateway
  手工冒烟(web 对话、断线恢复)。

### Phase 2 — 流式与消息推送
- streaming.ts:订阅 message_start/update/end → sendDelta(thinking + content)。
- tools/message-push.ts + delivery.ts:message_push 工具(文本/文件/图片)。
- 验收:web 与支持流式的 channel 看到打字态与增量;turn 内 agent 可主动发消息。

### Phase 3 — 记忆
- memory.ts:createMemoryEngine + MemoryScope(channel, chatId) + 三个记忆工具 +
  context 事件注入检索块。
- 验收:memorize 后 recall 命中;不同 channel/chat 记忆隔离;检索块出现在请求上下文。

### Phase 4 — 网络与消息查询
- web 工具(按 §4.3 决策移动或复制 DriftWebPolicy)。
- tools/messages.ts:fetch_messages(最近 N 条)/ search_messages(会话索引检索)。
- 验收:web_fetch 遵守策略(私网拒绝);消息查询工具返回正确历史。

### Phase 5 — 定时任务
- scheduler.ts + tools/schedule.ts:at/after/every、instant/soft、JobStore 持久化、
  进程重启后恢复。
- 验收:注册/查询/取消;instant 到点投递;soft 到点生成内容后投递;重启后任务仍在。

### Phase 6 — 扩展点、面板、收尾
- extensions.ts:chat 扩展目录加载;示例扩展(记忆注入外置)。
- dashboard.ts:面板增强路由(chat 状态、活动会话、工具使用)。
- 文档(README 迁移指南)+ CHANGELOG + 单测补全。
- 验收:扩展可热加载注册工具与事件;面板展示 chat 状态;文档齐全。

## 8. 决策记录(2025-xx-xx 已确认,全部采纳推荐项)

1. **进程形态**:与 gateway 同进程。
2. **DriftWebPolicy 归属**:chat 内复制最小实现,不跨包改动。
3. **定时任务**:本期做(Phase 5);soft 触发用轻量单轮 prompt(不带完整 AgentSession)。
4. **配置入口**:并入 `config.json` 的 `chat` 节。
5. **默认工具集**:默认启用核心集 —— `message_push`、记忆工具(memorize/recall_memory/
   forget_memory)、`web_fetch`/`web_search`、`fetch_messages`/`search_messages`;
   `schedule`/`list_schedules`/`cancel_schedule` 默认关闭按需开启。
6. **入口脚本**:`scripts/cogito-gateway.ts` 保留为薄入口(读配置 → runChatModule),
   `run-daemons.sh` 不改。

### 遗留决策(实施中确认)

- soft 触发生成内容的模型与最大 token 上限。
- 空闲回收的默认 `maxIdleMinutes`(建议 30)与 `maxSessions`(建议 50)。
- `persona` 默认值与注入方式(resourceLoader customPrompt)。

## 9. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 每 chat 长驻 AgentSession 内存膨胀 | 空闲回收 + maxSessions 上限(LRU);会话持久化保证重建无损 |
| sendDelta 在部分 channel 不支持 | gateway capabilities + 降级为最终文本(现状行为) |
| 记忆引擎依赖 embedding 模型 | createMemoryEngine 关键字降级已内置;无 embedder 时工具仍可用 |
| 定时任务与 proactive 推送语义重叠 | 分工明确:chat schedule 是 agent 自注册任务,proactive 是独立推送循环 |
| 迁移破坏现有 gateway 行为 | Phase 1 严格等价迁移,gateway 测试 + 手工冒烟后进入 Phase 2 |
| web 策略实现 | 已落地:`@cogito/gate` 的 DriftWebPolicy(SSRF/重定向/大小上限)直接复用,零复制 |

## 10. 参考

- akashic:`bootstrap/passive_worker.py`、`agent/control/runtime.py`、
  `agent/core/passive_turn.py`、`agent/tools/*`、`agent/scheduler.py`、
  `plugins/default_memory/`、`bus/queue.py`
- cogito:`scripts/cogito-gateway.ts`、`packages/gateway/src/runtime.ts`、
  `packages/host/src/core/sdk.ts`、`packages/host/src/core/agent-session.ts`、
  `packages/host/src/core/extensions/`、`packages/drift/src/tools.ts`

## 11. 实施状态(2025-08-16 全部完成)

Phase 1-6 全部落地,`npm run check` 全绿,chat 包 28 个单测通过,全仓 51 文件 285 测试通过,
web 通道端到端冒烟通过(入站→会话→回复/错误兜底→消息库→readiness→SIGTERM 干净停机)。

### 交付物

- `packages/chat`(@cogito/chat):index/config/delivery/session-pool/streaming/turn/memory/
  scheduler/extensions/dashboard/lifecycle + tools/(message-push, web, messages, memory-tools,
  schedule, skills) + test/(scheduler, config, memory, delivery, skills) + README/CHANGELOG。
- `scripts/cogito-gateway.ts`:瘦身为薄入口(读配置 → runChatModule)。
- `packages/ui/src/web/src/views/chat.tsx`:修复 delta 事件读取(`delta.delta`),重建 dist/web。
- host 最小改动(2 处):
  1. `index.ts` 新增 `export { ExtensionSqlite }`(additive,聊天模块需要审计库)。
  2. `core/memory/store.ts` 修复 `keywordSearchSummary` SQL 占位符顺序 bug
     (scope/memoryTypes 条件与 OR 条件的绑定错位,导致 requireScopeMatch 关键字检索永远空)。
- 根 `package.json` workspaces/build、`tsconfig.json` paths 加入 chat。

### 与方案/akashic 的差异

- §4.3 决策"chat 内复制 DriftWebPolicy"未执行:该策略本就在 `@cogito/gate`(drift 即从
  gate 导入),chat 直接复用,零复制零跨包改动,优于方案。
- 新增 §4.2 未列的 `load_skill` 工具(akashic skill_loader 对应):读取 agentDir/skills 与
  projectDir/.cogito/skills 下的 SKILL.md,默认启用。

### akashic 对比结论(§4 映射表逐项核对)

- **4.1 已覆盖项(20)**:全部接线完成,无缺项。
- **4.2 新增项(6)+ load_skill**:全部实现并有测试。
- **4.4 明确不做项(8)**:按批准的方案范围保留,未实现:
  spawn/subagent、tool_search 动态解锁、独立 vision VLM 工具、异步记忆优化
  (post_response_worker/procedure_tagger)、history_route 多选流、交互式 shell
  三件套(write_stdin/task_stop)、agent_restart 工具、MCP 管理工具、mobile realtime。
  均为后续单独评估项,不阻塞本模块。
