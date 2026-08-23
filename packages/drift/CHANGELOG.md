# Changelog

## [Unreleased]

### Added

- Context frame now degrades by section instead of blind truncation: `fitContextFrame` drops low-priority sections (`FRAME_DROP_ORDER`, exported) until the budget fits and appends a `[context frame dropped sections: ...]` notice so the model knows what is missing; hard clipping remains as a last resort.

### Added

- 文件上下文提供器：按每轮 Drift 重新加载 `memory/VEDA.md`、`SELF.md`、`MEMORY.md` 与 `RECENT_CONTEXT.md`；支持严格 UTF-8 校验和 `requiredVeda`。
- 投递闭环：`runs.message_hash` 列 + `markRunMessageSent()`，投递确认后 `message_result` 从 staged 回写 sent（akashic `record_commit_result` 对应物，按 hash 幂等匹配）。
- 上下文帧补全：`runtime_clock` 增加 `current_time_local`（akashic `_build_runtime_clock`）；新增可选 `activityFn` 依赖，注入 `user_activity` 段（如 last_user_at）。
- `message_push` 投递前查重：`DriftDeliverySink.dedupeCheck` 可选接口，重复消息被拒绝并走静默闭环。
- 时长预算：`DriftTurnPipelineDeps.maxDurationMs`（默认 10 分钟），超时走 wrap-up。
- shell 进程生命周期：`ShellTool` 改为 spawn 托管（`active` 集合 + `terminate()`），pipeline run 结束时回收仍在运行的子进程（akashic `terminate_owner`）。
- MCP 支持：`DriftMcpConnections` 类型 + `mount_server` 工具；`requires_mcp` 按已连接 server 过滤（不再一律丢弃）；context frame 增加 `drift_mcp_directory` 段；系统提示补充挂载指引。
- 向量召回：`recallPreferencesRanked()`（LIKE 粗筛 + 嵌入余弦精排，失败降级）；`DriftToolDeps.memoryEmbeddingFn` 可选依赖。
- 技能健康度：selection context 与 briefing 标注 `[stale-paused]`（paused 超 3 天）与 `[flaky]`（最近步骤错误率 > 30%）。
- Skill frontmatter 扩展：`cooldown_hours` / `max_runs_per_day` / `time_window`，受限 skill 不进候选（`DriftStateStore.skillRestriction`）。
- `read_journal` 工具：skill 运行中只读查询自己的 journal 与 cursor。
- SKILL.md 版本哈希：`skill_continuum.skill_hash` 列，文件变更后标注 `[skill-updated]`。
- 结构化日志：`[drift]` 前缀（`DRIFT_LOG_LEVEL=silent` 可关），覆盖 enter/skip/step/约束拒绝/工具错误/wrap-up/fallback/异常。
- 可扩展 `DriftToolRegistry`：支持同名保护、搜索和 MCP 动态挂载；文件工具新增显式 `workspace/<path>` 命名空间。
- LLM 调用适配层：统一 OpenAI-compatible tool-call 解析、超时与有界瞬时错误重试，并支持宿主注入客户端。
- Durable Drift run lease、阶段进度、staged delivery 恢复与同一 `run_id` 的 finish 幂等。
- 工具风险元数据、宿主授权/审计回调、脱敏 tool-call 事件，以及文件、shell cwd、web SSRF 边界。
- Host-owned session/memory 适配、上下文字符预算、LLM observer 与 run diagnostics API。
- Added terminal-run retention APIs with age/count limits, staged-delivery protection, and linked step/journal cleanup.
- Added native web DNS preflight, resolved-address pinning, redirect-hop validation, and rebinding-focused security coverage.
- Added migration and multi-process lease coverage for legacy SQLite Drift databases.
- 三进程门控：`drift_gate` 表新增 `context` 列(写入方预取的上下文事件文本)，`DriftGate`/`writeDriftGate`/`readDriftGate` 同步携带；老库自动迁移。
- Drift 观测与重复抑制：`drift_observations` 表 + `recordDriftObservation()`/`recentDriftObservations()`；`drift_repeat` 表 + `recordDriftSuccess()`/`loadDriftRepeat()`(指纹相同累计、变化重置)。
- `runDriftDaemon` tick 闭环：gate 的 `context` 预取进 `driftCurrentContext`；`repetition` 取 `drift_repeat` 计数；每次 tick 记录 observation；有 committed 出站时记录成功指纹。
- Daemon 模型选择：`pickDaemonModel()` 由 settings.json 的官方 `enabledModels` 字段驱动(与 --models 同格式：精确 "provider/modelId"、裸 id 或 glob)，未配置时保持取第一个可用模型；drift daemon 启动时按此选择。

- 解耦:门控表/调度/偏好召回/投递哈希/事件契约迁至共享层 `@cogito/gate`;`DriftStateStore` 的 staged 读写改为委托 `DriftStagedDeliveryStore`,drift daemon 的 gate 读取改用 `DriftGateStore`。drift 不再依赖 proactive。

### Changed

- `ScanSkillsStrategy` 构造函数接受可选 `DriftMcpConnections`；扫描过滤同时包含 requires_mcp 与 frontmatter 限制。
- `DriftRunContext` 增加 `driftMessageHash`。
- Drift 的 OpenAI-compatible LLM 调用改为复用 `@cogito/ai/chat`，保留宿主注入 fetch/client 的兼容入口。
- `DriftLlmFn`/`LlmToolCall` 返回值携带 LLM cache usage;loop 汇总为 run 级统计,随 `drift_finished` 事件以 `llmCacheReadTokens`/`llmCacheWriteTokens` 输出(akashic `record_llm_cache` 审计)。
- wrap-up 收尾提示保持 user role 并注释原因:`@cogito/ai` 的 `Message` 联合类型无 system 角色,akashic 的 system-role 注入无法等价移植(行为等价)。


- Default `driftDir` moved from `~/.cogito/agent/drift` to `<cwd>/.cogito/extensions/drift` (skills at `<driftDir>/skills`); the daemon now mounts drift under the project `.cogito/extensions` tree alongside proactive.