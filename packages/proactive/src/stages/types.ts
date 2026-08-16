/**
 * Proactive 阶段策略接口。
 *
 * 一个阶段 = 一个策略接口 + 可插拔实现;ProactiveEngine 负责编排 tick。
 * 默认实现(见 defaults.ts)包住原有行为,替换任意策略即可改变对应阶段:
 * 感知换成 API 心跳、调度换成固定间隔、判题换成关键词、生成换成模板、
 * 投递换成 webhook、空闲分支换成其他后台任务。
 */

import type { ProactiveEvidence, ProactiveProposal } from "../proposal.ts";
import type { ProactiveItem, ProactiveStore } from "../store.ts";

export type { ProactiveAction, ProactiveEvidence, ProactiveProposal } from "../proposal.ts";

/** 数据源候选条目(来自 ProactiveStore)。 */
export type { ProactiveItem as CandidateItem } from "../store.ts";

/** 判题证据(agent tick 抓取的正文章节)。 */
export type Evidence = ProactiveEvidence;

/** 感知结果:用户活动状态 + 能量/基础分(供调度与 trace)。 */
export interface SenseState {
	lastUserAt: number | null;
	lastProactiveAt: number | null;
	energy: number;
	baseScore: number;
}

/** 一次 tick 的共享上下文。 */
export interface TurnContext {
	sessionKey: string;
	now: Date;
	/** PROACTIVE_CONTEXT.md 规则面板(硬约束)。 */
	rulesPanel: string;
	/** 用户偏好块(记忆 + 画像 + 静态 interests)。 */
	preferenceBlock: string;
	/** 本轮是否允许 context_only 兜底(gate 概率开关,akashic context_as_fallback_open)。 */
	contextAsFallbackOpen: boolean;
	/** 空候选闲聊模式:judge 只允许 get_recent_chat / message_push / finish_judgment。 */
	chatLevity?: boolean;
	/** 插件贡献的 judge system prompt 底部段(akashic proactive:prompt:system_bottom:*)。 */
	promptSections?: readonly string[];
	store: ProactiveStore;
	/** 判题工具级审计回调(akashic record_tick_step_log);缺省不记录。 */
	recordToolStep?(step: {
		toolName: string;
		toolArgs: string;
		resultText: string;
		actionAfter: string;
		skipReasonAfter: string;
		toolCallId?: string;
		interestingIds?: number[];
		discardedIds?: number[];
		citedIds?: number[];
		finalMessage?: string | null;
	}): void;
}

/** 准入闸门判定(akashic GateResult)。 */
export interface GateVerdict {
	blocked: boolean;
	reason: string;
	/** 终局 base_score(akashic GateResult.base_score;blocked 时为 null)。 */
	baseScore: number | null;
	/** 是否开放 context_only 兜底(供 judge 提示与引擎分支使用)。 */
	contextAsFallbackOpen: boolean;
}

/** 准入闸门策略:tick 的第一相位,blocked 则本轮不判题不 drift。 */
export interface GateStrategy {
	readonly id: string;
	check(now: Date): GateVerdict;
	/** 动作成功后调用(anyaction 配额记账):投递成功 / 进入 drift。 */
	recordAction?(now?: Date): void;
}

// ------------------------------------------------------------------
// 阶段策略接口
// ------------------------------------------------------------------

/** 感知策略:环境 → 用户活动状态。 */
export interface PresenceStrategy {
	readonly id: string;
	sense(): Promise<SenseState>;
	/** 投递成功后由引擎调用(可选;默认实现记录 last_proactive_at)。 */
	recordProactiveSent?(now?: number): void;
}

/** 调度策略:感知状态 → 下次 tick 间隔(毫秒)。 */
export interface ScheduleStrategy {
	readonly id: string;
	nextInterval(state: SenseState): number;
	/** 调度参数快照(akashic rate trace 的 tick_interval_s0/s1/jitter)。 */
	traceContext?(): Record<string, unknown>;
}

