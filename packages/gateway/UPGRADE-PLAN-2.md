# Gateway 通道消息能力升级第二阶段(对齐 nanobot,剩余差距全量)

> **实施状态:计划已定稿,未开始实施。** 范围决策(用户确认):WhatsApp 本轮
> 不做;weixin 允许引入最小 npm 依赖;matrix E2EE 跳过;插件机制(W2-M6)
> 本轮做;telegram 先做 polling + `/start` `/help`(webhook 与 `/forward`
> 列为可选)。每个里程碑的最终改动与测试登记在文末"实施记录",格式同
> `UPGRADE-PLAN.md` 第一波(M1–M7 已全部完成)。

目标:把第一波未覆盖、审计确认的 nanobot 领先项补齐。审计对照结论:

- **已有且保持**(第一波产物,不做回归):类型化出站事件、进度/工具提示/推理/
  文件编辑语义、流式覆盖(telegram/discord/matrix/mattermost/slack/feishu)、
  按钮(telegram/slack)、配对码、多实例、流 delta 合并、出站指纹去重、入站
  去重+重试+死信、outbox、投递回执、入站限流、per-session 串行调度、
  media 能力声明、channel 热重配。
- **剩余差距(本计划范围)**:
  1. 入站契约:授权实体与 sender 解耦(`authorization_id`)、`is_dm` 显式语义、
     `_wants_stream`、基类 `transcribeAudio()` 助手、`login()` 交互登录钩子、
     `defaultConfig()` onboarding。
  2. 出站投递细节:deadline 截止时间重试(重启通知场景)、
     `RuntimeModelUpdatedEvent` + websocket 通道未启用时跳过。
  3. telegram 深度:typing 指示器、reaction、媒体组聚合、论坛话题会话、
     webhook 模式、markdown→HTML 渲染(表格/代码围栏/分块)、`/start` `/help`
     命令。(注:per-chat 有序更新队列经核实不需要——cogito 长轮询逐条
     `await processUpdate`,天然有序;M5 调度器已做 per-session 串行。)
  4. discord 深度:交互组件回调、斜杠命令、ephemeral 回复、working emoji、
     线程管理、按父频道白名单。
  5. feishu 深度:QR 扫码登录注册、reaction、富文本卡片渲染(表格/标题)、
     入站分享卡片/富文本解析、多实例身份持久化。
  6. matrix/slack/email 深度:matrix 线程/媒体/邀请事件/重连(slack 已有出站
     thread_ts,补入站与去重;email 补 IMAP UID 增量去重、HTML→文本、多账号)。
  7. 缺失通道:signal、wecom、msteams、qq、dingtalk、mochat、weixin
     (napcat 已由 onebot.ts 覆盖;whatsapp 按决策 deferred)。
  8. 通道插件机制:清单元数据、配置校验、宿主注册自定义通道、onboarding 信息面。

设计原则(沿用第一波):

- gateway 包保持零运行时依赖;新通道一律用 raw fetch/WebSocket + node 内置模块
  实现(同 feishu/onebot 风格),不走 SDK。例外见决策点 1。
- 不破坏现有可靠投递层(outbox/handoff/死信/回执)。
- 每个渠道能力缺失必须显式降级(基类默认实现),绝不静默丢用户可见内容。
- 分里程碑实施,每个里程碑独立可测、可合并、一次合并一个。

---

## W2-M0 基础契约对齐(地基,先行)

### 0.1 `src/types.ts`

```ts
export interface InboundMessage {
  // ...现有字段不变...
  /** 显式 DM 标志;缺省由 channel 判断(chatType/metadata)。 */
  isDm?: boolean;
  /** 授权实体 id(群/房间级授权时与 senderId 解耦,对齐 nanobot authorization_id)。 */
  authorizationId?: string;
}
```

### 0.2 `src/channels/base.ts`

- `handleMessage` 入参增加 `isDm?: boolean`、`authorizationId?: string`;
  权限检查对象 = `authorizationId ?? senderId`(nanobot `_handle_message` 语义)。
- group 策略统一:新增 `groupPolicy: "open" | "mention" | "allowlist"` 配置
  (对齐 nanobot `DIRECT_GROUP_POLICIES` + allowlist);现有
  `group.allowFrom`/`group.requireAt` 映射到等价策略,迁移期两者都接受。
