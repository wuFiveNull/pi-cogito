# Gateway Channel 消息能力升级方案(对齐 nanobot)

> **实施状态:全部完成(2026-01 实施)。** 每个里程碑的最终改动与测试见文末
> "实施记录"。

目标:把 nanobot 在 channel 消息维度做得好、而本 gateway 缺失或薄弱的能力补齐。
对照结论(详见此前审计):

- 本 gateway 已有且保持:出站 outbox / 投递回执、入站去重+重试+死信、有界队列背压、
  入站限流、媒体能力声明、消息历史、channel 热重配。
- 需要补齐(nanobot 领先项):① 类型化出站事件 ② 进度/工具提示/推理/文件编辑语义
  ③ 流式覆盖(telegram 等编辑原消息) ④ 按钮 ⑤ 配对码 ⑥ 多实例 ⑦ 流 delta 合并
  ⑧ 出站内容指纹去重 ⑨ 入站 per-session 串行调度。

设计原则:

- 不破坏现有可靠投递层(outbox/handoff/回执照旧)。
- 出站消息模型扩展为"内容 + 类型化事件",与 nanobot `OutboundMessage.event` 对齐;
  旧的 metadata 旗标走兼容桥,迁移期两者都能发。
- 每个渠道声明能力 + 实现原语方法,dispatcher 按事件类型路由;渠道没实现的能力
  由基类提供可用的降级实现(绝不静默丢用户可见内容,与现有 media 校验哲学一致)。
- 分里程碑实施,每个里程碑独立可测、可合并。

---

## M1 类型化出站事件(地基)

### 1.1 新文件 `src/events.ts`

```ts
/** 出站事件标记基类。 */
export abstract class OutboundEvent {}

/** 过程性进度/工具提示/推理/文件编辑。 */
export class ProgressEvent extends OutboundEvent {
  content = "";
  toolHint = false;
  toolEvents?: Array<Record<string, unknown>>;
  fileEditEvents?: Array<Record<string, unknown>>;
  reasoning = false;      // 一次性推理块(整段)
  reasoningDelta = false; // 推理增量
  reasoningEnd = false;   // 推理段结束
  streamId?: string;
}

/** 流式增量(走 delta 队列)。 */
export class StreamDeltaEvent extends OutboundEvent {
  content = "";
  streamId?: string;
}

/** 流式结束(走 delta 队列,带 resuming/merge_next 语义)。 */
export class StreamEndEvent extends OutboundEvent {
  content = "";
  streamId?: string;
  resuming = false;
  /** true 表示下一段文本属于同一条用户可见消息(重试续写边界)。 */
  mergeNext = false;
}

/** 一次性完整回复(流式已完成的最终落盘消息)。 */
export class StreamedResponseEvent extends OutboundEvent {}

/** 整轮 turn 结束(延迟、goal 状态)。 */
export class TurnEndEvent extends OutboundEvent {
  latencyMs?: number;
  goalState?: Record<string, unknown>;
}

/** 重试等待提示(agent 侧在等待 provider 重试)。 */
export class RetryWaitEvent extends OutboundEvent {
  content = "";
}

/** 运行时会话/模型状态变更(供 WebUI 渲染)。 */
export class SessionUpdatedEvent extends OutboundEvent {
  scope?: string;
}
export class RuntimeModelUpdatedEvent extends OutboundEvent {
  model?: string | null;
  modelPreset?: string | null;
}
```

辅助函数(全部在 `events.ts`):

- `outboundEventFromMessage(msg: OutboundMessage): OutboundEvent | undefined`
  优先 `msg.event`,否则读兼容旗标(`_stream_delta`/`_stream_end`/`_progress`/
  `_reasoning*`/`_file_edit_events`/`_tool_events`/`_tool_hint`/`_retry_wait`/
  `_turn_end`/`_session_updated`/`_runtime_model_updated`),返回对应事件。
