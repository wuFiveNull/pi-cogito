/**
 * DefaultRuntime — default 生命周期的业务执行服务(akashic ProactiveFlowRuntime 的 pi 形态)。
 *
 * 一次 tick = gate → sense → route(idle/drift)→ judge → resolve → commit → schedule。
 * 模块(modules.ts)只做薄包装,状态经 ProactiveRunState 在模块间传递;
 * tick 日志记录与终局事件在此统一收口。
 */

import { formatPreferenceBlock, recallPreferences } from "@cogito/gate";
import { BeforeTurn, Delivered, type EventBus, ProactiveFinished } from "../../bus.ts";
import { type Clock, SystemClock } from "../../clock.ts";
import { type PersonaConfig, renderPersonaBlock } from "../../persona.ts";
import { maybeRefreshProfile, type ProfileConfig } from "../../profile.ts";
import { createProactiveProposal, type ProactiveEvidence, type ProactiveProposal } from "../../proposal.ts";
import type { ProactiveRules } from "../../rules.ts";
import type { ProactiveRuntimePorts } from "../../runtime/ports.ts";
import { normalizeOutboundText } from "../../stages/outbound-text.ts";
import type { GateVerdict, JudgeVerdict, ProactiveStages, SenseState, TurnContext } from "../../stages/types.ts";
import type { ProactiveItem, ProactiveStore, TickLogRecord } from "../../store.ts";

export interface DefaultRuntimeDeps {
	stages: ProactiveStages;
	store: ProactiveStore;
	rules: ProactiveRules;
	contextOnlyDailyMax: number;
	/** 每轮候选上限(akashic agent_tick_content_limit,默认 5)。 */
	contentLimit?: number;
	clock?: Clock;
	eventBus?: EventBus;
	profileConfig?: ProfileConfig;
	memoryDbPath?: string;
	staticInterests?: string;
	/** VEDA/persona prompt block, loaded for every proactive context build. */
	persona?: PersonaConfig;
	/** Host-owned session, memory, presence and delivery ports. */
	runtimePorts?: ProactiveRuntimePorts;
	/** 空候选闲聊分支开关(akashic get_recent_chat 低概率路径)。 */
	chatLevity?: boolean;
	/** 空候选闲聊分支触发概率(默认 0.1)。 */
	chatLevityProbability?: number;
	/** 可注入随机源(回放时钟确定性用)。 */
	random?: () => number;
}

/** 一次 tick 的运行时状态(模块间经 frame.slots["run:state"] 传递)。 */
export interface ProactiveRunState {
	ctx: { sessionKey: string; now: Date };
	startedAt: number;
	tickLogId: number;
	finished: boolean;
	gateVerdict: GateVerdict | null;
	/** gate 退出原因(akashic gate_exit):open / busy / cooldown / anyaction / ... */
	gateExit: string;
	senseState: SenseState | null;
	candidates: ProactiveItem[];
	verdict: JudgeVerdict | null;
	proposal: ProactiveProposal | null;
	message: string | null;
	delivered: boolean;
	action: string;
	skipReason: string;
	steps: number;
	baseScore: number | null;
	nextIntervalSeconds: number | null;
	/** 本轮是否空候选闲聊模式(judge 受限工具)。 */
	chatLevity: boolean;
	/** 插件贡献的 judge prompt 底部段(akashic proactive:prompt:system_bottom:*)。 */
	promptSections: string[];
	/** 插件贡献的 effect 审计记录(akashic proactive:effect:*)。 */
	effects: Record<string, unknown>[];
}

export class DefaultRuntime {
	private readonly stages: ProactiveStages;
	private readonly store: ProactiveStore;
	private readonly rules: ProactiveRules;
	private readonly contextOnlyDailyMax: number;
	private readonly contentLimit: number;
	private readonly clock: Clock;
	private readonly eventBus: EventBus | undefined;
	private readonly profileConfig: ProfileConfig | undefined;
	private readonly memoryDbPath: string | undefined;
	private readonly staticInterests: string | undefined;
	private readonly persona: PersonaConfig | undefined;
	private readonly runtimePorts: ProactiveRuntimePorts | undefined;
	private readonly chatLevity: boolean;
	private readonly chatLevityProbability: number;
	private readonly random: () => number;
	private stepIndex = 0;
	private stepStarted = 0;

