# Cogito Drift 完善计划

## Purpose

完善 `packages/drift`（akashic drift_flow 的 TypeScript 移植版）及其宿主接线 `packages/proactive`。核心管线（Scan → Prepare → Execute → Finish）已经移植完整，本计划的重点是补宿主闭环（投递状态、MCP、进程生命周期）、提升选择质量（上下文信号、去重、健康度），以及少量超越 akashic 的新设计。

本文档是 implementation handoff。记录设计讨论的决策，除非实现中发现需要推翻的理由，否则按此范围执行。

## 现状盘点（基线）

已存在：

- `DriftTurnPipeline`：四段式管线，select 前置约束（BEFORE_SELECT / AFTER_SEND 工具白名单）、constraint rejection 上限 2、wrap-up 强制收尾（2 次重试）、fallback_pause、maxSteps=20。
- `DriftStateStore`：`drift.db` 7 张表（runs / skill_continuum / skill_journal / global_note / self_state / run_steps），schema 与 akashic 一致，含 cursor_json ALTER 迁移先例。
- 12 个自研工具：select_skill / idle_drift / finish_drift / read_file / list_dir / write_file / edit_file / shell / fetch_messages / search_messages / recall_memory / message_push。
- 策略抽象：`DriftEngine` + `DriftScanStrategy` / `DriftExecutionStrategy`（默认 ScanSkillsStrategy + TurnPipelineExecutionStrategy）。
- 宿主接线：默认生命周期 `DriftIdleStrategy`（idle 阶段，minIntervalHours 默认 3h）、wake 生命周期 `wake/drift-drive.ts`（akashic drift_drive.py 移植）、`seedExampleDriftSkill`、`buildDriftLlmFn`（裸 fetch OpenAI 兼容端点）。
- 测试：`test/drift.test.ts`（434 行，覆盖主线 + 约束 + wrap-up + fallback + 校验契约）。

已确认的缺口：

| 缺口 | 证据 |
|---|---|
| message_result 永远到不了 "sent" | `state.ts::updateLastMessageResult` 与 `store.ts::markDelivered` 均无调用方，ack 链路断裂 |
| requires_mcp 的 skill 一律丢弃 | `scan.ts` 注释 "pi 无 MCP 网关"，但 `packages/mcp`（client+server）已存在，只是未接线 |
| shell 一次性执行、无终止手段 | `ShellTool` 用 `execFile`；akashic 有 owner 绑定 + `terminate_owner()` |
| runtime_clock 只有 UTC | akashic 提供 UTC + local；prompt 要求按"今天/昨天"判断相对时间 |
| 上下文无本轮 fetch 事件 | pi `TurnContext` 没有 akashic 的 `fetched_context` |
| message_push 不查重、不查冷却 | `SendMessageTool` 直接 insertDelivery；store 里已有 hash 去重与冷却计数但未复用 |
| 无时间预算 | 只有步数上限，无时长上限 |
| recall_memory 只有 LIKE 子串召回 | `memory.ts` 用 term 提取 + LIKE；宿主已有 `buildEmbeddingApi` 未接入 |
| drift 活动不可见 | monitor/TUI 只展示 deliveries，不展示 drift run |

## 设计原则

1. 不改变 Drift 的语义模型：completed/paused、fire-and-forget、每轮重新选择、自我连续性（self_state / self_observation）全部保持。
2. 默认行为不回归：所有新增能力必须可关（配置开关或依赖缺省降级），akashic 行为作为参照系。
3. 状态表变更沿用 cursor_json 先例：`PRAGMA table_info` 检查 + `ALTER TABLE ADD COLUMN` 迁移，不破坏已有 drift.db。
4. 宿主差异留在宿主：drift 包保持纯依赖注入（deps 接口），不直接 import proactive 包；反向依赖（proactive → drift）保持不变。
5. 每个 phase 落地时同步：测试（包内 vitest 单测，不跑全量套件）、`packages/drift/CHANGELOG.md` 与 `packages/proactive/CHANGELOG.md` 的 `[Unreleased]` 条目。

## Phase 1 — 投递闭环（P0，先做） — ✅ 已完成

### 现状