- `outboundMessageForEvent({ channel, chatId, event, content?, metadata? })`
- `replaceOutboundEvent(msg, event, content?)`

### 1.2 `src/types.ts` 改动

```ts
export interface OutboundMessage {
  // ...现有字段不变...
  /** 类型化出站事件(nanobot 对齐)。缺省无,即普通文本消息。 */
  event?: OutboundEvent;
}

export interface OutboundDelta {
  // ...现有字段不变...
  /** 事件化增量:仅 StreamDeltaEvent/StreamEndEvent。 */
  event?: StreamDeltaEvent | StreamEndEvent;
}
```

### 1.3 `src/bus.ts` 改动

- `publishOutbound`/`publishDelta` 不变(事件只是消息的字段)。
- 新增 `recordOutbound` 已存在,无需动。

### 1.4 兼容性

- 旧的 metadata 旗标继续工作(`outboundEventFromMessage` 兜底),但新代码一律用
  `msg.event`。迁移完成后可删旗标读取分支。

---

## M2 dispatcher 类型路由 + 渠道语义原语

### 2.1 `src/channels/base.ts`:渠道原语扩展

```ts
export interface ChannelConfig extends ... {
  /** 是否发送过程性进度文本(默认 true)。 */
  sendProgress?: boolean;
  /** 是否发送工具调用提示(默认 true)。 */
  sendToolHints?: boolean;
  /** 是否投递推理/思考内容(默认 true;渠道无渲染原语时自动降级)。 */
  showReasoning?: boolean;
  /** 渠道声明的富能力(默认全 false,除 streaming)。 */
  capabilities?: Partial<ChannelCapabilities>;
}
```

BaseChannel 新增原语方法(全部有可用默认实现,不抛错):

```ts
/** 渠道能力声明:供 dispatcher 门控与 SDK capabilities() 暴露。 */
get capabilities(): ChannelCapabilities {
  return {
    streaming: this.supportsStreaming,
    reasoning: this.sendReasoningDelta !== BaseChannel.prototype.sendReasoningDelta,
    fileEdits: this.sendFileEditEvents !== BaseChannel.prototype.sendFileEditEvents,
    progress: true, // 文本降级恒可用
    buttons: false,
  };
}

/** 过程性消息(进度/工具提示)。默认:整条作为普通文本发送。 */
async sendProgress(message: OutboundMessage): Promise<void | ChannelSendResult> {
  return this.send(message);
}

/** 推理增量。默认 no-op(无低强调渲染原语的渠道不展示)。 */
async sendReasoningDelta(chatId, delta, metadata?, streamId?): Promise<void> {}

/** 推理段结束。默认 no-op。 */
async sendReasoningEnd(chatId, metadata?, streamId?): Promise<void> {}

/** 一次性推理块。默认 = 一个 delta + end(渠道只需实现流式原语)。 */
async sendReasoning(message: OutboundMessage): Promise<void> {
  if (!message.content) return;
  await this.sendReasoningDelta(message.chatId, message.content, message.metadata, streamIdOf(message));
  await this.sendReasoningEnd(message.chatId, message.metadata, streamIdOf(message));
}

/** 结构化文件编辑事件。默认 no-op。 */
async sendFileEditEvents(chatId, edits, metadata?): Promise<void> {}

/** 按钮回调回灌(渠道收到按钮点击后调用,默认拒绝)。 */
protected async handleButtonClick(input): Promise<ChannelPublishResult> {
  return { status: "filtered", messageId: createMessageId(this.name) };
}
```

`sendDelta` 签名扩展(带 `resuming`/`mergeNext`,默认 false,避免破坏现有调用):

```ts
async sendDelta(delta: OutboundDelta): Promise<void>;
// OutboundDelta 增加字段:resuming?: boolean; mergeNext?: boolean;
```

### 2.2 `src/channels/dispatcher.ts`:按事件类型路由

