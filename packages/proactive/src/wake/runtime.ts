/**
 * Wake 运行时(akashic plugins/wake_proactive/runtime.py port)。
 *
 * 每 300s 一个 tick:ingest(三类通道入蓄水池)→ 决策链:
 *   alerts(强制发送)→ context 重评估 → 内容 hazard 抽签(命中则
 *   scratchpad → investigate → share/skip)→ 否则 drift 一次性定时器。
 */

import type { DriftDriveResult } from "@cogito/gate";
import { SystemClock } from "../clock.ts";
import { type DriftGateWriter, WAKE_DRIFT_GATE_TTL_HOURS } from "../drift-gate.ts";
import { createProactiveProposal, type ProactiveProposal } from "../proposal.ts";
import type { MaybePromise } from "../runtime/ports.ts";
import type { TickScheduler } from "../stages/schedule.ts";
import { EVENT_TOOL_SCHEMAS, executeEventTool } from "./event-tools.ts";
import { advanceHazard, type HazardResult, rankEvents, WAKE_ADMISSION_FLOOR } from "./hazard.ts";
import { runWakeTurn } from "./loop-adapter.ts";
import { buildMessages } from "./prompt.ts";
import type { WakeStateStore } from "./state.ts";
import { executeWakeTool, TOOL_SCHEMAS, type WakeToolDeps } from "./tools.ts";
import { newWakeContext, type WakeContext, type WakeEvent } from "./types.ts";

const MAX_TITLES_PER_WAKE = 100;
const SEMANTIC_CALIBRATION_POWER = 4;
const CONTENT_MIN_RESIDENCE_MS = 24 * 3600_000;

export interface ChatToolCall {
	name: string;
	arguments: Record<string, unknown>;
}

export interface WakeChannelBatch {
	alert: WakeEvent[];
	content: WakeEvent[];
	context: WakeEvent[];
	/** Commit source cursors after the batch has been persisted. */
	commit?: () => void;
}

export interface WakeRuntimeDeps {
	sessionKey: string;
	stateStore: WakeStateStore;
	/** 拉取三类通道。 */
	fetchChannels(): Promise<WakeChannelBatch>;
	/** 可选:向来源确认消费。 */
	acknowledge?(sourceId: string, eventIds: string[]): Promise<void>;
	/** LLM chat(工具调用已解析)。 */
	chat(
		messages: Array<{ role: string; content: string }>,
		tools: Array<{
			type: "function";
			function: { name: string; description: string; parameters: Record<string, unknown> };
		}>,
		toolChoice: "required" | "auto" | { type: "function"; function: { name: string } },
	): Promise<{ content: string | null; toolCalls: ChatToolCall[] }>;
	model: string;
	maxTokens: number;
	/** 用户偏好记忆 db 路径(可选)。 */
	memoryDbPath?: string;
	/** 最近用户消息时间戳(ms)。 */
	lastUserAt(): number | null;
	/** 最近被动对话文本。 */
	recentPassiveConversation(now: Date): MaybePromise<string>;
	/** 最近已发送主动消息文本(7 天窗口)。 */
	recentProactiveMessages(now: Date): MaybePromise<string>;
	/** PROACTIVE_CONTEXT.md 内容。 */
	readRules(): string;
	/** 长期记忆文本。 */
	readMemory(now?: Date): MaybePromise<string>;
	/** Host memory consolidation hook before a wake turn begins. */
	beforeTurn?(input: { sessionKey: string; now: Date }): MaybePromise<void>;
	/** 三进程模式:写 drift_gate 许可,由 drift daemon 调度执行。 */
	driftGate?: DriftGateWriter;
	/** 三进程模式:写「允许」许可的 TTL(小时);默认 WAKE_DRIFT_GATE_TTL_HOURS。 */
	driftGateTtlHours?: number;
	/** 投递。返回是否成功。 */
	deliver(message: string, sourceRefs: Array<Record<string, unknown>>): Promise<boolean>;
	/** Shared proposal delivery boundary. Legacy deliver remains the test/host adapter. */
	deliverProposal?(proposal: ProactiveProposal): Promise<boolean>;
	/** 可选嵌入 API(语义兴趣;缺省跳过)。 */
	embeddingApi?: { embedBatch(texts: string[]): Promise<number[][]>; modelId?: string };
	/** 可选:最近会话的 user→assistant 消息对(原型向量来源;akashic MessageEmbeddingStore 的 pi 形态)。 */
	turnPairs?: (now: Date) => MaybePromise<readonly { user: string; assistant: string }[]>;
	/** 可选:会话变更签名(原型向量缓存失效用)。 */
	sessionSignature?: () => MaybePromise<string>;
	/** 可选 web 抓取。 */
	webFetchFn?(url: string, maxChars: number): Promise<{ text?: string; error?: string; truncated?: boolean }>;
	rng?: () => number;
	/** Optional deterministic wake id for replay. */
	wakeIdFn?: () => string;
	tickIntervalSeconds?: number;
	/** 可选:energy 自适应调度器(akashic energy.py)。缺省用固定 tickIntervalSeconds。 */
	tickScheduler?: TickScheduler;
	/** 可注入时钟(akashic Clock;测试用固定时间)。 */
	nowFn?: () => Date;
}