- `SendMessageTool` 调 `storeDb.insertDelivery()` 写入 deliveries 表（fire-and-forget），返回 delivery id 但未使用。
- `FinishDriftTool` 把 `message_result` 记为 `staged`/`silent`。
- `DriftStateStore::updateLastMessageResult()` 存在但无调用方。
- `ProactiveStore` 有 `unackedDeliveries()` / `markDelivered()`，仓库内无消费方（ack 归属待确认，见开放问题）。

### 目标

真实投递确认后，drift run 的 `message_result` 变为 `sent`，下一轮 briefing / recent_drift_runs 显示真实结果。

### 设计

1. `drift.db` 的 `runs` 表加可空列 `message_hash TEXT`（迁移照 cursor_json 先例）。`saveFinish` 在 `messageResult === "staged"` 时写入该 run 的消息 hash（`SendMessageTool` 已算过 sha256，把 hash 存入 `DriftRunContext`）。
2. 宿主侧（`packages/proactive`）在确认投递的地方（ack 路径，待确认归属）回写：
   `UPDATE runs SET message_result='sent' WHERE message_hash=? AND message_result='staged'`
   封装为 `DriftStateStore::markRunMessageSent(messageHash)`。
3. 回写路径不依赖 drift 进程存活：ack 与 drift run 是不同时刻，靠 message_hash 匹配，天然幂等。

### 涉及文件

- `packages/drift/src/state.ts`（迁移 + markRunMessageSent + saveFinish 写 hash）
- `packages/drift/src/tools.ts`（ctx 传递 messageHash）
- `packages/drift/src/runtime.ts`（DriftRunContext 加字段）
- `packages/proactive/src/store.ts`（ack 后回调或由消费方调用）
- 待确认：ack 消费方所在包

### 验收

- 一轮 message_push：finish 后 runs.message_result='staged' 且 message_hash 非空；ack 后变为 'sent'。
- 无 staged 消息的 run 不受影响。
- 测试：`updateLastMessageResult` 路径 + hash 匹配幂等。

## Phase 2 — 上下文帧补全（P0） — ✅ 已完成

### 2a. runtime_clock 加本地时间

照 akashic `_build_runtime_clock`：`current_time_utc` + `current_time_local`。prompt 里已有"以 runtime_clock 完整日期时间为准"的规则，补 local 时间让"今天/昨天"判断不再依赖用户时区猜测。

### 2b. 注入本轮用户活动信号

akashic 注入 `fetched_context`；pi 的 `TurnContext` 没有等价物。低配实现：`DriftTurnPipelineDeps` 加可选 `activityFn?: () => Promise<string>`，宿主在 idle 阶段注入 `SenseState.lastUserAt` 等摘要（如 "last_user_at=... energy=..."）。放到 context frame 的 `runtime_clock` 段或独立 `user_activity` 段。可选，不阻塞其他 phase。

### 涉及文件

- `packages/drift/src/runtime.ts`（buildRuntimeContextMessage）
- `packages/proactive/src/stages/idle.ts`（注入 activityFn）

### 验收

- 上下文帧出现 `current_time_local`。
- 开启 activityFn 时出现 user_activity 段；未提供时帧内容与现在逐字一致（除 local 时间）。

## Phase 3 — 推送去重与门控（P1） — ✅ 已完成

### 现状

`message_push` 不查重、不查冷却：同一个问题可能隔几轮连发两遍。`ProactiveStore` 已有 `hasDeliveredMessage`（24h hash 窗口）与投递冷却计数，未复用。

### 设计

1. `DriftDeliverySink` 接口扩展可选方法 `dedupeCheck?(message: string): { duplicate: boolean; reason?: string }`（宿主用现有 store 方法实现）。
2. `SendMessageTool` 在 insert 前调用：重复或冷却中 → 返回错误 JSON（"已推送过类似消息"），LLM 走静默闭环或换内容；错误信息进 run_steps 可回溯。
3. 不改变 fire-and-forget 语义。

### 验收

- 同一消息 24h 内第二次 push 被拒，run 仍正常 finish（completed / silent）。
- 未接 sink 时行为与现在一致。

## Phase 4 — 时间预算（P1） — ✅ 已完成

### 现状

只有 maxSteps=20，无时长上限；卡死的 shell 或慢 LLM 会拖住整个 tick。

### 设计

- `DriftTurnPipelineDeps` 加 `maxDurationMs?: number`（默认 10 分钟）。
- `executeLoop` 每步检查 elapsed，超时走 wrap-up（与步数耗尽同一路径）。
- LLM 调用本身已有 60s 超时，不重复处理。