	constructor(deps: DefaultRuntimeDeps) {
		this.stages = deps.stages;
		this.store = deps.store;
		this.rules = deps.rules;
		this.contextOnlyDailyMax = deps.contextOnlyDailyMax;
		this.contentLimit = deps.contentLimit ?? 5;
		this.clock = deps.clock ?? SystemClock;
		this.eventBus = deps.eventBus;
		this.profileConfig = deps.profileConfig;
		this.memoryDbPath = deps.memoryDbPath;
		this.staticInterests = deps.staticInterests;
		this.persona = deps.persona;
		this.runtimePorts = deps.runtimePorts;
		this.chatLevity = deps.chatLevity === true;
		this.chatLevityProbability = deps.chatLevityProbability ?? 0.1;
		this.random = deps.random ?? Math.random;
	}

	// ------------------------------------------------------------------
	// Tick 生命周期(模块调用)
	// ------------------------------------------------------------------

	/** 建状态 + 开 tick 日志。 */
	async begin(sessionKey: string): Promise<ProactiveRunState> {
		const startedAt = this.clock.nowMs();
		await this.runtimePorts?.memory?.beforeTurn?.({ sessionKey, now: new Date(startedAt) });
		if (this.eventBus) {
			await this.eventBus.emit(new BeforeTurn(sessionKey, 0, startedAt));
		}
		const tickLogId = this.store.recordTickLog({
			session_key: sessionKey,
			started_at: startedAt,
			finished_at: null,
			base_score: null,
			candidates: 0,
			steps: 0,
			action: "none",
			skip_reason: "",
			error: null,
		});
		this.stepIndex = 0;
		this.stepStarted = startedAt;
		const state: ProactiveRunState = {
			ctx: { sessionKey, now: this.clock.now() },
			startedAt,
			tickLogId,
			finished: false,
			gateVerdict: null,
			gateExit: "",
			senseState: null,
			candidates: [],
			verdict: null,
			proposal: null,
			message: null,
			delivered: false,
			action: "none",
			skipReason: "",
			steps: 0,
			baseScore: null,
			nextIntervalSeconds: null,
			chatLevity: false,
			promptSections: [],
			effects: [],
		};
		this.lastState = state;
		return state;
	}

	/** 记录一个阶段步骤(tick step 回放)。tool 提供结构化工具级审计字段(akashic tick_step_log)。 */
	step(
		state: ProactiveRunState,
		phase: string,
		detail: string,
		actionAfter: string,
		skipReasonAfter: string,
		tool?: {
			name: string;
			callId: string;
			argsJson: string;
			resultText: string;
			interestingIds: number[];
			discardedIds: number[];
			citedIds: number[];
			finalMessage: string | null;
		},
	): void {
		this.store.recordTickStep({
			tick_id: state.tickLogId,
			step_index: this.stepIndex++,
			phase,
			detail,
			action_after: actionAfter,
			skip_reason_after: skipReasonAfter,
			duration_ms: this.clock.nowMs() - this.stepStarted,
			tool_name: tool?.name,
			tool_call_id: tool?.callId,
			tool_args_json: tool?.argsJson,
			tool_result_text: tool?.resultText,
			interesting_ids_after: tool ? JSON.stringify(tool.interestingIds) : "",
			discarded_ids_after: tool ? JSON.stringify(tool.discardedIds) : "",
			cited_ids_after: tool ? JSON.stringify(tool.citedIds) : "",
			final_message_after: tool ? (tool.finalMessage ?? "") : "",
		});
		this.stepStarted = this.clock.nowMs();
	}

