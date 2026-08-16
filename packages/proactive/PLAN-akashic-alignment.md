# PLAN: 对照 akashic-agent 补齐 drift/proactive 实现差距(保持三进程架构)

> 目标:把 `@cogito/drift` + `@cogito/proactive` 相对 akashic-agent
> (akashic-agent 仓库当前 main)的已确认实现差距逐项补齐——**行为与语义以
> akashic 为参照,结构以 cogito 现状为准**。
> 硬约束:
> - 保持三进程架构(proactive daemon / drift daemon / 主 agent,经
>   `@cogito/gate` 共享契约层通信,不引入 IPC、不内嵌 drift)。
> - 保持 TS + SQLite + 生命周期模块图 + 插件注册表的现有结构;跨进程新状态
>   进 `@cogito/gate` 或各进程自有 SQLite,新表走现有 `ALTER TABLE` 迁移模式。
> - 只改行为语义与补齐能力;akashic 的 Python 结构(类名/模块布局)不做直译。
> - 每阶段 `npm run check` 全绿 + 相关测试通过后再进下一阶段;改动进各包
>   CHANGELOG `[Unreleased]`。

---

## 实施状态(已全部完成)

- Phase 1 ✅ 数值与配置对齐:score_weight_energy 默认 0.35、presets 补
  gate.judgeSendThreshold(0.60/0.28/0.75)、配置根级未知键拒绝 + tickS0>=tickS1。
- Phase 2 ✅ wake 事务边界:ingestWithIds 批量单事务 + quarantine commit:false
  延后落库、consume/expire 失败回滚;drift 门控死代码注释 + decideDrift 观察
  记录(wake_observations kind=drift);event ACK 范围核对一致(alert 决策后消费,
  context 不参与)。
- Phase 3 ✅ judge 上下文与健壮性:collectRecent/isContextFrameContent 接入
  recentChatFn(200 截断 + context-frame 过滤);lifecycle start/stop AbortSignal
  shield;drift 约束拒绝计数验证(agent-core 对 blocked 调用发 isError,计数已
  正确,无改动);wrap-up 消息保持 user role(@cogito/ai 无 system 角色,注释说明)。
- Phase 4 ✅ 插件 prompt/effect 贡献:`proactive.prompt.collect` 模块收集
  `proactive:prompt:system_bottom:*`/`proactive:effect:*` slots,段注入 judge
  prompt 底部,effect 写入 tick_log.effects_json(user_version 9);顺带修复
  拓扑排序 bug(collects 展开边未参与排序,现按 akashic 用展开 bindings 排序)。
- Phase 5 ✅ 召回与观测:recallPreferencesRanked 增加 minScore floor,wake
  recall_memory 向量精排 + limit 12;drift LLM usage 累计并经
  drift_finished 事件(llmCacheReadTokens/llmCacheWriteTokens)输出;README
  补 DriftFinished 映射表。

验证:proactive 285 / drift 67 / gate 19 全量测试通过;biome 干净;tsgo 仅剩
packages/gateway 存量错误(其他会话)。`npm run check` 的 biome 阶段仍被
gateway 的存量 suppression warning 卡住,与本次改动无关。

---

## 0. 现状核对(已等价,不在本方案范围,禁止改动)

以下经逐文件核对与常量比对,两侧等价或 cogito 已是超集:

- **hazard / energy / anyaction / drive 数学**:wake hazard 全部常量
  (36h 半衰、0.03/0.01/0.5/0.02/0.35/1.5/3.0/2h)、energy 三尺度衰减
  (30/240/2880min, 0.5/0.35/0.15)、anyaction 概率公式与配额窗口、
  drift drive(12h 半衰、rate 0.3、delay 0.08、抑制 0.95/0.9/0.9、
  64 次二分)均逐行一致。
- **生命周期编排**:topo 排序、slot/requires/produces/collects 校验、
  数据 slot(含 `:`)与模块 slot(含 `.`)判定、collects 前缀展开,
  `ext/lifecycle.ts` 与 `proactive_v2/lifecycle.py` 等价。
- **wake 模块序列与状态表**:wake.start→ingest→content.decide→
  drift.decide→schedule 完全一致;`reservoir_*`/`hazard_*`/`context_*`/
  `pending_acknowledgements` 表一致(cogito 追加 `wake_tick_log`)。
- **judge 判题语义**:alert 快速路径、completeness 回环(5 轮)、反射回环
  (3 轮)、skip_reason 分类法(no_content|user_busy|already_sent_similar|other)、
  cache token 统计均一致。
- **drift 执行语义**:扫描/去重/排序、select_skill/idle_drift 前置约束、
  finish_drift 后置约束、wrap-up 2 次重试、max_steps=20、completed/paused
  + scratchpad/cursor/journal/self_update 语义一致。