- `supportsStreaming` 时入站 metadata 写入 `_wants_stream: true`
  (nanobot `_handle_message` 行为),供宿主 agent 决定流式回复。
- 新增基类助手 `transcribeAudio(source: string): Promise<string>`,封装
  `channelContext.transcriber`(telegram/feishu 现有调用改为走基类)。
- 新增 `async login(force = false): Promise<boolean>` 基类钩子(默认 true),
  QR 登录通道(weixin/feishu)覆写;`start()` 前由宿主调用。
- 新增 `static defaultConfig(): ChannelConfig`(默认 `{ enabled: false }`),
  供 onboarding 自动生成配置(对齐 nanobot `default_config`)。

### 0.3 `src/channels/dispatcher.ts`

- `deliver()` 增加 deadline 模式:`retryUntilMs` 选项,截止时间内持续重试
  (对齐 nanobot `_send_with_retry(deadline=...)`,重启通知场景);
  现有 maxAttempts 模式不变。
- 路由增加特判:`RuntimeModelUpdatedEvent` 且 channel 为 websocket 且未启用时
  跳过(对齐 nanobot `_dispatch_outbound`)。

### 0.4 `src/channels/registry.ts`

- `createChannel` 不感知具体通道即可用 `defaultConfig()` 做 onboarding 默认值。

### 测试

- 新 `test/base-contract.test.ts`(~8 例):authorizationId 授权、isDm 配对码分支、
  groupPolicy 枚举映射、_wants_stream、transcribeAudio 代理、login 默认实现、
  deadline 重试、RuntimeModelUpdatedEvent 特判。
- 回归:`test/dispatcher.test.ts`、`test/pairing.test.ts`、`test/telegram-features.test.ts`。

## W2-M1 telegram 深度补齐(收益最高)

`src/channels/telegram.ts`,全部走现有长轮询架构:

1. **typing 指示器**:`sendChatAction("typing")` 循环(对齐 nanobot
   `_typing_loop`),流式发送期间启动、finalize 后停止;turn 级开关
   `showTyping`(默认 true)。
2. **reaction**:流开始 `setMessageReaction(👍)`、结束/失败移除
   (对齐 nanobot `_add_reaction`/`_remove_reaction`);配置开关 `reactions`
   (默认 true)。
3. **媒体组聚合**:入站 `media_group_id` 缓冲 + 定时 flush,同组多条消息合并为
   一条 InboundMessage(内容 + 全部 attachments,对齐 nanobot
   `_flush_media_group`)。
4. **论坛话题**:`message_thread_id` 存在时 `sessionKeyOverride =
   telegram:<chatId>:<threadId>`(对齐 nanobot `_derive_topic_session_key`);
   出站 sendDelta 带 `message_thread_id`。
5. **webhook 模式**:配置 `mode: "polling" | "webhook"`;webhook 复用 web.ts 的
   HTTP server + TLS 模式,启动时 `setWebhook`,轮询关闭;校验 webhook path
   以 `/` 开头(对齐 nanobot validation)。
6. **markdown→HTML 渲染**:`_markdown_to_telegram_html` 移植(表格、代码围栏
   原样保存、行内代码、超长分块 `_split_telegram_markdown_html`);发送时优先
   HTML,失败降级纯文本。
7. **命令**:可注入命令处理器注册表(`/start` 内置——回复配对/欢迎语,`/help`
   内置——能力列表);`/forward` 因需要 session→chatId 映射,由宿主通过
   注册表注入(可选,见决策点 4)。

### 测试

- `test/telegram-features.test.ts` 扩展 ~10 例:typing 启停、reaction 打点、
  媒体组聚合、话题 sessionKey、webhook 配置校验与 setWebhook 调用、HTML 渲染
  (表格/围栏/分块)、命令路由。

## W2-M2 discord 补齐

`src/channels/discord.ts`(现为裸 gateway WebSocket 实现):

1. **交互组件回调**:message component(button/select)回调 → `handleMessage`
   (content = custom_id,metadata 带 interaction 标记 + 应答 ack)。
2. **斜杠命令**:命令 handler 注册表(构造注入,host 提供 `/model` `/trigger`
   实现,内置 `/help`);注册 `applicationCommands` + interaction 路由
   (对齐 nanobot `_register_app_commands`);错误 ephemeral 回复。
