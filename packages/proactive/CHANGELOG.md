# Changelog

## [Unreleased]

### Added

- Delivery now writes back to session history: `appendProactiveToSessionLog` appends a proactive assistant message to `<sessionsDir>/<sessionKey>.jsonl` (drift `fetch_messages`-compatible format) after a successful delivery via the default `createStandaloneSessionPort`; host-provided `runtimePorts.session` still overrides it.
- Added a default busy port (`createStandaloneBusyPort`): presence `last_user_at` within `gate.busyWindowSeconds` (default 120s) blocks proactive ticks, approximating akashic's `processing_state.is_busy` in the three-process model.

- Added host-facing runtime ports for authoritative sessions, presence, busy state, memory, outbound delivery, and source acknowledgements; standalone mode supplies a local adapter and durable ACK retry queue.
- Added namespaced plugin source registration for duplicate local source IDs, concurrent Wake source fetch with partial-failure isolation, and persistent MCP connections with lifecycle cleanup.
- Added default and Wake delivery orchestration with post-send session/presence/ACK side effects, plus monitor inspection for pending source ACK retries.
- Drift 接入文件上下文：默认从记忆 workspace 读取 VEDA/SELF/MEMORY/RECENT_CONTEXT，并支持通过 `drift.vedaPath` 与 `drift.vedaRequired` 配置 VEDA。
- Added an optional Feishu delivery outlet for proactive and drift messages, backed by the shared gateway config.
- Added source acknowledgement wiring for Wake, including generic MCP `ack` tool configuration and persistent retry handling.
- Added plugin architecture (`src/ext/`): `ProactivePlugin` contract + `PluginRegistry`, `ProactiveLifecycleSpec` + `ProactiveLifecycleBuilder` (slot/requires/produces/collects, topological ordering, dependency and terminal-slot validation, start rollback / stop error aggregation), `ProactiveFrame` + `ProactiveTickResult`, and `ProactiveKernel`.
- Directory loading now treats each module as a plugin (`plugin` named export, default-export plugin object/class, or legacy default-export source); plugins can contribute sources, lifecycles, modules, and runtime/module factories. Legacy source files keep working unchanged.
- `runPusher` assembles the selected lifecycle through `PluginRegistry` (spec → runtime factory → module factory → `ProactiveKernel`); built-in `default_proactive` / `wake_proactive` plugins and directory plugins share the same assembly path. Non-default lifecycles (wake/custom) run on the generic `ProactiveLoop` (immediate first tick, interval-driven sleeps); runtime `abortError`/`close` hooks are wired automatically.
- Default lifecycle runs as a module graph (`proactive.run.start` → `admission.collect` → `sense` → `route` → `judge` → `resolve` → `commit` → `schedule`) driven by `DefaultRuntime`; `ProactiveEngine` now drives the kernel (external kernel via `options.kernel`, error ticks via `kernel.onTickError`).
- Wake lifecycle is now a kernel lifecycle (`wake.start` → `ingest` → `content.decide` → `drift.decide` → `schedule`) selected via `lifecycle: "wake"`; `runWakePusher` replaced by `buildWakeRuntimeDeps` + `WakeProactivePlugin` (apiKey validation deferred to runtime creation).
- Added `Clock` (injectable time; `SystemClock`) and typed `EventBus` with `ProactiveFinished` / `Delivered` events; engine and wake runtime emit tick-terminal and delivery events.
- Hot reload (`runReloadable`) now builds and starts the candidate instance before swapping (start failure keeps the old instance; `EADDRINUSE` retries stop-first).
- Added durable delivery outbox semantics: external delivery must succeed before item state is marked pushed; failed Feishu deliveries remain pending and retry.
- Rate trace lines are now envelope-shaped (`trace_type` / `source` / `subject` / `ts` / `payload`).
- Delivery acknowledgements now have a durable outbox migration path for existing databases and notify async retry bookkeeping.
- Drift 生命周期事件现在通过 `DriftEventObserved` 进入 Proactive `EventBus`；宿主可注入总线统一订阅 tick、投递与 Drift 事件。
- Memory background tasks now start with the pusher, expose serialized on-demand triggers, and shut down idempotently.
- Added the consolidation bridge wiring: `memory.vectorSync` (default true) syncs markdown-layer consolidation output into the host memory engine (`agentDir/memory/memory.sqlite`) through `ConsolidationBridge` — `history_entries` become idempotent `event` items and a second-pass LLM extraction writes profile/preference/procedure items; automatically skipped when no embedding model is configured.
- Added per-turn `BeforeTurn` hooks for event-driven memory consolidation, while retaining scheduled scans as a recovery fallback.
- Unified proactive, wake, profile, dedupe, judge, resolve, and memory LLM calls through the shared `@cogito/ai/chat` adapter.
- Added strict source contracts for declared channels, event identity, preprocess scores, and timestamps, with per-item quarantine and source health diagnostics.
- Added durable source scheduler last-fetch/backoff state, pending ACK batch inspection, transactional reservoir consume/expire/ack commits, and expiry tombstones that survive payload loss.
- Added durable MCP offset/cursor pagination with bounded page count and commit-after-ingest checkpointing.
- Added context-source dictionary results, Wake tick success/error audit records, source failure history, and monitor endpoints for quarantine, pending delivery, pending ACK, and Wake tick inspection.
- Added delivery idempotency keys, provider message IDs, and per-target delivery receipts for retry-safe external delivery.
- Added `RuntimeSnapshotStore` lease/fence admission, async-context snapshot binding, retired-resource draining, and append-only runtime replay journaling for safe hot reload.
- Added persistent `ReplayClock` and deterministic replay randomness; the monitor exposes runtime transitions at `/api/dashboard/proactive/runtime/replay`.
- Added tick-driven source fetch mode with durable last-fetch/backoff state; `fetch.mode: "background"` remains available for independent polling.
- Added full historical tick replay: canonical event normalization, replay source, fixed/event-time tick execution, and per-tick JSONL audit reports.
- Added VEDA/persona loading, atomic reset backups, passive turn lifecycle events, and EventBus-backed monitor live events with SQLite fallback.
- Added startup/resume replay of staged Drift deliveries through the same idempotent host outbox sink.
- Added host memory recall/text adapters for Drift, context budget configuration, and Drift LLM outcome state.
- Added read-only Drift active-run and diagnostics monitor endpoints.
- Added durable ACK exponential backoff with configurable retry bounds, source health metrics with a restart-safe circuit breaker, a `/metrics` monitor endpoint, and migration coverage for existing ACK queues.
- Added `buildPusher` recovery coverage for provider acceptance before process failure, SQLite migration/concurrency coverage, configurable runtime history retention, and host-facing `DeliveryOutlet` exports.
- Added Drift active-run and diagnostics panels to the UI dashboard when `driftDbPath` is configured.
- Added the standard workspace `test` script for proactive package tests.
- 三进程门控：`DriftGateWriter` 支持携带预取的上下文事件文本(`context`)，wake 空闲时写入 gate 的 `allowed` 许可(读 drift daemon 时恢复 `driftCurrentContext` 预取)；TTL 可通过 `drift.gateTtlHours` 配置，缺省 1 小时。
- 默认生命周期统一到 host：`createHostChatClient()` 把 pi-host `ModelRuntime` 包装成 `ChatCompletionClient`；提供 `host` 服务时 judge/dedupe/resolve/profile 全部改走 host 认证+流式(不再依赖 `agentTick` 的 apiKey)，未提供时保持配置式客户端不变。
- Daemon 模型选择：`pickDaemonModel()`(drift 导出)由 settings.json 的官方 `enabledModels` 字段驱动(与 --models 同格式：精确 "provider/modelId"、裸 id 或 glob)，未配置时保持取第一个可用模型；proactive/drift daemon 启动时按此选择。