- **outbound 文本清洗**:`normalizeOutboundText` 逐行等价(唯一差异:
  ftfy `\N{...}` 命名转义未移植,无实际影响,不动)。
- **memory_optimizer**:等价,位于 `packages/agent/src/memory/optimizer.ts`
  (缺席成本测试、四分类契约、SELF.md 三段、两阶段提交、18h 整点触发)。
- **monitor**:akashic 的 5 个 dashboard 端点 cogito 全有且是超集。
- **drift 工具面**:两侧均有 select_skill/idle_drift/finish_drift/
  message_push/mount_server/recall_memory/shell/文件工具/fetch_messages/
  search_messages;cogito 另有 web_fetch/web_search(带 SSRF 策略)与
  read_journal。
- **三进程 drift 门控数学**:`drift/daemon.ts` checkDriftTimer/
  sampleNextAttempt/advanceDriftDrive 与 akashic `_decide_drift`/
  `_schedule_drift_attempt` 数学等价(anchor 重采样、到期强制 attempt、
  成功指纹抑制)。

---

## 1. 决策点:有意保留的差异(先确认,默认保留并文档化)

| 差异 | akashic | cogito 现状 | 建议 |
|---|---|---|---|
| 消息去重失败语义 | fail-closed(ValueError 使 tick 失败) | fail-open(`dedupe.ts` 放行,注释明示) | 默认保留;加 `safety.messageDedupeFailClosed` 配置(默认 false)可选对齐 |
| 事件身份 | 缺 event_id 一律隔离 | legacy 源生成 synthetic identity(README 记录) | 默认保留兼容;加 `sourceContract.strictEventId` 配置(默认 false)可选对齐 |
| drift 工具错误 | 静默 break,不落 finish | fallbackPause 兜底存 paused(更稳) | 保留(超集) |
| drift 随机源 | 运行时 RNG(ReplayClock 例外) | anchor 种子确定性随机 | 保留(anchor 持久化已消除抖动;确定性利于测试) |
| wrap-up 消息角色 | system | user | 对齐(Phase 3.4),若 agent-core 不支持则保留并注释 |
| judge 工具面 | 12 个(含按类型浏览事件) | 10 个(fetch_evidence 合并) | 保留(候选已入库 items,行为等价) |

---

## Phase 1 — 数值与配置对齐(小)

### 1.1 `score_weight_energy` 默认 0.35

- **akashic 参考**:`proactive_v2/presets.py:141` STRATEGY_PARAMS
  `score_weight_energy=0.35` → `config_loader.py:271` `final_config.update(STRATEGY_PARAMS)`
  覆盖 `config.py:54` 默认 0.40;**有效值为 0.35**。
- **cogito 现状**:`stages/schedule.ts:109` `scoreWeightEnergy ?? 0.4`;
  `stages/defaults.ts:287` `JsonlPresenceStrategy(..., 0.4, ...)`。
- **改动**:两处默认 0.4 → 0.35;保留配置可覆盖(`tick.scoreWeightEnergy`)。
- **验收**:gate 阻断回退路径 base_score = dEnergy(energy) * 0.35;
  `test/scheduling*` 相关断言同步;`npm run check` 全绿。

### 1.2 presets 补 `gate.judgeSendThreshold`

- **akashic 参考**:PRESETS default/daily/quiet 的 `gate.judge_send_threshold`
  = 0.60 / 0.28 / 0.75。
- **cogito 现状**:`presets.ts` PRESETS 无 gate 组;`applyPreset` 只装配
  anyaction/contextOnly。
- **改动**:`PresetConfig` 增加 `gate: { judgeSendThreshold: number }`;
  `applyPreset` 输出 `gate.judgeSendThreshold`;judge 保持不消费
  (与 akashic 一致,仅进 initial slots/配置)。
- **验收**:三组 preset 数值与 akashic 一致;preset 测试更新。

### 1.3 配置校验收紧

- **akashic 参考**:`config_loader.py` `_check_forbidden_keys`(根级未知键
  白名单硬拒绝)、`_validate_ranges`(tick_interval_s0 >= s1 递减)。
- **cogito 现状**:`index.ts:310 validatePusherConfig` 有类型 + numeric
  range + probMin<=probMax,无未知键拒绝、无 s0>=s1。
- **改动**:
  1. 顶层键白名单,未知键报错(行为收紧:配置拼写错误会直接失败,
     符合 akashic 语义;属小 breaking,记录 CHANGELOG)。
  2. `tick.tickS0 >= tick.tickS1` 校验(仅在两者都显式配置时)。
- **验收**:配置测试新增未知键/递减用例。

---

## Phase 2 — wake 事务边界与 drift 门控语义(中)

