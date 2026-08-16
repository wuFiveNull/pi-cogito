# Proactive 插件化架构改造计划

将 `packages/proactive` 从「目录扫描数据源 + 固定阶段接口」升级为「插件 + 生命周期模块图」，
对齐 akashic-agent 的 proactive v2 架构（`proactive_v2/lifecycle.py` + `agent/lifecycle/phase.py` +
`agent/plugins/` + `plugins/*_proactive`）。

## 目标

1. 扩展机制升级：插件可贡献数据源、生命周期规格、模块、runtime 工厂（对应 akashic
   `Plugin.proactive_sources/proactive_lifecycles/proactive_module_factories/proactive_runtime_factories`）。
2. tick 编排从硬编码阶段调用改为生命周期模块图（slot/requires/produces/collects + 拓扑排序 + 依赖校验）。
3. wake 生命周期从独立组装（`runWakePusher`）迁入同一 kernel，与 default 共享编排层。
4. 补 EventBus 与可注入 Clock（akashic `bus/event_bus.py`、`core/clock.py` 的最小移植）。
5. 默认行为不变：现有 16 个测试文件必须全绿。

## 执行状态(2026-08-08)

全部阶段已完成;两处计划项经确认裁剪,一处偏差说明:

- 裁剪:`TickLogged` 事件(Phase 0 计划列出)——tick step 已入库,事件冗余,不做。
- 裁剪:`monitor` 改订阅 EventBus(Phase 6)——monitor 是 HTTP 即时查询 SQLite,非轮询,无订阅需求。
- 偏差:`lifecycles/default/` 文件组织为 runtime.ts + modules.ts + index.ts(计划列了
  start/gate/sense/... 逐文件),模块内容一一对应;`WakeRuntimeFactory` 补回(惰性 deps builder)。
- 追加:Phase 2 的 runPusher 插件装配已完成(见 Phase 2 改造项),非 default 生命周期
  (wake/自定义)走通用 `ProactiveLoop`;`runWakePusher` 删除,由 `buildWakeRuntimeDeps`
  + `WakeProactivePlugin` 替代。

## 硬约束

- 默认行为（default lifecycle 的 gate/sense/judge/resolve/deliver/drift 语义）不变，逐模块替换、每步测试全绿后再进下一步。
- fetch 默认按 tick 驱动并写 SQLite，保留 `fetch.mode: "background"` 以兼容独立后台轮询；两种模式都持久化 last-fetch/backoff 状态。
- `ProactiveStages` 九个策略接口保留为策略实现层，模块图是编排层；插件可只替换单个策略。
- 不移植：被动链路 turn lifecycle hook（pi 无被动链路）、persona/veda。ReplayClock、RuntimeSnapshotStore lease/fence、上下文绑定与 replay journal 已补齐。
- `pi-drift` 保持独立引擎，不内嵌。

## 现状盘点

- 编排：`engine.ts` `ProactiveEngine.tick()` 硬编码 gate→sense→idle→judge→resolve→deliver；
  `loop()` 闭环调度（base_score → 下次间隔）。
- 策略接口：`stages/types.ts`（gate/sense/schedule/fetch/judge/resolve/deliver/idle），
  `stages/defaults.ts` 组装默认实现。
- 扩展：`registry.ts` 目录扫描（`.ts` 文件 default export 即 source）；`reload.ts` watch + 重建。
- wake：`wake/index.ts` `runWakePusher` 独立组装（`WakeRuntime`/`WakeStateStore`/自己的循环），
  `runPusher` 用 `lifecycle: "default" | "wake"` 分支。
- 存储：`store.ts`（SQLite：候选/tick log/tick step/投递记录）、`wake/state.ts`（蓄水池）。
- 测试：`test/*.test.ts` 16 个文件，vitest。

akashic 对照参考（只读，不复制）：
- `proactive_v2/lifecycle.py`：`ProactiveLifecycleSpec` + `ProactiveLifecycleBuilder`（编译、slot 校验、
  start/stop 逆序回滚、terminal slot 校验）。
- `agent/lifecycle/phase.py`：`topo_sort_modules`（入度排序、循环依赖报错、缺失依赖禁用模块、inspect）。
- `proactive_v2/frame.py`：`ProactiveFrame{input,slots,output}` + `ProactiveTickResult{base_score,next_interval_seconds}`。
- `agent/core/proactive_kernel.py`：`ProactiveKernel(modules, lifecycle, initial_slots_fn)`，`run_tick_result`。
- `agent/plugins/base.py`：`Plugin` 基类 + 贡献方法。
- 模块划分参考：default 生命周期由 `default_proactive`（Start/Admission/Source/PluginState/Route/Resolve/Commit/Schedule）
  + `proactive_flow`（Prepare→`candidate:batch`、Judge→`proposal:proactive`）共同贡献；
  wake 生命周期由 `wake_proactive`（Start/Ingest→`wake:reservoir`/ContentDecision/DriftDecision/Schedule）贡献。