export interface WakeTickResult {
	nextIntervalSeconds: number;
	baseScore: number;
}

export class WakeRuntime {
	private readonly deps: WakeRuntimeDeps;
	private readonly rng: () => number;
	private readonly tickIntervalSeconds: number;
	private readonly tickScheduler: TickScheduler | undefined;
	private readonly nowFn: () => Date;
	private readonly toolDeps: WakeToolDeps;
	private readonly schemaByName: Map<string, (typeof TOOL_SCHEMAS)[number]>;
	private readonly eventSchemaByName: Map<string, (typeof EVENT_TOOL_SCHEMAS)[number]>;
	private lastWakeAt: Date | null = null;
	private lastState: WakeRunState | null = null;

	constructor(deps: WakeRuntimeDeps) {
		this.deps = deps;
		this.rng = deps.rng ?? Math.random;
		this.tickIntervalSeconds = deps.tickIntervalSeconds ?? 300;
		this.tickScheduler = deps.tickScheduler;
		this.nowFn = deps.nowFn ?? SystemClock.now;
		this.toolDeps = {
			webFetchFn: deps.webFetchFn,
			memoryDbPath: deps.memoryDbPath,
			embeddingFn: deps.embeddingApi ? (texts) => deps.embeddingApi!.embedBatch(texts) : undefined,
			maxChars: 8000,
			maxConcurrency: 6,
			stateStore: deps.stateStore,
		};
		this.schemaByName = new Map(TOOL_SCHEMAS.map((schema) => [schema.function.name, schema]));
		this.eventSchemaByName = new Map(EVENT_TOOL_SCHEMAS.map((schema) => [schema.function.name, schema]));
	}

	/**
	 * 无 alert/内容时的下次 tick 间隔:有 energy 调度器且存在 presence 时按
	 * 电量衰减自适应(刚聊完→长间隔;长期无互动→短间隔);否则固定间隔。
	 */
	private scheduleNextInterval(): number {
		const scheduler = this.tickScheduler;
		if (!scheduler) return this.tickIntervalSeconds;
		return scheduler.nextInterval(null, this.deps.lastUserAt());
	}

	/** 执行一次 wake tick,返回下次间隔与 base_score。 */
	async runTick(): Promise<WakeTickResult> {
		const state = this.begin();
		try {
			await this.deps.beforeTurn?.({ sessionKey: state.ctx.sessionKey, now: state.ctx.nowUtc });
			await this.ingest(state);
			const contentCompleted = await this.decideContent(state);
			if (!contentCompleted) await this.decideDrift(state);
			const result = { nextIntervalSeconds: state.nextIntervalSeconds, baseScore: state.baseScore };
			this.finish(state, result);
			return result;
		} catch (error) {
			this.abortError(error);
			throw error;
		}
	}

	close(): void {
		this.deps.stateStore.close();
	}

	// ------------------------------------------------------------------
	// Tick 状态
	// ------------------------------------------------------------------

	/** 建一次 tick 的状态(生命周期 start 模块调用)。 */
	begin(): WakeRunState {
		const ctx = newWakeContext(this.deps.sessionKey, this.nowFn(), this.deps.wakeIdFn?.());
		this.deps.stateStore.recordTickStart({ wakeId: ctx.wakeId, sessionKey: ctx.sessionKey, startedAt: ctx.nowUtc });
		const state: WakeRunState = {
			ctx,
			alerts: [],
			contents: [],
			baseScore: 0,
			nextIntervalSeconds: this.tickIntervalSeconds,
			hazardResult: null,
			contextResults: null,
			contextReevaluate: false,
			contextEvent: null,
			driftResult: null,
			contentCompleted: false,
			newAlertCount: 0,
			newContentCount: 0,
			newContentIds: null,
			unreadContentMass: 0,
			unreadContentCount: 0,
			tickCompleted: false,
		};
		this.lastState = state;
		return state;
	}