`outboundLoop` 处理 `OutboundMessage`:

```
event = outboundEventFromMessage(msg)
switch:
  ProgressEvent:
    reasoningDelta/reasoningEnd  -> 若 channel.showReasoning 且渠道支持,调
                                     sendReasoningDelta/End;否则丢弃(与 nanobot 一致)
    reasoning(一次性)            -> 同上,调 sendReasoning
    fileEditEvents               -> channel.sendFileEditEvents(不经重试?走 sendWithRetry 统一)
    toolHint                     -> 若 sendToolHints 门控通过, channel.sendProgress
    普通 progress                -> 若 sendProgress 门控通过, channel.sendProgress
  RetryWaitEvent                 -> 丢弃
  StreamedResponseEvent          -> 不重发(只用于回执/落盘语义)
  TurnEndEvent / SessionUpdated /
  RuntimeModelUpdated            -> 无 IM 渲染,仅转发给 web/websocket(见 2.4)
  无事件(普通文本)               -> channel.send(msg)(现有路径)
```

`deltaLoop` 处理增量:

- 事件化增量(`StreamDeltaEvent`/`StreamEndEvent`)与现有裸 delta 统一进
  `channel.sendDelta`(裸 delta 语义 = StreamDeltaEvent)。
- **流 delta 合并**(新增,对齐 nanobot `_coalesce_stream_deltas`):
  `_coalesceStreamDeltas(first)` 从 delta 队列连续取同 (channel, chatId, streamId)
  的 `StreamDeltaEvent`,拼接 content 合并为一次调用;遇到 `StreamEndEvent`
  或不同目标即停止,把未匹配项退回待处理缓冲(`pending` 数组,dispatcher 已有循环
  结构,只需加一个 pending 列表)。

### 2.3 出站内容指纹去重(新增)

dispatcher 维护 `originReplyFingerprints: Map<`${channel}:${chatId}:${originMessageId}`, sha1>`:

- 仅对**非流事件**生效(stream/progress 放行,与 nanobot 一致)。
- `metadata.originMessageId`(或 `messageId`)存在时,对 content 归一化空白后取
  sha1;同 key 同指纹 → 抑制并日志。
- 上限 4096 条,LRU 淘汰。

### 2.4 web/websocket 事件透传

- `web.ts` SSE:事件名扩展 `progress`/`reasoning`/`turn_end`,payload 带 `kind`;
  现有 `message`/`delta`/`stopped`/`turn` 不变。
- `websocket.ts`:outbound frame 增加 `kind` 字段(`progress`/`tool_hint`/
  `reasoning`/`file_edits`),对齐 nanobot websocket 的 kind 语义。

---

## M3 telegram 渠道补齐(优先级最高,差距最大)

### 3.1 流式:`sendDelta` 编辑原消息(对齐 nanobot telegram runtime)

- 新配置:`streamEditIntervalMs`(默认 600)、`maxStreamLength`(4000)。
- 状态:`_streamBufs: Map<chatId, { messageId?, text, streamId?, lastEditAt }>`。
- 首帧:`sendMessage`(带 reply_to_message_id、parse_mode 可选)。
- 后续帧:节流(`streamEditIntervalMs`)内累积,超时或 `streamEnd` 时
  `editMessageText`;超过 4000 字符先 `sendMessage` 分块(仿
  `_flush_stream_overflow`)。
- `streamEnd`:`editMessageText` 最终版;`mergeNext` 时不结束(续写边界);
  `resuming` 时忽略(避免旧流覆盖新流)。
- `message is not modified` 错误静默(BadRequest 400),其余错误抛出走重试。
- 复用现有 `post` 注入式 HTTP,测试用 mock。

### 3.2 入站:非文本消息 + 媒体下载 + 音频转写

