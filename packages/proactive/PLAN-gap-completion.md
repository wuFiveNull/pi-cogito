# PLAN: 补齐相对 akashic-agent 的能力缺口(保持三进程架构)

> 目标:把 `@cogito/proactive` + `@cogito/gate` + `@cogito/drift` 相对
> akashic-agent proactive/drift 的实现、功能、策略缺口补全。
> 约束:保持当前三进程架构(proactive daemon / drift daemon / 主 agent,
> 经 `@cogito/gate` 共享契约层通信,不引入 IPC)。所有跨进程新状态进
> `@cogito/gate` 或各进程自有 SQLite;所有新增表遵循现有
> `ALTER TABLE` 迁移模式(参考 `store.ts` 中 `deliveries.target_channel`)。

---

## 实施状态(2026-08 完成)

- Phase 1 ✅ judge 工具面(10 工具)+ Alert 快速路径 + `@cogito/gate/web.ts`
  共享 web 策略 + 空候选闲聊分支(`gate.contextOnly.chatLevity`,
  默认关闭;`chatLevityProbability` 默认 0.1)。
- Phase 2 ✅ `tick_log`/`tick_steps` 审计列(user_version 8)+ judge LLM
  cache token 统计 + monitor `tick_logs` 合并 drift.db 时间线(`flow=drift`)。
- Phase 3 ✅ `drift_timer` 表 + `checkDriftTimer`(anchor 驱动一次性到期采样,
  `sampleDriftDelayHours` 接线,确定性随机源;未进入 pipeline 时重采样防热循环)。
- Phase 4 ⚠️ **无需新代码**:`@cogito/agent/src/memory/optimizer.ts` 已实现
  等价的 MemoryOptimizer(PENDING.md → MEMORY.md 缺席成本测试合并 + SELF.md
  更新 + 两阶段提交),proactive 经 `memory.enabled` + `startMemoryTasks` 接线。
- Phase 5 ✅ 配置 range 校验(tick/anyaction/contextOnly/safety/sourceAck)、
  顶层 `webPolicy`(兼容 `drift.webPolicy`)、skip_reason 分类法进 prompt。
  `5.3 authorize 钩子` 维持可选(未实施;drift 已有 `DriftToolPolicy`)。
- 测试:新增 judge-tools(8)/chat-levity(4)/store-kind-migration(3)/
  monitor-drift-merge(1)/scheduling(4)/config-ranges(1);修复 drift 既有
  flaky 用例(`maxDurationMs: 1` 真实时钟竞态 → `-1` 确定性)。
  三个包全量测试通过;biome 干净;tsgo 仅剩 gateway 存量错误(其他会话)。

---

## 0. 现状核对(以下"缺口"已闭环或双方一致,不在本方案范围)

- **busy 闸**:`GateChain` 已支持 `busyFn`(`stages/gate.ts:29-30`),
  `createDefaultStages` 已接线 `runtimePorts.busy.isBusy`(`stages/defaults.ts:166-169`)。已闭环。
- **judge_send_threshold**:akashic 也只把它放进 initial slots
  (`proactive:base_judge_send_threshold`),judge 从未消费。双方一致,保持现状。
- **d_recent / ProactiveFeedbackRecorded**:akashic 侧同样未使用,不补。
- **预设数值 / energy 调度 / anyaction 概率 / context_only 兜底 / wake hazard 常量**:
  双方一致,不补。

---

## Phase 1 — judge 工具面补齐 + Alert 快速路径(default 生命周期)

**现状**:`stages/judge-agent-tick.ts` 只有 3 个工具
(`fetch_evidence`/`mark_not_interesting`/`finish_judgment`);akashic 有 12 个;
`items` 表不存 `kind`,alert 与 content 同质化走 judge;`setVerdict` 已存在但
judge 从不调用。

### 1.1 items 表增加 kind 列(迁移)

- `store.ts` `ensureSchema`:`ALTER TABLE items ADD COLUMN kind TEXT NOT NULL DEFAULT 'content'`
  (复用 `deliveries.target_channel` 的列检查模式,见 `store.ts:560`)。