	/** 终局:tick 日志收口 + 事件发布。 */
	async finish(
		state: ProactiveRunState,
		patch: Pick<TickLogRecord, "finished_at" | "base_score" | "steps" | "action" | "skip_reason" | "error">,
	): Promise<void> {
		const verdict = state.verdict;
		state.action = patch.action;
		state.skipReason = patch.skip_reason;
		state.steps = patch.steps;
		state.baseScore = patch.base_score;
		// 判题审计字段(akashic tick_log interesting/discarded/cited/drift/final_message/llm_call_count/cache tokens)。
		this.store.finishTickLog(state.tickLogId, {
			...patch,
			interesting_ids: JSON.stringify(verdict?.itemIds ?? []),
			discarded_ids: JSON.stringify(verdict?.discardedItemIds ?? []),
			cited_ids: JSON.stringify(verdict?.citedItemIds ?? []),
			drift_entered: state.action === "drift" ? 1 : 0,
			final_message: state.message ?? "",
			llm_call_count: verdict?.llmCallCount ?? 0,
			llm_cache_read_tokens: verdict?.llmCacheReadTokens ?? 0,
			llm_cache_write_tokens: verdict?.llmCacheWriteTokens ?? 0,
			effects_json: JSON.stringify(state.effects),
		});
		this.store.updateTickLogGateExit(state.tickLogId, state.gateExit || "open");
		if (this.eventBus) {
			await this.eventBus.emit(
				new ProactiveFinished(
					state.tickLogId,
					state.ctx.sessionKey,
					patch.action,
					patch.skip_reason,
					patch.base_score,
					patch.steps,
					state.startedAt,
					patch.finished_at ?? state.startedAt,
				),
			);
		}
	}

	// ------------------------------------------------------------------
	// 阶段(模块调用)
	// ------------------------------------------------------------------