	/** Mark a lifecycle tick successful after its schedule phase commits. */
	finish(state: WakeRunState, result: WakeTickResult): void {
		if (state.tickCompleted) return;
		this.deps.stateStore.finishTick({
			wakeId: state.ctx.wakeId,
			finishedAt: this.nowFn(),
			status: "success",
			baseScore: result.baseScore,
			nextIntervalSeconds: result.nextIntervalSeconds,
		});
		state.tickCompleted = true;
	}

	/** Persist an incomplete lifecycle tick before the loop backs off and retries. */
	abortError(error: unknown): void {
		const state = this.lastState;
		if (!state || state.tickCompleted) return;
		this.deps.stateStore.finishTick({
			wakeId: state.ctx.wakeId,
			finishedAt: this.nowFn(),
			status: "error",
			baseScore: state.baseScore,
			nextIntervalSeconds: state.nextIntervalSeconds,
			error: formatError(error),
		});
		state.tickCompleted = true;
	}

	// ------------------------------------------------------------------
	// Ingest
	// ------------------------------------------------------------------

	/** 拉取通道事件并入蓄水池(生命周期 ingest 模块调用)。 */
	async ingest(state: WakeRunState): Promise<void> {
		await this.flushPendingAcks();
		const channels = await this.deps.fetchChannels();
		state.newAlertCount = this.deps.stateStore.ingest("alert", channels.alert, state.ctx.nowUtc);
		const newContentIds = this.deps.stateStore.ingestWithIds("content", channels.content, state.ctx.nowUtc);
		state.newContentIds = new Set(newContentIds);
		state.newContentCount = newContentIds.length;
		state.contextResults = this.deps.stateStore.ingestContext(channels.context, state.ctx.nowUtc);
		state.contextEvent =
			channels.context.find((_snapshot, index) => state.contextResults?.[index]?.signal === "reevaluate") ?? null;
		state.contextReevaluate =
			state.contextEvent !== null ? this.deps.stateStore.claimContextReevaluation(state.ctx.nowUtc) : false;
		state.alerts = this.deps.stateStore.unread("alert");
		state.unreadContentMass = this.deps.stateStore.unreadAggregateMass("content", state.ctx.nowUtc);
		channels.commit?.();
		await this.flushPendingAcks();

		// Alert 不依赖内容向量;普通轮次再刷新内容兴趣。
		if (state.alerts.length > 0) return;
		await this.cacheEventEmbeddings();
		state.contents = this.deps.stateStore.unread("content", MAX_TITLES_PER_WAKE);
		state.unreadContentCount = this.deps.stateStore.unreadCount("content");
		await this.applySemanticInterest(state.contents, state.ctx.nowUtc);
	}

	private async flushPendingAcks(): Promise<void> {
		if (!this.deps.acknowledge) return;
		const grouped = this.deps.stateStore.pendingAcknowledgements();
		for (const [sourceId, eventIds] of Object.entries(grouped)) {
			try {
				await this.deps.acknowledge(sourceId, eventIds);
			} catch (error) {
				console.error(`proactive wake acknowledgement failed source=${sourceId}: ${formatError(error)}`);
				continue;
			}
			this.deps.stateStore.markAcknowledged(sourceId, eventIds);
		}
	}

	// ------------------------------------------------------------------
	// 决策链
	// ------------------------------------------------------------------