- 解耦:proactive 不再依赖 `@cogito/drift`;门控/调度/投递恢复/事件契约改从共享层 `@cogito/gate` 引用。删除进程内 Drift 引擎装配(三进程模式下为死代码),`DriftConfig` 缩减为 `enabled`/`minIntervalHours`/`gateTtlHours`/`driftDir`。

### Changed

- `runPusher` splits into `buildPusher` (assemble, no start) + `start()`, so the reload supervisor can build-then-swap.
- Direct plugin modules are now included in lifecycle assembly; duplicate lifecycle/runtime/module providers fail loudly.
- Candidate hot reload instances are stopped after startup failure, and reload shutdown waits for an in-flight rebuild.
- Hot reload rebuilds are serialized, and failed old-instance stops attempt to restore the old instance before reporting an error.
- Proactive config parsing now reports malformed JSON and invalid critical fields instead of silently returning an empty config.
- Injected clocks now cover store, presence, profile, wake state, polling, and frame defaults; source health and invalid plugin/MCP diagnostics are persisted or logged.
- EventBus handlers are now asynchronous and scope-aware, with ordered transforms, sequential or parallel observers, queued delivery, error isolation, and scope-owned cleanup.
- Source health now distinguishes empty, successful, degraded, and failed fetches; delivery and candidate state changes remain success-only side effects.
- Wake and generic lifecycle monitor startup now expose the same read-only observability surface; Wake tick failures are persisted before loop backoff.
- Hot reload now quiesces the old instance, starts and validates the candidate, commits a fenced snapshot, and drains the retired instance after active leases finish.
- Feishu proactive sends propagate the durable logical delivery key to the provider idempotency field, including deterministic suffixes for media parts.
- Legacy `start/stop` reloadable plugins are adapted to idempotent pause/resume snapshot semantics; stop-only plugins remain explicitly isolated on the compatibility path.
- `buildPusher` now performs configured retention cleanup during assembly and preserves pending delivery work, while the host integration docs and example config document outlet idempotency, monitoring, and SSRF boundaries.
- `score_weight_energy` 默认值对齐 akashic STRATEGY_PARAMS(0.40 → 0.35),触发频率更接近 akashic 语义。
- 拓扑排序改用展开依赖后的编译绑定(akashic `topo_sort_modules(bindings)`):`collects` 前缀展开的依赖边现在参与排序,修复了 collect 模块可能先于 producer 执行的问题。
- `CompiledProactiveLifecycle.start/stop` 支持 AbortSignal 取消防护(akashic `_await_cleanup` shield 语义):取消不截断清理,取消以 AbortError 聚合。
- `get_recent_chat` 改为 akashic `Sensor.collect_recent` 语义:角色过滤 + context-frame 过滤(`<system-reminder` / `[SYSTEM_CONTEXT_FRAME]` 标记)+ 单条 200 字符截断。
- Wake 蓄水池批量 ingest 改为单事务(akashic `ingest_with_ids` 单 commit):事件与 `commit:false` 延后的隔离区一起原子落库;`consume`/`expire` rowcount 不匹配时回滚。
- Wake 偏好召回(`recall_memory`)在提供嵌入时走向量精排 + relevance floor(limit 12,近似 akashic `relevance_floor="strong"`)。