- `TelegramUpdate.message` 扩展 `photo/voice/audio/document/video/video_note/animation`。
- 下载走 `getFile` + `getFile` 路径拉字节:
  - 图片 → `images: [{ type: "image", data: base64, mimeType }]`(进 InboundMessage,供多模态)。
  - 音频(voice/audio)→ 依赖注入转写:`channelContext.transcriber?: (data, mime) => Promise<string>`
    (context.ts 扩展,宿主提供 Whisper 实现;无转写器则记 `[audio]` 占位文本)。
  - 文件 → `attachments: [{ kind: "file", source: 本地缓存路径或 data URL }]`。
- 媒体组(`media_group_id`)缓冲 600ms 合并一轮(可选,后置)。

### 3.3 群聊 @ 策略落地

- `processUpdate` 解析 `entities`(`mention`/`text_mention`)与 `reply_to_message`:
  命中 bot 用户名或回复 bot → `metadata.mentionedBot = true`;群聊
  (`chat.type !== "private"`)未 @ 且 `group.requireAt` 打开 → 不响应。
- 同时把 `chat.type` 写入 `metadata.chatType`,`isAllowedGroup` 已有的
  metadata 分支即可生效(base.ts:202 无需改)。

### 3.4 按钮

- `OutboundMessage.buttons?: string[][]`(types.ts 新增,对齐 nanobot)。
- 发送:`sendMessage` 附 `reply_markup.inline_keyboard`(每行一组,label 截 64 字节)。
- 回调:轮询 `callback_query` 更新 → 以"按钮label回灌"方式调
  `handleMessage`(`metadata.button = true`),代理可看到按钮点击文本。

### 3.5 推理渲染(低强调)

- `sendReasoningDelta`:累积到 `_reasoningBuf`,`sendReasoningEnd` 时用
  `<blockquote expandable>...</blockquote>` 发一条(或附在正文前)。
- 默认关闭 `showReasoning` 也可(配置决定)。

---

## M4 其余渠道补齐(按收益排序)

### 4.1 slack.ts

- `sendDelta`:编辑原消息(`chat.update`,ts 存 buffer);不支持则降级为整条。
- `sendReasoningDelta/End`:`context` block(低强调)累积渲染。
- `sendFileEditEvents`:no-op。
- 按钮:`buttons` → Block Kit `actions` block,`_on_button_action` 回灌文本
  (slack 事件订阅已存在,补 interactive endpoint)。

### 4.2 feishu.ts

- 修掉 `delta.type === "thinking"` 直接丢弃:改为 `sendReasoningDelta/End`
  在卡片内低强调区渲染;无卡片能力时至少不丢(合并进正文)。
- 按钮:CardKit action 回调 → 回灌(后置)。

### 4.3 discord.ts / matrix.ts / mattermost.ts

- 至少补 `sendDelta`(编辑原消息,三者 API 均支持 edit);discord 的 reasoning
  用 subtext 渲染(低优先级,可后置)。

### 4.4 onebot.ts / email.ts / console.ts / websocket.ts

- onebot:保持整条发送,progress 合并进文本。
- console/email:不变(文本降级路径天然可用)。

---

## M5 入站 per-session 串行调度(对齐 nanobot agent/loop.py)

### 5.1 `src/sdk.ts` dispatch 改造

现状:`dispatch` 用 `Promise.allSettled` 并发调全部 handler,同会话消息可能乱序。

设计:新增 `src/scheduler.ts`

```ts
export interface TurnSchedulerOptions {
  /** 每 session 串行执行;默认 true。 */
  serializeBySession?: boolean;
  /** 全局并发 turn 上限(0 = 不限制);默认 0。 */
  maxConcurrentTurns?: number;
}

export class TurnScheduler {
  // 每 sessionKey 一个 promise 链(先进先出,天然保序)
  // 全局信号量(可配)
  enqueue(message: InboundMessage, run: () => Promise<void>): void;
}
```

- `ChannelSdk` 持有 `TurnScheduler`,`dispatch` 改为
  `scheduler.enqueue(message, () => handlers(message))`。