	/** 内容决策:hazard 抽签 + LLM 判别(生命周期 content.decide 模块调用)。返回是否完成内容分支。 */
	async decideContent(state: WakeRunState): Promise<boolean> {
		const now = state.ctx.nowUtc;
		if (state.alerts.length > 0) {
			await this.decideEvent(state, "alert", state.alerts[0]!);
			state.nextIntervalSeconds = state.alerts.length > 1 ? 1 : this.scheduleNextInterval();
			return true;
		}
		if (state.contextReevaluate && state.contextEvent !== null) {
			await this.decideEvent(state, "context", state.contextEvent);
			state.nextIntervalSeconds = this.scheduleNextInterval();
			return true;
		}

		// 过期清理:超龄内容在跌破衰减线后淘汰。
		const expiryRows = this.deps.stateStore.expiryCandidates(
			"content",
			new Date(now.getTime() - CONTENT_MIN_RESIDENCE_MS),
		);
		const expiryEvents = expiryRows.map((row) => ({
			id: String(row.item_id),
			_reservoir_original_source_id: row.original_source_id,
			_reservoir_ack_source_id: row.ack_source_id,
			_reservoir_source_event_id: row.source_event_id,
			published_at: row.published_at,
			first_seen_at: row.first_seen_at,
			preprocess_score: row.preprocess_score,
		}));
		const expiredIds = new Set(
			rankEvents(expiryEvents as unknown as Array<Record<string, unknown>>, now)
				.filter((event) => this.contentExpired(event as unknown as WakeEvent, now))
				.map((event) => String(event.id)),
		);
		if (expiredIds.size > 0) {
			this.deps.stateStore.queueExpiration([...expiredIds], now);
			await this.flushPendingAcks();
			state.contents = state.contents.filter((event) => !expiredIds.has(String(event.id)));
			state.unreadContentCount = this.deps.stateStore.unreadCount("content");
		}
		const newContentIds = new Set(
			[...(state.newContentIds ?? new Set<string>())].filter((id) => !expiredIds.has(id)),
		);
		const shouldEvaluate = state.contents.length > 0 && newContentIds.size > 0;
		if (!shouldEvaluate) return false;

		const hazardState = this.deps.stateStore.loadHazard(state.ctx.sessionKey);
		const lastWakeAt = parseOptionalTime(hazardState ? (hazardState.last_wake_at as string | null) : null);
		const result = advanceHazard(state.contents as unknown as Array<Record<string, unknown>>, {
			now,
			newItemIds: newContentIds,
			randomDraw: this.contentDraw(),
			lastWakeAt: lastWakeAt ?? this.lastWakeAt,
			poolMass: state.unreadContentMass,
		});
		state.hazardResult = result;
		state.baseScore = result.rate;
		this.deps.stateStore.saveHazardMonitor({
			sessionKey: state.ctx.sessionKey,
			hazard: result,
			candidateCount: state.contents.length,
			evaluatedAt: now,
		});
		if (result.shouldWake) {
			state.ctx.contentEvents = selectContentPage(state.contents, now);
			state.ctx.contentBacklogCount = state.unreadContentCount - state.ctx.contentEvents.length;
			await this.recordContentObservation(state.ctx, result);
			await this.runContentTools(state.ctx);
			const completed = await this.commitContentDecision(state);
			this.deps.stateStore.saveHazard({
				sessionKey: state.ctx.sessionKey,
				hazard: result.hazardAfter,
				threshold: result.threshold,
				updatedAt: now,
				lastWakeAt: completed ? now : (lastWakeAt ?? this.lastWakeAt),
			});
			if (completed) this.lastWakeAt = now;
			state.nextIntervalSeconds = this.scheduleNextInterval();
			return true;
		}
		this.deps.stateStore.saveHazard({
			sessionKey: state.ctx.sessionKey,
			hazard: result.hazardAfter,
			threshold: result.threshold,
			updatedAt: now,
			lastWakeAt: lastWakeAt ?? this.lastWakeAt,
		});
		return false;
	}

	private contentExpired(event: WakeEvent, now: Date): boolean {
		const firstSeenAt = parseOptionalTime(String(event.first_seen_at ?? ""));
		if (firstSeenAt === null) throw new Error("wake content missing first_seen_at");
		if (now.getTime() - firstSeenAt.getTime() < CONTENT_MIN_RESIDENCE_MS) return false;
		const features = (event as unknown as Record<string, unknown>)._wake_rank_features as Record<string, number>;
		return Number(features?.admission_mass ?? 0) < WAKE_ADMISSION_FLOOR;
	}

	private contentDraw(): number {
		return this.rng();
	}

	private async recordContentObservation(ctx: WakeContext, hazard: HazardResult): Promise<void> {
		const messages = buildMessages({
			ctx,
			memoryText: await this.deps.readMemory(),
			proactiveContext: this.deps.readRules(),
			recentPassiveConversation: await this.deps.recentPassiveConversation(ctx.nowUtc),
			recentProactiveMessages: await this.deps.recentProactiveMessages(ctx.nowUtc),
			currentContext: this.currentContextText(ctx.nowUtc),
		});
		const candidates = ctx.contentEvents.map((event) =>
			Object.fromEntries(
				[
					"id",
					"source_id",
					"source_name",
					"title",
					"url",
					"published_at",
					"first_seen_at",
					"preprocess_score",
					"_wake_interest_score",
					"_wake_semantic_interest",
					"_wake_rank_score",
					"_wake_rank_features",
				].map((key) => [key, event[key]]),
			),
		);
		this.deps.stateStore.recordObservation({
			wakeId: ctx.wakeId,
			sessionKey: ctx.sessionKey,
			kind: "content",
			now: ctx.nowUtc,
			trigger: hazardTrace(hazard),
			candidates,
			llmInput: messages,
		});
	}