3. **ephemeral 回复**:交互响应 `flags: 64`(对齐 nanobot `_reply_ephemeral`)。
4. **working emoji**:收到消息后延迟添加 ✋/⏳ emoji,首帧流式后移除
   (对齐 nanobot `_delayed_working_emoji`);配置开关。
5. **线程管理**:`on_thread_update`/`on_thread_delete` 清理缓存;入站
   `thread` 消息合并进父 channel 会话或独立 thread 会话(配置选择)。
6. **按父频道白名单**:allowFrom 支持 category(父频道)key,`_channel_allow_keys`
   语义(频道 + 父频道 + server 三键匹配)。
7. **入站媒体**:attachment 下载(现有已下载,补大小上限与类型嗅探)。

### 测试

- 新 `test/discord-interactions.test.ts`(~8 例):component 回调、斜杠命令注册
  与路由、ephemeral 标志、working emoji 时序、thread 缓存清理、白名单三键匹配。

## W2-M3 feishu 补齐

`src/channels/feishu.ts`:

1. **QR 扫码登录注册**:应用身份注册流程(tenant/app 注册 + QR 轮询,
   对齐 nanobot `connect.py`/`_init_registration`);`login()` 覆写;
   结果持久化(身份边界 key)。
2. **reaction**:`_add_reaction`/`_remove_reaction`(THUMBSUP,流开始/结束打点,
   与 telegram 同语义)。
3. **富文本卡片渲染**:markdown 表格/标题分块 → 卡片元素(`_build_card_elements`/
   `_split_headings` 移植);保留现有流式卡片管线。
4. **入站富文本解析**:分享卡片/富文本 post 内容提取(`_extract_share_card_content`/
   `_extract_post_content` 移植),链接消息解析。
5. **多实例身份持久化**:instances 各自保存身份边界与 cursor(现有 cursor 已按
   instance 存,补身份边界同步)。

### 测试

- `test/feishu-channel.test.ts` 扩展 ~8 例:QR 注册轮询状态机、reaction 调用、
  表格→卡片元素、分享卡片/富文本入站解析、多实例身份边界。

## W2-M4 matrix / slack / email 补齐

- `src/channels/matrix.ts`:
  - 线程:入站 `m.thread` relation 提取 `threadId`(sessionKeyOverride);
    出站发送 `m.relates_to`(in_reply_to + thread)。
  - 媒体:入站 mxc URL 下载(带大小上限)、出站 mxc 上传。
  - 房间邀请/成员事件处理(拒绝/忽略策略,对齐 nanobot `_on_room_invite`)。
  - 重连:现有 resume 基础上补增量 sync token 持久化(对齐 nanobot sync 处理)。
  - **E2EE(决策点 2)**:默认 deferred。
- `src/channels/slack.ts`:
  - 入站 `thread_ts` 提取 → `threadId`;出站已有 `thread_ts`(保留)。
  - 入站 `event.ts` 去重(滑动窗口,事件重放防护)。
  - mention 语义:bot mention / DM 判定入 metadata。
- `src/channels/email.ts`:
  - IMAP UID 增量拉取 + UID 去重(现状:按 unseen 序列号,重启会重投;
    对齐 nanobot `_lookup_imap_id_by_uid`/`_remember_processed_uid`)。
  - HTML→文本入站(现状仅纯文本/基础提取)。
  - 多账号:配置 `accounts[]` 展开为多实例(复用 M7 多实例机制)。

### 测试

- `test/channel-streaming.test.ts`、`test/email-channel.test.ts` 扩展 ~12 例。

## W2-M5 缺失通道(零依赖 raw 协议)

每个通道:新建 `src/channels/<name>.ts` + registry/config 注册 + 独立 test
文件 + `README.md` 通道表更新。按实施成本从低到高(建议顺序,可并行):