- 消费者语义不变:`onInbound(consume: true)` 的 drainer 在**整条链完成**后
  ack —— 与 bus 现有 `Promise.all(drainPromises)` 兼容(链内串行,
  链间并行,都 await 完成后才 ack)。
- `AgentAdapter`(agent.ts)的 `consumeInbound` 拉取路径:由宿主自行用同一
  scheduler(导出实例),FakeAgent 演示串行用法。

### 5.2 优先级(可选,后置)

- 入站消息带 `metadata.priority` 时插队(不承诺,标记 P3)。

---

## M6 配对码(pairing)(对齐 nanobot channels/pairing)

### 6.1 新文件 `src/pairing.ts`

```ts
export interface PairingStore {
  isApproved(channel: string, senderId: string): boolean;
  generateCode(channel: string, senderId: string): string; // 8 字符 ABCD-EFGH,TTL 10min
  approve(channel: string, senderId: string): void;
  deny(channel: string, senderId: string): void;
  list(): PairingRecord[];
}
export class FilePairingStore implements PairingStore { /* path 可选,默认 ~/.cogito/pairing.json */ }
export class InMemoryPairingStore implements PairingStore {}
```

### 6.2 `src/channels/base.ts` 改造

- `ChannelConfig.pairing?: boolean | { store?: PairingStore }`,默认 false
  (**行为不变**:现无 allowFrom 时全放行;开启后无 allowFrom 即配对模式)。
- `isAllowed(senderId)` 增加:`allowFrom 为空且 pairing 开启` → 查 store。
- `handleMessage` 未授权分支:DM(`metadata.chatType === "private"` 或
  `!chatId.startsWith("group:")`)→ 生成码,`this.send` 配对回复
  (content 模板 + `metadata.pairingCode`),记录日志;群聊 → 静默丢弃
  (现状保留)。

### 6.3 管理面(后置)

- WebChannel 增加 `GET/POST /api/pairing`(list/approve/deny),走
  `GatewayManagement` 扩展。

---

## M7 多实例(改动最大,放最后)

### 7.1 配置形态

```jsonc
{
  "channels": {
    "telegram": {
      "enabled": true,
      "token": "…",                        // 单实例照旧
      "instances": [                        // 可选:多实例展开
        { "id": "work", "token": "…" },
        { "id": "home", "token": "…" }
      ]
    }
  }
}
```

### 7.2 registry 改造

- `configuredChannelDefinitions`:遇到 `instances[]` 展开为多个定义,
  `runtimeName = type === name ? id : `${name}.${id}``(对齐 nanobot
  `channel_runtime_name` 冲突校验)。
- `createChannel` 按 `type` 建类,构造后 `channel.name = runtimeName`
  (BaseChannel.name 允许 set,或加 `rename()`)。
- `ChannelConfig` 增加 `type?: string`(基类定义),`instanceId?: string`。
- collision 检测:同 runtime name 报错跳过(日志),对齐 nanobot manager。
- SDK `SUPPORTED_CHANNELS` 校验改为按 type;`status()` 输出加 `owner/instanceId`。
- WebChannel 管理页可后置热启停(现有 `reconfigure` 已能按 fingerprint 热替换)。

### 7.3 热启停 API(可选)

- `GatewayManagement` 增加 `enableChannel(name, instanceId?)`/
  `disableChannel(name, instanceId?)`,对齐 nanobot `apply_channel_feature_action`。
  registry 已有 `add/removeChannel` 可直接复用。

---

## 文件级改动清单