### 验收

- 测试：短预算 + 假 LLM 验证超时进入 wrap-up / fallback_pause。

## Phase 5 — shell 进程生命周期（P1） — ✅ 已完成（write_stdin/task_stop 可选增强未做）

### 现状

`ShellTool` 是 `execFile` 一次性执行：无长进程管理、无 stdin、无终止。run 结束后泄漏进程无兜底。

### 设计

1. drift 包内加 `ProcessRegistry`：`spawn` 管理（记录 pid / sessionKey），`terminateOwner(ownerKey)` 杀进程组。
2. `ShellTool` 改为走 registry，暴露 `terminate()`；`DriftTurnPipeline.run()` 的 finally 中回收（照 akashic `terminate_owner`，且保留原始异常语义）。
3. 可选增强：`write_stdin` / `task_stop` 工具（akashic 有），依赖 registry 的 stdin/terminate 能力。放同一 phase 的第二个提交。

### 验收

- 测试：shell 起 `sleep 1000`，pipeline 结束（含异常路径）后进程被终止。
- 现有一次性命令行为不回归。

## Phase 6 — MCP 支持（P2） — ✅ 已完成

### 现状

`ScanSkillsStrategy` 丢弃所有 `requires_mcp` 的 skill；`packages/mcp` 存在但 drift 未接线。

### 设计

1. `DriftToolDeps` 加 `mcp?: DriftMcpConnections`（宿主传入：serverName → { tools: [{name, schema, call(args)}] }，由宿主用 `packages/mcp` client 维护连接）。
2. `ScanSkillsStrategy` 改为：`requires_mcp` 全部在已连接集合内的 skill 可用（akashic 集合包含语义）。
3. 新增 `mount_server` 工具（照 akashic MountServerTool）：把已连接 server 的工具注入 drift 工具注册表，risk 标记为 external-side-effect。
4. 上下文帧补 `drift_mcp_directory` 段（server 名 + 工具数 + 挂载提示，照 akashic）。
5. 无 mcp 依赖时行为与现在一致（requires_mcp 丢弃）。

### 开放问题

- MCP 连接生命周期归属：drift 与 proactive 共享连接还是 drift 自建？倾向共享（宿主传入），避免重复握手。

### 验收

- 一个 requires_mcp 的 skill 在 server 连接时可被选择并可调用其工具；未连接时仍不可用。
- 手写假 mcp 连接测试（不依赖真实 server）。

## Phase 7 — recall_memory 向量召回（P2） — ✅ 已完成

### 现状

`memory.ts::recallPreferences` 用 ASCII token + CJK bigram 提取 + `summary LIKE`，召回质量有限。

### 设计

- `recallPreferences` 加可选 `embeddingFn?: (texts: string[]) => Promise<number[][]>`；有则对 query + 候选 summary 做余弦 top-k，无则回退现有 LIKE 路径。
- 宿主 `packages/proactive/src/index.ts` 传入 `buildEmbeddingApi` 产物（与 wake 共用）。
- 注意延迟：embedding 调用放在 executor 线程外或限流；候选集先 SQL 粗筛（现状）再精排。

### 验收

- 构造 memory_items + mock embedding，验证 top-k 排序与 limit。
- 无 embeddingFn 时输出与现在一致。

## Phase 8 — 技能健康度信号（P2） — ✅ 已完成

### 现状

selection context 只有 status / run_count / briefing / scratchpad / cursor；长期 paused 或反复失败的 skill 靠用户自写审计 skill（akashic 的 review-drift-gaps 模式）。

### 设计

在 `buildSelectionContext` / `loadBriefing` 中，用已有表数据（无 schema 变更）加标注：

- `[stale-paused]`：last_status=paused 且距今 > N 天（默认 3，可配），标注 `paused 天数` 与上次停点。
- `[flaky]`：从 `run_steps` 统计该 skill 最近 10 步 error 占比 > 0.3。

标注进入 context 后由 LLM 决定续接 / 放弃 / 改选，runtime 不做强制。

### 验收

- 构造 paused 3 天的 skill，briefing 出现 stale-paused 标注与天数；flaky 同理。

## Phase 9 — 超越 akashic 的新设计（P3，逐项可选） — ✅ 9a/9b/9c 全部完成