- `store.ts` `insertItem`:新增 `kind` 参数并入 SQL。
- `stages/fetch-pipeline.ts` `ingest`:从 `raw.kind`(`WakeEvent.kind`:
  `alert`/`content`/`context`)传入;缺省 `content`。
- `store.ts` `listNew`:不变(仍返回全部 status=new),由 judge 侧按 kind 分组。
- 测试:`store-delivery-media` 模式新增迁移用例(旧库打开 → 列存在)。

### 1.2 judge 工具面扩展到 9 个(akashic 12 个中的核心)

`stages/judge-agent-tick.ts` 的 `TOOLS` 增加:

| 工具 | 行为 | 数据来源 |
|---|---|---|
| `mark_interesting(item_ids, reason)` | 落库 `store.setVerdict("interesting", reason)` | items 表 |
| `mark_not_interesting(item_ids, reason)` | 已有,补 reason → `setVerdict("not_interesting")` | items 表 |
| `get_recent_chat()` | 最近对话文本(≤20 条,过滤 context frame) | `runtimePorts.session.recentMessages`,fallback 复用 wake 的 jsonl 读取(`wake/index.ts readRecentPassiveConversation`,提取为共享 helper) |
| `recall_memory(query)` | 偏好召回,关键词 + 可选 embedding 排序 | `@cogito/gate` `recallPreferencesRanked`(`runtimePorts.memory.preferenceBlock` 的按需版) |
| `get_content(item_id)` | 正文缓存优先 → 摘要/标题 | `store.getItem(id).evidence` / items |
| `web_fetch(url)` | 带 webPolicy 的安全抓取 | 见 1.4 |
| `web_search(query)` | 带 webPolicy 的安全搜索 | 见 1.4 |
| `message_push(message, evidence_ids)` | judge 内暂存草稿(不终止 loop) | `TickContext.draftMessage` |

- `TickContext` 增加:`draftMessage: string | null`、`interestingItemIds` 语义改为
  mark_interesting 的显式结果(与 `fetch_evidence` 的隐式 interesting 合并)。