/** 获取策略:数据源轮询(独立于 tick 循环)。 */
export interface FetchStrategy {
	readonly id: string;
	/** True when source fetches are part of the lifecycle tick rather than a background loop. */
	readonly tickDriven?: boolean;
	start(
		onFetched: (
			sourceId: string,
			stats: { received: number; inserted: number; duplicates: number; quarantined: number },
		) => void,
		onError: (sourceId: string, error: unknown) => void,
	): void;
	/** Fetch sources that are due now; failures are reported through start callbacks. */
	runOnce?(): Promise<void>;
	stop(): void;
}

/** 判题终局。 */
export interface JudgeVerdict {
	action: "send" | "skip" | "context_only";
	itemIds: number[];
	evidence: Evidence[];
	skipReason: string;
	stepsTaken: number;
	/** 判题分类审计(akashic tick_log discarded_ids 等)。 */
	discardedItemIds?: number[];
	citedItemIds?: number[];
	/** LLM 调用次数(akashic llm_call_count)。 */
	llmCallCount?: number;
	/** judge 内 message_push 暂存的草稿(akashic message_push);resolve 优先使用。 */
	draftMessage?: string | null;
	/** LLM cache token 统计(akashic record_llm_cache)。 */
	llmCacheReadTokens?: number;
	llmCacheWriteTokens?: number;
}

/** 判题策略:候选 → 终局动作(含证据)。 */
export interface JudgeStrategy {
	readonly id: string;
	judge(items: ProactiveItem[], ctx: TurnContext): Promise<JudgeVerdict>;
}

/**
 * 预取策略:判题前并行抓取候选正文并缓存(akashic DataGateway content_store)。
 * 判题的 fetch_evidence 优先读缓存,避免在 LLM 循环内逐个串行抓取。
 */
export interface PrefetchStrategy {
	readonly id: string;
	prefetch(items: ProactiveItem[]): Promise<void>;
}

/** 生成策略:证据 → 推送消息(返回 null 表示放弃,如 <no_content/>)。 */
export interface ResolveStrategy {
	readonly id: string;
	resolve(evidence: Evidence[], ctx: TurnContext): Promise<string | null>;
}

/** 待投递消息。 */
export interface DeliveryMessage {
	message: string;
	evidence: Evidence[];
	itemIds: number[];
	/** Canonical decision envelope shared with wake delivery. */
	proposal?: ProactiveProposal;
}

export interface DeliveryResult {
	delivered: boolean;
	reason?: string;
}

/** 投递策略:消息 → 渠道(默认写入 deliveries 表)。 */
export interface DeliverStrategy {
	readonly id: string;
	deliver(message: DeliveryMessage, ctx: TurnContext): Promise<DeliveryResult>;
}

/** 空闲策略:无候选时执行(默认交给 drift)。返回 true 表示已处理。 */
export interface IdleStrategy {
	readonly id: string;
	run(ctx: TurnContext): Promise<boolean>;
}

/** 一次 tick 的终局结果(闭环调度:结果反哺下一次间隔)。 */
export interface TickResult {
	/** 终局 base_score;null 表示无法计算(下次间隔回退到 presence 驱动)。 */
	baseScore: number | null;
	/**
	 * 下一次 tick 等待秒数(akashic frame.output.next_interval_seconds)。
	 * 未提供时,引擎用 schedule 策略按终局 base_score 计算(akashic 默认 lifecycle)。
	 */
	nextIntervalSeconds?: number | null;
}

/** 全部阶段策略的组装。 */
export interface ProactiveStages {
	gate: GateStrategy;
	sense: PresenceStrategy;
	schedule: ScheduleStrategy;
	fetch: FetchStrategy;
	prefetch: PrefetchStrategy;
	judge: JudgeStrategy;
	resolve: ResolveStrategy;
	deliver: DeliverStrategy;
	idle: IdleStrategy;
}