### 9a. Skill frontmatter 扩展

`parseSkillFrontmatter`（手写解析器，已支持数字/布尔）扩展字段：

- `cooldown_hours`：该 skill 两次运行最小间隔。
- `max_runs_per_day`：当日运行上限。
- `time_window`：可选时段（如 `21:00-23:00`）。

Scan 阶段过滤 + selection context 标注（如 `[冷却中: 剩余 2h]`）。`SkillMeta` 加字段。注意：frontmatter 解析器需同步扩展，暂不引入 YAML 依赖（依赖政策：直接外部依赖锁精确版本，收益不明确前保持手写）。

### 9b. `read_journal` 工具

只读工具：skill 运行中随时查自己的 `skill_journal`（按 entry_type/key 过滤）与 cursor。现在只能靠 select_skill 返回的最近 8 条或 shell 读 sqlite。

### 9c. SKILL.md 版本哈希

`skill_continuum` 加 `skill_hash TEXT` 列（迁移先例同 cursor_json）；`loadSkillMeta` 计算正文 sha256。文件变更后 briefing 标注 `[skill-updated]`，提示 LLM 旧 scratchpad/停点可能失效，不要盲信。

### 验收

- 每项独立：frontmatter 字段生效且有测试；read_journal 返回过滤结果；SKILL.md 改动后 briefing 出现标注。

## Phase 10 — 可观测性（P3） — ✅ 已完成

- monitor API 增加 drift 摘要端点（最近 runs：skill / status / briefing / message_result，来源 drift.db），或在现有 dashboard 端点追加。
- drift 包内结构化日志统一 `[drift]` 前缀（现在基本无日志）。
- `run_steps` 只读查询入口（调试用）。

## 测试策略

- 所有 phase 在 `packages/drift/test/drift.test.ts` 扩展或新增文件；宿主侧（proactive）改动在 `packages/proactive/test/` 补对应单测。
- 运行方式：包内 `node ../../node_modules/vitest/dist/cli.js --run test/<file>.test.ts`；不跑全量套件。
- 假 LLM / mock 依赖模式沿用现有测试（faux LLM 返回预定 tool call 序列）。
- MCP / embedding / 进程回收必须有独立单测，不依赖真实外部服务。

## 文件映射

| 文件 | Phase |
|---|---|
| `packages/drift/src/state.ts` | 1, 8, 9c |
| `packages/drift/src/tools.ts` | 1, 3, 5, 6, 9b |
| `packages/drift/src/runtime.ts` | 1, 2, 4, 5, 6, 8 |
| `packages/drift/src/stages/scan.ts` | 6, 9a |
| `packages/drift/src/stages/execution.ts` | 4 |
| `packages/drift/src/memory.ts` | 7 |
| `packages/drift/src/index.ts` | 导出面 |
| `packages/proactive/src/index.ts` | 1, 7 接线 |
| `packages/proactive/src/stages/idle.ts` | 1, 2b |
| `packages/proactive/src/store.ts` | 1, 3（sink 实现） |
| `packages/proactive/src/monitor.ts` | 10 |
| `packages/proactive/src/wake/*` | 1, 2b, 4（wake 侧接线） |
| `packages/drift/test/` | 全部 |
| `packages/drift/CHANGELOG.md`、`packages/proactive/CHANGELOG.md` | 每 phase 落地时 |

## 优先级汇总

| 优先级 | Phase | 理由 |
|---|---|---|
| P0 | 1 投递闭环、2 上下文帧 | 补洞，工作量小，直接影响下一轮决策质量 |
| P1 | 3 推送去重、4 时间预算、5 shell 生命周期 | 可靠性，防刷屏 / 防卡死 / 防泄漏 |
| P2 | 6 MCP、7 向量召回、8 健康度 | 能力面与选择质量，需跨包接线 |
| P3 | 9 新设计、10 可观测性 | 可选增强 |

## 非目标

- 不移植 akashic 的 veda / persona / 行为规则前缀（pi 无 persona 体系，drift prompt 已自洽）。
- 不做多 workspace / 多用户隔离。
- 不引入 YAML 依赖（9a 维持手写解析，除非解析缺陷被证实）。
- 不改动 akashic-agent 仓库。
- 不做 legacy `state.json` 兼容（已是有意移除）。

## 风险与开放问题

