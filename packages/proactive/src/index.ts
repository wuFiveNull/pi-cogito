/**
 * Proactive — 组装入口。
 *
 * runPusher 组装:数据源 + 记忆/规则资源 + drift 引擎 + 默认阶段策略 +
 * ProactiveEngine。替换任意阶段策略即可改变行为(见 stages/defaults.ts)。
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
	type MemoryTasksHandle,
	type MemoryTasksOptions,
	openaiTextLlm,
	startMemoryTasks,
} from "@cogito/agent-core/node";
import type { Model } from "@cogito/ai";
import type {
	DriftDeliveryReceipt,
	DriftDeliveryRecord,
	DriftDeliverySink,
	DriftEvent,
	DriftEventSink,
	DriftStagedDelivery,
} from "@cogito/gate";
import { DriftGateStore, DriftStagedDeliveryStore, hashOutboundMessage } from "@cogito/gate";
import type { ModelRuntime } from "@cogito/host";
import { BeforeTurn, Delivered, DriftEventObserved, EventBus } from "./bus.ts";
import { type Clock, clockFromEnv, ReplayClock } from "./clock.ts";
import type { DriftGateWriter } from "./drift-gate.ts";
import { ProactiveEngine } from "./engine.ts";
import { ProactiveKernel } from "./ext/kernel.ts";
import { ProactiveLoop } from "./ext/loop.ts";
import { PluginRegistry } from "./ext/plugin.ts";
import { RuntimeReplayJournal, RuntimeSnapshotStore } from "./ext/snapshot.ts";
import { GatewayDeliveryOutlet } from "./gateway-delivery.ts";
import { createHostChatClient } from "./host.ts";
import { DefaultProactivePlugin } from "./lifecycles/default/index.ts";
import { resolveApiKey } from "./llm.ts";
import { type MonitorHandle, startMonitor } from "./monitor.ts";
import { PassiveTurnLifecycle, PassiveTurnStarted } from "./passive.ts";
import type { PersonaConfig } from "./persona.ts";
import { applyPreset } from "./presets.ts";
import type { ProfileConfig } from "./profile.ts";
import { loadPlugins } from "./registry.ts";
import { runReloadable } from "./reload.ts";
import type { HistoricalReplayReport } from "./replay.ts";
import {
	HistoricalReplaySource,
	HistoricalTickReplayRunner,
	historicalEventToWakeEvent,
	readHistoricalReplayEvents,
} from "./replay.ts";
import { defaultRulesPath, ProactiveRules } from "./rules.ts";
import { mergeRuntimePorts, type ProactiveRuntimePorts, StandaloneRuntimeAdapter } from "./runtime/ports.ts";
import { SourceAckCoordinator } from "./runtime/source-ack.ts";
import { SourceHealthTracker } from "./runtime/source-health.ts";
import { createDefaultStages, type DefaultStagesConfig, type DefaultStagesDeps } from "./stages/defaults.ts";
import { type DeliveryOutlet, type DeliverySendReceipt, getDeliverySendStatus } from "./stages/deliver.ts";
import { Pipeline } from "./stages/fetch-pipeline.ts";
import { TickScheduler } from "./stages/schedule.ts";
import { DEFAULT_SESSION_KEY, Presence } from "./stages/sense.ts";
import type { TickResult } from "./stages/types.ts";
import { type ProactiveRetentionOptions, ProactiveStore } from "./store.ts";
import type { WakeEmbeddingsConfig } from "./wake/embeddings.ts";
import { buildEmbeddingApi } from "./wake/embeddings.ts";
import { buildWakeRuntimeDeps } from "./wake/index.ts";
import { WakeProactivePlugin } from "./wake/lifecycle.ts";

export { BeforeTurn, Delivered, DriftEventObserved, EventBus, ProactiveFinished } from "./bus.ts";
export type { Clock } from "./clock.ts";
export { clockFromEnv, ReplayClock, replayRandom, SystemClock } from "./clock.ts";
export type { DriftGateWriter } from "./drift-gate.ts";
export { WAKE_DRIFT_GATE_TTL_HOURS } from "./drift-gate.ts";
export type {
	RuntimeReplayEvent,
	RuntimeSnapshot,
	RuntimeSnapshotState,
	RuntimeSnapshotStoreOptions,
	SnapshotResourceLifecycle,
	SnapshotTransaction,
} from "./ext/snapshot.ts";
export {
	bindRuntimeSnapshot,
	getCurrentRuntimeLease,
	getCurrentRuntimeSnapshot,
	RuntimeReplayJournal,
	RuntimeSnapshotFenceError,
	RuntimeSnapshotLease,
	RuntimeSnapshotStore,
	withRuntimeSnapshot,
} from "./ext/snapshot.ts";
export type {
	GatewayDeliveryLogger,
	GatewayDeliveryOutletOptions,
} from "./gateway-delivery.ts";
export { createGatewayDeliveryOutlet, GatewayDeliveryOutlet, loadGatewayDeliveryConfig } from "./gateway-delivery.ts";
export type { HostChatOptions } from "./host.ts";
export { createHostChatClient, createHostChatFn } from "./host.ts";
export type { PassiveTurnAgentBridgeOptions, PassiveTurnContext, PassiveTurnLifecycleOptions } from "./passive.ts";
export {
	createPassiveTurnLifecycleModules,
	PassiveAfterReasoning,
	PassiveBeforeReasoning,
	PassiveTurnFinished,
	PassiveTurnLifecycle,
	PassiveTurnStarted,
} from "./passive.ts";
export type { PersonaConfig } from "./persona.ts";
export {
	AKASHIC_BEHAVIOR_RULES,
	DEFAULT_VEDA,
	readDefaultVeda,
	readVeda,
	renderBehaviorBlock,
	resetVeda,
	VedaLoadError,
	vedaPath,
} from "./persona.ts";
export type { ProactiveAction, ProactiveEvidence, ProactiveProposal } from "./proposal.ts";
export { createProactiveProposal, proposalAcknowledgements } from "./proposal.ts";
export type {
	HistoricalReplayEvent,
	HistoricalReplayOptions,
	HistoricalReplayReport,
	HistoricalReplayTickAudit,
	HistoricalReplayTickContext,
	ProactiveHistoricalReplayOptions,
} from "./replay.ts";
export {
	HistoricalReplaySource,
	HistoricalTickReplayRunner,
	historicalEventToWakeEvent,
	normalizeHistoricalReplayEvent,
	readHistoricalReplayAudit,
	readHistoricalReplayEvents,
	runHistoricalReplay,
} from "./replay.ts";
export type { ProactiveSideEffectReport, ProactiveTurnRequest } from "./runtime/orchestrator.ts";
export { ProactiveTurnOrchestrator } from "./runtime/orchestrator.ts";
export type {
	MaybePromise,
	ProactiveBusyPort,
	ProactiveDeliveryStatus,
	ProactiveMemoryContext,
	ProactiveMemoryPort,
	ProactiveOutboundMessage,
	ProactiveOutboundPort,
	ProactiveOutboundReceipt,
	ProactivePresencePort,
	ProactivePresenceSnapshot,
	ProactiveRuntimePorts,
	ProactiveSessionMessage,
	ProactiveSessionPort,
	ProactiveSessionTurnPair,
	ProactiveSourceAckPort,
} from "./runtime/ports.ts";
export { mergeRuntimePorts, StandaloneRuntimeAdapter } from "./runtime/ports.ts";
export type { SourceAckCoordinatorOptions, SourceAckFlushOptions, SourceRuntimeConfig } from "./runtime/source-ack.ts";
export { acknowledgeSource, SourceAckCoordinator } from "./runtime/source-ack.ts";
export type {
	SourceCircuitState,
	SourceHealthMetrics,
	SourceHealthRecord,
	SourceHealthTrackerOptions,
} from "./runtime/source-health.ts";
export { SourceHealthTracker } from "./runtime/source-health.ts";
export type {
	DeliveryOutlet,
	DeliverySendReceipt,
	DeliverySendStatus,
	ProactiveDeliveryContext,
	ProactiveDeliveryExecutorOptions,
} from "./stages/deliver.ts";
export {
	type CollectRecentOptions,
	collectRecent,
	isContextFrameContent,
	LEGACY_CONTEXT_FRAME_MARKER,
	RECENT_CHAT_MESSAGE_MAX_CHARS,
} from "./stages/recent-chat.ts";
export type { ProactiveRetentionOptions, ProactiveRetentionResult } from "./store.ts";

export interface AgentLlmConfig {
	model?: string;
	apiBaseUrl?: string;
	apiKey?: string;
}

export interface DriftConfig {
	/** drift_enabled: 空闲时写 drift_gate 许可(三进程模式)。 */
	enabled?: boolean;
	/** drift_min_interval_hours: 连续两次 drift 的最小间隔(小时)。 */
	minIntervalHours?: number;
	/** 三进程模式:「允许」许可的 TTL(小时);默认 1。 */
	gateTtlHours?: number;
	/** Drift 工作区目录(默认 ~/.cogito/agent/drift)。 */
	driftDir?: string;
	/** Drift 内部 HTTP 访问策略(如允许私网、重定向跳数)。 */
	webPolicy?: { allowPrivateNetwork?: boolean; maxRedirectHops?: number };
}