## 阶段划分

### Phase 0 — 前置基础设施（Clock + EventBus）

新增：
- `src/clock.ts`：`Clock` 接口（now/nowMs）+ `SystemClock`；engine/schedule/judge/gate/wake 全部改为注入
  （替换现有 `Date.now()`/`new Date()`，默认 SystemClock，行为不变）。
- `src/bus.ts`：类型化 `EventBus`（`on/emit/off`，事件对象类区分类型，对齐 akashic `EventBus` 最小面）；
  事件：`ProactiveFinished`、`TickLogged`、`Delivered`。先接入 tick 完成与投递两处 emit，monitor 暂不改。

验收：
- `npm run check` 通过；现有测试全绿（时钟注入零行为变化）。

### Phase 1 — 模块图核心（纯新增）

新增 `src/ext/`：
- `frame.ts`：`ProactiveFrame` / `ProactiveTickInput` / `ProactiveTickResult`。
- `phase.ts`：`topoSortModules`（slot 去重、入度排序、循环依赖报错、缺失依赖禁用 + warning、inspect 输出）。
- `lifecycle.ts`：`ProactiveLifecycleSpec(id, modules, initialSlots, terminalSlots)` +
  `ProactiveLifecycleBuilder.build`（编译校验、依赖展开 collects 前缀、start 顺序/stop 逆序 + 失败聚合回滚）。
- `kernel.ts`：`ProactiveKernel(modules, lifecycle, initialSlotsFn)`（start/stop/runTickResult/lastResult/inspect）。

新增测试：
- `test/ext-phase.test.ts`：拓扑排序、slot 重复报错、循环依赖报错、缺失依赖禁用。
- `test/ext-lifecycle.test.ts`：依赖展开、terminal slot 校验、start 失败逆序回滚、stop 错误聚合。
- `test/ext-kernel.test.ts`：runTickResult 产出 output、lastResult。

验收：新测试全绿；`npm run check` 通过；现有代码零改动。

### Phase 2 — 插件注册与加载

新增 `src/ext/plugin.ts`：
- `ProactivePlugin` 接口/基类：`name`、`proactiveSources()`、`proactiveLifecycles()`、
  `proactiveModules()`、`proactiveModuleFactories()`、`proactiveRuntimeFactories()`。
- 注册表 `pluginRegistry`：注册 + 按目录加载（保留 jiti 动态 import，moduleCache: false）。

重写 `registry.ts`：
- 目录扫描从「文件即 source」改为「文件即插件模块」：导出 `plugin` 实例（或默认导出 Plugin 子类/工厂）即注册；
  `ProactiveSource` 成为插件贡献之一（`proactiveSources()`）。
- 保持失败隔离（单文件坏不影响其余）与优先级（用户目录 `extensions/proactive/` 优先）。

改造 `index.ts`（部分）：
- `runPusher` 先收集插件贡献，按 `lifecycle` 配置选 spec；为 Phase 3/4 留好组装点（此阶段仍走旧 engine，
  只把数据源加载切到插件路径，保证 registry.test.ts 语义兼容）。

验收：`registry.test.ts` 更新后全绿（文件即插件）；现有 source 样例（dailyhot/agent-reach/mcp）无需改动即可加载。

### Phase 3 — default 生命周期模块化（核心重构）

新增 `src/lifecycles/default/`（模块序列对齐 akashic，slot 名沿用 `proactive.*`）：
- `start.ts`：建 `ProactiveRunState`（ctx/sessionKey/startedAt）。
- `gate.ts`：`GateChain.check` → blocked 则终局（tick log finish + skip）。
- `sense.ts`：presence 感知 + `store.listNew` 候选（保持 pi 的「轮询入库后读候选」模式）。
- `route.ts`：候选为空 → idle/drift 分支（产出 route）；有候选 → proactive。
- `judge.ts`：`AgentTickJudgeStrategy`（产出 proposal + evidence）。
- `resolve.ts`：`EvidenceFirstResolveStrategy`（证据 → 消息）。
- `commit.ts`：`SqliteDeliverStrategy` + tick log finish + `recordAction` + EventBus emit。
- `schedule.ts`：`EnergyScheduleStrategy`（产出 `nextIntervalSeconds`）。
- `index.ts`：`defaultLifecycleSpec` + `DefaultRuntimeFactory` + `DefaultModuleFactory`。
- `types.ts`：`ProactiveRunState`（对齐 akashic `ProactiveRunState`，模块间经 frame.slots 传状态）。