| 通道 | 协议面 | 说明 |
|---|---|---|
| `signal.ts` | signal-cli-rest-api HTTP | 最易;send/receive + 附件;dm/group 双 allowFrom |
| `wecom.ts` | 企业微信 bot 回调 + 主动消息 API | HTTP server 回调(复用 web.ts 模式)+ 签名校验 |
| `msteams.ts` | Bot Framework HTTP + JWT | `node:crypto` HMAC/JWT 校验,对齐 nanobot `PyJWT` 逻辑 |
| `qq.ts` | QQ 开放平台 WS gateway + 消息 API | 官方 bot 协议 raw 实现(现 onebot.ts 的 QQ 变体是另一条线,保持并存) |
| `dingtalk.ts` | 钉钉 stream 模式 WS | 长连 + 事件分发,对齐 nanobot `dingtalk-stream` 语义 |
| `mochat.ts` | socket.io + msgpack | raw socket.io 协议(engine.io)客户端,msgpack 用内置解码器 |
| `weixin.ts` | 个人微信网页协议 | 允许引入最小 npm 依赖(决策确认);高风险脆弱,独立子里程碑 |
| ~~`whatsapp.ts`~~ | 多设备协议 | **按决策 deferred,本轮不做** |

### 测试

- 每通道一个 test 文件(协议层用注入 fetch/socket 假件,模式同
  `test/onebot-channel.test.ts`/`test/feishu-channel.test.ts`)。

## W2-M6 通道插件机制(本轮做,架构项,后置)

- 新 `src/channels/plugin.ts`:通道清单元数据(对齐 nanobot `ChannelPlugin`:
  name/displayName/runtime/connector/setup 字段/management 规格/依赖声明)。
- `registry.ts` 增加宿主注册 API:`registerChannelType(manifest, factory)`,
  第三方通道类实现 `BaseChannel` 即可被配置发现/实例化。
- 配置校验钩子:每通道 `validate(config)` 由 registry 在实例化前调用。
- onboarding 信息面:`GatewayManagement` 增加 `channelCatalog()`(清单 +
  defaultConfig + 已配置状态),宿主 UI 消费。
- 测试:新 `test/registry-plugin.test.ts`(~6 例)。

## W2-M7 收尾

- 更新 `UPGRADE-PLAN.md` 实施记录(逐里程碑登记,格式同第一波)。
- 全量非 e2e 测试(`./test.sh`)+ `npm run check` 全绿;gateway 包内改动仅限
  本计划文件;每里程碑提交遵循仓库 Git 规则(只 stage 本次会话文件)。

## 里程碑依赖与建议顺序

```
W2-M0(契约地基)→ W2-M1(telegram)→ W2-M2(discord)→ W2-M3(feishu)→ W2-M4(matrix/slack/email)
       ↘ W2-M5 各通道在 M0 后随时独立插入(每个通道一次合并)
       ↘ W2-M6(插件,最后,独立)
```

## 已定范围决策(用户确认)

1. **依赖策略**:保持零依赖;whatsapp deferred;weixin 允许引入最小 npm 依赖。
2. **matrix E2EE**:跳过(本轮不做)。
3. **插件机制(W2-M6)**:本轮做。
4. **telegram**:本轮做 polling + `/start` `/help`;webhook 与 `/forward` 列为
   可选,后续按需加。

## 实施记录(对照检查)

> 每个里程碑完成后在此追加一条 `- **W2-Mx … — 完成**:…`,并登记测试数。

- **W2-M0 基础契约 — 完成**:`types.ts` InboundMessage 增加 `isDm`/`authorizationId`;
  `base.ts` handleMessage 支持授权实体(permissionId = authorizationId ?? senderId)、
  `_wants_stream`(streaming 通道入站元数据,metadata 恒为对象,nanobot 语义)、
  `GroupPolicy.mode` 枚举(open/mention/allowlist,保留 allowFrom/requireAt 兼容)、
  基类 `transcribeAudio()`/`login()`/`defaultConfig()`;`dispatcher.ts` 增加
  `sendDirect()` deadline 截止时间重试 + RuntimeModelUpdatedEvent websocket
  未启用跳过(在 channel 查找前,nanobot 语义);telegram 转写改走基类助手。
  测试 `test/base-contract.test.ts`(17 例)。验证:gateway 包类型检查零错误、
  biome 零告警、受影响 7 个测试文件 82 例全过;web-page 3 例失败为 packages/ui
  未提交改动的既有问题(页面标题 "pi web"→"Cogito"),与本里程碑无关。