	// ------------------------------------------------------------------
	// 内容工具链
	// ------------------------------------------------------------------

	private async runContentTools(ctx: WakeContext): Promise<void> {
		const memoryText = await this.deps.readMemory();
		const proactiveContext = this.deps.readRules();
		const recentPassiveConversation = await this.deps.recentPassiveConversation(ctx.nowUtc);
		const recentProactiveMessages = await this.deps.recentProactiveMessages(ctx.nowUtc);
		const currentContext = this.currentContextText(ctx.nowUtc);
		const baseMessages = buildMessages({
			ctx,
			memoryText,
			proactiveContext,
			recentPassiveConversation,
			recentProactiveMessages,
			currentContext,
		});

		await this.runPhase(baseMessages, ctx, new Set(["scratchpad"]), "scratchpad");
		const investigation = await executeWakeTool("investigate_candidates", {}, ctx, this.toolDeps);
		const finalBaseMessages = buildMessages({
			ctx,
			memoryText,
			proactiveContext,
			recentPassiveConversation,
			recentProactiveMessages,
			currentContext,
			contentPhase: "final",
		});
		const finalMessages = [
			finalBaseMessages[0]!,
			finalBaseMessages[1]!,
			{ role: "user", content: `【已执行的初筛与并发调查结果】\n${investigation}` },
			finalBaseMessages[2]!,
		];
		await this.runPhase(finalMessages, ctx, new Set(["share_content", "skip_content"]), null);
		if (ctx.terminalAction === null) {
			throw new Error("wake proactive LLM did not finish content decision");
		}
	}

	private async runPhase(
		messages: Array<{ role: string; content: string }>,
		ctx: WakeContext,
		allowed: Set<string>,
		forcedName: string | null,
	): Promise<void> {
		const call = await this.callTool(messages, allowed, forcedName);
		await executeWakeTool(call.name, call.arguments, ctx, this.toolDeps);
	}