- `finish_judgment` 保持终局动作;send 时若 `draftMessage` 为空,回环要求先
  `message_push`(对应 akashic "mark_* 不是终止动作,之后必须调 finish_turn"。
- **prompt 升级**:从 `akashic plugins/proactive_flow/prompt.py` 移植
  「Alert 快速路径 / 工具职责 / 规则优先级 / 信息源规则 / 决策流程 / 发送要求 /
  finish_turn.reason 分类法(no_content | user_busy | already_sent_similar | other)」,
  替换 `buildSystemPrompt` 的简短版本。VEDA/persona 块保留现注入方式。

### 1.3 Alert 快速路径

- `buildSystemPrompt`:候选按 kind 分组渲染——`【Alerts(时效性高,优先处理)】`
  在前,`【Content 列表】` 在后;优先级规则 `Alert > Content > Context-fallback`。
- judge 循环:alert 条目视为已分类(无需 `fetch_evidence`/`mark_*`);
  send 时 evidence 自动包含全部 alert 的 item_id。
- 完整性回环(completeness)只对未分类的 content 生效,alert 不参与。
- `DefaultRuntime.commit`/`deliver`:alert 条目照常 `markPushed` + ACK
  (`sourceRefsForEvidence` 已带 `event_id`/`ack_source_id`,无需改)。

### 1.4 共享 web 安全策略(proactive 侧首次落地)

- 现状:安全 web 抓取只存在于 `@cogito/drift/src/tools.ts`
  (`validateWebUrl`/`fetchWebPage`/`DriftWebPolicy` 等),proactive 的
  `fetch_evidence` 是裸 `fetch`。
- 方案:把 `DriftWebPolicy`/`validateWebUrl`/`fetchWebPage`/`webSearchPage`
  /`DriftWebDnsLookupFn` 从 `drift/src/tools.ts` **上移到 `@cogito/gate`
  新模块 `web.ts`**,drift 保留 re-export(不破坏 drift 的公开 API)。
- proactive 的 judge `web_fetch`/`web_search` 工具与 `HttpPrefetchStrategy`
  (prefetch 阶段)改用 `@cogito/gate/web.ts`,webPolicy 从
  `PusherConfig.drift.webPolicy` 提升为顶层 `webPolicy`(保留 `drift.webPolicy`
  兼容读取)。默认拒绝 loopback/私网/DNS 重绑定,`maxRedirectHops` ≤ 5。
- 测试:`gate/test/web.test.ts`(从 drift security.test.ts 迁移用例)。

### 1.5 空候选"轻松挑起话题"分支(route 阶段)

- 现状:`DefaultRuntime.route`(`lifecycles/default/runtime.ts:232`)候选为空直接
  `idle.run` → 写 drift 许可,judge 不跑。akashic 允许空 alert/content 时
  `get_recent_chat` → 低概率发一条 evidence 为空的轻消息。
- 方案:
  - `route`:候选为空且 `gateVerdict.contextAsFallbackOpen` 为 true 且
    `runtimePorts.session.recentMessages` 可用时,以**空候选 + 仅允许
    `get_recent_chat`/`finish_judgment`/`message_push`** 的受限模式跑一次
    judge(对应 akashic「禁止在这两条路之外做任何事,不允许捏造 item_id」)。
  - 判定 `context_only` 且 `draftMessage` 非空 → 走 `resolve`/`commit`
    发轻消息(evidence 必须为空数组);否则照旧 idle/drift。
  - 新配置:`gate.contextOnly.chatLevity`(bool,默认 false 保持现状)与
    `gate.contextOnly.chatLevityProbability`(默认 0.1,对应 akashic 低概率)。
  - `judge-agent-tick.ts` 支持 `items=[]` 的受限模式(空候选时 `fetch_evidence`
    等工具不出现在 schema 中)。

---

## Phase 2 — tick 审计补全

**现状**:`tick_log` 无 `tick_id`/`gate_exit`/三类计数/`proactive_effects_json`;
`tick_steps` 无工具级字段;无 cache token 统计;drift 步骤不进入统一审计时间线。

### 2.1 tick_log 补列

- `store.ts` 迁移:
  - `tick_id TEXT`(新行写入 UUID,旧行留空;monitor 查询优先 tick_id)
  - `gate_exit TEXT NOT NULL DEFAULT ''`(gate 判定结果,akashic gate_exit)
  - `alert_count INTEGER NOT NULL DEFAULT 0` / `content_count INTEGER NOT NULL DEFAULT 0`
    / `context_count INTEGER NOT NULL DEFAULT 0`(按 candidates 的 kind 计数)
  - `llm_cache_read_tokens INTEGER NOT NULL DEFAULT 0` /
    `llm_cache_write_tokens INTEGER NOT NULL DEFAULT 0`
- `recordTickLog`/`finishTickLog` 签名扩展;`DefaultRuntime.begin` 记录
  gate_exit(`state.gateVerdict.reason` 或 `"open"`),`sense` 阶段按 kind 计数。

### 2.2 tick_steps 工具级字段

- 迁移:`tool_name`/`tool_call_id`/`tool_args_json`/`tool_result_text`/
  `interesting_ids_after`/`discarded_ids_after`/`cited_ids_after`/
  `final_message_after`,全部 `TEXT NOT NULL DEFAULT ''`。
- `recordTickStep` 签名扩展;`TurnContext.recordToolStep`(judge 工具审计)改为
  结构化写入(保留 `detail` 兼容拼接,monitor 展示优先用结构化列)。
- 对齐 akashic `tick_step_log` 的形状,现有 `phase/detail` 列保留不删。

### 2.3 cache token 统计

- `ChatCompletionResponse.usage` 已含 `cacheRead`/`cacheWrite`
  (`packages/ai/src/chat.ts:57`)。
- judge 循环每次 `client.complete` 后累加 → `TickContext` → `finishTickLog`
  写入 2.1 的两列。dedupe/resolve 的调用不计数(与 akashic 一致,只记 judge)。

### 2.4 drift 步骤并入统一审计时间线(三进程语义)

- 不做跨库写(proactive.sqlite 归 proactive)。方案:
  - `@cogito/drift` daemon 在 `DriftTurnPipeline.run` 返回后,把
    `{run_id, session_key, run_at, skill_name, status, steps_taken, message_result,
    briefing}` 写一条 `drift.db runs`(已存在,无需新表)。
  - `@cogito/gate` 新增只读查询 `loadDriftAudit(driftDbPath)`(读 runs 表,
    无写权限要求)。
  - `monitor.ts` 的 `tick_logs` 端点:收到 `driftDbPath`(index.ts 已传入,
    见 `index.ts:963`)时,按时间合并 drift 行,`flow=drift` 标记(akashic
    dashboard 的 `flow` 过滤参数已有,补齐数据源)。
- 测试:`monitor` 合并时间线用例。

---

## Phase 3 — drift 触发调度:一次性到期采样接线

**现状**:`@cogito/gate/drive.ts` 的 `sampleDriftDelayHours`(akashic
`sample_drift_delay_hours` 移植)生产代码零调用;daemon 固定 300s 轮询,
`advanceDriftDrive` 以 `hazard=0, threshold=0` 调用,实际只起 repetition 抑制;
akashic wake 用 `timer_anchor` + `next_attempt_at` 做一次性到期采样。

### 3.1 drift.db 新增 timer 状态

- `@cogito/drift/src/state.ts` 新表 `drift_timer`:
  `session_key TEXT PRIMARY KEY, timer_anchor TEXT NOT NULL,
  next_attempt_at TEXT NOT NULL, updated_at TEXT NOT NULL`。
- `DriftStateStore` 增加 `loadDriftTimer(sessionKey)` /
  `saveDriftTimer(sessionKey, anchor, nextAttemptAt, now)`。

### 3.2 daemon 调度逻辑(`drift/src/daemon.ts`)

```
tick():
  1. gate = readDriftGate(sessionKey, now)
     gate?.verdict === "suppressed" → skip(保留现有 TTL 语义)
  2. lastUserAt / lastDriftAt / repetition(现有逻辑)
  3. timer_anchor = f(lastUserAt, lastDriftAt, repetition)   # 移植 _drift_timer_anchor
     if anchor != stored.anchor or stored.next_attempt_at 缺失:
        delay = sampleDriftDelayHours(random_draw, idle_hours, recent_drift_suppression, repetition_suppression)
        next_attempt_at = now + delay * 3600_000; 持久化
  4. now < next_attempt_at → skip(不执行)
  5. 到期:advanceDriftDrive 评估(保留现有 repetition 抑制)→ 执行 pipeline
     → 执行后清空 next_attempt_at(下次 tick 重新采样)
```

- 保留 300s 轮询外壳(不引入 setInterval 长睡眠,便于重启恢复);
  到期精度由 `next_attempt_at` 保证,轮询只是唤醒机制。
- `repetition`(drift_repeat 指纹)参与 anchor 与 scale,行为对齐 akashic。
- 测试:`drift/test/scheduling.test.ts`(anchor 变化重采样、未到期跳过、
  重启后从持久化 next_attempt_at 恢复)。

---

## Phase 4 — MemoryOptimizerLoop(记忆质量优化器)

**现状**:akashic `bootstrap/proactive.py:122` 独立后台任务
(`proactive_v2/memory_optimizer.py`,~440 行):每轮把 `PENDING.md` 的
`[identity]/[preference]/[key_info]/[health_long_term]/[requested_memory]/
[correction]/[agent_context]` 事实合并进 `MEMORY.md`(缺席成本测试 +
三类保留 + 必须剔除清单),并更新 `SELF.md` 三段自我认知。cogito 无对应。

### 4.1 新模块 `@cogito/drift/src/memory-optimizer.ts`

- 移植 `MemoryOptimizer` 类:
  - 输入:`memoryDir`(默认 `agentDir/memory`)、LLM fn、Clock。
  - 流程:`read PENDING.md + MEMORY.md + SELF.md` → LLM 重写 → 原子写
    (`write tmp + rename`)+ 写前备份 `MEMORY.md.bak`(与 `resetVeda` 备份模式一致);
    失败不破坏原文件;`MemoryOptimizerBusy` 并发保护。
  - 提示词逐条移植(缺席成本测试、网络运维细节剔除、当前社会角色保留现在时等)。
- 放 drift 包的理由:空闲期任务 + 已有 LLM 适配;不放 proactive(推送引擎
  语义不符),不受 `drift_gate` 门控。

### 4.2 daemon 接线

- `runDriftDaemon` 新选项:
  `memoryOptimizer?: { enabled?: boolean; intervalSeconds?: number; memoryDir?: string }`
  (默认 disabled,保持现状)。
- 启动独立 loop(与 drift tick 并行):`setInterval` 等价结构 + SIGTERM 清理;
  每轮独立 try/catch,失败仅日志(与 akashic MemoryOptimizerLoop 行为一致)。

---

## Phase 5 — 配置校验与杂项

### 5.1 validatePusherConfig 补 range/枚举校验

- `packages/proactive/src/index.ts` `validatePusherConfig` 增加:
  - `tick.tickS0/tickS1` ∈ [1, 86400] 且整数;`tickJitter` ∈ [0, 1]
  - `gate.anyaction.probabilityMin/probabilityMax` ∈ [0, 1] 且 min ≤ max;
    `idleScaleMinutes` ∈ [1, 1440]
  - `gate.contextOnly.probability` ∈ [0, 1];`chatLevityProbability` ∈ [0, 1]
  - `safety.deliveryDedupeHours` ∈ [0, 168]
  - `sourceAck.retryBaseDelayMs/retryMaxDelayMs` ∈ [1000, 86400_000]
- 对齐 akashic `config_loader._validate_ranges` 的意图(akashic 对 tick 间隔、
  jitter、anyaction 概率、context 参数都有 range 校验)。

### 5.2 gate 链 reason 分类法

- `finish_judgment.skip_reason` 提示限定为
  `no_content | user_busy | already_sent_similar | other`(prompt 层,
  Phase 1 的 prompt 移植已含)。

### 5.3 ToolHook 等价物(可选,评估后实施)

- akashic 的 `ToolHook`/`ToolExecutor` 全局钩子。cogito drift 已有
  `DriftToolPolicy`/`authorizationRequest`(`drift/src/tools.ts:56-82`)。
- 建议:只给 proactive judge 的 `web_fetch`/`web_search`/`message_push`
  增加一个 `authorize?(tool, args)` 宿主钩子(与 drift 的
  `DriftToolAuthorizationRequest` 同型),不做全局 ToolHook 体系。

---

## 测试与验收

| Phase | 新增/修改测试 |
|---|---|
| 1 | `test/judge-tools.test.ts`(mark_interesting/recall_memory/get_recent_chat/web_fetch 拒绝私网)、`test/alert-fastpath.test.ts`、`test/chat-levity.test.ts`、`test/store-kind-migration.test.ts` |
| 2 | `test/audit-columns.test.ts`、`test/tick-steps-tool.test.ts`、`test/monitor-drift-merge.test.ts` |
| 3 | `drift/test/scheduling.test.ts`(一次性到期采样) |
| 4 | `drift/test/memory-optimizer.test.ts`(原子写/备份/PENDING 消费) |
| 5 | `test/config-validation.test.ts`(range 拒绝用例) |

验收流程:
1. 每个 Phase 完成后 `npm run check`(全量,无 warning)。
2. 单测:`./test.sh`(根目录)或包内
   `node ../../node_modules/vitest/dist/cli.js --run test/<file>.test.ts`。
3. 迁移兼容:旧 proactive.sqlite/drift.db 打开不报错、新列存在
   (`sqlite-migration-concurrency` 模式)。
4. 端到端冒烟:`proactive.example.json` 开 `preset: "dev_verify"`,
   观察 judge 工具调用与 tick_log 审计列。

## 实施顺序建议

1. **Phase 1 + 2**(功能与可观测性价值最大,且 2 依赖 1 的 kind/工具数据)
2. **Phase 3**(策略修正,独立)
3. **Phase 4**(记忆优化,独立)
4. **Phase 5**(收尾校验)

每个 Phase 保持独立可合并、可回退;不改变三进程架构与 gate 共享契约。