### 2.1 批量 ingest 原子性 + quarantine 延后提交

- **akashic 参考**:`plugins/wake_proactive/state.py` `ingest_with_ids`
  整批一个 `commit()`;`record_quarantine(commit=False)` 延后到批提交。
- **cogito 现状**:`wake/state.ts:356-452 ingestWithIds` 逐行自动提交;
  `recordQuarantine`(`state.ts:529-571`)忽略 `commit` 参数,立即落库。
- **改动**:`ingestWithIds` 用现有 `withTransaction`(BEGIN IMMEDIATE)包整批;
  `recordQuarantine` 支持 `commit: false` 延后(暂存队列,批提交时 flush,
  失败时回滚);`consume`/`expire` 失败语义见 2.2。
- **验收**:进程中断/异常场景下批次原子(新增测试:注入中途异常,断言
  隔离区与事件要么全落要么全不落);既有 wake state 测试全绿。

### 2.2 consume/expire 失败回滚

- **akashic 参考**:`state.py:847-851` consume rowcount 不匹配 → `rollback()`。
- **cogito 现状**:`wake/state.ts:579-588 consume` 抛错不回滚(部分行已提交)。
- **改动**:`consume`/`expire` 包 `withTransaction`,不匹配时回滚;
  `consumeAndQueueAck`/`queueExpiration`/`markAcknowledged` 已事务化,不动。
- **验收**:rowcount 不匹配用例断言事件保持原状态(可重试)。

### 2.3 drift 门控:死代码清理与观测补全

- **已确认等价**:`drift/daemon.ts:86-130` checkDriftTimer/sampleNextAttempt
  与 akashic `_decide_drift`/`_schedule_drift_attempt` 数学一致
  (anchor 变化才重采样、sample_drift_delay_hours 反演到期、到期后
  advanceDriftDrive(hazard=0, threshold=0) 强制 attempt、成功指纹
  recordDriftSuccess 抑制)。
- **cogito 现状**:wake 侧 `drift_state.timer_anchor/next_attempt_at` 列
  存在但无人写入(调度归 daemon);`wake/runtime.ts:637 decideDrift` 只写
  1h TTL 的 drift_gate 许可。
- **改动**:
  1. 保留表结构(迁移兼容),删除 wake 代码里对这两列的写入/读取预期,
     在 `wake/state.ts` 与 README 注明「wake 只门控,调度在 drift daemon,
     数学与 akashic `_decide_drift` 等价」。
  2. `decideDrift` 补充观察记录(gate verdict/reason/ttl 进
     `wake_observations` kind=drift),使 tick 日志可解释门控。
- **验收**:daemon 定时器等价性测试保留;wake 观察记录新增断言。

### 2.4 event ACK 范围核对(低)

- **akashic 参考**:wake event tools 仅对 tryCreated(本轮新建)消息 ACK。
- **改动**:核对 cogito `wake/event-tools.ts` + consume/ack 范围,若发散
  则对齐(只 ACK 本轮新建/消费的事件)。
- **验收**:ACK 范围测试。

---

## Phase 3 — judge 上下文与生命周期健壮性(中)

### 3.1 collect_recent 对齐(context-frame 过滤 + 200 截断)

- **akashic 参考**:`proactive_v2/sensor.py:43-70 collect_recent`(仅
  user/assistant、过滤 context frame、单条 200 字符、上限
  recent_chat_messages=20);context-frame 标记见
  `agent/prompting/assembler.py:56-63`(`<system-reminder` 前缀 /
  `[SYSTEM_CONTEXT_FRAME]` 旧标记)。
- **cogito 现状**:`stages/defaults.ts:232-245 recentChatFn` 300 截断、
  无 context-frame 过滤;过滤/截断语义下放 host 端口。
- **改动**:proactive 包新增 `isContextFrameContent()`(与 akashic 标记一致)
  与 `collectRecent(rows, { limit: 20, maxChars: 200 })`;`defaults.ts`
  recentChatFn 应用;host 端口仍可注入原始行(由 helper 统一清洗)。
- **验收**:judge 工具测试新增 context frame 剔除、截断、角色过滤用例。

### 3.2 生命周期取消安全(shield 等价物)

- **akashic 参考**:`proactive_v2/lifecycle.py:42-68 _await_cleanup`
  (asyncio.shield 保证 stopper 在外部取消下完成,取消/错误聚合)。
- **cogito 现状**:`ext/lifecycle.ts:77-115` start/stop 只 try/catch 聚合,
  无 shield;调用方取消会截断后续 stopper。
- **改动**:`CompiledProactiveLifecycle.stop()` 对每个 stopper 用 shield
  语义(外部取消时等待清理完成),CancelledError 与错误聚合进
  AggregateError;start 回滚路径同。