1. **ack 消费方归属**：`unackedDeliveries` / `markDelivered` 目前无调用方，需先确认 pi 中 deliveries 由哪个 outlet 展示与确认（monitor API？TUI？gateway？），Phase 1 的接线点依赖此结论。
2. **MCP 连接生命周期**（Phase 6）：共享连接 vs 自建连接，倾向宿主传入共享实例。
3. **embedding 延迟**（Phase 7）：每轮 drift 的 embedding 调用次数与超时需限流，失败回退 LIKE。
4. **时间预算与 LLM 调用**：60s LLM 超时 + 10min 总预算的组合下，wrap-up 本身也可能超时；wrap-up 阶段单独放宽或直接 fallback_pause，实现时定。
5. **9a 的 time_window 解析**：手写解析器只支持简单键值，time_window 用字符串格式（如 `21:00-23:00`），不做完整表达式。


---

## 实施记录（2026-05 完成）

全部 10 个 phase 已实现并测试通过（drift 27 项 / ui 14 项 / proactive 相关 16 项；`npm run check` 中本计划涉及文件的 biome + tsgo 全绿）。与 akashic 的对照结论：

| Phase | akashic 参照 | cogito 实现 | 差异说明 |
|---|---|---|---|
| 1 | `record_commit_result` + `DriftFinished` 事件 | `markRunMessageSent(messageHash)` + web dashboard ack 端点 | 按 message_hash 幂等回写，与投递时刻解耦；事件总线 pi 无，以 ack 端点替代 |
| 2 | `_build_runtime_clock`（UTC+local）+ `fetched_context` | `buildRuntimeClock`（UTC+local）+ `user_activity` 段 | pi 的 idle 路径无 per-tick fetched context，用 presence 的 last_user_at 作低配注入 |
| 3 | 无（akashic drift 无查重） | `DriftDeliverySink.dedupeCheck`（24h hash + 最近 5 条） | 超越 akashic |
| 4 | 无（仅 max_steps） | `maxDurationMs`（默认 10min） | 超越 akashic |
| 5 | `DriftShellTool` owner 绑定 + `terminate_owner` | `ShellTool` active 集合 + `recycleShells`（finally） | `write_stdin`/`task_stop` 为可选增强，未实现 |
| 6 | `shared_tools` MCP 过滤 + `MountServerTool` | `DriftMcpConnections` + `mount_server` + `drift-mcp.ts` 桥 | 宿主用 `McpServerManager`（packages/mcp）eager 连接，复用 sources.mcp 配置；pi 无 risk 标注体系（N/A） |
| 7 | memory retriever 向量检索 | `recallPreferencesRanked`（LIKE 粗筛 + 余弦精排 + 降级） | 语义一致；无 embedding 时行为与旧版逐字一致 |
| 8 | 无（靠用户自写 review-drift-gaps） | `[stale-paused]` / `[flaky]` 内置标注 | 超越 akashic |
| 9 | 无 | frontmatter 扩展 / read_journal / skill_hash | 超越 akashic |
| 10 | `logging.getLogger("[drift]")` | `[drift]` 结构化日志 + monitor drift 端点 | run_steps 只读入口以 `/drift/steps` 提供 |

### 开放问题处置

1. ack 消费方：确认为 web dashboard（投递 tab 展示即 ack，`POST /api/dashboard/proactive/deliveries/ack`）。
2. MCP 连接归属：宿主 pusher 启动时 eager 连接共享实例，stop 时 `closeAll()`。
3. embedding 延迟：单批候选上限 40，失败降级 LIKE；未加独立限流（一次 recall 只发一批）。
4. wrap-up 超时：wrap-up 阶段不执行 deadline 检查（放宽），靠自身 2 次重试上限收口。
5. time_window：字符串 `HH:MM-HH:MM`，支持跨午夜（start > end 按次日处理）。

### 未做（明确排除）

- `write_stdin` / `task_stop` 工具（Phase 5 可选增强）。
- 事件总线（pi 无总线，投递闭环以 ack 端点 + deliveries 表完成）。
- veda/persona、多 workspace、YAML 依赖、legacy state.json 兼容（非目标）。
- 注意：`npm run check` 目前整体非零，是因为其他会话的未跟踪文件（`coding-agent/examples/extensions/vision-cache.ts` 等）存在 lint/type 错误，与本计划文件无关。
