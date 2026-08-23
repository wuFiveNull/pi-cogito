/**
 * 默认阶段策略组装 — 包住原 proactive 行为,替换任意一项即可换策略。
 */

import type { ChatCompletionClient } from "@cogito/ai/chat";
import {
	type DriftWebDnsLookupFn,
	type DriftWebFetchFn,
	type DriftWebPolicy,
	type DriftWebSearchFn,
	fetchWebPage,
	searchWebPage,
} from "@cogito/gate";
import { type Clock, ReplayClock, replayRandom, SystemClock } from "../clock.ts";
import type { DriftGateWriter } from "../drift-gate.ts";
import { resolveApiKey } from "../llm.ts";
import type { ProactiveRuntimePorts } from "../runtime/ports.ts";
import type { SourceHealthTracker } from "../runtime/source-health.ts";
import type { ProactiveItem, ProactiveStore } from "../store.ts";
import { isMessageDuplicate, type RecentDeliveryLike } from "./dedupe.ts";
import { type DeliveryOutlet, SqliteDeliverStrategy } from "./deliver.ts";
import { type PollSourceInstance, SourcePollStrategy } from "./fetch-scheduler.ts";
import { GateChain } from "./gate.ts";
import { DriftIdleStrategy } from "./idle.ts";
import { AgentTickJudgeStrategy, htmlToText, type TickToolDeps } from "./judge-agent-tick.ts";
import { collectRecent } from "./recent-chat.ts";
import { EvidenceFirstResolveStrategy } from "./resolve-evidence.ts";
import { EnergyScheduleStrategy, type TickSchedulerConfig } from "./schedule.ts";
import { DEFAULT_SESSION_KEY, JsonlPresenceStrategy, type Presence } from "./sense.ts";
import type { PrefetchStrategy, ProactiveStages } from "./types.ts";

export interface DefaultStagesDeps {
	store: ProactiveStore;
	presence: Presence;
	/** 目标会话 key(akashic channel:chat_id;默认 local)。 */
	sessionKey?: string;
	/** 已包装的数据源实例(id + 拉取入库函数)。 */
	sourceInstances: PollSourceInstance[];
	/** 每源轮询间隔(ms)。 */
	intervals: Record<string, number>;
	driftMinIntervalHours: number;
	/** 三进程模式:写 drift_gate 许可。 */
	driftGate?: DriftGateWriter;
	/** 三进程模式:「允许」许可的 TTL(小时);默认 max(1, driftMinIntervalHours)。 */
	driftGateTtlHours?: number;
	/** 宿主注入的 ChatCompletionClient(pi-host ModelRuntime);提供时 judge/dedupe/resolve 走 host。 */
	hostChatClient?: ChatCompletionClient;
	/** 可注入时钟(默认系统时钟)。 */
	clock?: Clock;
	/** 可选外部投递出口;未配置时 deliveries 表本身是本地出口。 */
	deliveryOutlet?: DeliveryOutlet;
	/** Host-owned runtime ports. */
	runtimePorts?: ProactiveRuntimePorts;
	/** Durable source metrics and circuit breaker. */
	sourceHealth?: SourceHealthTracker;
}

/**
 * 预取策略(默认:判题前并行抓取候选正文缓存,akashic DataGateway content_store)。
 * 单条失败降级为摘要/标题,不影响其他候选;超时与抓取错误不抛给调用方。
 */
export class HttpPrefetchStrategy implements PrefetchStrategy {
	readonly id = "http-prefetch";

	private readonly store: ProactiveStore;
	private readonly limit: number;
	private readonly maxChars: number;
	private readonly timeoutMs: number;
	private readonly fetchFn: typeof fetch;

	constructor(
		store: ProactiveStore,
		options: {
			contentLimit?: number;
			webFetchMaxChars?: number;
			requestTimeoutMs?: number;
			fetchFn?: typeof fetch;
		} = {},
	) {
		this.store = store;
		this.limit = options.contentLimit ?? 5;
		this.maxChars = options.webFetchMaxChars ?? 8000;
		this.timeoutMs = options.requestTimeoutMs ?? 60_000;
		this.fetchFn = options.fetchFn ?? fetch;
	}