- **W2-M1 telegram — 完成**:typing 指示器(`sendChatAction` 循环,`showTyping`/
  `typingIntervalMs` 配置)、reaction(`setMessageReaction`,`reactEmoji` 配置,
  回复完成/流结束移除)、媒体组聚合(`media_group_id` 600ms 缓冲合并为一条
  InboundMessage)、论坛话题(`message_thread_id` → sessionKey
  `telegram:<chat>:<thread>`)、markdown→HTML 渲染(`renderTelegramHtml`:
  代码围栏/行内代码/粗斜体/删除线/链接/表格盒;完整发送与流 finalize 使用,
  失败降级纯文本)、斜杠命令(`/start` `/help` 内置 + 可注入
  `TelegramCommandRegistry`,未注册命令照常进 agent)。测试
  `test/telegram-features.test.ts` 扩展 8 例(typing/reaction 启停、媒体组聚合、
  话题 session、HTML 渲染/降级、命令路由)。验证:telegram 2 个测试文件 23 例
  全过,gateway 全量(非 e2e)205 例通过。
- **W2-M2 discord — 完成**:重写 `discord.ts`(raw gateway + REST):斜杠命令
  (registry 注入,默认 /model /trigger /help,start 时 PUT 同步到应用,
  INTERACTION_CREATE 路由,ephemeral "Processing..." ack,未授权 ephemeral
  拒绝)、消息组件回调(button/select → custom_id 入站,type 6 ack)、
  read-receipt(👀)+ 延迟 working emoji(🔧,2s)reaction、typing 指示器、
  线程会话(`discord:<parent>:thread:<threadId>`)、allowChannels 通道/父频道/
  guild 白名单(懒加载 + 事件缓存)、群组默认 mention 策略(nanobot
  `group_policy="mention"` 默认)、入站附件下载(图片嗅探/文件 data URL,
  20MiB 上限)、bot 身份解析与自循环防护(只忽略自己,允许其他 bot,
  nanobot 多智能体语义)。测试 `test/discord-interactions.test.ts`(8 例)+
  messaging-channels 更新 1 例。验证:discord 相关 4 个测试文件 42 例全过,
  gateway 全量(非 e2e)213 例通过,biome/tsc 零告警。
