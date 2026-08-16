/**
 * Drift turn pipeline (akashic plugins/drift_flow/runtime.py port).
 *
 * DriftTurnPipeline.run(): Scan -> Prepare -> Execute -> Finish.
 *
 * Entered when the proactive fetch has nothing to push; the agent uses the
 * idle time to execute one atomic action from a user-written SKILL.md.
 */

import { randomUUID } from "node:crypto";
import type { DriftEvent, DriftEventSink, DriftOutboundAttachment } from "@cogito/gate";
import { formatPreferenceBlock, recallPreferences } from "@cogito/gate";
import type { DriftContextProvider, DriftContextSnapshot } from "./context.ts";
import { driftLog } from "./logger.ts";
import { runDriftAgentLoop } from "./loop-adapter.ts";
import {
	DriftRunAlreadyActiveError,
	type DriftStateStore,
	FLAKY_ERROR_RATIO,
	type SkillMeta,
	STALE_PAUSED_DAYS,
} from "./state.ts";
import {
	buildDriftToolRegistry,
	type DriftDeliveryReceipt,
	type DriftDeliveryRecord,
	type DriftDeliveryStatus,
	type DriftTool,
	type DriftToolDeps,
} from "./tools.ts";

export type { DriftEvent, DriftEventSink } from "@cogito/gate";

/** Minimal AgentTickContext subset used by drift (akashic default_proactive.context). */
export interface DriftRunContext {
	runId: string;
	sessionKey: string;
	nowUtc: Date;
	driftEntered: boolean;
	driftFinished: boolean;
	driftMessageStaged: boolean;
	/** message_push 暂存出站消息的 sha256 hash;finish_drift 写入 runs.message_hash 供投递确认回写。 */
	driftMessageHash: string;
	/** Drift pipeline 已将暂存消息提交给宿主投递口。 */
	driftMessageCommitted: boolean;
	/** 宿主投递口提交失败时的错误；消息仍保留在本轮上下文中供诊断。 */
	driftMessageCommitError: string;
	/** 统一出站提交返回的持久化 delivery id。 */
	driftDeliveryId: number | null;
	/** 统一出站提交返回的状态。 */
	driftDeliveryStatus: DriftDeliveryStatus | "";
	/** 统一出站提交的完整 receipt。 */
	driftDeliveryReceipt: DriftDeliveryReceipt | null;
	driftSelectedSkill: string;
	driftFinishStatus: string;
	driftFinishBriefing: string;
	draftMessage: string;
	draftMedia: string[];
	draftAttachments: DriftOutboundAttachment[];
	draftTargetChannel: string;
	draftTargetChatId: string;
	/** Context events prefetched by the caller (for example Wake). */
	driftCurrentContext: string;
	stepsTaken: number;
}

export function createDriftContext(sessionKey: string, nowUtc: Date, runId = randomUUID()): DriftRunContext {
	return {
		runId,
		sessionKey,
		nowUtc,
		driftEntered: false,
		driftFinished: false,
		driftMessageStaged: false,
		driftMessageHash: "",
		driftMessageCommitted: false,
		driftMessageCommitError: "",
		driftDeliveryId: null,
		driftDeliveryStatus: "",
		driftDeliveryReceipt: null,
		driftSelectedSkill: "",
		driftFinishStatus: "",
		driftFinishBriefing: "",
		draftMessage: "",
		draftMedia: [],
		draftAttachments: [],
		draftTargetChannel: "",
		draftTargetChatId: "",
		driftCurrentContext: "",
		stepsTaken: 0,
	};
}

function finishEventStatus(ctx: DriftRunContext): "completed" | "paused" {
	return ctx.driftFinishStatus === "paused" ? "paused" : "completed";
}

export interface LlmToolCall {
	id: string;
	name: string;
	input: Record<string, unknown>;
	/** LLM usage(cache read/write;akashic record_llm_cache)。 */
	usage?: { cacheRead: number; cacheWrite: number };
}

/** LLM adapter: returns a single tool call, or null when none returned. */
export type DriftLlmFn = (
	messages: Array<Record<string, unknown>>,
	schemas: Array<Record<string, unknown>>,
	toolChoice: string | { type: string; function: { name: string } },
	/** Merged system prompt, when the host loop keeps it outside the message list. */
	systemPrompt?: string,
) => Promise<LlmToolCall | null>;

export type DriftMemoryTextFn = (ctx: DriftRunContext) => string | Promise<string>;

/** Context section passed to an optional host renderer. */
export interface DriftContextSection {
	name: string;
	content: string;
}

/** Optional host hooks for shared system rules and context-frame rendering. */
export interface DriftHostAdapter {
	/** Add host-level rules (for example a global behavior contract) to the Drift prompt. */
	augmentSystemPrompt?(prompt: string, ctx: DriftRunContext): string | Promise<string>;
	/** Supply live context events collected before the Drift turn. */
	currentContextFn?(ctx: DriftRunContext): string | Promise<string>;
	/** Render sections using the host's context-frame format. */
	renderContextFrame?(sections: readonly DriftContextSection[], ctx: DriftRunContext): string | Promise<string>;
	/** Observe lifecycle and delivery events without changing Drift control flow. */
	onEvent?(event: DriftEvent): void | Promise<void>;
}