export interface ProactiveRetentionConfig extends Omit<ProactiveRetentionOptions, "now"> {
	/** Drift terminal run history age limit. */
	driftMaxAgeDays?: number;
	/** Drift terminal run count limit. */
	driftMaxRuns?: number;
}

export interface PusherConfig extends DefaultStagesConfig {
	/** 可注入时钟(测试/回放用,配置文件中不设置)。 */
	clock?: Clock;
	/** 宿主事件总线；未提供时为本次 pusher 创建独立总线。 */
	eventBus?: EventBus;
	enabled?: boolean;
	/** 预设(akashic presets.py):daily / dev_verify / quiet;显式配置逐字段覆盖。未知预设忽略。 */
	preset?: string;
	/** 目标会话 key(akashic channel:chat_id;默认 local)。 */
	sessionKey?: string;
	/** Host-owned session, memory, presence, busy, channel and ACK ports. */
	runtimePorts?: ProactiveRuntimePorts;
	/** Source failure circuit breaker and retry metrics. */
	sourceHealth?: { failureThreshold?: number; cooldownMs?: number };
	/** Durable source ACK retry policy. */
	sourceAck?: { retryBaseDelayMs?: number; retryMaxDelayMs?: number };
	/** 生命周期 id:default / wake / 插件自定义(akashic lifecycle)。 */
	lifecycle?: string;
	/** Directory containing source modules (default: ./src/sources). */
	sourcesDir?: string;
	/** Path of the proactive.sqlite database (default: ./proactive.sqlite). */
	dbPath?: string;
	/** Sessions directory for presence sensing. */
	sessionsDir?: string;
	/** Path of PROACTIVE_CONTEXT.md (default: ~/.cogito/agent/PROACTIVE_CONTEXT.md). */
	rulesPath?: string;
	/** Path of the memory engine database (default: ~/.cogito/agent/memory/memory.sqlite). */
	memoryDbPath?: string;
	/** 用户兴趣描述,静态 fallback(动态画像/记忆优先)。 */
	interests?: string;
	/** 空闲后台任务(drift):候选为空时执行用户写的 SKILL.md。 */
	drift?: DriftConfig;
	/** 三进程模式:写 drift_gate 许可(drift.db),由 drift daemon 执行。 */
	driftGate?: DriftGateWriter;
	/** pi-host 服务:提供时 wake 的 chat 走 host 的 ModelRuntime(认证+流式)。 */
	host?: { modelRuntime: ModelRuntime; model: Model<any> };
	/** 兴趣画像:定期从会话历史提炼用户兴趣。 */
	profile?: ProfileConfig;
	/** Persona/VEDA:默认读取 workspaceDir/memory/VEDA.md。 */
	persona?: PersonaConfig;
	/** 只读 HTTP monitor(akashic dashboard API 移植)。 */
	monitor?: { enabled?: boolean; port?: number };
	/** 热重载:watch 源目录与配置,变更后重建 pusher(akashic snapshot 热换的 pi 形态)。 */
	reload?: { enabled?: boolean; watchConfig?: boolean; debounceMs?: number };
	/** 回放时钟、runtime snapshot journal 与历史 tick 审计。 */
	replay?: { clockPath?: string; journalPath?: string; eventsPath?: string; reportPath?: string };
	/** wake 语义兴趣嵌入(默认 BAAI/bge-m3 @ siliconflow)。 */
	embeddings?: WakeEmbeddingsConfig;
	/** 记忆后台任务(优化器 + 会话提取;akashic bootstrap build_memory_optimizer_task)。 */
	memory?: {
		enabled?: boolean;
		/** 记忆目录 workspace(默认 ~/.cogito/agent)。 */
		workspaceDir?: string;
		/** 会话目录(默认同 sessionsDir)。 */
		memorySessionsDir?: string;
		optimizerIntervalSeconds?: number;
		consolidateIntervalSeconds?: number;
		keepCount?: number;
		minNewMessages?: number;
		maxConversationChars?: number;
	};
	/** Feishu 出口:读取根目录 config.json 的 channels.feishu 与 proactive.targets。 */
	delivery?: {
		enabled?: boolean;
		configPath?: string;
		replayPending?: boolean;
		/** Host/test outlet. When supplied, no Feishu config is loaded. */
		outlet?: DeliveryOutlet;
	};
	/** Runtime history retention; pending deliveries and staged/active Drift runs are never pruned. */
	retention?: ProactiveRetentionConfig;
	sources?: Record<string, { enabled?: boolean; intervalMin?: number; [key: string]: unknown }>;
}

/** 将 Drift 的结构化事件桥接到 Proactive 的类型化总线。 */
/** 将 Drift 的结构化事件桥接到 Proactive 的类型化总线。 */
export function createDriftEventSink(eventBus: EventBus): DriftEventSink {
	return {
		emit: async (event: DriftEvent) => {
			await eventBus.emit(new DriftEventObserved(event));
		},
	};
}

const DEFAULT_CONFIG: Required<Pick<PusherConfig, "sourcesDir" | "dbPath" | "sessionsDir">> = {
	sourcesDir: join(import.meta.dirname, "sources"),
	dbPath: join(import.meta.dirname, "..", "proactive.sqlite"),
	sessionsDir: join(process.env.HOME ?? "/tmp", ".cogito", "agent", "sessions"),
};