- **验收**:新增取消场景测试(启动后立即取消 stop,断言 stopper 仍执行)。

### 3.3 drift 约束拒绝计数

- **akashic 参考**:`plugins/drift_flow/runtime.py:268-307` 循环层直接计数,
  2 连拒触发 wrap-up。
- **cogito 现状**:`drift/loop-adapter.ts:215` 仅当 `tool_execution_end`
  isError 时计数;`beforeToolCall`(241-250)block 的调用是否产生 isError
  取决于 agent-core,存在漏计风险。
- **改动**:先核对 `packages/agent-core` runAgentLoop 对 blocked 调用的
  emit 语义;若漏计,在 beforeToolCall 拒绝路径显式计数,
  2 连拒触发 wrap-up(与 akashic 一致)。
- **验收**:新增 2 连拒 → wrap-up 用例。

### 3.4 wrap-up 消息角色(低)

- **akashic 参考**:wrap-up/重试提示用 system role。
- **cogito 现状**:`drift/loop-adapter.ts:330` 用 user role。
- **改动**:若 agent-core `AgentMessage` 支持中途 system 消息则切换;
  否则保留并注释差异(见决策点表)。

---

## Phase 4 — 插件 prompt/effect 贡献(中)

### 4.1 插件面扩展

- **akashic 参考**:`agent/plugins/base.py` `prompt_render_modules`;
  `plugins/default_proactive/runtime.py:753-767` `ProactivePluginStateModule`
  (slot `proactive.prompt.collect`,collects `proactive:prompt:system_bottom:*`
  / `proactive:effect:*`);装配逻辑见 `runtime.collect_plugin_state`
  (实施前先通读该方法与 prompt render 装配)。
- **cogito 现状**:`ext/plugin.ts` 插件面只有 proactiveSources/
  proactiveLifecycles/proactiveModules/proactiveRuntimeFactories,
  无 prompt 贡献点;default 生命周期无 `proactive.prompt.collect` 模块。
- **改动**:
  1. 插件贡献类型:`proactivePromptContributions?()`(system_bottom 段
     + effect 钩子),重复 provider 启动失败(与现有 registry 规则一致)。
  2. `lifecycles/default/modules.ts` 增加 `proactive.prompt.collect` 模块
     (requires admission:result,produces prompt:sections:collected),
     收集后注入 judge prompt(system_bottom 追加到 system prompt 底部)。
  3. README 插件章节更新示例;`PluginRegistry` 装配测试。
- **验收**:自定义插件注入 prompt 段生效;重复 provider 报错;默认行为不变
  (无插件时 prompt 与现状逐字一致)。

---

## Phase 5 — 召回与观测收尾(低)

### 5.1 recall_memory 召回口径

- **akashic 参考**:`memory.query(intent="interest", effect="read_only",
  relevance_floor="strong", limit=12, timestamp)`。
- **cogito 现状**:`wake/tools.ts` recallPreference / `drift/tools.ts`
  用 `recallPreferences`(sqlite,无 floor/时间过滤)。
- **改动**:改用 `recallPreferencesRanked` + relevance floor 常量 +
  时间过滤(保持 sqlite 后端与 gate 契约不变)。
- **验收**:召回结果排序与过滤测试。

### 5.2 drift run 内 LLM usage 统计

- **akashic 参考**:`runtime.py` record_llm_cache 累加 cache 统计。
- **cogito 现状**:`drift/loop-adapter.ts` EMPTY_USAGE 恒 0。
- **改动**:从 agent loop usage 事件累加 cacheRead/cacheWrite,写入
  run 诊断/step 记录(不改变控制流)。
- **验收**:诊断输出含 usage;既有 drift 测试全绿。

### 5.3 DriftFinished 事件映射(文档,无代码)

- cogito 已通过 `DriftEvent` 系列(含 `drift_finished`/
  `drift_delivery_committed`)提供等价信息;README 补一节说明与 akashic
  `DriftFinished` 的字段映射,宿主无需改动。

---

## 验收与测试

- 每阶段完成:对应包 `node ../../node_modules/vitest/dist/cli.js --run <file>` 跑新增/相关测试;
  全量非 e2e 用仓库根 `./test.sh`;`npm run check` 必须全绿(不跑 build/test 全量)。
- 阶段顺序:Phase 1 → 2 → 3 → 4 → 5,可独立合并,不阻塞。
- 改动涉及 `packages/drift` / `packages/proactive` / `packages/gate` 的
  CHANGELOG `[Unreleased]` 各记一条;配置收紧(1.3)标 Breaking。
- 预估工作量:Phase 1 ≈ 0.5d;Phase 2 ≈ 1d;Phase 3 ≈ 1d;
  Phase 4 ≈ 1d;Phase 5 ≈ 0.5d。
