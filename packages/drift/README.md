# @cogito/drift

Idle-time background task engine (akashic drift_flow design). Runs when the
proactive loop finds nothing worth pushing: the agent scans user-written
drift skills (`SKILL.md`), selects one, executes a small atomic action with
tools, and closes the run with `finish_drift` (completed/paused +
scratchpad/cursor continuity).

Also hosts shared memory-read helpers (`recallPreferences`) used by both
drift tools and the proactive judge.

## 技能

- 技能放在 `driftDir/skills/<skill-name>/SKILL.md`(默认 `~/.cogito/agent/drift/skills`)。
- **内置元技能 `create-drift-skill`**:daemon 启动时自动种入(幂等,已存在则跳过),
  让 agent 能在空闲时创建/更新其他 drift skill。
- **示例案例技能**:`packages/drift/examples/skills/`(`audit-dirty-memories` 记忆审计 /
  `explore-curiosity` 好奇心探索 / `review-drift-gaps` 自我反思),复制到技能目录即可启用。
- 用户向指南见仓库根 `docs/drift-guide.md`。

Host integration is explicit: `message_push` stages a message and the pipeline
commits it through `DriftDeliverySink` only after `finish_drift`. Hosts can add
global prompt rules, live context events, a context-frame renderer, and shared
tools through `DriftHostAdapter` and `DriftToolDeps.sharedTools`.

## Reliability and host boundaries

Each run has a durable `run_id` and a single-session lease in
`drift_active_runs`. Progress, staged message payloads, and tool steps are
written before the run is finished. A stale active row is converted to
`paused`; a repeated finish or delivery reuses the same durable identity.
Hosts should call the same `DriftDeliverySink` during startup to replay
`listStagedDeliveries()`.

`DriftToolMeta` classifies tools as `read-only`, `write`, or
`external-side-effect`. `DriftToolDeps.toolPolicy` can deny a call before
execution and receive a redacted audit event afterwards. File reads and shell
working directories stay inside Drift/workspace/skill roots by default;
`DriftWebPolicy` blocks local and private HTTP destinations unless explicitly
allowed.

The state store exposes `listActiveRuns()` and `getRunDiagnostics(runId)` for
read-only diagnostics. The Proactive monitor exposes these through
`/api/dashboard/proactive/drift/active` and
`/api/dashboard/proactive/drift/diagnostics/<run_id>`.

`DriftStateStore.pruneHistory()` supports age and count limits for terminal
runs. It removes linked `run_steps` and journal rows in the same SQLite
transaction while preserving staged deliveries and active-run state. Proactive
hosts can configure this together with outbox retention through `retention` in
the pusher config; cleanup runs when the pusher is built.

Native `web_fetch` and `web_search` use `DriftWebPolicy`. Private and reserved
destinations are denied by default, all DNS answers are checked, and the
request connects to the checked address rather than resolving again during the
HTTP request. Redirects are denied by default; when `maxRedirectHops` is set
(0–5), every target is validated again. A host-provided web function owns its
transport, so it must apply equivalent DNS, redirect, timeout, and response
size limits itself.

## 事件与 akashic DriftFinished 的映射

akashic 在 drift 收尾时向 EventBus 发单个 `DriftFinished` 事件;cogito 用
`DriftEvent` 系列(`@cogito/gate` 共享契约)覆盖同样信息,宿主经
`DriftHostAdapter.onEvent` 或 `DriftEventSink` 订阅:

| akashic DriftFinished 字段 | cogito DriftEvent |
|---|---|
| `session_key` | `drift_finished.sessionKey` |
| `skill_name` | `drift_finished.skill` |
| `status` (completed/paused) | `drift_finished.status`(completed/paused/failed) |
| `briefing` | `drift_finished.error`(failed 时)或 run diagnostics |
| `message_result` (sent/silent) | `drift_finished.messageStaged` + `messageCommitted` |
| `timestamp` | `drift_finished.at` |
| LLM cache 统计(record_llm_cache) | `drift_finished.llmCacheReadTokens` / `llmCacheWriteTokens` |

工具级过程观测由 `drift_started` / `drift_tool_called` /
`drift_delivery_committed` 事件补齐,akashic 没有等价粒度。