export function loadPusherConfig(configPath: string): PusherConfig {
	let text: string;
	try {
		text = readFileSync(configPath, "utf-8");
	} catch (error) {
		if (errorCode(error) === "ENOENT") return {};
		throw new Error(`failed to read proactive config ${configPath}: ${formatError(error)}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text) as unknown;
	} catch (error) {
		throw new Error(`invalid proactive config ${configPath}: ${formatError(error)}`);
	}
	validatePusherConfig(parsed, configPath);
	return parsed;
}

function validatePusherConfig(value: unknown, configPath: string): asserts value is PusherConfig {
	const root = asRecord(value);
	if (!root) throw new Error(`invalid proactive config ${configPath}: top-level value must be an object`);
	// 根级键白名单(akashic config_loader._check_forbidden_keys):JSON 配置
	// 只允许已声明的键,拼写错误/旧平铺键直接报错。TS-only 注入项
	// (clock/eventBus/runtimePorts/driftGate/host/webFetchFn 等)不进 JSON。
	const forbiddenKeys = Object.keys(root).filter((key) => !JSON_CONFIG_ROOT_KEYS.has(key));
	if (forbiddenKeys.length > 0) {
		throw new Error(
			`invalid proactive config ${configPath}: 非法的根级键: ${[...forbiddenKeys].sort().join(", ")}。` +
				`允许的根级键: ${[...JSON_CONFIG_ROOT_KEYS].sort().join(", ")}`,
		);
	}
	for (const field of [
		"preset",
		"sessionKey",
		"lifecycle",
		"sourcesDir",
		"dbPath",
		"sessionsDir",
		"rulesPath",
		"memoryDbPath",
		"interests",
	] as const) {
		if (root[field] !== undefined && typeof root[field] !== "string") {
			throw new Error(`invalid proactive config ${configPath}: ${field} must be a string`);
		}
	}
	const persona = asRecord(root.persona);
	if (root.persona !== undefined && !persona) {
		throw new Error(`invalid proactive config ${configPath}: persona must be an object`);
	}
	for (const field of ["workspaceDir", "vedaPath", "behaviorRules"] as const) {
		if (persona?.[field] !== undefined && typeof persona[field] !== "string") {
			throw new Error(`invalid proactive config ${configPath}: persona.${field} must be a string`);
		}
	}
	if (persona?.required !== undefined && typeof persona.required !== "boolean") {
		throw new Error(`invalid proactive config ${configPath}: persona.required must be a boolean`);
	}
	if (root.enabled !== undefined && typeof root.enabled !== "boolean") {
		throw new Error(`invalid proactive config ${configPath}: enabled must be a boolean`);
	}
	for (const field of [
		"tick",
		"agentTick",
		"resolve",
		"dedupe",
		"gate",
		"safety",
		"profile",
		"embeddings",
		"memory",
		"drift",
		"monitor",
		"reload",
		"delivery",
		"retention",
		"replay",
		"fetch",
	] as const) {
		if (root[field] !== undefined && !asRecord(root[field])) {
			throw new Error(`invalid proactive config ${configPath}: ${field} must be an object`);
		}
	}
	const reload = asRecord(root.reload);
	if (reload?.debounceMs !== undefined && !isNonNegativeFiniteNumber(reload.debounceMs)) {
		throw new Error(`invalid proactive config ${configPath}: reload.debounceMs must be a non-negative number`);
	}
	const replay = asRecord(root.replay);
	for (const field of ["clockPath", "journalPath", "eventsPath", "reportPath"] as const) {
		if (replay?.[field] !== undefined && typeof replay[field] !== "string") {
			throw new Error(`invalid proactive config ${configPath}: replay.${field} must be a string`);
		}
	}
	const fetch = asRecord(root.fetch);
	if (fetch?.mode !== undefined && fetch.mode !== "tick" && fetch.mode !== "background") {
		throw new Error(`invalid proactive config ${configPath}: fetch.mode must be tick or background`);
	}
	const gate = asRecord(root.gate);
	const contextOnly = asRecord(gate?.contextOnly);
	if (gate?.contextOnly !== undefined && !contextOnly) {
		throw new Error(`invalid proactive config ${configPath}: gate.contextOnly must be an object`);
	}
	// range 校验(akashic config_loader._validate_ranges 的 pi 形态)。
	const tick = asRecord(root.tick);
	for (const field of ["tickS0", "tickS1"] as const) {
		if (
			tick?.[field] !== undefined &&
			(typeof tick[field] !== "number" || !Number.isInteger(tick[field]) || tick[field] < 1 || tick[field] > 86400)
		) {
			throw new Error(`invalid proactive config ${configPath}: tick.${field} must be an integer from 1 to 86400`);
		}
	}
	if (
		tick?.tickJitter !== undefined &&
		(typeof tick.tickJitter !== "number" ||
			!Number.isFinite(tick.tickJitter) ||
			tick.tickJitter < 0 ||
			tick.tickJitter > 1)
	) {
		throw new Error(`invalid proactive config ${configPath}: tick.tickJitter must be a number from 0 to 1`);
	}
	// tick 必须递减(akashic config_loader._validate_ranges:tick_interval_s0 >= tick_interval_s1)。
	if (typeof tick?.tickS0 === "number" && typeof tick?.tickS1 === "number" && tick.tickS0 < tick.tickS1) {
		throw new Error(
			`invalid proactive config ${configPath}: tick 必须递减: tickS0 (${tick.tickS0}) < tickS1 (${tick.tickS1})`,
		);
	}
	const anyaction = asRecord(gate?.anyaction);
	if (gate?.anyaction !== undefined && !anyaction) {
		throw new Error(`invalid proactive config ${configPath}: gate.anyaction must be an object`);
	}
	for (const field of ["probabilityMin", "probabilityMax"] as const) {
		if (
			anyaction?.[field] !== undefined &&
			(typeof anyaction[field] !== "number" ||
				!Number.isFinite(anyaction[field]) ||
				anyaction[field] < 0 ||
				anyaction[field] > 1)
		) {
			throw new Error(
				`invalid proactive config ${configPath}: gate.anyaction.${field} must be a number from 0 to 1`,
			);
		}
	}
	if (
		anyaction?.probabilityMin !== undefined &&
		anyaction.probabilityMax !== undefined &&
		typeof anyaction.probabilityMin === "number" &&
		typeof anyaction.probabilityMax === "number" &&
		anyaction.probabilityMin > anyaction.probabilityMax
	) {
		throw new Error(
			`invalid proactive config ${configPath}: gate.anyaction.probabilityMin must not exceed probabilityMax`,
		);
	}
	if (
		anyaction?.idleScaleMinutes !== undefined &&
		(typeof anyaction.idleScaleMinutes !== "number" ||
			!Number.isFinite(anyaction.idleScaleMinutes) ||
			anyaction.idleScaleMinutes < 1 ||
			anyaction.idleScaleMinutes > 1440)
	) {
		throw new Error(
			`invalid proactive config ${configPath}: gate.anyaction.idleScaleMinutes must be a number from 1 to 1440`,
		);
	}
	if (
		contextOnly?.probability !== undefined &&
		(typeof contextOnly.probability !== "number" ||
			!Number.isFinite(contextOnly.probability) ||
			contextOnly.probability < 0 ||
			contextOnly.probability > 1)
	) {
		throw new Error(
			`invalid proactive config ${configPath}: gate.contextOnly.probability must be a number from 0 to 1`,
		);
	}
	const safety = asRecord(root.safety);
	if (
		safety?.deliveryDedupeHours !== undefined &&
		(typeof safety.deliveryDedupeHours !== "number" ||
			!Number.isFinite(safety.deliveryDedupeHours) ||
			safety.deliveryDedupeHours < 0 ||
			safety.deliveryDedupeHours > 168)
	) {
		throw new Error(
			`invalid proactive config ${configPath}: safety.deliveryDedupeHours must be a number from 0 to 168`,
		);
	}
	const sourceAck = asRecord(root.sourceAck);
	if (sourceAck !== undefined && !sourceAck) {
		throw new Error(`invalid proactive config ${configPath}: sourceAck must be an object`);
	}
	for (const field of ["retryBaseDelayMs", "retryMaxDelayMs"] as const) {
		if (
			sourceAck?.[field] !== undefined &&
			(typeof sourceAck[field] !== "number" ||
				!Number.isFinite(sourceAck[field]) ||
				sourceAck[field] < 1000 ||
				sourceAck[field] > 86_400_000)
		) {
			throw new Error(
				`invalid proactive config ${configPath}: sourceAck.${field} must be a number from 1000 to 86400000`,
			);
		}
	}

	if (contextOnly?.chatLevity !== undefined && typeof contextOnly.chatLevity !== "boolean") {
		throw new Error(`invalid proactive config ${configPath}: gate.contextOnly.chatLevity must be a boolean`);
	}
	if (
		contextOnly?.chatLevityProbability !== undefined &&
		(typeof contextOnly.chatLevityProbability !== "number" ||
			!Number.isFinite(contextOnly.chatLevityProbability) ||
			contextOnly.chatLevityProbability < 0 ||
			contextOnly.chatLevityProbability > 1)
	) {
		throw new Error(
			`invalid proactive config ${configPath}: gate.contextOnly.chatLevityProbability must be a number from 0 to 1`,
		);
	}
	const monitor = asRecord(root.monitor);
	if (
		monitor?.port !== undefined &&
		(!isNonNegativeFiniteNumber(monitor.port) ||
			!Number.isInteger(monitor.port) ||
			monitor.port < 1 ||
			monitor.port > 65_535)
	) {
		throw new Error(`invalid proactive config ${configPath}: monitor.port must be an integer from 1 to 65535`);
	}
	const drift = asRecord(root.drift);
	if (drift?.gateTtlHours !== undefined && !(typeof drift.gateTtlHours === "number" && drift.gateTtlHours > 0)) {
		throw new Error(`invalid proactive config ${configPath}: drift.gateTtlHours must be a positive number`);
	}
	// 顶层 webPolicy(judge web_fetch/web_search 共用)与 drift.webPolicy 走同一套校验。
	for (const [path, value] of [
		["webPolicy", root.webPolicy],
		["drift.webPolicy", drift?.webPolicy],
	] as const) {
		if (value === undefined) continue;
		const policy = asRecord(value);
		if (!policy) {
			throw new Error(`invalid proactive config ${configPath}: ${path} must be an object`);
		}
		if (policy.allowPrivateNetwork !== undefined && typeof policy.allowPrivateNetwork !== "boolean") {
			throw new Error(`invalid proactive config ${configPath}: ${path}.allowPrivateNetwork must be a boolean`);
		}
		for (const field of ["allowedHosts", "blockedHosts"] as const) {
			const hosts = policy[field];
			if (
				hosts !== undefined &&
				(!Array.isArray(hosts) || hosts.some((host: unknown) => typeof host !== "string"))
			) {
				throw new Error(`invalid proactive config ${configPath}: ${path}.${field} must be an array of strings`);
			}
		}
		if (
			policy.maxRedirectHops !== undefined &&
			(!isNonNegativeFiniteNumber(policy.maxRedirectHops) ||
				!Number.isInteger(policy.maxRedirectHops) ||
				policy.maxRedirectHops > 5)
		) {
			throw new Error(
				`invalid proactive config ${configPath}: ${path}.maxRedirectHops must be an integer from 0 to 5`,
			);
		}
	}
	const delivery = asRecord(root.delivery);
	for (const field of ["enabled", "replayPending"] as const) {
		if (delivery?.[field] !== undefined && typeof delivery[field] !== "boolean") {
			throw new Error(`invalid proactive config ${configPath}: delivery.${field} must be a boolean`);
		}
	}
	if (delivery?.configPath !== undefined && typeof delivery.configPath !== "string") {
		throw new Error(`invalid proactive config ${configPath}: delivery.configPath must be a string`);
	}
	const retention = asRecord(root.retention);
	for (const field of [
		"maxItemAgeDays",
		"maxDeliveryAgeDays",
		"maxDeliveries",
		"maxTickLogAgeDays",
		"maxTickLogs",
		"maxSourceFailureAgeDays",
		"maxSourceFailures",
		"maxQuarantineAgeDays",
		"maxContextOnlyAgeDays",
		"maxDailyCountAgeDays",
		"driftMaxAgeDays",
		"driftMaxRuns",
	] as const) {
		if (retention?.[field] !== undefined && !isNonNegativeFiniteNumber(retention[field])) {
			throw new Error(`invalid proactive config ${configPath}: retention.${field} must be non-negative`);
		}
	}
	const sources = asRecord(root.sources);
	if (root.sources !== undefined && !sources) {
		throw new Error(`invalid proactive config ${configPath}: sources must be an object`);
	}
	for (const [sourceId, sourceConfig] of Object.entries(sources ?? {})) {
		const source = asRecord(sourceConfig);
		if (!source) throw new Error(`invalid proactive config ${configPath}: sources.${sourceId} must be an object`);
		if (source.enabled !== undefined && typeof source.enabled !== "boolean") {
			throw new Error(`invalid proactive config ${configPath}: sources.${sourceId}.enabled must be a boolean`);
		}
		if (source.intervalMin !== undefined && !isNonNegativeFiniteNumber(source.intervalMin)) {
			throw new Error(`invalid proactive config ${configPath}: sources.${sourceId}.intervalMin must be a number`);
		}
	}
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/** JSON 配置允许的根级键(akashic _check_forbidden_keys 白名单)。 */
const JSON_CONFIG_ROOT_KEYS: ReadonlySet<string> = new Set([
	"enabled",
	"preset",
	"sessionKey",
	"lifecycle",
	"sourcesDir",
	"dbPath",
	"sessionsDir",
	"rulesPath",
	"memoryDbPath",
	"interests",
	"persona",
	"tick",
	"agentTick",
	"resolve",
	"dedupe",
	"gate",
	"safety",
	"profile",
	"embeddings",
	"memory",
	"drift",
	"monitor",
	"reload",
	"delivery",
	"retention",
	"replay",
	"fetch",
	"sourceAck",
	"sourceHealth",
	"webPolicy",
	"webSearchUrl",
	"webSearchApiKey",
	"scoreWeightEnergy",
	"sources",
]);

function isNonNegativeFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function errorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null) return undefined;
	const code = (error as { code?: unknown }).code;
	return typeof code === "string" ? code : undefined;
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export async function runPusher(config: PusherConfig): Promise<{
	stop: () => Promise<void>;
	passiveTurn?: PassiveTurnLifecycle;
	replay?: HistoricalReplayReport<TickResult | null>;
}> {
	const handle = await buildPusher(config);
	let replay: HistoricalReplayReport<TickResult | null> | undefined;
	try {
		if (config.replay?.eventsPath) {
			if (!handle.replay) throw new Error("historical replay is only available for the default lifecycle");
			replay = await handle.replay();
		} else {
			await handle.start();
		}
	} catch (error) {
		await handle.stop().catch(() => {});
		throw error;
	}
	return { stop: () => handle.stop(), passiveTurn: handle.passiveTurn, replay };
}

/** 组装 pusher 但不启动(热重载 supervisor 先建后换)。 */
export interface PusherHandle {
	start(): Promise<void>;
	stop(): Promise<void>;
	/** Passive agent turn lifecycle bridge (before/after turn and reasoning). */
	passiveTurn?: PassiveTurnLifecycle;
	/** 热重载时停止准入并等待当前 tick，再释放 monitor 等可复用资源。 */
	pause?(): Promise<void>;
	/** 热重载候选失败时恢复旧实例。 */
	resume?(): Promise<void>;
	/** Execute the configured historical event file against the real tick engine. */
	replay?(): Promise<HistoricalReplayReport<TickResult | null>>;
}

export async function buildPusher(config: PusherConfig): Promise<PusherHandle> {
	config = applyPreset(config);
	const replayClockPath =
		config.replay?.clockPath ??
		(config.replay?.eventsPath
			? join(storeDbDir(config.dbPath ?? DEFAULT_CONFIG.dbPath), "proactive_replay_clock.json")
			: undefined);
	const clock = config.clock ?? clockFromEnv(replayClockPath);
	const eventBus = config.eventBus ?? new EventBus();
	const sessionKey = config.sessionKey ?? DEFAULT_SESSION_KEY;
	const scopedEventBus = eventBus.scope(sessionKey);
	const passiveTurn = new PassiveTurnLifecycle(scopedEventBus, { clock });
	const sourcesDir = config.sourcesDir ?? DEFAULT_CONFIG.sourcesDir;
	// 插件加载:用户扩展目录(extensions/proactive/)优先,内置目录兜底。
	const customSourcesDir = join(process.cwd(), ".cogito", "extensions", "proactive");
	const loadedPlugins = await loadPlugins(customSourcesDir, sourcesDir);
	const registry = new PluginRegistry();
	registry.registerMany(loadedPlugins.map((loaded) => loaded.plugin));
	const sourceRegistrations = registry.collectSourceRegistrations();
	if (config.replay?.eventsPath) {
		if (sourceRegistrations.some((registration) => registration.sourceId === "historical-replay")) {
			throw new Error("replay source id historical-replay is already provided by a plugin");
		}
		const replaySource = new HistoricalReplaySource(readHistoricalReplayEvents(config.replay.eventsPath), clock);
		sourceRegistrations.push({
			pluginName: "historical-replay",
			sourceId: replaySource.id,
			sourceKey: replaySource.id,
			source: replaySource,
		});
	}
	if (sourceRegistrations.length === 0) {
		throw new Error(`No sources found in ${sourcesDir}`);
	}

	const store = new ProactiveStore(config.dbPath ?? DEFAULT_CONFIG.dbPath, clock);
	// 默认出口:多通道投递(feishu/qq/onebot/napcat,按 config.json 的
	// proactive.targets 路由)。也可注入自定义 outlet 覆盖。
	const deliveryOutlet =
		config.delivery?.outlet ??
		(config.delivery?.enabled
			? new GatewayDeliveryOutlet(store, {
					configPath: config.delivery.configPath,
					replayPending: config.delivery?.replayPending ?? true,
					clock,
				})
			: undefined);
	const rules = new ProactiveRules(config.rulesPath ?? defaultRulesPath());
	const agentDir = join(process.env.HOME ?? "/tmp", ".cogito", "agent");
	const persona: PersonaConfig = {
		...config.persona,
		workspaceDir: config.persona?.workspaceDir ?? config.memory?.workspaceDir ?? agentDir,
	};
	const memoryDbPath = config.memoryDbPath ?? join(agentDir, "memory", "memory.sqlite");
	const dbPath = config.dbPath ?? DEFAULT_CONFIG.dbPath;
	const sessionsDir = config.sessionsDir ?? DEFAULT_CONFIG.sessionsDir;
	const standaloneRuntime = new StandaloneRuntimeAdapter({ store, memoryDbPath, sessionsDir, sessionKey });
	const runtimePorts = mergeRuntimePorts(standaloneRuntime.ports, config.runtimePorts);
	// 嵌入 API(drift recall_memory 向量召回 + wake 语义兴趣共用;未配置时 undefined)。
	const embeddingApi = buildEmbeddingApi(config.embeddings);

	// ------------------------------------------------------------------
	// Drift 引擎(空闲分支 / wake drift 定时器)
	// ------------------------------------------------------------------

	const driftConfig = config.drift ?? {};
	const driftEnabled = driftConfig.enabled ?? false;
	const driftDir =
		driftConfig.driftDir ?? (driftEnabled ? join(agentDir, "drift") : join(storeDbDir(dbPath), ".drift-disabled"));
	const pluginBaseDirs = new Map(loadedPlugins.map((loaded) => [loaded.plugin.name, dirname(loaded.path)]));
	const _pluginSkillRoots = registry
		.list()
		.flatMap((plugin) =>
			(plugin.proactiveDriftSkillRoots?.() ?? []).map((root) => {
				const normalized = String(root ?? "").trim();
				if (!normalized || isAbsolute(normalized)) return normalized;
				return resolve(pluginBaseDirs.get(plugin.name) ?? process.cwd(), normalized);
			}),
		)
		.filter((root) => root.length > 0);
	const stagedDriftStore = new DriftStagedDeliveryStore({ driftDir });
	const driftGateStore = new DriftGateStore({ driftDir });
	const unsubscribeDriftDelivery = store.onDeliveryAcknowledged((record) => {
		if (record.state_summary_tag === "drift") stagedDriftStore.markRunMessageSent(record.message_hash);
	});
	const driftDeliverySink: DriftDeliverySink = {
		insertDelivery: (record) => store.insertDelivery(record),
		sendDelivery: async (record): Promise<DriftDeliveryReceipt> => {
			const deliveryId = store.insertDelivery(record, { notify: false });
			const delivery = store.getDelivery(deliveryId);
			if (!delivery) {
				return { deliveryId, status: "failed", detail: "delivery row not found after insert" };
			}
			const canonicalMedia = [
				...(record.media ?? []),
				...(record.attachments ?? []).map((attachment) => attachment.source),
			];
			if (delivery.acked !== 0 && delivery.delivery_status === "success") {
				return {
					deliveryId,
					status: "success",
					providerMessageId: delivery.provider_message_id ?? undefined,
					canonicalMedia,
				};
			}
			if (!deliveryOutlet) {
				store.ackDeliveries([deliveryId], clock.nowMs());
				return { deliveryId, status: "success", canonicalMedia };
			}
			try {
				const sent = await deliveryOutlet.send(delivery);
				const receipt: DeliverySendReceipt = sent ?? { status: "success" };
				store.recordDeliveryReceipt(deliveryId, {
					providerMessageId: receipt.providerMessageId,
					targetReceipts: receipt.targetReceipts,
				});
				const deliveryStatus = getDeliverySendStatus(receipt);
				const status =
					deliveryStatus === "partial"
						? "partial"
						: deliveryStatus === "failed" || deliveryStatus === "cancelled"
							? "failed"
							: "success";
				if (status !== "success") {
					store.recordDeliveryFailure(deliveryId, status, receipt.detail, {
						providerMessageId: receipt.providerMessageId,
						targetReceipts: receipt.targetReceipts,
						detail: receipt.detail,
					});
					deliveryOutlet.enqueue?.(delivery);
					return {
						deliveryId,
						status,
						providerMessageId: receipt.providerMessageId,
						canonicalMedia: receipt.canonicalMedia ?? canonicalMedia,
						detail: receipt.detail,
					};
				}
				store.ackDeliveries([deliveryId], clock.nowMs());
				return {
					deliveryId,
					status: "success",
					providerMessageId: receipt.providerMessageId,
					canonicalMedia: receipt.canonicalMedia ?? canonicalMedia,
					detail: receipt.detail,
				};
			} catch (error) {
				const detail = formatError(error);
				store.recordDeliveryFailure(deliveryId, "failed", detail);
				deliveryOutlet.enqueue?.(delivery);
				return { deliveryId, status: "failed", canonicalMedia, detail };
			}
		},
		// 投递前查重:24h hash 窗口 + 最近 5 条文本去重。
		dedupeCheck: (message, media = [], targetChannel = "", targetChatId = "", attachments = []) => {
			const hash = hashOutboundMessage(message, media, attachments, targetChannel, targetChatId);
			if (store.isMessageDelivered(hash, 24)) {
				return { duplicate: true, reason: "24 小时内已推送过相同消息" };
			}
			if (message.trim() && store.recentDeliveredMessages(5).some((item) => item.trim() === message.trim())) {
				return { duplicate: true, reason: "最近推送过相同消息" };
			}
			return { duplicate: false };
		},
	};
	const recoverStagedDriftDeliveries = async (): Promise<void> => {
		for (const staged of stagedDriftStore.listStagedDeliveries()) {
			const record = stagedDeliveryRecord(staged);
			try {
				if (!driftDeliverySink.sendDelivery) {
					driftDeliverySink.insertDelivery(record);
					continue;
				}
				const receipt = await driftDeliverySink.sendDelivery(record);
				if (staged.runId) {
					stagedDriftStore.markRunDelivery(staged.runId, receipt.deliveryId, receipt.status, receipt.detail);
				} else if (receipt.status === "success") {
					stagedDriftStore.markRunMessageSent(staged.messageHash);
				}
			} catch (error) {
				store.setState("lastError.driftDeliveryRecovery", formatError(error).slice(0, 2000));
			}
		}
	};
	// ------------------------------------------------------------------
	// 记忆后台任务(优化器 + 会话提取;akashic bootstrap memory_optimizer_task)
	// ------------------------------------------------------------------

	let memoryTasks: MemoryTasksHandle | undefined;
	let memoryTaskOptions: MemoryTasksOptions | undefined;
	const memoryConfig = config.memory;
	if (memoryConfig?.enabled) {
		const memoryApiKey = config.agentTick?.apiKey ?? resolveApiKey(config.agentTick);
		if (memoryApiKey) {
			memoryTaskOptions = {
				workspaceDir: memoryConfig.workspaceDir ?? agentDir,
				sessionsDir: memoryConfig.memorySessionsDir ?? sessionsDir,
				llm: openaiTextLlm({
					model: config.agentTick?.model ?? "deepseek-v4-flash",
					baseUrl: config.agentTick?.apiBaseUrl ?? "https://opencode.ai/zen/go/v1",
					apiKey: memoryApiKey,
				}),
				optimizerIntervalSeconds: memoryConfig.optimizerIntervalSeconds,
				consolidateIntervalSeconds: memoryConfig.consolidateIntervalSeconds,
				consolidateConfig: {
					keepCount: memoryConfig.keepCount,
					minNewMessages: memoryConfig.minNewMessages,
					maxConversationChars: memoryConfig.maxConversationChars,
				},
			};
		}
	}
	const ensureMemoryTasks = (): MemoryTasksHandle | undefined => {
		if (!memoryTasks && memoryTaskOptions) memoryTasks = startMemoryTasks(memoryTaskOptions);
		return memoryTasks;
	};
	const consolidateBeforeTurn =
		memoryTaskOptions && !runtimePorts.memory?.beforeTurn
			? async () => {
					await ensureMemoryTasks()?.consolidateNow();
				}
			: undefined;
	const unsubscribeMemoryBeforeTurn = consolidateBeforeTurn
		? [
				scopedEventBus.on(BeforeTurn, consolidateBeforeTurn),
				scopedEventBus.on(PassiveTurnStarted, consolidateBeforeTurn),
			]
		: undefined;

	// ------------------------------------------------------------------
	// 数据源实例(拉取 → 入库;default 轮询,wake 取通道)
	// ------------------------------------------------------------------

	const pipeline = new Pipeline(store, { clock });
	const presence = new Presence(store, { sessionsDir, sessionKey, clock }, runtimePorts.presence);
	const unsubscribeAsyncDelivery = deliveryOutlet
		? store.onDeliveryAcknowledged((_record, acknowledgedAt) => {
				presence.recordProactiveSent(acknowledgedAt);
			})
		: undefined;
	const tracePath = join(storeDbDir(dbPath), "proactive_rate_trace.jsonl");
	const runtimeJournalPath = config.replay?.journalPath ?? join(storeDbDir(dbPath), "proactive_runtime_replay.jsonl");
	const replayReportPath = config.replay?.reportPath ?? join(storeDbDir(dbPath), "proactive_replay_ticks.jsonl");

	const sourceMap = new Map(sourceRegistrations.map(({ sourceKey, source }) => [sourceKey, source]));
	const sourceConfigMap: Record<string, { enabled?: boolean; intervalMin?: number; [key: string]: unknown }> = {};
	for (const registration of sourceRegistrations) {
		const sourceConfig = config.sources?.[registration.sourceKey] ?? config.sources?.[registration.sourceId];
		if (sourceConfig) sourceConfigMap[registration.sourceKey] = sourceConfig;
	}
	for (const source of sourceMap.values()) source.setStateStore?.(store);
	const sourceAckCoordinator = new SourceAckCoordinator({
		store,
		sources: sourceMap,
		sourceConfigs: sourceConfigMap,
		clock,
		retryBaseDelayMs: config.sourceAck?.retryBaseDelayMs,
		retryMaxDelayMs: config.sourceAck?.retryMaxDelayMs,
	});
	const sourceHealth = new SourceHealthTracker({
		store,
		failureThreshold: config.sourceHealth?.failureThreshold,
		cooldownMs: config.sourceHealth?.cooldownMs,
	});
	if (!runtimePorts.sourceAck) runtimePorts.sourceAck = sourceAckCoordinator;
	const flushSourceAcknowledgements = async (): Promise<void> => {
		try {
			await sourceAckCoordinator.flush();
		} catch (error) {
			store.setState("lastError.sourceAck", formatError(error).slice(0, 2000));
		}
	};
	const intervals: Record<string, number> = {};
	const sourceInstances: Array<{
		id: string;
		fetch: () => Promise<{ received: number; inserted: number; duplicates: number; quarantined: number }>;
	}> = [];

	for (const registration of sourceRegistrations) {
		const { sourceKey: id, source } = registration;
		const sourceConfig = sourceConfigMap[id];
		if (sourceConfig?.enabled === false) continue;
		const intervalMin = sourceConfig?.intervalMin;
		if (typeof intervalMin === "number" && intervalMin > 0) {
			intervals[id] = intervalMin * 60 * 1000;
		}
		sourceInstances.push({
			id,
			fetch: async () => {
				const result = await source.fetch(sourceConfig ?? {});
				if (!Array.isArray(result)) {
					throw new Error(`default lifecycle source must return an event array: ${id}`);
				}
				const stats = await pipeline.ingest(id, result, source);
				source.commitFetchState?.();
				return stats;
			},
		});
	}

	if (sourceInstances.length === 0) {
		unsubscribeAsyncDelivery?.();
		unsubscribeDriftDelivery();
		await Promise.allSettled([...new Set(sourceMap.values())].map((source) => source.close?.()));
		stagedDriftStore.close();
		driftGateStore.close();
		store.close();
		throw new Error("No enabled sources");
	}

	for (const { id } of sourceInstances) {
		const source = sourceMap.get(id)!;
		if (!(id in intervals) && source.defaultIntervalMs) {
			intervals[id] = source.defaultIntervalMs;
		}
	}

	const lifecycleId = config.lifecycle ?? "default";
	const closeSources = async (): Promise<void> => {
		const results = await Promise.allSettled([...new Set(sourceMap.values())].map((source) => source.close?.()));
		const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
		if (errors.length === 1) throw errors[0];
		if (errors.length > 1) throw new AggregateError(errors, "proactive source cleanup failed");
	};

	// ------------------------------------------------------------------
	// Default 生命周期(插件装配 + ProactiveEngine 闭环调度)
	// ------------------------------------------------------------------

	if (lifecycleId === "default") {
		const hostChatClient = config.host ? createHostChatClient(config.host) : undefined;
		const profileConfig = config.profile
			? hostChatClient
				? { ...config.profile, client: hostChatClient }
				: config.profile
			: undefined;
		const stagesDeps: DefaultStagesDeps = {
			store,
			presence,
			sessionKey,
			sourceInstances,
			intervals,
			driftMinIntervalHours: driftConfig.minIntervalHours ?? 3,
			driftGate: config.driftGate,
			driftGateTtlHours: driftConfig.gateTtlHours,
			hostChatClient,
			deliveryOutlet,
			clock,
			runtimePorts,
			sourceHealth,
		};
		const stagesConfig: DefaultStagesConfig = config.replay?.eventsPath
			? {
					...config,
					fetch: { ...config.fetch, mode: "background" as const },
					// 顶层 webPolicy 优先,兼容旧的 drift.webPolicy 位置。
					webPolicy: config.webPolicy ?? driftConfig.webPolicy,
				}
			: {
					...config,
					webPolicy: config.webPolicy ?? driftConfig.webPolicy,
				};
		const stages = createDefaultStages(stagesConfig, stagesDeps);
		const unsubscribeDefaultDelivery = deliveryOutlet
			? store.onDeliveryAcknowledged((record, acknowledgedAt) => {
					const itemIds = deliveryItemIds(record);
					void scopedEventBus.emit(new Delivered(record.session_key, record.message, itemIds, acknowledgedAt));
					stages.sense.recordProactiveSent?.(acknowledgedAt);
					stages.gate.recordAction?.(new Date(acknowledgedAt));
				})
			: undefined;
		registry.register(
			new DefaultProactivePlugin({
				stages,
				store,
				rules,
				contextOnlyDailyMax: config.safety?.contextOnlyDailyMax ?? 1,
				contentLimit: config.agentTick?.contentLimit,
				profileConfig: profileConfig,
				memoryDbPath,
				staticInterests: config.interests,
				persona,
				clock,
				eventBus: scopedEventBus,
				runtimePorts,
			}),
		);
		const { kernel } = assembleKernel(registry, "default");
		const runtimeSnapshotStore = new RuntimeSnapshotStore<ProactiveKernel>({
			clock,
			journal: new RuntimeReplayJournal(runtimeJournalPath, clock),
			stopResource: false,
		});
		runtimeSnapshotStore.install(kernel);
		const engine = new ProactiveEngine(stages, store, {
			sessionKey,
			tracePath,
			contextOnlyDailyMax: config.safety?.contextOnlyDailyMax ?? 1,
			rules,
			profileConfig: profileConfig,
			memoryDbPath,
			staticInterests: config.interests,
			persona,
			kernel,
			runtimePorts,
			snapshotStore: runtimeSnapshotStore,
			chatLevity: config.gate?.contextOnly?.chatLevity,
			chatLevityProbability: config.gate?.contextOnly?.chatLevityProbability,
		});

		let engineHandle: { stop(): Promise<void> } | undefined;
		let monitor: MonitorHandle | undefined;
		let kernelStarted = false;
		let started = false;
		let stopped = false;
		let paused = false;
		const monitorConfig = config.monitor;
		const replayEventsPath = config.replay?.eventsPath;
		const startFetch = (): void => {
			stages.fetch.start(
				(id, stats) => {
					const source = sourceMap.get(id);
					const diagnostics = source?.fetchDiagnostics?.();
					const status =
						stats.quarantined > 0 || (diagnostics?.failed ?? 0) > 0
							? "degraded"
							: stats.received === 0
								? "empty"
								: "ok";
					store.setState(`lastStats.${id}`, JSON.stringify(stats));
					const health = sourceHealth.read(id) ?? sourceHealth.recordSuccess(id, clock.nowMs(), stats);
					store.setState(`health.source.${id}`, JSON.stringify({ ...health, status, ...stats, diagnostics }));
				},
				(id, error) => {
					const message = error instanceof Error ? error.message : String(error);
					const diagnostics = sourceMap.get(id)?.fetchDiagnostics?.();
					store.recordSourceFailure({ sourceId: id, error: message, diagnostics, now: clock.nowMs() });
					store.setState(`lastError.${id}`, message);
					const health = sourceHealth.read(id) ?? sourceHealth.recordFailure(id, clock.nowMs(), message);
					store.setState(`health.source.${id}`, JSON.stringify({ ...health, diagnostics }));
				},
			);
		};
		const startReplayResources = async (): Promise<void> => {
			if (started) throw new Error("proactive default instance is already started");
			started = true;
			await kernel.start();
			kernelStarted = true;
			await flushSourceAcknowledgements();
			ensureMemoryTasks();
			await deliveryOutlet?.start?.();
			await recoverStagedDriftDeliveries();
			if (monitorConfig?.enabled) {
				monitor = await startMonitor({
					port: monitorConfig.port ?? 4810,
					dbPath: config.dbPath ?? DEFAULT_CONFIG.dbPath,
					driftDbPath: driftEnabled ? stagedDriftStore.dbFile : undefined,
					runtimeJournalPath,
					replayReportPath,
					eventBus,
				});
			}
		};
		const runHistoricalTicks = replayEventsPath
			? async (): Promise<HistoricalReplayReport<TickResult | null>> => {
					if (!(clock instanceof ReplayClock)) {
						throw new Error("historical replay requires ReplayClock; configure replay.clockPath");
					}
					await startReplayResources();
					return await new HistoricalTickReplayRunner<TickResult | null>({
						clock,
						events: readHistoricalReplayEvents(replayEventsPath),
						sessionKey,
						reportPath: replayReportPath,
						continueOnError: true,
						ingest: async (events) =>
							await pipeline.ingest("historical-replay", events.map(historicalEventToWakeEvent)),
						executeTick: async () => await engine.runOnce(),
					}).run();
				}
			: undefined;

		return {
			passiveTurn,
			replay: runHistoricalTicks,
			start: async () => {
				if (stopped) throw new Error("proactive default instance is already stopped");
				if (started) return;
				started = true;
				await kernel.start();
				kernelStarted = true;
				await flushSourceAcknowledgements();
				ensureMemoryTasks();
				await deliveryOutlet?.start?.();
				await recoverStagedDriftDeliveries();
				startFetch();
				engineHandle = await engine.start();
				store.setState("pusher.startedAt", String(clock.nowMs()));
				// 只读 HTTP monitor(akashic dashboard API 移植):端口监听放 start,
				// 使热重载能先建后换(EADDRINUSE 在 start 时抛出)。
				if (monitorConfig?.enabled) {
					monitor = await startMonitor({
						port: monitorConfig.port ?? 4810,
						dbPath: config.dbPath ?? DEFAULT_CONFIG.dbPath,
						driftDbPath: driftEnabled ? stagedDriftStore.dbFile : undefined,
						runtimeJournalPath,
						replayReportPath,
						eventBus,
					});
				}
			},
			pause: async () => {
				if (!started || stopped || paused) return;
				await engineHandle?.stop();
				stages.fetch.stop();
				await monitor?.stop();
				monitor = undefined;
				await deliveryOutlet?.pause?.();
				paused = true;
			},
			resume: async () => {
				if (!started || stopped || !paused) return;
				await deliveryOutlet?.resume?.();
				await recoverStagedDriftDeliveries();
				await flushSourceAcknowledgements();
				startFetch();
				engineHandle = await engine.start();
				if (monitorConfig?.enabled) {
					monitor = await startMonitor({
						port: monitorConfig.port ?? 4810,
						dbPath: config.dbPath ?? DEFAULT_CONFIG.dbPath,
						driftDbPath: driftEnabled ? stagedDriftStore.dbFile : undefined,
						runtimeJournalPath,
						replayReportPath,
						eventBus,
					});
				}
				paused = false;
			},
			stop: async () => {
				if (stopped) return;
				stopped = true;
				paused = true;
				const errors: unknown[] = [];
				const cleanup = async (action: () => void | Promise<void>): Promise<void> => {
					try {
						await action();
					} catch (error) {
						errors.push(error);
					}
				};
				await cleanup(() => stages.fetch.stop());
				await cleanup(async () => await engineHandle?.stop());
				await cleanup(closeSources);
				await cleanup(async () => await monitor?.stop());
				await cleanup(async () => await deliveryOutlet?.stop?.());
				if (kernelStarted) await cleanup(async () => await kernel.stop());
				await cleanup(async () => await runtimeSnapshotStore.close());
				await cleanup(() => unsubscribeDefaultDelivery?.());
				await cleanup(() => unsubscribeAsyncDelivery?.());
				await cleanup(() => unsubscribeDriftDelivery());
				await cleanup(async () => await memoryTasks?.stop());
				await cleanup(() => {
					unsubscribeMemoryBeforeTurn?.forEach((unsubscribe) => {
						unsubscribe();
					});
				});
				await cleanup(() => stagedDriftStore.close());
				await cleanup(() => driftGateStore.close());
				await cleanup(() => store.close());
				if (errors.length === 1) throw errors[0];
				if (errors.length > 1) throw new AggregateError(errors, "proactive default instance stop failed");
			},
		};
	}

	// ------------------------------------------------------------------
	// 其他生命周期(wake/自定义):插件装配 + 通用 kernel 循环
	// ------------------------------------------------------------------

	if (lifecycleId === "wake") {
		registry.register(
			new WakeProactivePlugin(() =>
				buildWakeRuntimeDeps({
					sources: sourceMap,
					sourceConfigs: sourceConfigMap,
					dbPath,
					sessionsDir,
					sessionKey,
					rules,
					memoryDbPath,
					store,
					llm: {
						model: config.agentTick?.model ?? "deepseek-v4-flash",
						apiBaseUrl: config.agentTick?.apiBaseUrl ?? "https://opencode.ai/zen/go/v1",
						apiKey: config.agentTick?.apiKey ?? resolveApiKey(config.agentTick),
					},
					driftGate: config.driftGate,
					driftGateTtlHours: driftConfig.gateTtlHours,
					host: config.host,
					clock,
					deliveryOutlet,
					deliveryDedupeHours: config.safety?.deliveryDedupeHours,
					messageDedupeRecentN: config.safety?.messageDedupeRecentN,
					runtimePorts,
					sourceHealth,
					embeddingApi,
					tickIntervalSeconds: clock instanceof ReplayClock ? 1 : (config.tick?.tickS0 ?? 300),
					// energy 自适应调度(akashic energy.py):无 presence 时按
					// fallbackIntervalSeconds,有 presence 时按电量衰减计算间隔。
					// ReplayClock 保持确定性 tick,不接自适应。
					tickScheduler:
						clock instanceof ReplayClock
							? undefined
							: new TickScheduler({
									...config.tick,
									fallbackIntervalSeconds: config.tick?.fallbackIntervalSeconds ?? 300,
								}),
				}),
			),
		);
	}
	const { kernel, runtime } = assembleKernel(registry, lifecycleId);
	const runtimeSnapshotStore = new RuntimeSnapshotStore<ProactiveKernel>({
		clock,
		journal: new RuntimeReplayJournal(runtimeJournalPath, clock),
		stopResource: false,
	});
	runtimeSnapshotStore.install(kernel);
	const loop = new ProactiveLoop(kernel, sessionKey, runtimeSnapshotStore);
	let running: Promise<void> | null = null;
	let started = false;
	let stopped = false;
	let paused = false;
	let kernelStarted = false;
	let monitor: MonitorHandle | undefined;
	return {
		passiveTurn,
		/** 启动 tick 循环(可延迟,供热重载 supervisor 先建后换)。 */
		start: async () => {
			if (stopped) throw new Error("proactive instance is already stopped");
			if (started) return;
			started = true;
			ensureMemoryTasks();
			await deliveryOutlet?.start?.();
			await recoverStagedDriftDeliveries();
			await kernel.start();
			kernelStarted = true;
			await flushSourceAcknowledgements();
			if (config.monitor?.enabled) {
				monitor = await startMonitor({
					port: config.monitor.port ?? 4810,
					dbPath: config.dbPath ?? DEFAULT_CONFIG.dbPath,
					wakeDbPath: lifecycleId === "wake" ? join(storeDbDir(dbPath), "wake_proactive.db") : undefined,
					runtimeJournalPath,
					replayReportPath,
					eventBus,
				});
			}
			running = loop.run();
		},
		pause: async () => {
			if (!started || stopped || paused) return;
			loop.stop();
			if (running) await running;
			await monitor?.stop();
			monitor = undefined;
			await deliveryOutlet?.pause?.();
			paused = true;
		},
		resume: async () => {
			if (!started || stopped || !paused) return;
			await deliveryOutlet?.resume?.();
			await recoverStagedDriftDeliveries();
			await flushSourceAcknowledgements();
			if (config.monitor?.enabled) {
				monitor = await startMonitor({
					port: config.monitor.port ?? 4810,
					dbPath: config.dbPath ?? DEFAULT_CONFIG.dbPath,
					wakeDbPath: lifecycleId === "wake" ? join(storeDbDir(dbPath), "wake_proactive.db") : undefined,
					runtimeJournalPath,
					replayReportPath,
					eventBus,
				});
			}
			running = loop.run();
			paused = false;
		},
		stop: async () => {
			if (stopped) return;
			stopped = true;
			paused = true;
			loop.stop();
			const errors: unknown[] = [];
			const cleanup = async (action: () => void | Promise<void>): Promise<void> => {
				try {
					await action();
				} catch (error) {
					errors.push(error);
				}
			};
			await cleanup(async () => {
				if (running) await running;
			});
			await cleanup(closeSources);
			if (kernelStarted) await cleanup(async () => await kernel.stop());
			await cleanup(async () => await monitor?.stop());
			await cleanup(async () => await runtimeSnapshotStore.close());
			await cleanup(() => (runtime as { close?: () => void }).close?.());
			await cleanup(async () => await deliveryOutlet?.stop?.());
			await cleanup(() => unsubscribeAsyncDelivery?.());
			await cleanup(() => unsubscribeDriftDelivery());
			await cleanup(async () => await memoryTasks?.stop());
			await cleanup(() => {
				unsubscribeMemoryBeforeTurn?.forEach((unsubscribe) => {
					unsubscribe();
				});
			});
			await cleanup(() => stagedDriftStore.close());
			await cleanup(() => driftGateStore.close());
			await cleanup(() => store.close());
			if (errors.length === 1) throw errors[0];
			if (errors.length > 1) throw new AggregateError(errors, "proactive instance stop failed");
		},
	};
}

/**
 * 按 lifecycleId 从插件注册表装配 kernel:
 * 选 spec → runtime factory create → module factory/direct modules → 拓扑排序编译。
 * runtime 若提供 abortError(tick 异常收口),自动挂到 kernel.onTickError。
 */
function assembleKernel(registry: PluginRegistry, lifecycleId: string): { kernel: ProactiveKernel; runtime: unknown } {
	const lifecycleCandidates = registry.collectLifecycles().filter((candidate) => candidate.id === lifecycleId);
	if (lifecycleCandidates.length === 0) {
		throw new Error(`lifecycle not found: ${lifecycleId}`);
	}
	const spec = selectSingle(`proactive lifecycle ${lifecycleId}`, lifecycleCandidates, { required: true });
	const runtimeFactory = selectSingle(
		`proactive runtime factory ${lifecycleId}`,
		registry.collectRuntimeFactories().filter((factory) => factory.lifecycleId === lifecycleId),
		{ required: true },
	);
	const moduleFactory = selectSingle(
		`proactive module factory ${lifecycleId}`,
		registry.collectModuleFactories().filter((factory) => factory.lifecycleId === lifecycleId),
		{ required: false },
	);
	const runtime = runtimeFactory.create();
	const modules = [...registry.collectModules(), ...(moduleFactory ? moduleFactory.create(runtime) : [])];
	const kernel = new ProactiveKernel(modules, { lifecycle: spec });
	const maybeAbort = (runtime as { abortError?: (error: unknown) => void | Promise<void> }).abortError;
	if (typeof maybeAbort === "function") {
		kernel.onTickError = (error) => maybeAbort(error);
	}
	return { kernel, runtime };
}

function selectSingle<T>(label: string, candidates: readonly T[], options: { required: true }): T;
function selectSingle<T>(label: string, candidates: readonly T[], options: { required: false }): T | undefined;
function selectSingle<T>(label: string, candidates: readonly T[], options: { required: boolean }): T | undefined {
	if (candidates.length === 0) {
		if (options.required) throw new Error(`${label} not found`);
		return undefined;
	}
	if (candidates.length > 1) {
		throw new Error(`${label} duplicated (${candidates.length} providers)`);
	}
	return candidates[0];
}

function storeDbDir(dbPath: string): string {
	const lastSlash = Math.max(dbPath.lastIndexOf("/"), dbPath.lastIndexOf("\\"));
	return lastSlash >= 0 ? dbPath.slice(0, lastSlash) : ".";
}

function deliveryItemIds(record: { source_refs: string }): number[] {
	try {
		const refs = JSON.parse(record.source_refs) as Array<{ id?: string | number }>;
		return refs.flatMap((ref) => {
			const id = typeof ref.id === "number" ? ref.id : Number(ref.id);
			return Number.isSafeInteger(id) && id > 0 ? [id] : [];
		});
	} catch {
		return [];
	}
}

function stagedDeliveryRecord(staged: DriftStagedDelivery): DriftDeliveryRecord {
	return {
		session_key: staged.sessionKey,
		message: staged.message,
		message_hash: staged.messageHash,
		media: staged.media,
		attachments: staged.attachments,
		target_channel: staged.targetChannel,
		target_chat_id: staged.targetChatId,
		source_refs: "[]",
		evidence: "[]",
		action: "send",
		state_summary_tag: "drift",
		delivered_at: staged.deliveredAt,
		idempotency_key: `drift:${staged.messageHash}`,
	};
}

/** 读取最近会话消息(供 drift recent_raw_chat)。 */
function _readSessionMessages(
	sessionsDir: string,
	limit: number,
): Array<{ role: string; content: string; proactive?: boolean }> {
	if (!existsSync(sessionsDir)) return [];
	const messages: Array<{ role: string; content: string; timestamp: string }> = [];
	try {
		for (const name of readdirSync(sessionsDir)) {
			const full = join(sessionsDir, name);
			if (name.endsWith(".jsonl")) {
				collectSessionFile(full, messages);
			} else if (statSync(full).isDirectory()) {
				for (const inner of readdirSync(full)) {
					if (inner.endsWith(".jsonl")) collectSessionFile(join(full, inner), messages);
				}
			}
		}
	} catch {
		return [];
	}
	messages.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
	return messages.slice(-limit).map(({ role, content }) => ({ role, content }));
}

function collectSessionFile(file: string, out: Array<{ role: string; content: string; timestamp: string }>): void {
	let lines: string[];
	try {
		lines = readFileSync(file, "utf-8").split("\n");
	} catch {
		return;
	}
	for (const line of lines) {
		if (!line.trim()) continue;
		let entry: { type?: string; message?: { role?: string; content?: unknown; timestamp?: string } };
		try {
			entry = JSON.parse(line) as typeof entry;
		} catch {
			continue;
		}
		if (entry.type !== "message" || !entry.message) continue;
		const role = entry.message.role;
		if (role !== "user" && role !== "assistant") continue;
		const text = extractTextContent(entry.message.content);
		if (!text) continue;
		out.push({ role, content: text, timestamp: String(entry.message.timestamp ?? "") });
	}
}

function extractTextContent(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (Array.isArray(content)) {
		return content
			.filter((part): part is { type: string; text?: string } => typeof part === "object" && part !== null)
			.map((part) => (part.type === "text" ? (part.text ?? "") : ""))
			.join(" ")
			.trim();
	}
	return "";
}

/**
 * 热重载 pusher:watch 源目录(+ 配置),变更后重建。
 * 数据源 .ts 文件变更或 proactive.json 变更无需重启进程。
 */
export async function runReloadablePusher(
	config: PusherConfig,
	options: { configPath?: string } = {},
): Promise<{ stop: () => Promise<void> }> {
	const sourcesDir = config.sourcesDir ?? DEFAULT_CONFIG.sourcesDir;
	const customSourcesDir = join(process.cwd(), ".cogito", "extensions", "proactive");
	const watchPaths = [sourcesDir, customSourcesDir];
	const configPath = options.configPath;
	if (configPath && config.reload?.watchConfig !== false) watchPaths.push(configPath);
	const build = configPath
		? async () => buildPusher({ ...config, ...loadPusherConfig(configPath) })
		: () => buildPusher(config);
	return runReloadable({
		watchPaths,
		build,
		snapshotJournalPath:
			config.replay?.journalPath ??
			join(storeDbDir(config.dbPath ?? DEFAULT_CONFIG.dbPath), "proactive_runtime_replay.jsonl"),
		onReload: (reason) => console.error(`proactive pusher reloaded: ${reason}`),
		onError: (error) =>
			console.error(`proactive pusher reload failed: ${error instanceof Error ? error.message : String(error)}`),
		debounceMs: config.reload?.debounceMs ?? 1000,
	});
}

// Entry point when executed directly.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const configPath = process.argv[2] ?? join(import.meta.dirname, "..", "proactive.json");
	const config = loadPusherConfig(configPath);
	if (config.enabled === false) {
		console.error("proactive pusher disabled by config");
		process.exit(0);
	}
	const run = config.reload?.enabled ? runReloadablePusher(config, { configPath }) : runPusher(config);
	run.then(() => {
		console.error(
			`proactive pusher running (sources dir: ${config.sourcesDir ?? DEFAULT_CONFIG.sourcesDir}, db: ${config.dbPath ?? DEFAULT_CONFIG.dbPath})`,
		);
	}).catch((error) => {
		console.error(`proactive pusher failed: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	});
}