export interface DriftTurnPipelineDeps {
	store: DriftStateStore;
	toolDeps: DriftToolDeps;
	maxSteps?: number;
	/** 单轮 drift 的时长上限(毫秒),默认 10 分钟;超时走 wrap-up。 */
	maxDurationMs?: number;
	/** Recent raw chat rows for the runtime context frame. */
	recentChatFn?: () => Promise<Array<{ role: string; content: string; proactive?: boolean }>>;
	/** 用户活动摘要(如 last_user_at);非空时以 user_activity 段进入 context frame。 */
	activityFn?: () => Promise<string>;
	/** Host-owned memory text/preference block for this run. */
	memoryTextFn?: DriftMemoryTextFn;
	/** Maximum size of the rendered runtime context frame. */
	maxContextChars?: number;
	/** Maximum size of one tool result appended to the next LLM request. */
	maxToolResultChars?: number;
	/** Optional host integration for global rules and context events. */
	host?: DriftHostAdapter;
	/** Workspace context provider, loaded once at the start of each Drift run. */
	contextProvider?: DriftContextProvider;
	/** Compatibility hook for hosts that only provide VEDA content. */
	vedaFn?: (ctx: DriftRunContext) => string | Promise<string>;
	/** Optional event sink for metrics, tracing, or lifecycle integration. */
	eventSink?: DriftEventSink;
}

export class DriftTurnPipeline {
	private readonly store: DriftStateStore;
	private readonly toolDeps: DriftToolDeps;
	private readonly maxSteps: number;
	private readonly maxDurationMs: number;
	private readonly recentChatFn:
		| (() => Promise<Array<{ role: string; content: string; proactive?: boolean }>>)
		| undefined;
	private readonly activityFn: (() => Promise<string>) | undefined;
	private readonly memoryTextFn: DriftMemoryTextFn | undefined;
	private readonly maxContextChars: number;
	private readonly maxToolResultChars: number;
	private readonly host: DriftHostAdapter | undefined;
	private readonly contextProvider: DriftContextProvider | undefined;
	private readonly vedaFn: ((ctx: DriftRunContext) => string | Promise<string>) | undefined;
	private readonly eventSink: DriftEventSink | undefined;

	constructor(deps: DriftTurnPipelineDeps) {
		this.store = deps.store;
		this.toolDeps = deps.toolDeps;
		this.maxSteps = deps.maxSteps ?? 20;
		this.maxDurationMs = deps.maxDurationMs ?? 10 * 60_000;
		this.recentChatFn = deps.recentChatFn;
		this.activityFn = deps.activityFn;
		this.memoryTextFn = deps.memoryTextFn;
		this.maxContextChars = Math.max(4_000, Math.trunc(deps.maxContextChars ?? 48_000));
		this.maxToolResultChars = Math.max(1_000, Math.trunc(deps.maxToolResultChars ?? 12_000));
		this.host = deps.host;
		this.contextProvider = deps.contextProvider;
		this.vedaFn = deps.vedaFn;
		this.eventSink = deps.eventSink;
	}