| 文件 | 动作 | 里程碑 |
|---|---|---|
| `src/events.ts` | 新增 | M1 |
| `src/types.ts` | `OutboundMessage.event`、`OutboundDelta.event/resuming/mergeNext`、`buttons` | M1/M3 |
| `src/bus.ts` | 无结构改动(事件只是字段) | M1 |
| `src/channels/base.ts` | 原语方法 + 能力声明 + 配置开关 + pairing 钩子 | M2/M6 |
| `src/channels/dispatcher.ts` | 类型路由 + 门控 + 合并 + 指纹去重 | M2 |
| `src/channels/context.ts` | `transcriber?` 依赖注入 | M3 |
| `src/channels/telegram.ts` | 流式/入站媒体/转写/@/按钮 | M3 |
| `src/channels/feishu.ts` | thinking 不再丢弃 + 卡片推理 | M4 |
| `src/channels/slack.ts` | 流式/推理/按钮 | M4 |
| `src/channels/discord.ts` 等 | sendDelta(编辑) | M4 |
| `src/channels/web.ts` / `websocket.ts` | SSE/WS 事件 kind 扩展 | M2 |
| `src/scheduler.ts` | 新增 per-session 串行 | M5 |
| `src/sdk.ts` | dispatch 走 scheduler、capabilities 扩展 | M2/M5 |
| `src/pairing.ts` | 新增 | M6 |
| `src/channels/registry.ts` | 多实例展开 + runtime name | M7 |
| `src/config.ts` | 多实例配置透传(已是 Record,基本无需改) | M7 |
| `src/management.ts` | pairing/热启停管理面 | M6/M7 |
| `test/*` | 每里程碑补测试(见下) | 全部 |

## 测试计划(每里程碑)

- **M1**:`events.test.ts` — 事件构造/兼容桥旗标读取/`outboundMessageForEvent`。
- **M2**:`dispatcher.test.ts` 扩展 — 类型路由表、门控(sendProgress=false 时
  ProgressEvent 不投递)、delta 合并(同 stream 合并、异 stream 退缓冲)、
  指纹去重(同源重复抑制、不同 origin 放行、stream 放行)。
- **M3**:`telegram-channel.test.ts` 扩展 — 流式首帧/编辑/节流/4000 分割/
  not-modified 静默;入站 photo→images、voice→转写器调用;@ 提及
  `mentionedBot`;按钮 callback_query 回灌。
- **M4**:`feishu-channel.test.ts` — thinking delta 不再丢弃(卡片或正文降级);
  slack 流式编辑 mock。
- **M5**:`scheduler.test.ts` + `sdk.test.ts` 扩展 — 同 session 保序、
  跨 session 并发、maxConcurrentTurns 生效、handler 抛错仍走入站重试。
- **M6**:`pairing.test.ts` — 码生成/审批/未授权 DM 收到配对回复、群聊静默。
- **M7**:`registry.test.ts` 扩展 — instances 展开、runtime name 冲突、
  热启停。每次改动后跑 `npm run check`(仓库根),测试用
  `./test.sh` 或包内 vitest 定向文件。

## 实施记录(对照检查)

- **M1 类型化出站事件 — 完成**:`src/events.ts`(9 个事件类 + kind 判别路由 +
  legacy metadata 兼容桥 + `eventFromPayload` JSON 往返恢复);`types.ts` 增加
  `OutboundMessage.event`/`OutboundDelta.event`/`resuming`/`mergeNext`/`buttons`。
  测试 `test/events.test.ts`(6 例)。注意:与 nanobot 的 isinstance 路由不同,
  事件带 `kind` 字符串,因为 cogito 的 outbox 会做 JSON 持久化,`instanceof`
  在往返后失效。