	/** 并行抓取前 limit 个候选的正文并写入 items.evidence(判题直接读缓存)。 */
	async prefetch(items: ProactiveItem[]): Promise<void> {
		const targets = items.slice(0, this.limit).filter((item) => !(item.evidence && item.evidence.length > 20));
		await Promise.all(targets.map((item) => this.fetchOne(item)));
	}

	private async fetchOne(item: ProactiveItem): Promise<void> {
		let snippet: string | undefined;
		if (item.url) {
			try {
				const controller = new AbortController();
				const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
				try {
					const response = await this.fetchFn(item.url, { signal: controller.signal });
					if (response.ok) {
						const text = await response.text();
						const plain = htmlToText(text);
						if (plain.length > 20) snippet = plain.slice(0, this.maxChars);
					}
				} finally {
					clearTimeout(timeout);
				}
			} catch {
				// 抓取失败降级到摘要。
			}
		}
		const fallback = (item.summary ?? item.title ?? "").slice(0, this.maxChars);
		this.store.setItemEvidence(item.id, snippet ?? fallback);
	}
}

export interface DefaultStagesConfig {
	/** Source fetch placement. Tick mode is the default; background preserves the legacy poller. */
	fetch?: { mode?: "tick" | "background" };
	tick?: TickSchedulerConfig;
	/** 判题(agent tick)配置。 */
	agentTick?: {
		model?: string;
		apiBaseUrl?: string;
		apiKey?: string;
		maxSteps?: number;
		/** agent_tick_content_limit: 每轮候选上限 + 预取正文上限(akashic 默认 5)。 */
		contentLimit?: number;
		webFetchMaxChars?: number;
		requestTimeoutMs?: number;
	};
	resolve?: { model?: string; apiBaseUrl?: string; apiKey?: string };
	dedupe?: { enabled?: boolean; model?: string; apiBaseUrl?: string; apiKey?: string };
	gate?: {
		/** agent_tick_delivery_cooldown_hours: 投递冷却窗口(小时)。 */
		deliveryCooldownHours?: number;
		/** judge_send_threshold: 判题发送置信度下限(akashic 只放进配置,judge 不消费;preset 填充)。 */
		judgeSendThreshold?: number;
		/** 主 agent 忙检查(akashic passive_busy_fn);返回 true 时本轮不判题。 */
		busyFn?: (now: Date) => boolean;
		/** 默认 busy 近窗(秒):presence.last_user_at 距今小于该值视为用户正在对话。默认 120。 */
		busyWindowSeconds?: number;
		/** anyaction 概率闸(akashic anyaction.py);enabled=false 时禁用。 */
		anyaction?: {
			enabled?: boolean;
			dailyMaxActions?: number;
			minIntervalSeconds?: number;
			probabilityMin?: number;
			probabilityMax?: number;
			idleScaleMinutes?: number;
			resetHourLocal?: number;
			timezone?: string;
		};
		/** context_only 兜底概率开关(akashic agent_tick_context_prob 等)。 */
		contextOnly?: {
			probability?: number;
			minIntervalHours?: number;
			dailyMax?: number;
			/** 空候选闲聊分支(akashic get_recent_chat 低概率路径);默认关闭。 */
			chatLevity?: boolean;
			/** 空候选闲聊分支的触发概率(默认 0.1)。 */
			chatLevityProbability?: number;
		};
	};
	safety?: { deliveryDedupeHours?: number; messageDedupeRecentN?: number; contextOnlyDailyMax?: number };
	scoreWeightEnergy?: number;
	/** 内部 HTTP 访问策略(judge web_fetch/web_search;默认拒绝私网/DNS 重绑定)。 */
	webPolicy?: DriftWebPolicy;
	/** 宿主注入的安全 web 抓取;未提供时用内置实现 + webPolicy。 */
	webFetchFn?: DriftWebFetchFn;
	/** 宿主注入的安全 web 搜索;未提供时用 webSearchUrl + webPolicy。 */
	webSearchFn?: DriftWebSearchFn;
	/** 可选 resolver 覆盖(测试/预检)。 */
	webDnsLookupFn?: DriftWebDnsLookupFn;
	/** OpenAI/Brave 风格搜索 endpoint(q 查询参数);webSearchFn 未提供时使用。 */
	webSearchUrl?: string;
	/** 搜索 API key(Bearer + X-Subscription-Token)。 */
	webSearchApiKey?: string;
}