改造：
- `engine.ts`：`tick()` 逻辑迁入模块；`loop()` 保留（闭环调度驱动 kernel.runTickResult）；
  `ProactiveEngine` 变为薄封装或并入 kernel。
- `stages/defaults.ts` 保留为策略实现组装（模块内部调用）。

新增测试：
- `test/lifecycle-default.test.ts`：完整 tick 链路（gate blocked / 空候选 drift / 判题 send / context_only）
  与现有 `tick-steps`、`index.test.ts` 覆盖对齐。

验收：`index/tick-steps/judge-completeness/tick-resolve/gate-anyaction/dedupe/pipeline-store` 等现有测试
全部迁移为模块化路径后仍全绿（行为不变，仅断言路径调整）。

### Phase 4 — wake 迁移为插件生命周期

改造 `src/wake/`：
- `index.ts`：`runWakePusher` 降级为选择 wake 生命周期的组装入口（或删除，由 `runPusher` + lifecycle 选择接管）。
- 新增 `wake/lifecycle.ts`：`wakeLifecycleSpec` + `WakeRuntimeFactory` + `WakeModuleFactory`
  （模块序列对齐 akashic：Start→Ingest→ContentDecision→DriftDecision→Schedule）。
- `runtime.ts`：`WakeRuntime` 包一层模块适配（begin/ingest/decideContent/decideDrift/schedule 对应模块方法）。
- 状态迁移：`WakeStateStore` 保留；tick 结果统一走 `ProactiveTickResult`。

验收：`wake.test.ts` / `wake-runtime.test.ts` 全绿；`lifecycle: "wake"` 走 kernel 路径。

### Phase 5 — 热重载升级（snapshot / lease / replay）

改造 `reload.ts`：
- 重建语义从「整实例 stop → build → swap」升级为「build 候选 kernel → start 校验 → commit → 停旧」；
  失败 abort 保留旧实例继续运行（现有雏形 + 模块级 start/stop）。
- 已实现 `RuntimeSnapshotStore` 的 lease/fence admission、AsyncLocalStorage context binding、pause/resume quiesce、候选 abort、退休实例 drain 和 runtime replay journal。

验收：`reload.test.ts` 全绿；新增「候选 kernel start 失败回滚保留旧」测试。

### Phase 6 — 基础设施收尾

- `monitor.ts`：从轮询 SQLite 改为订阅 EventBus（保留轮询作为降级路径或直接替换）。
- trace 信封化：`proactive_rate_trace.jsonl` 包一层（trace_type/source/subject/payload/timestamp，
  对齐 akashic `strategy_trace.py`）。
- 结构化诊断：可选，接入 pi 的 logger（`diagnostic_context` 等价物），可后置。

验收：`monitor.test.ts` 全绿；trace 格式向后兼容（旧行仍可读）。

### Phase 7 — 文档与清理

- README 增补「写一个 proactive 插件」章节（贡献 sources/lifecycle/modules/runtime 的示例）。
- `CHANGELOG.md` 更新。
- 清理：删除迁移后的死代码（如 `runWakePusher` 若已合并）；`engine.ts` 中不再被引用的分支。
- `npm run check` 全绿。

## 测试与质量门

- 每阶段结束跑：`npm run check`（全量输出）+ `./test.sh`（或指定 proactive 测试文件）。
- 修改过的测试文件必须运行并全绿后才算完成该阶段。
- 全程不跑 `npm run build` / 全量 vitest（按 AGENTS.md 规则）。

## 风险与决策点

1. Phase 3 是最大风险（重构 tick 主链路）：用 adapter 模式让模块只做编排、策略实现不动，把改动面压到最小。
2. `ProactiveStages` 接口保留 vs 废弃：**保留**，作为策略层抽象；插件可只贡献单个策略（经模块适配）。
3. tick 驱动 fetch 是默认语义，后台轮询作为显式兼容选项保留；两者共享持久化 scheduler 状态。
4. snapshot 机制要求实例提供 pause/resume 才启用完整 quiesce；旧的仅 stop 实例继续走兼容回载路径。
5. 插件加载安全：目录扫描默认只信任用户自己的 `extensions/` 目录，与现状一致；不做沙箱。

## 工作量估算

- Phase 0：0.5 天
- Phase 1：1 天
- Phase 2：0.5 天
- Phase 3：2–3 天（核心）
- Phase 4：1 天
- Phase 5：0.5–1 天
- Phase 6：0.5 天
- Phase 7：0.5 天

合计约 1.5–2 周。