- **W2-M3 feishu — 完成**:入站 reaction(THUMBSUP,`reactEmoji` 配置,POST
  /im/v1/messages/:id/reactions 记录 reaction_id,回复/流结束 DELETE 移除)、
  富文本入站解析(post 消息提取文本+链接、interactive 分享卡片提取
  标题/描述/URL/body 元素文本)、出站 markdown 表格渲染为等宽 ``` 文本盒
  (飞书文本消息不解析 markdown,与 telegram `<pre>` 盒同降级哲学)、
  `login()` 覆写(凭据缺失时明确报错;QR 应用注册属开放平台 onboarding,
  需开发者账号,未移植,已在实施记录说明)。多实例身份:offsetStore 按
  runtime name 键控,实例天然隔离(核实无需改动)。测试
  `test/feishu-channel.test.ts` 扩展 6 例(reaction 添加/移除、禁用、
  post/分享卡片解析、表格盒、login)。验证:feishu 23 例全过,gateway 全量
  (非 e2e)219 例通过。
- **W2-M4 matrix/slack/email — 完成**:
  - `matrix.ts`:入站 `m.in_reply_to` 线程提取(`matrix:<room>:thread:<eventId>`
    session + `threadId` metadata)、出站 `threadId` → `m.relates_to`
    (in_reply_to + m.thread)、入站 mxc 媒体下载(图片→base64 多模态,其余→
    附件,20MiB 上限)、`autoJoinInvites` 邀请入群(默认 false)、`m.room.encrypted`
    跳过(E2EE 按决策 deferred)、sync token 已按实例持久化。
  - `slack.ts`:入站 `thread_ts` → 线程 session(`slack:<channel>:thread:<ts>`)、
    `botUserId` @mention 检测、事件 ts 滑动窗口去重(Socket Mode 重投防护)。
  - `email.ts`:IMAP UID 水位线增量拉取(重启安全、不依赖 \Seen;首次运行
    拉全量 unseen)、`UID FETCH`/`UID STORE`、HTML→text 降级解析(纯文本优先),
    \Seen 标记降为 best-effort 不阻塞水位线落盘;多账号由实例机制覆盖。
  - `types.ts` OutboundMessage 增加 `threadId`。
  - 测试:messaging-channels 扩展 4 例(matrix 线程 session/出站线程关系、
    mxc 媒体+邀请、slack 线程/去重/mention)+ email 扩展 3 例(UID 命令、
    水位线重启、HTML 解析)。验证:3 个测试文件 22 例全过,gateway 全量(非
    e2e)225 例通过。
- **W2-M5 缺失通道 — 完成(7/7,whatsapp 按决策 deferred)**:
  - `signal.ts`(signal-cli-rest-api):SSE 接收(/api/v1/events,receipt/typing/
    sync 忽略,群组 groupId 路由)、/api/v1/send 发送(超长分块、群 groupId)、
    typing 指示器、入站附件名标记、出站媒体显式降级。测试 7 例。
  - `wecom.ts`(企业微信自建应用):回调 HTTP server(GET 验证 echostr 解密 +
    POST 消息,AES-256-CBC 解密、sha1 签名校验)、gettoken + message/send
    主动发送。说明:nanobot 的 wecom 基于闭源 wecom-aibot-sdk(WS 协议),
    零依赖无法复刻,采用标准自建应用回调模型(需公网回调地址)。测试 5 例。
  - `msteams.ts`(Bot Framework):回调端点 + Bearer JWT 校验(OpenID 配置 +
    JWKS RS256 验签,issuer/aud 检查)、client_credentials 换取 botframework
    token、serviceUrl 按会话学习、replyTo 回复。测试 5 例(真实 RSA 签名)。
  - `qq.ts`(QQ 官方开放平台 api-v2,配置键 `qqofficial` 与 onebot 的 qq
    变体并存):gateway WS(IDENTIFY token "Bot AppID.Token"、GROUP_AND_C2C
    intent、心跳、重连)、C2C/GROUP_AT 消息归一化(@提及剥离、消息 id 去重、
    附件下载为 images/attachments)、/v2/users|groups 消息发送。测试 5 例。
  - `dingtalk.ts`(钉钉 stream 模式):connections/open 换 WS URL、register
    chatbot topic、ping/pong、data 帧 base64 body 解析、机器人消息 API
    (oToMessages/batchSend + groupMessages/send)。协议按 stream SDK v1
    规范实现,需真实应用线上验证。测试 6 例。
  - `mochat.ts`(mochat.io Claw):最小 socket.io v4 JSON 客户端(engine.io
    ping/pong、auth 连接、ack 关联订阅 subscribeSessions/subscribePanels、
    claw.session.events/panel.events/notify:* 归一化、会话游标)、HTTP
    sessions/panels send(X-Claw-Token)。测试 8 例。
  - `weixin.ts`(微信 ilink bot):协议为纯 HTTP(零依赖,无需引入 npm 依赖)—
    QR 扫码登录(get_bot_qrcode/get_qrcode_status,token 持久化到
    offsetStore)、getupdates 长轮询(游标持久化、自身消息跳过、msg id 去重)、
    sendmessage(context_token 会话续接)。测试 5 例。
  - 全部接入 registry(config 键 + 实例化)+ `src/index.ts` 导出。
- **W2-M6 插件机制 — 完成**:`plugin.ts`(ChannelPluginDefinition/setup 字段/
  validate 钩子/ChannelValidationError/validateChannelConfig);registry
  `registerChannelType()`(宿主注册自定义通道类,内置名冲突拒绝)、插件名
  进入配置发现、校验失败跳过并告警(nanobot 语义)、`catalog()` onboarding
  目录(内置 + 插件,configured/setup/defaultConfig);GatewayManagement
  `channelCatalog()` + SDK `registerChannelType()` 透传。测试
  `test/registry-plugin.test.ts`(5 例)。
- **W2-M7 收尾 — 完成**:本文件全部实施记录登记;gateway 全量非 e2e 测试
  **271 例通过**(仅剩 3 例 web-page 失败,为 packages/ui 未提交改动的既有
  问题,与本计划无关);`tsc`/`tsgo` 全仓零错误(顺手修复了 wave-1 遗留的
  channel-streaming/multi-instance 测试类型问题)、biome gateway 零告警;
  `npm run check` 的 pinned-deps/ts-imports/tsgo 全过;biome 步骤仅剩
  packages/proactive 的 1 处既有告警(其他会话未提交改动,按 Git 规则不
  越界修改);仓库级 ./test.sh 中 host/proactive 的失败同为其他会话半成品
  改动所致。