	/**
	 * 插件状态收集(akashic ProactivePluginStateModule.collect_plugin_state):
	 * 从 frame slots 收集 proactive:prompt:system_bottom:* 段与
	 * proactive:effect:* 记录,段进入 judge prompt 底部,effect 进入 tick 审计。
	 */
	collectPluginState(state: ProactiveRunState, slots: Readonly<Record<string, unknown>>): void {
		if (state.finished) return;
		state.promptSections = Object.keys(slots)
			.filter((key) => key.startsWith("proactive:prompt:system_bottom:"))
			.sort()
			.map((key) => String(slots[key] ?? "").trim())
			.filter(Boolean);
		state.effects = Object.entries(slots)
			.filter(([key, value]) => key.startsWith("proactive:effect:") && isRecord(value))
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([, value]) => ({ ...(value as Record<string, unknown>) }));
	}

	/** 1. Gate:准入闸门,blocked 则本轮结束(不判题、不 drift)。 */
	async gate(state: ProactiveRunState): Promise<void> {
		const verdict = this.stages.gate.check(state.ctx.now);
		state.gateVerdict = verdict;
		state.gateExit = verdict.blocked ? verdict.reason : "open";
		if (verdict.blocked) {
			this.step(state, "gate", `准入被拒:${verdict.reason}`, "none", verdict.reason);
			await this.finish(state, {
				finished_at: this.clock.nowMs(),
				base_score: verdict.baseScore,
				steps: 0,
				action: "none",
				skip_reason: verdict.reason,
				error: null,
			});
			state.finished = true;
		}
	}

	/** 2. Sense:感知 + 候选读取。 */
	async sense(state: ProactiveRunState): Promise<void> {
		if (this.stages.fetch.tickDriven) await this.stages.fetch.runOnce?.();
		const senseState = await this.stages.sense.sense();
		state.senseState = senseState;
		state.candidates = this.store.listNew(this.contentLimit);
		// 候选 kind 计数(akashic alert_count/content_count/context_count)。
		let alertCount = 0;
		let contentCount = 0;
		let contextCount = 0;
		for (const candidate of state.candidates) {
			if (candidate.kind === "alert") alertCount++;
			else if (candidate.kind === "context") contextCount++;
			else contentCount++;
		}
		this.store.updateTickLogCounts(state.tickLogId, { alertCount, contentCount, contextCount });
		this.step(
			state,
			"sense",
			`感知完成,候选 ${state.candidates.length} 条`,
			state.candidates.length > 0 ? "judge" : "idle",
			"",
		);
	}

	/**
	 * 3.5 Prepare:判题前并行预取候选正文缓存(akashic prepare_proactive)。
	 * fetch_evidence 直接读缓存,LLM 循环内不再串行抓取。
	 */
	async prepare(state: ProactiveRunState): Promise<void> {
		if (state.finished || state.candidates.length === 0) return;
		await this.stages.prefetch.prefetch(state.candidates);
	}

	/** 3. Route:候选为空 → 闲聊分支(可选)→ 空闲分支(默认 drift);否则判题。 */
	async route(state: ProactiveRunState): Promise<void> {
		if (state.candidates.length > 0) return;
		// 空候选闲聊分支(akashic 空 alert/content 时 get_recent_chat 低概率路径):
		// 仅当 gate 开放 context_only 兜底、开关开启、概率抽签命中且近聊可用时尝试。
		const chatLevityOpen =
			this.chatLevity &&
			state.gateVerdict?.contextAsFallbackOpen === true &&
			this.random() < this.chatLevityProbability &&
			this.runtimePorts?.session?.recentMessages !== undefined;
		if (chatLevityOpen) {
			state.chatLevity = true;
			const verdict = await this.stages.judge.judge([], await this.buildContext(state));
			state.verdict = verdict;
			if (verdict.action !== "skip" && verdict.draftMessage) {
				// resolve 复用:context_only 计数 + 草稿归一化;commit 负责投递。
				await this.resolve(state);
				await this.commit(state);
				if (state.finished) return;
			}
		}
		// 三路皆空 → 空闲策略(默认交给 drift)。
		const handled = await this.stages.idle.run(await this.buildContext(state));
		this.step(
			state,
			"idle",
			handled ? "进入 drift 空闲任务" : "无候选且未进入空闲任务",
			handled ? "drift" : "none",
			handled ? "" : "no_candidates",
		);
		if (handled) {
			// drift 也消耗 anyaction 配额(akashic runtime.drift record_action)。
			this.stages.gate.recordAction?.(state.ctx.now);
		}
		await this.finish(state, {
			finished_at: this.clock.nowMs(),
			base_score: handled ? 0 : (state.senseState?.baseScore ?? null),
			steps: 0,
			action: handled ? "drift" : "none",
			skip_reason: handled ? "" : "no_candidates",
			error: null,
		});
		state.finished = true;
	}

	/** 4. Judge:LLM 判题(证据优先)。 */
	async judge(state: ProactiveRunState): Promise<void> {
		const verdict = await this.stages.judge.judge(state.candidates, await this.buildContext(state));
		state.verdict = verdict;
		this.step(
			state,
			"judge",
			`判题完成:${verdict.action}${verdict.skipReason ? ` (${verdict.skipReason})` : ""}`,
			verdict.action,
			verdict.skipReason,
		);
	}

	/** 5. Resolve:证据 → 推送消息;judge 草稿优先;context_only 兜底分支在此收口。 */
	async resolve(state: ProactiveRunState): Promise<void> {
		const verdict = state.verdict;
		if (!verdict) return;
		state.proposal = createProactiveProposal({
			action: verdict.action,
			evidence: verdict.evidence,
			itemIds: verdict.itemIds,
			reason: verdict.skipReason,
		});
		// context_only 兜底计数(akashic context_only_timestamps;chat-levity 也计入)。
		if (verdict.action === "context_only") {
			const count = this.store.countContextOnlyInWindow(24, this.clock.nowMs());
			this.store.markContextOnlySend(state.ctx.sessionKey, this.clock.nowMs());
			this.step(
				state,
				"context_only",
				`近 24h 已 ${count + 1} 次(上限 ${this.contextOnlyDailyMax})`,
				"context_only",
				"",
			);
		}
		// judge 内 message_push 暂存的草稿优先(akashic message_push;chat-levity 依赖此路径)。
		if (verdict.draftMessage && (verdict.action === "send" || verdict.action === "context_only")) {
			const message = normalizeOutboundText(verdict.draftMessage).trim();
			state.message = message;
			state.proposal = createProactiveProposal({
				action: "send",
				message,
				evidence: verdict.evidence,
				itemIds: verdict.itemIds,
				sourceRefs: this.sourceRefsForEvidence(verdict.evidence),
				reason: message ? "judge_draft" : "resolve_empty",
			});
			this.step(state, "resolve", message ? `使用判题草稿(${message.length} 字)` : "草稿为空", "deliver", "");
			return;
		}
		if (verdict.action === "send" && verdict.evidence.length > 0) {
			const message = await this.stages.resolve.resolve(verdict.evidence, await this.buildContext(state));
			state.message = message;
			state.proposal = createProactiveProposal({
				action: "send",
				message,
				evidence: verdict.evidence,
				itemIds: verdict.itemIds,
				sourceRefs: this.sourceRefsForEvidence(verdict.evidence),
				reason: message ? "default_judge" : "resolve_empty",
			});
			this.step(state, "resolve", message ? `生成消息(${message.length} 字)` : "未生成消息", "deliver", "");
		}
	}

	/** 6. Commit:投递 + tick 日志收口。 */
	async commit(state: ProactiveRunState): Promise<void> {
		const verdict = state.verdict;
		if (!verdict || state.message === null) {
			// skip / context_only / 未生成消息:直接收口。
			await this.finish(state, {
				finished_at: this.clock.nowMs(),
				base_score: state.senseState?.baseScore ?? null,
				steps: verdict?.stepsTaken ?? 0,
				action: verdict?.action ?? "skip",
				skip_reason: verdict?.skipReason ?? "",
				error: null,
			});
			state.finished = true;
			return;
		}
		const proposal = state.proposal;
		if (!proposal || proposal.action !== "send" || proposal.message === null) {
			await this.finish(state, {
				finished_at: this.clock.nowMs(),
				base_score: state.senseState?.baseScore ?? null,
				steps: verdict.stepsTaken,
				action: verdict.action,
				skip_reason: proposal?.reason ?? verdict.skipReason,
				error: null,
			});
			state.finished = true;
			return;
		}
		const result = await this.stages.deliver.deliver(
			{
				message: proposal.message,
				evidence: [...proposal.evidence],
				itemIds: proposal.itemIds.filter((itemId): itemId is number => typeof itemId === "number"),
				proposal,
			},
			await this.buildContext(state),
		);
		state.delivered = result.delivered;
		this.step(
			state,
			"deliver",
			result.delivered ? "投递成功" : "投递被去重或拒绝",
			"send",
			result.delivered ? "" : "dedup",
		);
		if (result.delivered) {
			if (this.eventBus) {
				await this.eventBus.emit(
					new Delivered(state.ctx.sessionKey, state.message, verdict.itemIds, this.clock.nowMs()),
				);
			}
			this.stages.sense.recordProactiveSent?.(this.clock.nowMs());
			// 投递成功也消耗 anyaction 配额(akashic runtime.judge record_action)。
			this.stages.gate.recordAction?.(state.ctx.now);
		}
		await this.finish(state, {
			finished_at: this.clock.nowMs(),
			base_score: state.senseState?.baseScore ?? null,
			steps: verdict.stepsTaken,
			action: verdict.action,
			skip_reason: verdict.skipReason,
			error: null,
		});
		state.finished = true;
	}

	/** 7. Schedule:下次 tick 间隔(用终局 base_score,与 loop 语义一致)。 */
	schedule(state: ProactiveRunState): number | null {
		if (state.nextIntervalSeconds !== null) return state.nextIntervalSeconds;
		const senseState = state.senseState;
		if (!senseState) return null;
		state.nextIntervalSeconds = this.stages.schedule.nextInterval({
			...senseState,
			baseScore: state.baseScore ?? senseState.baseScore,
		});
		return state.nextIntervalSeconds;
	}

	/** tick 异常收口(engine 调用)。 */
	async abortError(error: unknown): Promise<void> {
		const message = error instanceof Error ? error.message : String(error);
		this.store.setState("lastError.tick", message);
		const lastState = this.lastState;
		if (!lastState) return;
		this.step(lastState, "error", message, "error", "");
		await this.finish(lastState, {
			finished_at: this.clock.nowMs(),
			base_score: null,
			steps: 0,
			action: "error",
			skip_reason: "",
			error: message,
		});
	}

	lastState: ProactiveRunState | null = null;

	private sourceRefsForEvidence(evidence: readonly ProactiveEvidence[]): Record<string, unknown>[] {
		return evidence.map((itemEvidence) => {
			const item = this.store.getItem(itemEvidence.itemId);
			const ref: Record<string, unknown> = {
				id: itemEvidence.itemId,
				source: item?.source ?? itemEvidence.source,
				title: item?.title ?? itemEvidence.title,
				url: item?.url ?? itemEvidence.url,
			};
			if (item?.sub_source) ref.sub_source = item.sub_source;
			if (item?.source_event_id && item.ack_source_id) {
				ref.event_id = item.source_event_id;
				ref.ack_source_id = item.ack_source_id;
			}
			return ref;
		});
	}

	// ------------------------------------------------------------------
	// Context
	// ------------------------------------------------------------------

	async buildContext(state: ProactiveRunState): Promise<TurnContext> {
		const rulesPanel = this.rules.read();
		const profile = this.profileConfig
			? await maybeRefreshProfile({ ...this.profileConfig, clock: this.clock })
			: undefined;
		const profileInterests = profile?.interests;
		const hostPreferenceBlock = this.runtimePorts?.memory?.preferenceBlock
			? await this.runtimePorts.memory.preferenceBlock({ sessionKey: state.ctx.sessionKey, now: state.ctx.now })
			: undefined;
		const recalled =
			hostPreferenceBlock === undefined && this.memoryDbPath ? recallPreferences(this.memoryDbPath) : [];
		const preferenceBlock = [
			renderPersonaBlock(this.persona),
			profileInterests ? `## 用户兴趣画像\n${profileInterests}` : "",
			hostPreferenceBlock ?? formatPreferenceBlock(recalled),
			this.staticInterests ? `## 用户兴趣\n${this.staticInterests}` : "",
		]
			.filter(Boolean)
			.join("\n\n");
		return {
			sessionKey: state.ctx.sessionKey,
			now: state.ctx.now,
			rulesPanel,
			preferenceBlock,
			contextAsFallbackOpen: state.gateVerdict?.contextAsFallbackOpen ?? false,
			chatLevity: state.chatLevity,
			promptSections: state.promptSections,
			store: this.store,
			// 判题工具级审计(akashic record_tick_step_log):以 judge.tool 相位记入 tick_steps。
			recordToolStep: (step) =>
				this.step(
					state,
					"judge.tool",
					`${step.toolName} ${step.toolArgs} → ${step.resultText}`,
					step.actionAfter,
					step.skipReasonAfter,
					{
						name: step.toolName,
						callId: step.toolCallId ?? "",
						argsJson: step.toolArgs,
						resultText: step.resultText,
						interestingIds: step.interestingIds ?? [],
						discardedIds: step.discardedIds ?? [],
						citedIds: step.citedIds ?? [],
						finalMessage: step.finalMessage ?? null,
					},
				),
		};
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