	private async callTool(
		messages: Array<{ role: string; content: string }>,
		allowed: Set<string>,
		forcedName: string | null,
	): Promise<ChatToolCall> {
		const schemas = [...allowed]
			.sort()
			.map((name) => this.schemaByName.get(name))
			.filter((schema): schema is (typeof TOOL_SCHEMAS)[number] => schema !== undefined);
		const toolChoice: "required" | { type: "function"; function: { name: string } } =
			forcedName !== null ? { type: "function", function: { name: forcedName } } : "required";
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				const response = await runWakeTurn({
					chat: this.deps.chat,
					schemas,
					toolChoice,
					messages,
				});
				if (!response.toolCalls || response.toolCalls.length === 0) {
					throw new Error("wake proactive phase requires one tool call");
				}
				const call = response.toolCalls[0]!;
				if (!allowed.has(call.name)) {
					throw new Error(`wake proactive unexpected tool in phase: ${call.name}`);
				}
				return call;
			} catch (error) {
				if (attempt === 1) throw error;
			}
		}
		throw new Error("wake proactive callTool unreachable");
	}

	private async commitContentDecision(state: WakeRunState): Promise<boolean> {
		if (state.ctx.terminalAction === "skip") return true;

		const selectedIds = new Set(state.ctx.citedItemIds);
		const selectedEvents = state.contents.filter((event) => selectedIds.has(String(event.id ?? "")));
		if (selectedEvents.length !== selectedIds.size) {
			throw new Error("wake proactive cited content does not match canonical candidates");
		}
		const proposal = createProactiveProposal({
			action: "send",
			message: state.ctx.finalMessage,
			itemIds: [...selectedIds],
			sourceRefs: state.ctx.sourceRefs,
			reason: "wake_content",
		});
		const delivered = await this.deliverProposal(proposal);
		// Content stays unread when the external channel did not fully accept the
		// message. Consumption and source ACK are success side effects only.
		if (delivered) await this.consumeEvents(selectedEvents, state.ctx.nowUtc);
		return delivered;
	}

	private async consumeEvents(events: WakeEvent[], now: Date): Promise<void> {
		const grouped: Record<string, string[]> = {};
		for (const event of events) {
			const sourceId = String(event._reservoir_ack_source_id ?? "");
			const sourceEventId = String(event._reservoir_source_event_id ?? "");
			if (sourceId && sourceEventId) {
				if (!grouped[sourceId]) grouped[sourceId] = [];
				grouped[sourceId]!.push(sourceEventId);
			}
		}
		this.deps.stateStore.consumeAndQueueAck({
			itemIds: events.map((event) => String(event.id ?? "")),
			acknowledgements: grouped,
			now,
		});
		await this.flushPendingAcks();
	}

	// ------------------------------------------------------------------
	// 单事件决策(alert / context)
	// ------------------------------------------------------------------

	private async decideEvent(state: WakeRunState, kind: "alert" | "context", event: WakeEvent): Promise<void> {
		const messages = await this.buildEventMessages(state, kind, event);
		const itemId = String(event.id ?? event.eventId ?? "");
		this.deps.stateStore.recordObservation({
			wakeId: state.ctx.wakeId,
			sessionKey: state.ctx.sessionKey,
			kind,
			now: state.ctx.nowUtc,
			trigger: { event_id: itemId, source: eventSource(event) },
			candidates: [event],
			llmInput: messages,
		});

		const allowed = kind === "alert" ? new Set(["send_event"]) : new Set(["send_event", "skip_event"]);
		const call = await this.callEventTool(messages, allowed, kind === "alert" ? "send_event" : null);
		const decision = executeEventTool(call.name, call.arguments);
		await this.commitEventDecision(state, kind, event, itemId, decision);
	}

	private async buildEventMessages(
		state: WakeRunState,
		kind: "alert" | "context",
		event: WakeEvent,
	): Promise<Array<{ role: string; content: string }>> {
		return buildMessages({
			ctx: state.ctx,
			memoryText: await this.deps.readMemory(),
			proactiveContext: this.deps.readRules(),
			recentPassiveConversation: await this.deps.recentPassiveConversation(state.ctx.nowUtc),
			recentProactiveMessages: await this.deps.recentProactiveMessages(state.ctx.nowUtc),
			currentContext: this.currentContextText(state.ctx.nowUtc),
			mode: kind,
			event,
		});
	}

	private async callEventTool(
		messages: Array<{ role: string; content: string }>,
		allowed: Set<string>,
		forcedName: string | null,
	): Promise<ChatToolCall> {
		const schemas = [...allowed]
			.sort()
			.map((name) => this.eventSchemaByName.get(name))
			.filter((schema): schema is (typeof EVENT_TOOL_SCHEMAS)[number] => schema !== undefined);
		const toolChoice: "auto" | { type: "function"; function: { name: string } } =
			forcedName !== null ? { type: "function", function: { name: forcedName } } : "auto";
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				const response = await runWakeTurn({
					chat: this.deps.chat,
					schemas,
					toolChoice,
					messages,
				});
				if (!response.toolCalls || response.toolCalls.length === 0) {
					throw new Error("wake proactive event phase requires one tool call");
				}
				const call = response.toolCalls[0]!;
				if (!allowed.has(call.name)) throw new Error(`wake proactive unexpected tool in phase: ${call.name}`);
				return call;
			} catch (error) {
				if (attempt === 1) throw error;
			}
		}
		throw new Error("wake proactive callEventTool unreachable");
	}

	private async commitEventDecision(
		state: WakeRunState,
		kind: "alert" | "context",
		event: WakeEvent,
		itemId: string,
		decision: { decision: "reply" | "skip"; message: string },
	): Promise<void> {
		state.ctx.terminalAction = decision.decision;
		state.ctx.finalMessage = decision.message;
		state.ctx.citedItemIds = kind === "alert" && itemId ? [itemId] : [];
		this.deps.stateStore.save(state.ctx);

		if (decision.decision === "reply") {
			const proposal = createProactiveProposal({
				action: "send",
				message: decision.message,
				itemIds: kind === "alert" ? [itemId] : [],
				sourceRefs: kind === "alert" ? [eventSourceRef(event)] : [],
				reason: `wake_${kind}`,
			});
			const delivered = await this.deliverProposal(proposal);
			// 只在发送成功后消费 alert(akashic success_side_effects);失败保留,下次重试。
			if (delivered && kind === "alert") {
				await this.consumeEvents([event], state.ctx.nowUtc);
			}
		} else if (kind === "alert") {
			// skip 也消费(akashic side_effects:决策已定,事件出蓄水池)。
			await this.consumeEvents([event], state.ctx.nowUtc);
		}
	}

	private async deliverProposal(proposal: ProactiveProposal): Promise<boolean> {
		if (this.deps.deliverProposal) return await this.deps.deliverProposal(proposal);
		if (proposal.message === null) return false;
		// Keep the legacy adapter's alert contract stable; the production adapter
		// uses deliverProposal and persists the typed source references.
		const sourceRefs = proposal.reason === "wake_alert" ? [] : [...proposal.sourceRefs];
		return await this.deps.deliver(proposal.message, sourceRefs);
	}

	// ------------------------------------------------------------------
	// Drift 决策
	// ------------------------------------------------------------------

	/** drift 分支:无内容触发时按 drift drive 调度(生命周期 drift.decide 模块调用)。 */
	async decideDrift(state: WakeRunState): Promise<void> {
		state.nextIntervalSeconds = this.scheduleNextInterval();
		// 三进程模式:写「允许」许可(wake 安静),drift daemon 自行调度执行。
		if (this.deps.driftGate) {
			const prefetchedContext = this.currentContextText(state.ctx.nowUtc);
			const hasContext = prefetchedContext !== "没有有效 ContextEvent";
			await this.deps.driftGate({
				sessionKey: state.ctx.sessionKey,
				verdict: "allowed",
				reason: "wake_idle",
				context: hasContext ? prefetchedContext : undefined,
				grantedAt: state.ctx.nowUtc,
				ttlHours: this.deps.driftGateTtlHours ?? WAKE_DRIFT_GATE_TTL_HOURS,
			});
			// 门控观察(wake_observations kind=drift):tick 日志可解释 drift 许可。
			// 实际调度(anchor 采样/delay 反演)在 drift daemon,数学与 akashic
			// wake _decide_drift/_schedule_drift_attempt 等价(@cogito/gate drive.ts)。
			this.deps.stateStore.recordObservation({
				wakeId: state.ctx.wakeId,
				sessionKey: state.ctx.sessionKey,
				kind: "drift",
				now: state.ctx.nowUtc,
				trigger: {
					verdict: "allowed",
					reason: "wake_idle",
					ttl_hours: this.deps.driftGateTtlHours ?? WAKE_DRIFT_GATE_TTL_HOURS,
					context_prefetched: hasContext,
				},
				candidates: [],
				llmInput: [],
			});
			return;
		}
	}

	/** 批量嵌入未嵌入事件(akashic _cache_event_embeddings)。 */
	private async cacheEventEmbeddings(): Promise<void> {
		const embeddingApi = this.deps.embeddingApi;
		if (!embeddingApi) return;
		const pending = this.deps.stateStore.unembedded();
		if (pending.length === 0) return;
		const embeddings = await embeddingApi.embedBatch(pending.map((item) => item.text));
		this.deps.stateStore.saveEventEmbeddings(
			pending.map((item) => item.itemId),
			embeddings.map((vector) => [...vector]),
		);
	}

	private prototypesCache: { signature: string; vectors: number[][] } | null = null;

	/** 语义兴趣:事件向量与用户对话原型向量的相似度校准。 */
	private async applySemanticInterest(events: WakeEvent[], now: Date): Promise<void> {
		const prototypes = await this.loadTurnPrototypes(now);
		for (const event of events) {
			const base = preprocessInterest(event);
			const rawVector = event._event_embedding;
			const vector = Array.isArray(rawVector)
				? rawVector.filter((value) => typeof value === "number").map(Number)
				: [];
			const similarity = Math.max(0, ...prototypes.map((prototype) => cosine(vector, prototype)));
			const semanticInterest = Math.min(0.999, Math.max(0, similarity) ** SEMANTIC_CALIBRATION_POWER);
			event._wake_semantic_interest = semanticInterest;
			event._wake_interest_score = 1 - (1 - base) * (1 - semanticInterest);
		}
	}

	/**
	 * 用户→助手对话对的原型向量(akashic _load_turn_prototypes + _normalize_weighted)。
	 * 按会话签名缓存;嵌入失败时降级为空(语义兴趣 = 0)。
	 */
	private async loadTurnPrototypes(now: Date): Promise<number[][]> {
		const api = this.deps.embeddingApi;
		if (!api || !this.deps.turnPairs) return [];
		const signature = (await this.deps.sessionSignature?.()) ?? "always";
		if (this.prototypesCache && this.prototypesCache.signature === signature) {
			return this.prototypesCache.vectors;
		}
		const pairs = (await this.deps.turnPairs(now)).slice(-256);
		if (pairs.length === 0) return [];
		const texts: string[] = [];
		for (const pair of pairs) texts.push(pair.user, pair.assistant);
		let embeddings: number[][];
		try {
			embeddings = await api.embedBatch(texts);
		} catch {
			return [];
		}
		const vectors: number[][] = [];
		for (let i = 0; i < pairs.length; i++) {
			const user = embeddings[i * 2];
			const assistant = embeddings[i * 2 + 1];
			if (!user || !assistant) continue;
			const combined = normalizeWeighted(user, assistant);
			if (combined.length > 0) vectors.push(combined);
		}
		this.prototypesCache = { signature, vectors };
		return vectors;
	}

	// ------------------------------------------------------------------
	// 上下文文本
	// ------------------------------------------------------------------

	private currentContextText(now: Date): string {
		const contexts = this.deps.stateStore
			.listContexts()
			.filter(
				(context) =>
					(context.expiresAt !== null && context.expiresAt.getTime() >= now.getTime()) ||
					(context.expiresAt === null &&
						context.observedAt !== null &&
						now.getTime() - context.observedAt.getTime() >= 0 &&
						now.getTime() - context.observedAt.getTime() <= 30 * 60_000),
			);
		if (contexts.length === 0) return "没有有效 ContextEvent";
		return contexts.map((context) => JSON.stringify(context.raw, Object.keys(context.raw).sort())).join("\n");
	}
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function parseOptionalTime(value: string | null): Date | null {
	if (!value) return null;
	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function selectContentPage(events: WakeEvent[], now: Date, limit = MAX_TITLES_PER_WAKE): WakeEvent[] {
	return rankEvents(events, now).slice(0, Math.max(0, limit));
}

function preprocessInterest(event: WakeEvent): number {
	const rawFeatures = event.preprocess_features as Record<string, unknown> | undefined;
	const rawInterest =
		typeof rawFeatures === "object" && rawFeatures !== null ? rawFeatures.interest : event.preprocessScore;
	try {
		return Math.min(0.999, Math.max(0, Number(rawInterest ?? 0)));
	} catch {
		return 0;
	}
}

function normalizeWeighted(user: number[], assistant: number[]): number[] {
	if (user.length !== assistant.length || user.length === 0) return [];
	const combined = user.map((value, index) => 0.9 * value + 0.1 * assistant[index]!);
	const norm = Math.sqrt(combined.reduce((sum, value) => sum + value * value, 0));
	return norm > 0 ? combined.map((value) => value / norm) : [];
}

function cosine(left: number[], right: number[]): number {
	if (left.length !== right.length || left.length === 0) return 0;
	let leftNorm = 0;
	let rightNorm = 0;
	let dot = 0;
	for (let i = 0; i < left.length; i++) {
		leftNorm += left[i]! * left[i]!;
		rightNorm += right[i]! * right[i]!;
		dot += left[i]! * right[i]!;
	}
	if (leftNorm <= 0 || rightNorm <= 0) return 0;
	return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function hazardTrace(result: HazardResult): Record<string, unknown> {
	return {
		hazard_before: result.hazardBefore,
		hazard_after: result.hazardAfter,
		threshold: result.threshold,
		evidence: result.evidence,
		refractory: result.refractory,
		rate: result.rate,
		preference_pressure: result.preferencePressure,
		should_wake: result.shouldWake,
		driver_item_id: result.driverItemId,
	};
}

function eventSource(event: WakeEvent): string {
	return String(event._reservoir_original_source_id ?? event.sourceId ?? event.source_name ?? event._source ?? "");
}

function eventSourceRef(event: WakeEvent): Record<string, unknown> {
	const itemId = String(event._reservoir_source_event_id ?? event.eventId ?? event.id ?? "").trim();
	const ackSourceId = String(event._reservoir_ack_source_id ?? event.ackSourceId ?? event.ack_server ?? "").trim();
	const ref: Record<string, unknown> = {
		id: String(event.id ?? event.eventId ?? "").trim(),
		source: eventSource(event),
		title: String(event.title ?? ""),
		url: String(event.url ?? ""),
	};
	if (ackSourceId && itemId) {
		ref.ack_source_id = ackSourceId;
		ref.event_id = itemId;
	}
	return ref;
}

export interface WakeRunState {
	ctx: WakeContext;
	alerts: WakeEvent[];
	contents: WakeEvent[];
	baseScore: number;
	nextIntervalSeconds: number;
	hazardResult: HazardResult | null;
	contextResults: ReturnType<WakeStateStore["ingestContext"]> | null;
	contextReevaluate: boolean;
	contextEvent: WakeEvent | null;
	driftResult: (DriftDriveResult & { decision: "attempt" }) | null;
	contentCompleted: boolean;
	newAlertCount: number;
	newContentCount: number;
	newContentIds: Set<string> | null;
	unreadContentMass: number;
	unreadContentCount: number;
	tickCompleted: boolean;
}