- **M2 dispatcher 路由/原语/门控 — 完成**:`base.ts` 新增
  `sendProgress`/`sendReasoningDelta`/`sendReasoningEnd`/`sendReasoning`/
  `sendFileEditEvents`/`sendButtons` 原语 + `capabilities` 声明 +
  `sendProgress`/`sendToolHints`/`showReasoning` 配置开关;`dispatcher.ts`
  按事件类型路由(ProgressEvent 的 reasoning/toolHint/fileEdit 分支、门控、
  RetryWaitEvent 丢弃、StreamedResponseEvent 只回执)、流 delta 合并
  (`coalesceStreamDeltas`,bus 新增 `tryConsumeDelta` 非阻塞偷看)、出站内容
  指纹去重(`originReplyFingerprints`,sha1 + LRU 4096);`web.ts` SSE 新增
  `progress`/`reasoning`/`turn_end` 事件,`websocket.ts` 出站帧新增 `kind`;
  `sdk.ts` `capabilities()` 扩展 4 项。测试 `test/dispatcher.test.ts`(14 例)。
- **M3 telegram — 完成**:流式 `sendDelta` 编辑原消息(首帧 sendMessage →
  节流 editMessageText,默认 600ms;4000 字符分割;`message is not modified`
  静默;`mergeNext`/`resuming` 语义;finalize 失败重发全文);入站 photo 下载为
  `images`、voice/audio 走 `context.transcriber` 转写(无转写器则忽略)、
  document/video 为 `attachments`;群聊 @ 解析(entities mention/reply-to-bot
  → `metadata.mentionedBot`);按钮 `inline_keyboard` + `callback_query` 回灌;
  reasoning 渲染为可折叠 `<blockquote expandable>`。测试
  `test/telegram-features.test.ts`(10 例)。
- **M4 其余渠道 — 完成**:feishu thinking 不再丢弃(改为 `sendReasoningDelta/End`
  累积后以引用块发送);slack 流式 `chat.update` 编辑 + reasoning context block +
  按钮 actions block + `block_actions` 回调回灌;discord PATCH 编辑、matrix
  `m.replace` 编辑、mattermost PUT 编辑。测试 `test/channel-streaming.test.ts`
  (7 例)。
- **M5 入站调度 — 完成**:`src/scheduler.ts`(per-session 串行 promise 链 +
  全局并发信号量 `maxConcurrentTurns`,失败不断链);`sdk.dispatch` 改走
  scheduler。测试 `test/scheduler.test.ts`(5 例)。
- **M6 配对码 — 完成**:`src/pairing.ts`(InMemory/File store,8 字符
  ABCD-EFGH 码,TTL 10 分钟,approve/deny/list);`base.ts` `pairing` 配置
  (默认 false 行为不变) + 未授权 DM 自动发配对回复、群聊静默;`web.ts`
  `/api/pairing` 列表/approve/deny(管理路径)。测试 `test/pairing.test.ts`
  (7 例)。
- **M7 多实例 — 完成**:`configuredChannelDefinitions` 展开
  `instances[]` 为 runtime name(`telegram.work`,id `default` 保留裸名);
  `createChannel` 构造后重命名;startAll/reconfigure 按 runtimeName 键控 +
  冲突跳过;`sdk.restrictChannels` 按 base type 校验。测试
  `test/multi-instance.test.ts`(4 例)。
- **未做(计划中标注可选的)**:M7 的 `enableChannel/disableChannel` 管理面
  API(registry 已有 `add/removeChannel`,宿主可直接调用);nanobot 的
  `_agent_ui` 结构化 UI(双方都无生产者,维持占位)。
- **验证**:gateway 包 25 个测试文件 170 例全过(非 e2e);`npm run check`
  中 gateway 无任何 lint/类型问题(仓库级 check 仅剩 drift/proactive 包
  的既有问题,属其他会话的半成品改动)。

## 里程碑依赖与建议顺序

```
M1(事件类型) → M2(路由/原语/门控) → M3(telegram) → M5(调度)
     ↘ M6(配对,可与 M2 并行)
     ↘ M4(其余渠道,在 M2 原语就绪后随时插)
     ↘ M7(多实例,最后,独立)
```

建议一次合并一个里程碑。M1+M2 是其余一切的地基,完成即可让宿主 agent
开始发 ProgressEvent/TurnEndEvent,telegram 流式等后续逐个渠道落地。