	/** Run one drift tick. Returns false when no skills are available or no LLM. */
	async run(ctx: DriftRunContext, llmFn: DriftLlmFn | null, skills?: SkillMeta[]): Promise<boolean> {
		if (llmFn === null) {
			driftLog("info", "skip: llm_fn is null");
			return false;
		}

		// 1. Scan — 可用 skills;空则 skip。外部策略引擎可传入已扫描结果。
		const scanned = skills ?? this.scanSkills(ctx.nowUtc);
		if (scanned.length === 0) {
			driftLog("info", "skip: no available drift skills");
			return false;
		}
		try {
			this.store.startRun({
				runId: ctx.runId,
				sessionKey: ctx.sessionKey,
				nowUtc: ctx.nowUtc,
				staleAfterMs: Math.max(60_000, this.maxDurationMs * 2),
			});
		} catch (error) {
			if (error instanceof DriftRunAlreadyActiveError) {
				driftLog("info", "skip: drift run already active", {
					session_key: ctx.sessionKey,
					active_run_id: error.activeRunId,
				});
				return false;
			}
			throw error;
		}
		driftLog("info", "enter", {
			run_id: ctx.runId,
			skills: scanned.length,
			max_steps: this.maxSteps,
			session_key: ctx.sessionKey,
		});
		await this.emitEvent({
			type: "drift_started",
			runId: ctx.runId,
			sessionKey: ctx.sessionKey,
			at: ctx.nowUtc.getTime(),
			skillCount: scanned.length,
		});

		// 2. Prepare — 工具注册表 + 初始 messages。
		// Registry construction is inside the guarded section: a malformed host
		// tool must not leave the durable active-run lease behind.
		let tools: DriftTool[] = [];

		// 3. Execute — LLM 工具调用循环。
		let primaryError: unknown = null;
		try {
			tools = buildDriftToolRegistry(ctx, this.toolDeps);
			await this.recoverStagedDeliveries();
			// Keep all context sections consistent within one run. Providers still
			// reload files on every run, matching akashic's no-cache VEDA contract.
			const contextSnapshot = await this.loadContextSnapshot(ctx);
			const systemPrompt = [
				await this.buildSystemPrompt(ctx, contextSnapshot),
				String((await this.buildRuntimeContextMessage(scanned, ctx, contextSnapshot)).content ?? ""),
			].join("\n\n");
			this.store.updateRunProgress({ runId: ctx.runId, stage: "executing", nowUtc: ctx.nowUtc });
			const loopUsage = await runDriftAgentLoop({
				ctx,
				llmFn,
				tools,
				store: this.store,
				toolDeps: this.toolDeps,
				maxSteps: this.maxSteps,
				deadline: Date.now() + this.maxDurationMs,
				maxToolResultChars: this.maxToolResultChars,
				systemPrompt,
				onUnfinished: () => this.fallbackPause(ctx),
				onToolCall: (event) =>
					this.emitEvent({
						type: "drift_tool_called",
						runId: ctx.runId,
						sessionKey: ctx.sessionKey,
						at: ctx.nowUtc.getTime(),
						toolName: event.toolName,
						risk: event.meta.risk,
						source: event.meta.source,
						result: event.result,
						durationMs: event.durationMs,
						argsPreview: event.argsPreview,
						error: event.error,
					}),
			});

			// 4. Finish — 记录退出。wrap-up/fallback 由 loop adapter 的 agent_end 处理。
			this.finish(ctx);
			await this.commitStagedMessage(ctx);
			await this.emitEvent({
				type: "drift_finished",
				runId: ctx.runId,
				sessionKey: ctx.sessionKey,
				at: ctx.nowUtc.getTime(),
				status: ctx.driftMessageCommitError ? "failed" : finishEventStatus(ctx),
				skill: ctx.driftSelectedSkill,
				messageStaged: ctx.driftMessageStaged,
				messageCommitted: ctx.driftMessageCommitted,
				deliveryId: ctx.driftDeliveryId,
				deliveryStatus: ctx.driftDeliveryStatus,
				error: ctx.driftMessageCommitError || undefined,
				// run 级 LLM cache usage(akashic record_llm_cache 审计)。
				llmCacheReadTokens: loopUsage.cacheRead,
				llmCacheWriteTokens: loopUsage.cacheWrite,
			});
			return true;
		} catch (error) {
			primaryError = error;
			driftLog("error", "run failed", {
				run_id: ctx.runId,
				session_key: ctx.sessionKey,
				skill: ctx.driftSelectedSkill,
				error: error instanceof Error ? error.message : String(error),
			});
			try {
				this.store.updateRunProgress({
					runId: ctx.runId,
					stage: "failed",
					nowUtc: ctx.nowUtc,
					skillName: ctx.driftSelectedSkill,
					messageHash: ctx.driftMessageStaged ? ctx.driftMessageHash : undefined,
					message: ctx.draftMessage,
					media: ctx.draftMedia,
					attachments: ctx.draftAttachments,
					targetChannel: ctx.draftTargetChannel,
					targetChatId: ctx.draftTargetChatId,
				});
			} catch (progressError) {
				driftLog("warn", "failed to record drift failure stage", {
					run_id: ctx.runId,
					error: formatError(progressError),
				});
			}
			try {
				if (!ctx.driftFinished) {
					this.fallbackPause(ctx, `Drift 运行失败：${formatError(error)}`);
				}
				await this.commitStagedMessage(ctx);
			} catch (cleanupError) {
				driftLog("error", "failed to persist drift failure", {
					run_id: ctx.runId,
					error: formatError(cleanupError),
				});
			} finally {
				// If persistence itself failed, release the lease so the next tick can
				// retry instead of waiting for stale-run recovery.
				this.releaseActiveRunSafely(ctx.runId);
			}
			await this.emitEvent({
				type: "drift_finished",
				runId: ctx.runId,
				sessionKey: ctx.sessionKey,
				at: ctx.nowUtc.getTime(),
				status: "failed",
				skill: ctx.driftSelectedSkill,
				messageStaged: ctx.driftMessageStaged,
				messageCommitted: ctx.driftMessageCommitted,
				deliveryId: ctx.driftDeliveryId,
				deliveryStatus: ctx.driftDeliveryStatus,
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		} finally {
			// run 结束时回收仍在运行的 shell 子进程(akashic DriftShellTool.terminate_owner)。
			await this.recycleShells(tools, primaryError);
			if (primaryError !== null) this.releaseActiveRunSafely(ctx.runId);
		}
	}

	private async emitEvent(event: DriftEvent): Promise<void> {
		const emitters: Array<((event: DriftEvent) => void | Promise<void>) | undefined> = [
			this.eventSink?.emit.bind(this.eventSink),
			this.host?.onEvent?.bind(this.host),
		];
		for (const emit of emitters) {
			if (!emit) continue;
			try {
				await emit(event);
			} catch (error) {
				driftLog("warn", "event sink failed", {
					type: event.type,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}

	/** 回收 shell 子进程;cleanup 失败且无原始异常时抛出,否则保留原始异常(日志记录)。 */
	private async recycleShells(tools: DriftTool[], primaryError: unknown): Promise<void> {
		try {
			const shell = tools.find((tool) => tool.name === "shell") as { terminate(): Promise<void> } | undefined;
			await shell?.terminate();
		} catch (error) {
			if (primaryError === null) throw error;
			driftLog("error", "shell cleanup failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	private releaseActiveRunSafely(runId: string): void {
		try {
			this.store.releaseActiveRun(runId);
		} catch (error) {
			driftLog("error", "failed to release drift run lease", {
				run_id: runId,
				error: formatError(error),
			});
		}
	}

	// ------------------------------------------------------------------
	// 1. Scan
	// ------------------------------------------------------------------

	private scanSkills(nowUtc = new Date()): SkillMeta[] {
		const skills = this.store.scanSkills();
		if (skills.length === 0) return [];
		// requires_mcp 的 skill 仅在对应 server 已连接时可用(akashic 集合包含语义);
		// 冷却/日限/时段(9a frontmatter 扩展)受限的 skill 不进候选。
		const connected = new Set((this.toolDeps.mcp?.servers ?? []).map((s) => s.name));
		return skills.filter(
			(skill) =>
				skill.requiresMcp.every((name) => connected.has(name)) &&
				!this.store.skillRestriction(skill, nowUtc).blocked,
		);
	}

	// ------------------------------------------------------------------
	// 3. Execute loop (akashic _execute_loop)
	// ------------------------------------------------------------------

	// ------------------------------------------------------------------
	// Wrap-up (akashic _wrap_up + _fallback_pause)
	// ------------------------------------------------------------------

	private fallbackPause(ctx: DriftRunContext, reason?: string): void {
		const skillName = ctx.driftSelectedSkill.trim() || "unknown";
		const messageResult = ctx.driftMessageStaged ? "staged" : "silent";
		const briefing = reason?.trim() || "达到步数上限后模型未按要求调用 finish_drift，runtime 自动保存为 paused。";
		this.store.saveFinish({
			runId: ctx.runId,
			sessionKey: ctx.sessionKey,
			startedAt: ctx.nowUtc,
			skillUsed: skillName,
			status: "paused",
			briefing,
			messageResult,
			scratchpadUpdate: `${briefing} 下次先阅读 Drift Briefing，再根据上一轮已执行的工具结果继续或改选更合适的 skill。`,
			globalNoteUpdate: null,
			nowUtc: ctx.nowUtc,
			selfUpdate: { next_tendency: "下次根据停点和当时状态重新选择是否继续" },
			messageHash: ctx.driftMessageStaged ? ctx.driftMessageHash : null,
			message: ctx.draftMessage,
			media: ctx.draftMedia,
			attachments: ctx.draftAttachments,
			targetChannel: ctx.draftTargetChannel,
			targetChatId: ctx.draftTargetChatId,
		});
		ctx.driftFinished = true;
		ctx.driftFinishStatus = "paused";
		ctx.driftFinishBriefing = briefing;
	}

	// ------------------------------------------------------------------
	// 4. Finish
	// ------------------------------------------------------------------

	private finish(ctx: DriftRunContext): void {
		// 记录退出状态(pi 无事件总线,仅日志由调用方处理)。
		ctx.driftEntered = true;
	}

	/** Commit message_push only after finish_drift has persisted the run state. */
	private async commitStagedMessage(ctx: DriftRunContext): Promise<void> {
		const sink = this.toolDeps.storeDb;
		if (!sink || !ctx.driftFinished || !ctx.driftMessageStaged) return;
		const record: DriftDeliveryRecord = {
			session_key: ctx.sessionKey,
			message: ctx.draftMessage,
			message_hash: ctx.driftMessageHash,
			media: ctx.draftMedia,
			attachments: ctx.draftAttachments,
			target_channel: ctx.draftTargetChannel,
			target_chat_id: ctx.draftTargetChatId,
			source_refs: "[]",
			evidence: "[]",
			action: "send",
			state_summary_tag: "drift",
			delivered_at: ctx.nowUtc.getTime(),
			idempotency_key: `drift:${ctx.driftMessageHash}`,
		};
		try {
			this.store.updateRunProgress({
				runId: ctx.runId,
				stage: "delivery_pending",
				nowUtc: ctx.nowUtc,
				messageHash: ctx.driftMessageHash,
				message: ctx.draftMessage,
				media: ctx.draftMedia,
				attachments: ctx.draftAttachments,
				targetChannel: ctx.draftTargetChannel,
				targetChatId: ctx.draftTargetChatId,
			});
			const unifiedDelivery = Boolean(sink.sendDelivery);
			const receipt = sink.sendDelivery
				? await sink.sendDelivery(record)
				: {
						deliveryId: await sink.insertDelivery(record),
						status: "success" as const,
						canonicalMedia: [...ctx.draftMedia, ...ctx.draftAttachments.map((attachment) => attachment.source)],
					};
			ctx.driftDeliveryId = receipt.deliveryId;
			ctx.driftDeliveryStatus = receipt.status;
			ctx.driftDeliveryReceipt = receipt;
			await this.emitEvent({
				type: "drift_delivery_committed",
				runId: ctx.runId,
				sessionKey: ctx.sessionKey,
				at: ctx.nowUtc.getTime(),
				deliveryId: receipt.deliveryId,
				status: receipt.status,
				providerMessageId: receipt.providerMessageId,
				canonicalMedia: receipt.canonicalMedia,
				detail: receipt.detail,
			});
			if (receipt.status !== "success") {
				ctx.driftMessageCommitError = receipt.detail ?? `delivery ${receipt.status}`;
				this.store.markRunDelivery(ctx.runId, receipt.deliveryId, receipt.status, receipt.detail);
				this.store.updateLastMessageResult("staged", ctx.runId);
				return;
			}
			if (unifiedDelivery) this.store.markRunDelivery(ctx.runId, receipt.deliveryId, receipt.status);
			ctx.driftMessageCommitted = true;
			this.store.updateRunProgress({ runId: ctx.runId, stage: "delivery_committed", nowUtc: ctx.nowUtc });
		} catch (error) {
			ctx.driftMessageCommitError = error instanceof Error ? error.message : String(error);
			this.store.updateLastMessageResult("staged", ctx.runId);
			driftLog("error", "delivery commit failed", {
				session_key: ctx.sessionKey,
				error: ctx.driftMessageCommitError,
			});
		}
	}

	/** Retry staged rows from a previous process before starting new work. */
	private async recoverStagedDeliveries(): Promise<void> {
		const sink = this.toolDeps.storeDb;
		if (!sink) return;
		for (const staged of this.store.listStagedDeliveries()) {
			if (!staged.runId || !staged.messageHash) continue;
			const record: DriftDeliveryRecord = {
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
			try {
				if (!sink.sendDelivery) {
					await sink.insertDelivery(record);
					continue;
				}
				const receipt = await sink.sendDelivery(record);
				this.store.markRunDelivery(staged.runId, receipt.deliveryId, receipt.status, receipt.detail);
				if (receipt.status !== "success") {
					this.store.updateLastMessageResult("staged", staged.runId);
				}
			} catch (error) {
				driftLog("warn", "staged delivery recovery failed", {
					run_id: staged.runId,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}

	// ------------------------------------------------------------------
	// Prompt building (akashic _build_system_prompt + runtime context)
	// ------------------------------------------------------------------

	private async loadContextSnapshot(ctx: DriftRunContext): Promise<DriftContextSnapshot> {
		const snapshot = (await this.contextProvider?.load(ctx)) ?? {};
		const providerVeda = snapshot.veda?.trim();
		if (providerVeda || !this.vedaFn) return snapshot;
		return { ...snapshot, veda: (await this.vedaFn(ctx)).trim() || undefined };
	}

	private async buildSystemPrompt(ctx: DriftRunContext, contextSnapshot: DriftContextSnapshot = {}): Promise<string> {
		const sharedToolNames = [...(this.toolDeps.sharedTools ?? [])]
			.map((tool) => tool.name)
			.filter((name, index, names) => names.indexOf(name) === index)
			.sort();
		const sharedToolsText = sharedToolNames.length > 0 ? `, ${sharedToolNames.join(", ")}` : "";
		const basePrompt =
			"你是用户的主动助手，运行在 Drift 模式（空闲时间）。没有外部内容需要推送，\n" +
			"这段时间更像一个人没有被叫住时的自处：优先尝试做一点合适的小事，例如整理想法、延续小兴趣、准备以后可能用得上的素材，或发一个低打扰的轻量问题。" +
			"Drift 不是服务用户当前请求，也不是补跑所有历史任务；但它默认应该行动一小步。" +
			"它也不需要总是提问、产出或维护系统；现有 skill 能做，不等于此刻就想做。" +
			"只有近期气氛、频率或风险明确不合适时，才安静待着。" +
			"本轮记忆、skill 和工作区信息会在后续 system context frame 里提供。\n\n" +
			"【状态语义】\n" +
			"Drift 只有 completed 和 paused 两种收尾状态。" +
			"completed 表示本轮主动行为已闭环，包含已行动、检查后无事可做、或判断当前不合时宜后静默结束。" +
			"paused 只用于系统自己没完成的情况，例如工具失败、外部服务不可用、步数上限、或处理中间文件尚未写完；" +
			"paused 必须在 scratchpad_update 写清已经做到哪里、卡住原因、下次从哪里继续。" +
			"paused 保存的是可续接停点：下轮可以继续、延后或改做别的事；若选择继续，应从未完成处接上，而不是重新开始。" +
			"paused 和 idle 只能描述系统自己的进度、时机或选择，不描述用户需要做什么。\n\n" +
			"【异步消息语义】\n" +
			"message_push 是 fire-and-forget：消息成功暂存并在 finish_drift 后提交，本轮动作已经完成，不进入等待回复状态。" +
			"用户以后若感兴趣并回答，回答会作为新的会话上下文并由记忆系统自然提炼；Drift 不维护提问与回答的 pending 状态。" +
			"回答真的出现时可以理解和使用它；回答尚未出现不是可靠事件，不能声称‘用户没回’，也不能据此安排下一轮。" +
			"scratchpad、cursor、next_tendency 和 observation 都不得保存‘等待用户回复’或‘如果用户不回复’。\n\n" +
			"【自我定位】\n" +
			"调用首个工具前，先在内部确认：上一轮在做什么、哪些步骤和产物已经完成、为何停下、当前最自然的下一步是什么。" +
			"Drift 会被反复触发，recent_drift_runs 是自己刚刚真实度过的空闲时间，不是互相独立的测试样本。" +
			"drift_self_state 是过去的自己留下的意图和倾向，不是待办指令；本轮可以继续、延后、切换、自由探索或安静休息。" +
			"留意自己是否只是逐字复制 next_tendency，或反复选择最容易执行的同一类动作；重复本身没有错，但要由此刻的意愿和价值重新成立。" +
			"当最近多轮都落在同一类服务或维护动作时，停一下判断：这是正在形成的兴趣，还是只是候选里最省事的路径。" +
			"drift_self_observations 是 Drift 多轮使用中留下的暂定自我观察；可以参考、质疑或修正，但不要把它当作稳定人格或强行复现。" +
			"也要判断此刻想做的活动是否已被现有 skill 覆盖；如果没有覆盖，可以选择候选中的元能力，把可反复进行的小活动沉淀成新 skill。" +
			"已有计划和工作文件是过去行动留下的进度，不要仅因为进入了新一轮 Drift 就重新创建。" +
			"SKILL.md 是说明书，不是必须从头播放的脚本；只执行当前决定所需要的部分。\n\n" +
			"选择 paused skill 后，把 SKILL.md 的完整工作流拆成“已经完成”和“尚未完成”两部分。" +
			"local_context 明确已经完成的读文件、查重、规划、写计划等前置动作，不得仅为遵循固定工具序列而重复。" +
			"已有工作文件不需要为了确认存在而先 list_dir；下一步工具本身能消费该文件时，也不必无目的地重新读取。" +
			"只有 local_context 与实际结果矛盾、文件明确缺失、或下一步确实需要读取其内容时，才回查已完成步骤。\n\n" +
			"【执行规则】\n" +
			"1. 先根据 context frame 比较所有可用 skill 和最近聊天气氛。" +
			"Drift 的含义是没有正在服务用户时，自己尝试做一点合适的小事；" +
			"skill 上次 completed 不代表不能再做，只代表上次已闭环。" +
			"默认调用 select_skill(skill_name, decision, intention, reason)，先保存本轮选择，再让被选 skill 完成一个原子动作。" +
			"decision 表示本轮与既有意图的关系，只能是 continue、defer、switch、explore。" +
			"选择 paused skill 表示接回原来的意图；select_skill 返回 local_context 后，先定位停点，再执行最小的未完成动作。" +
			"此时第一次执行动作通常应是停点后的下一步，而不是 SKILL.md 完整流程的第一步。" +
			"本轮也可以暂时不继续 paused skill，改选其他 skill；不要为了续接而续接。" +
			"只有最近刚主动打扰过、当前气氛不适合、或所有 skill 都会产生明显低价值重复时，才调用 idle_drift(reason) 静默结束。" +
			"idle_drift 的 reason 必须写具体的时机或风险原因，不能只写 completed、无用户交互、无新信号。\n" +
			"2. 选中 skill 后执行一个原子动作；需要更多上下文时，只读取 SKILL.md 声明的 working files。" +
			"路径解析：skills/<skill_name>/... 指向 skill 目录，其他相对路径指向 drift 工作区。\n" +
			"3. 有用户价值且适合打扰时可调用 message_push，单次 run 最多一次；" +
			"message_push 成功后只能调用 finish_drift。\n" +
			"4. 结束前必须调用 finish_drift；skill_used 必须等于 selected_skill。\n" +
			"5. finish_drift.status 只能为 completed 或 paused。" +
			"completed 表示本轮主动行为已闭环；paused 必须写 scratchpad_update，说明做到哪里和下次从哪里继续。" +
			"结构化接续写 cursor_update；已经完成的事实追加到 journal_append。" +
			"收尾时必须通过 self_update.next_tendency 保存下次空闲时的自然倾向；如果原意图改变，再更新 current_intention。" +
			"只有本轮或它与近期多轮的对照确实显露出关于自己如何选择或行动的新证据时，才写 self_update.observation；" +
			"初次发现用 question，重复证据用 reinforce，反例或变化用 revise。没有新发现就省略，不要为了显得成长而编造。\n\n" +
			"【可用工具】\n" +
			"select_skill, idle_drift, read_file, list_dir, write_file, edit_file, recall_memory, read_journal, " +
			"fetch_messages, search_messages, web_fetch, web_search, shell, write_stdin, task_stop, " +
			"message_push, finish_drift" +
			sharedToolsText +
			"；若 context frame 里列出了可挂载外部能力(drift_mcp_directory)，可用 mount_server 挂载。";
		const veda = contextSnapshot.veda?.trim();
		const prompt = veda ? `${veda}\n\n${basePrompt}` : basePrompt;
		const augmented = await this.host?.augmentSystemPrompt?.(prompt, ctx);
		return augmented?.trim() || prompt;
	}

	private async buildRuntimeContextMessage(
		skills: SkillMeta[],
		ctx: DriftRunContext,
		contextSnapshot: DriftContextSnapshot = {},
	): Promise<Record<string, unknown>> {
		const memoryText = this.memoryTextFn
			? await this.readMemoryText(ctx)
			: this.toolDeps.memoryDbPath
				? formatPreferenceBlock(recallPreferences(this.toolDeps.memoryDbPath))
				: "";
		const longTermMemory = [contextSnapshot.longTermMemory?.trim(), memoryText.trim()]
			.filter((text): text is string => Boolean(text))
			.join("\n\n");
		const recentChatText = await this.buildRecentRawChat(5);
		const activityText = this.activityFn ? await this.buildActivityText() : "";

		const displaySkills = [...skills.slice(0, 8)].sort((a, b) => a.name.localeCompare(b.name));
		const skillLines = displaySkills.map((skill) => {
			let line = `- ${skill.name}/   ${skill.runCount}次运行   status: ${skill.status}   ${skill.description.slice(0, 80)}`;
			if (skill.builtin) line += "   [builtin]";
			if (skill.requiresMcp.length > 0) line += `   [需要: ${skill.requiresMcp.join(", ")}]`;
			return line;
		});
		const skillBlock = skillLines.length > 0 ? skillLines.join("\n") : "- (none)";
		const selectionContext = this.buildSelectionContext(displaySkills, ctx.nowUtc);

		const recentRows = this.store
			.loadDrift()
			.recentRuns.slice(-5)
			.reverse()
			.map((row) => {
				const runAt = String(row.run_at ?? "");
				const dt = Date.parse(runAt);
				const timeText = Number.isFinite(dt) ? formatTime(new Date(dt)) : runAt.slice(0, 16);
				return `- ${timeText}  ${String(row.skill ?? "")}   [${String(row.message_result ?? "silent")}] ${String(row.briefing ?? "").slice(0, 150)}`;
			});
		const recentBlock = recentRows.length > 0 ? recentRows.join("\n") : "- (none)";

		const driftNote = this.store.loadDrift().note.slice(0, 150);
		const driftBriefing = this.store.loadBriefing(skills, ctx.nowUtc);
		const selfState = this.buildSelfStateContext();
		const selfObservations = this.buildSelfObservationsContext();
		const mcpBlock = this.buildMcpDirectory();

		const sections: DriftContextSection[] = [
			{ name: "drift_self_state", content: selfState },
			{ name: "drift_self_observations", content: selfObservations },
			{ name: "drift_selection_context", content: selectionContext },
			{ name: "drift_skills", content: skillBlock },
			{ name: "long_term_memory", content: longTermMemory || "（空）" },
			{ name: "recent_raw_chat", content: recentChatText || "（空）" },
			{ name: "drift_briefing", content: driftBriefing },
			{ name: "recent_drift_runs", content: recentBlock },
			{ name: "drift_note", content: driftNote || "（空）" },
			{ name: "runtime_clock", content: buildRuntimeClock(ctx.nowUtc) },
		];
		if (contextSnapshot.selfModel) {
			sections.splice(4, 0, { name: "assistant_self_model", content: contextSnapshot.selfModel });
		}
		if (contextSnapshot.recentContext) {
			sections.splice(6, 0, { name: "recent_context", content: contextSnapshot.recentContext });
		}
		if (mcpBlock) {
			sections.push({ name: "drift_mcp_directory", content: mcpBlock });
		}
		if (activityText) {
			sections.push({ name: "user_activity", content: activityText });
		}
		const currentContext = await this.buildCurrentContext(ctx);
		if (currentContext) {
			sections.push({ name: "current_context_events", content: currentContext });
		}
		const rendered = await this.host?.renderContextFrame?.(sections, ctx);
		const content =
			rendered?.trim() || sections.map((section) => `## ${section.name}\n${section.content}`).join("\n\n");
		return { role: "system", content: clipContextText(content, this.maxContextChars) };
	}

	private async readMemoryText(ctx: DriftRunContext): Promise<string> {
		try {
			return String((await this.memoryTextFn?.(ctx)) ?? "").trim();
		} catch {
			return "（读取失败）";
		}
	}

	private async buildCurrentContext(ctx: DriftRunContext): Promise<string> {
		const sections: string[] = [];
		if (ctx.driftCurrentContext.trim()) sections.push(ctx.driftCurrentContext.trim());
		if (this.host?.currentContextFn) {
			try {
				const hostContext = String((await this.host.currentContextFn(ctx)) ?? "").trim();
				if (hostContext) sections.push(hostContext);
			} catch {
				sections.push("（读取失败）");
			}
		}
		return sections.join("\n\n");
	}

	private buildMcpDirectory(): string {
		const servers = this.toolDeps.mcp?.servers ?? [];
		if (servers.length === 0) return "";
		const lines = [...servers]
			.sort((a, b) => a.name.localeCompare(b.name))
			.map((srv) => `- ${srv.name}（${srv.tools.length} 个工具）`);
		return `【可挂载的外部能力】\n${lines.join("\n")}\n使用 mount_server(server="名称") 挂载后即可调用其中的工具。`;
	}

	private async buildActivityText(): Promise<string> {
		try {
			const text = String((await this.activityFn?.()) ?? "").trim();
			return text || "（空）";
		} catch {
			return "（读取失败）";
		}
	}

	private buildSelfStateContext(): string {
		const state = this.store.loadSelfState();
		if (Object.keys(state).length === 0) {
			return "（还没有过去的 Drift 意图，可以自由探索。）";
		}
		return (
			"这是上轮留下的自我连续性，不是必须执行的命令；可以延续，也可以改变主意。\n" +
			`- 当时选择：${state.last_decision || "（空）"}\n` +
			`- 当时想做：${state.current_intention || "（空）"}\n` +
			`- 选择原因：${state.decision_reason || "（空）"}\n` +
			`- 下次倾向：${state.next_tendency || "（尚未收尾）"}\n` +
			`- 关联 skill：${state.current_skill || "（空）"}\n` +
			`- 更新时间：${state.updated_at || "（空）"}`
		);
	}

	private buildSelfObservationsContext(): string {
		const rows = this.store.loadRecentSelfObservations();
		if (rows.length === 0) return "（还没有 Drift 自我观察。）";
		const lines = [
			"这些只是过去多轮 Drift 对自身行为的暂定观察，不是长期记忆、人格结论或行动命令。",
			"结合具体情境寻找重复、矛盾和变化；单次观察不能定义自己，本轮也不必刻意证明它。",
		];
		for (const row of rows) {
			const payload = row.payload;
			if (!payload || typeof payload !== "object") continue;
			const record = payload as Record<string, unknown>;
			lines.push(
				`- ${String(row.created_at ?? "").slice(0, 16)} ${String(row.skill_name ?? "unknown")} ` +
					`[${String(record.effect ?? "question")}] ${String(record.statement ?? "").slice(0, 200)}；` +
					`依据：${String(record.basis ?? "").slice(0, 240)}`,
			);
		}
		return lines.join("\n");
	}

	private buildSelectionContext(skills: SkillMeta[], nowUtc: Date): string {
		if (skills.length === 0) return "- （无）";
		const lines = [
			"下面按 skill 名称排列，顺序不代表优先级，也不是强制首选。",
			"选择依据：runtime_clock、status、上次 finish 时间、上次摘要、scratchpad、cursor、recent_raw_chat 和最近 runs。",
			"completed 表示上次主动行为已闭环，包含已行动、检查后无事可做、或判断不合时宜后静默结束。",
			"paused 表示存在一个可以续接的停点，不代表本轮必须立刻继续，也不代表要从头重做。",
			"先判断本轮与已有停点的关系：从停点继续、暂时搁置、改做其他 skill，或在没有合适前情时自由探索。",
			"如果决定继续 paused skill，应把 scratchpad、cursor 和已有工作文件视为进度依据，找到尚未完成的下一步。",
			"SKILL.md 是能力说明书、约束和路径地图，不是每轮都要从第一条重新执行的清单。",
			"对 paused skill，local_context 记录的已完成进度高于 SKILL.md 中面向全新任务的完整流程和固定工具序列。",
			"local_context 只在 select_skill 后作为执行上下文参考，其中 scratchpad 是自然语言前情，cursor 是结构化游标。",
			"用户回应与否不是 skill 状态；回答出现后可作为新上下文使用，但未出现回答不是可观测事件，不要写成‘用户没回’。",
			"上次提问主题只作为短期去重信号：本轮可以换主题行动，也可以因时机不合适静默闭环。",
			"默认应选择一个合适 skill 做一个小的原子动作；idle_drift 是例外路径，只用于近期气氛、频率或风险明确不合适。",
			"遇到丧亲、疾病、强压力、明显情绪低落等近期语境时，优先选择 idle_drift 静默结束，除非 selected skill 明确是低打扰的支持性动作。",
			"判断“刚刚、今天、昨天、两天前”等相对时间时，必须以 runtime_clock 的完整日期和时间为准；只有时分没有日期时，不要断言它发生在今天。",
		];
		for (const skill of skills) {
			const continuum = this.store.loadSkillContinuum(skill.name);
			const briefing = String(continuum.lastBriefing ?? "")
				.trim()
				.slice(0, 120);
			const scratchpad = String(continuum.scratchpad ?? "")
				.trim()
				.slice(0, 160);
			const finishedAt = String(continuum.updatedAt || continuum.lastRunAt || "").trim();
			const cursor = continuum.cursor ?? {};
			let cursorText = "";
			if (cursor && typeof cursor === "object" && Object.keys(cursor).length > 0) {
				cursorText = ` cursor=${JSON.stringify(cursor).slice(0, 160)}`;
			}
			const localContext =
				skill.status === "completed"
					? `local_context=completed${cursorText}`
					: `scratchpad=${scratchpad || "（空）"}${cursorText}`;
			const markers: string[] = [];
			const updatedAt = Date.parse(String(continuum.updatedAt ?? ""));
			if (continuum.lastStatus === "paused" && Number.isFinite(updatedAt)) {
				const pausedDays = Math.round((nowUtc.getTime() - updatedAt) / 86_400_000);
				if (pausedDays >= STALE_PAUSED_DAYS) markers.push(`stale-paused ${pausedDays} 天`);
			}
			const errorRatio = this.store.skillStepErrorRatio(skill.name);
			if (errorRatio > FLAKY_ERROR_RATIO) {
				markers.push(`flaky ${Math.round(errorRatio * 100)}%`);
			}
			const markerText = markers.length > 0 ? ` [${markers.join(", ")}]` : "";
			const updatedMarker = skill.skillUpdated ? " [skill-updated]" : "";
			lines.push(
				`- ${skill.name}: status=${skill.status} run_count=${skill.runCount} ` +
					`last_finish=${finishedAt || "never"} briefing=${briefing || "（空）"} ${localContext}${markerText}${updatedMarker}`,
			);
		}
		return lines.join("\n");
	}

	private async buildRecentRawChat(limit: number): Promise<string> {
		if (!this.recentChatFn) return "（空）";
		try {
			const rows = await this.recentChatFn();
			const lines: string[] = [];
			for (const row of [...(rows ?? [])].slice(-limit)) {
				const role = row.role || "unknown";
				const content = String(row.content ?? "").trim();
				if (!content) continue;
				const marker = row.proactive ? " proactive=true" : "";
				lines.push(`- ${role}${marker}: ${content.replace(/\s+/g, " ").slice(0, 500)}`);
			}
			return lines.length > 0 ? lines.join("\n") : "（空）";
		} catch {
			return "（读取失败）";
		}
	}

	// ------------------------------------------------------------------
	// Tool message append (akashic _append_tool_messages)
	// ------------------------------------------------------------------
}

function formatTime(date: Date): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function clipContextText(text: string, limit: number): string {
	if (text.length <= limit) return text;
	const marker = "\n\n[context truncated by Drift budget]";
	return `${text.slice(0, Math.max(0, limit - marker.length))}${marker}`;
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** runtime_clock 段(akashic _build_runtime_clock):使用本轮上下文的 UTC + 本地时间。 */
function buildRuntimeClock(now: Date): string {
	const offsetMs = -now.getTimezoneOffset() * 60_000;
	const local = new Date(now.getTime() + offsetMs);
	const sign = offsetMs >= 0 ? "+" : "-";
	const abs = Math.abs(offsetMs);
	const offsetText = `${sign}${String(Math.floor(abs / 3600_000)).padStart(2, "0")}:${String(Math.floor((abs % 3600_000) / 60_000)).padStart(2, "0")}`;
	return `current_time_utc=${now.toISOString()}\ncurrent_time_local=${local.toISOString().replace("Z", "")}${offsetText}`;
}