- Data source/plugin mount directory is now fixed to `<cwd>/.cogito/extensions/proactive` (the `sourcesDir` config key was removed; built-in package sources are used only as a fallback when the mount directory is empty).
- Drift workspace default moved from `~/.cogito/agent/drift` to `<cwd>/.cogito/extensions/drift` (drift gate / staged deliveries / skills all live under the project mount now).
### Added

- `collectRecent`/`isContextFrameContent`/`RECENT_CHAT_MESSAGE_MAX_CHARS`:近期会话收集 helper(akashic `Sensor.collect_recent` 移植),宿主端口与 judge 共用。
- Default 生命周期新增 `proactive.prompt.collect` 模块(akashic `ProactivePluginStateModule`):收集插件写入的 `proactive:prompt:system_bottom:*` 段与 `proactive:effect:*` 记录,段注入 judge system prompt 底部,effect 写入 tick 审计(`tick_log.effects_json`,schema user_version 9)。
- presets 补 `gate.judgeSendThreshold`(daily 0.60 / dev_verify 0.28 / quiet 0.75,与 akashic PRESETS 一致;judge 保持 reserved 不消费)。
- Wake `decideDrift` 增加 drift 门控观察记录(`wake_observations` kind=drift,含 verdict/reason/TTL)。

### Breaking Changes

- 配置校验收紧扣 akashic `_check_forbidden_keys`:JSON 配置根级未知键直接报错(拼写错误/旧平铺键不再静默忽略);`tick.tickS0 >= tick.tickS1` 递减校验。

### Removed

- `ProactiveEngine.tick()` inline orchestration moved into `DefaultRuntime` + lifecycle modules; `engine.ts` no longer owns gate/sense/judge/resolve/deliver logic.
- `runWakePusher` / `WakePusherHandle` removed (replaced by `buildWakeRuntimeDeps` + `WakeProactivePlugin` + generic `ProactiveLoop`).
- Drift 投递确认端点：`POST /api/dashboard/proactive/deliveries/ack` 标记 deliveries 已确认，并把 drift 投递按 message_hash 回写 `drift.db` 的 `runs.message_result='sent'`。
- Drift MCP 接线：`buildDriftMcpBridge()` 复用 `sources.mcp` 配置 eager 连接，供 drift 的 requires_mcp 过滤与 `mount_server`。
- Drift 嵌入接线：`config.embeddings` 的嵌入 API 现在同时供 drift `recall_memory` 向量召回与 wake 语义兴趣使用。
- Monitor 增加 drift 观测端点：`/api/dashboard/proactive/drift/runs` 与 `/api/dashboard/proactive/drift/steps`（需配置 `driftDbPath`）。
- 默认生命周期 idle 阶段为 drift 注入 `activityFn`（presence 的 last_user_at 摘要）。