/** 用默认实现组装全部阶段。 */
export function createDefaultStages(config: DefaultStagesConfig, deps: DefaultStagesDeps): ProactiveStages {
	const clock = deps.clock ?? SystemClock;
	const gateRandom = clock instanceof ReplayClock ? replayRandom(clock, "default-gate") : undefined;
	const scheduleRandom = clock instanceof ReplayClock ? replayRandom(clock, "default-schedule") : undefined;
	const tickModel = config.agentTick?.model ?? "deepseek-v4-flash";
	const tickBaseUrl = config.agentTick?.apiBaseUrl ?? "https://opencode.ai/zen/go/v1";
	const tickApiKey = resolveApiKey(config.agentTick);
	const dedupeConfig = config.dedupe;
	const dedupeApiKey = dedupeConfig?.apiKey ?? tickApiKey;
	const busyFn = deps.runtimePorts?.busy
		? (now: Date) =>
				Boolean(
					config.gate?.busyFn?.(now) ||
						deps.runtimePorts?.busy?.isBusy(deps.sessionKey ?? DEFAULT_SESSION_KEY, now),
				)
		: config.gate?.busyFn;
	const llmDedupeFn =
		dedupeConfig && dedupeConfig.enabled !== false && (dedupeApiKey || deps.hostChatClient)
			? (newMessage: string, recent: RecentDeliveryLike[]) =>
					isMessageDuplicate(newMessage, recent, {
						model: dedupeConfig.model ?? tickModel,
						baseUrl: dedupeConfig.apiBaseUrl ?? tickBaseUrl,
						apiKey: dedupeApiKey,
						client: deps.hostChatClient,
					})
			: undefined;
	const gateConfig = config.gate;
	const anyaction = gateConfig?.anyaction;
	const gate = new GateChain(deps.store, {
		deliveryCooldownHours: gateConfig?.deliveryCooldownHours ?? 1,
		busyFn,
		sessionKey: deps.sessionKey,
		clock: deps.clock,
		anyAction: anyaction?.enabled
			? {
					dailyMaxActions: anyaction.dailyMaxActions ?? 24,
					minIntervalSeconds: anyaction.minIntervalSeconds ?? 300,
					probabilityMin: anyaction.probabilityMin ?? 0.03,
					probabilityMax: anyaction.probabilityMax ?? 0.45,
					idleScaleMinutes: anyaction.idleScaleMinutes ?? 240,
					resetHourLocal: anyaction.resetHourLocal ?? 12,
					timezone: anyaction.timezone ?? "Asia/Shanghai",
				}
			: null,
		contextOnly: {
			probability: gateConfig?.contextOnly?.probability ?? 0.03,
			minIntervalHours: gateConfig?.contextOnly?.minIntervalHours ?? 12,
			dailyMax: gateConfig?.contextOnly?.dailyMax ?? 1,
		},
		rng: gateRandom,
	});

	/** 判题工具提供器(akashic judge ToolDeps):recent_chat / recall_memory / web_fetch / web_search。 */
	const judgeToolDeps: TickToolDeps = {
		recentChatFn: deps.runtimePorts?.session?.recentMessages
			? async () => {
					const sessionKey = deps.sessionKey ?? DEFAULT_SESSION_KEY;
					const rows = await deps.runtimePorts!.session!.recentMessages!({
						sessionKey,
						limit: 20,
						now: clock.now(),
					});
					// akashic Sensor.collect_recent 语义:角色过滤 + context-frame
					// 过滤 + 单条 200 字符截断(host 端口只负责取原始行)。
					return collectRecent(rows);
				}
			: undefined,
		recallMemoryFn: deps.runtimePorts?.memory?.recall
			? async (query) => {
					const sessionKey = deps.sessionKey ?? DEFAULT_SESSION_KEY;
					const prefs = await deps.runtimePorts!.memory!.recall!({
						sessionKey,
						now: clock.now(),
						query,
						limit: 5,
					});
					return prefs
						.map((pref) => `[${pref.memoryType}] ${pref.summary}`)
						.join("\n")
						.slice(0, 3000);
				}
			: undefined,
		webFetchFn: config.webFetchFn
			? config.webFetchFn
			: (url, maxChars, timeoutMs) =>
					fetchWebPage(url, maxChars, timeoutMs, config.webPolicy, config.webDnsLookupFn),
		webSearchFn: config.webSearchFn
			? config.webSearchFn
			: config.webSearchUrl
				? (query, maxResults, timeoutMs) =>
						searchWebPage(
							config.webSearchUrl,
							config.webSearchApiKey,
							query,
							maxResults,
							timeoutMs,
							config.webPolicy,
							config.webDnsLookupFn,
						)
				: undefined,
		webFetchMaxChars: config.agentTick?.webFetchMaxChars,
		webSearchMaxResults: 5,
		webRequestTimeoutMs: config.agentTick?.requestTimeoutMs,
	};

	return {
		gate,
		// akashic STRATEGY_PARAMS 有效值 0.35(presets.py:141 覆盖 config 默认 0.40)。
		sense: new JsonlPresenceStrategy(deps.presence, config.scoreWeightEnergy ?? 0.35, deps.clock),
		schedule: new EnergyScheduleStrategy({ ...config.tick, random: config.tick?.random ?? scheduleRandom }, clock),
		fetch: new SourcePollStrategy(
			deps.sourceInstances,
			deps.intervals,
			60_000,
			clock,
			deps.store,
			config.fetch?.mode !== "background",
			deps.sourceHealth,
		),
		prefetch: new HttpPrefetchStrategy(deps.store, {
			contentLimit: config.agentTick?.contentLimit,
			webFetchMaxChars: config.agentTick?.webFetchMaxChars,
			requestTimeoutMs: config.agentTick?.requestTimeoutMs,
		}),
		judge: new AgentTickJudgeStrategy({
			model: tickModel,
			baseUrl: tickBaseUrl,
			apiKey: tickApiKey,
			client: deps.hostChatClient,
			config: {
				maxSteps: config.agentTick?.maxSteps,
				webFetchMaxChars: config.agentTick?.webFetchMaxChars,
				requestTimeoutMs: config.agentTick?.requestTimeoutMs,
			},
			toolDeps: judgeToolDeps,
		}),
		resolve: new EvidenceFirstResolveStrategy({
			model: config.resolve?.model ?? tickModel,
			baseUrl: config.resolve?.apiBaseUrl ?? tickBaseUrl,
			apiKey: config.resolve?.apiKey ?? tickApiKey,
			client: deps.hostChatClient,
		}),
		deliver: new SqliteDeliverStrategy(deps.store, {
			deliveryDedupeHours: config.safety?.deliveryDedupeHours ?? 24,
			messageDedupeRecentN: config.safety?.messageDedupeRecentN ?? 5,
			llmDedupeFn,
			outlet: deps.deliveryOutlet,
			runtimePorts: deps.runtimePorts,
		}),
		idle: new DriftIdleStrategy({
			store: deps.store,
			minIntervalHours: deps.driftMinIntervalHours,
			gateTtlHours: deps.driftGateTtlHours,
			clock: deps.clock,
			gateWriter: deps.driftGate,
		}),
	};
}
