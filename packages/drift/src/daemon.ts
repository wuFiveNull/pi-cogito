/**
 * Drift daemon(三进程模式的 drift 进程入口)。
 *
 * 基于 pi-host 服务(ModelRuntime 认证/模型 + SessionManager 会话读取)组装
 * drift 的 agent runtime,按 tick 循环运行:
 *   1. 读 drift_gate(proactive 写入的许可,TTL 过期视为无许可)
 *   2. 读用户活跃度(会话目录)
 *   3. advanceDriftDrive 调度(空闲时长/上次 drift/重复抑制)
 *   4. 放行则 DriftTurnPipeline 执行一轮 SKILL
 */

import { join } from "node:path";
import { advanceDriftDrive, DriftGateStore, pickDaemonModel, sampleDriftDelayHours } from "@cogito/gate";
import { createAgentSessionServices, getAgentDir, SessionManager, SettingsManager } from "@cogito/host";
import { createHostDriftLlmFn, createHostRecentChatFn } from "./host.ts";
import { seedExampleDriftSkill } from "./index.ts";
import { createDriftContext, DriftTurnPipeline } from "./runtime.ts";
import { DriftStateStore } from "./state.ts";

/** Options for {@link runDriftDaemon}. */
export interface DriftDaemonOptions {
	/** Drift 工作区/状态目录(默认 <cwd>/.cogito/extensions/drift)。 */
	driftDir?: string;
	/** 目标会话 key(默认 local)。 */
	sessionKey?: string;
	/** tick 间隔(秒,默认 300)。 */
	tickIntervalSeconds?: number;
	/** 可注入时钟(测试用)。 */
	nowFn?: () => Date;
	/** 单轮 Drift 步数上限(默认 20)。 */
	maxSteps?: number;
	/** 单轮 Drift 时长上限(毫秒,默认 10 分钟)。 */
	maxDurationMs?: number;
	/** 错误回调(默认 console.error)。 */
	onError?: (error: unknown) => void;
}

function parseTime(value: string | null | undefined): Date | null {
	if (!value) return null;
	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** 最近用户消息时间(从默认会话分支读取)。 */
function readLastUserActivity(sessionManager: SessionManager): Date | null {
	try {
		const branch = sessionManager.getBranch();
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i]!;
			if (entry.type !== "message") continue;
			const message = (entry as { message?: { role?: string } }).message;
			if (message?.role !== "user") continue;
			const timestamp = parseTime(entry.timestamp);
			if (timestamp) return timestamp;
		}
		return null;
	} catch {
		return null;
	}
}

// ------------------------------------------------------------------
// 一次性到期采样(akashic wake _drift_timer_anchor / sample_drift_delay_hours)
// ------------------------------------------------------------------

export interface DriftTimerInput {
	now: Date;
	/** 活动状态指纹(last_user_at/last_drift_at/repetition)。 */
	anchor: string;
	lastUserAt: Date | null;
	lastDriftAt: Date | null;
	repetition: number;
}

export interface DriftTimerResult {
	/** now >= next_attempt_at 时到期。 */
	due: boolean;
	nextAttemptAt: Date;
	/** 本轮是否重新采样并持久化(anchor 变化/缺失/损坏)。 */
	resampled: boolean;
}

/**
 * 读取/刷新一次性 drift 到期事件(akashic _schedule_drift_attempt):
 * anchor 变化或缺失才重新采样;普通 tick 直接复用持久化的 next_attempt_at。
 */
export function checkDriftTimer(store: DriftStateStore, sessionKey: string, input: DriftTimerInput): DriftTimerResult {
	const timer = store.loadDriftTimer(sessionKey);
	const storedNext = timer ? parseTime(timer.nextAttemptAt) : null;
	if (!timer || timer.timerAnchor !== input.anchor || storedNext === null) {
		const nextAttemptAt = sampleNextAttempt(
			input.now,
			input.anchor,
			input.lastUserAt,
			input.lastDriftAt,
			input.repetition,
		);
		store.saveDriftTimer({ sessionKey, timerAnchor: input.anchor, nextAttemptAt, updatedAt: input.now });
		return { due: input.now.getTime() >= nextAttemptAt.getTime(), nextAttemptAt, resampled: true };
	}
	return { due: input.now.getTime() >= storedNext.getTime(), nextAttemptAt: storedNext, resampled: false };
}

/** 活动状态指纹:任一输入变化都触发重新采样(akashic _drift_timer_anchor)。 */
function driftTimerAnchor(lastUserAt: Date | null, lastDriftAt: Date | null, repetition: number): string {
	return [
		lastUserAt !== null ? lastUserAt.toISOString() : "none",
		lastDriftAt !== null ? lastDriftAt.toISOString() : "none",
		repetition.toFixed(6),
	].join("|");
}

/** 从递增空闲 hazard 采样下一次尝试的到期时刻(akashic _schedule_drift_attempt)。 */
function sampleNextAttempt(
	now: Date,
	seed: string,
	lastUserAt: Date | null,
	lastDriftAt: Date | null,
	repetition: number,
): Date {
	const idleHours = lastUserAt !== null ? Math.max(0, (now.getTime() - lastUserAt.getTime()) / 3600_000) : 0;
	const recentDrift =
		lastDriftAt !== null ? Math.exp(-Math.max(0, (now.getTime() - lastDriftAt.getTime()) / 1000) / (6 * 3600)) : 0;
	const delayHours = sampleDriftDelayHours({
		randomDraw: seededRandom(`drift-timer:${seed}`),
		idleHours,
		recentDriftSuppression: recentDrift,
		repetitionSuppression: repetition,
	});
	return new Date(now.getTime() + delayHours * 3600_000);
}

/** 确定性随机源(anchor 驱动;避免每次 tick 重采样抖动,测试可复现)。 */
function seededRandom(seed: string): number {
	let h = 1779033703;
	for (let i = 0; i < seed.length; i++) {
		h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
		h = (h << 13) | (h >>> 19);
	}
	h = Math.imul(h ^ (h >>> 16), 2246822507);
	h = Math.imul(h ^ (h >>> 13), 3266489909);
	h ^= h >>> 16;
	let t = h >>> 0;
	t += 0x6d2b79f5;
	t = Math.imul(t ^ (t >>> 15), t | 1);
	t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/**
 * 启动 drift daemon(常驻,直到进程退出)。
 * 需要 host 的模型/认证配置(agentDir/auth.json + models.json)。
 */
export async function runDriftDaemon(options: DriftDaemonOptions = {}): Promise<void> {
	const cwd = process.cwd();
	const agentDir = getAgentDir();
	// 挂载目录统一在项目 .cogito/extensions 下(与 proactive 扩展同层)。
	const driftDir = options.driftDir ?? join(cwd, ".cogito", "extensions", "drift");
	const sessionKey = options.sessionKey ?? "local";
	const tickIntervalSeconds = options.tickIntervalSeconds ?? 300;
	const nowFn = options.nowFn ?? (() => new Date());
	const onError = options.onError ?? ((error: unknown) => console.error("drift daemon tick failed", error));

	const settingsManager = SettingsManager.create(cwd, agentDir);
	const services = await createAgentSessionServices({ cwd, agentDir, settingsManager });
	const models = await services.modelRuntime.getAvailable();
	const model = pickDaemonModel(models, settingsManager.getEnabledModels());
	if (!model) {
		throw new Error(
			"No allowed model available. Configure a model and API key first (opencode-go only allows deepseek-v4-flash).",
		);
	}
	const sessionManager = SessionManager.create(cwd);
	const store = new DriftStateStore({ driftDir });
	const gateStore = new DriftGateStore({ driftDir });
	// 种入内置示例技能(create-drift-skill 等,幂等:已存在则跳过),让 agent 能在
	// 对话/漂移中创建新技能。示例案例技能在 packages/drift/examples/skills。
	seedExampleDriftSkill(join(driftDir, "skills"));
	const recentChatFn = createHostRecentChatFn({ sessionManager });
	const llmFn = createHostDriftLlmFn({ modelRuntime: services.modelRuntime, model });

	const tick = async (): Promise<void> => {
		const now = nowFn();
		// 1. gate:suppressed 时跳过,直到 TTL 过期(readDriftGate 过期返回 null)。
		const gate = gateStore.readDriftGate(sessionKey, now);
		if (gate?.verdict === "suppressed") return;

		// 2. presence + drive 调度(重复抑制来自上次成功指纹)。
		const lastUserAt = readLastUserActivity(sessionManager);
		const lastRun = store.loadDrift().recentRuns[0];
		const lastDriftAt = lastRun ? parseTime(String(lastRun.run_at ?? "")) : null;
		const repeat = store.loadDriftRepeat(sessionKey);
		const repetition = Math.min(1, repeat.repeatCount / 3);
		const result = advanceDriftDrive({
			now,
			hazard: 0,
			threshold: 0,
			updatedAt: now,
			lastUserAt,
			lastDriftAt,
			contentEvidence: 0,
			repetition,
		});
		if (result.decision !== "attempt") return;

		// 3. 一次性到期采样(akashic wake _drift_timer_anchor + sample_drift_delay_hours):
		//    anchor 变化或缺失才重新采样;未到期跳过,轮询只是唤醒机制。
		const anchor = driftTimerAnchor(lastUserAt, lastDriftAt, repetition);
		const timerResult = checkDriftTimer(store, sessionKey, {
			now,
			anchor,
			lastUserAt,
			lastDriftAt,
			repetition,
		});
		store.recordDriftObservation({
			sessionKey,
			kind: "tick",
			now,
			payload: {
				gate: gate?.verdict ?? "none",
				decision: result.decision,
				rate: result.rate,
				repetition,
				next_attempt_at: timerResult.nextAttemptAt.toISOString(),
				timer_resampled: timerResult.resampled,
			},
		});
		if (!timerResult.due) return;

		// 4. 执行一轮 Drift(gate 携带的上下文事件预取给 driftCurrentContext)。
		const ctx = createDriftContext(sessionKey, now);
		if (gate?.context) ctx.driftCurrentContext = gate.context;
		const pipeline = new DriftTurnPipeline({
			store,
			toolDeps: { driftDir, store, workspaceDir: driftDir },
			recentChatFn,
			maxSteps: options.maxSteps ?? 20,
			maxDurationMs: options.maxDurationMs ?? 10 * 60_000,
		});
		const ran = await pipeline.run(ctx, llmFn);
		if (!ran) {
			// 未进入(无可用 skills / 无 LLM):重新采样,避免热循环重试。
			const retryAt = sampleNextAttempt(now, `${anchor}:retry`, lastUserAt, lastDriftAt, repetition);
			store.saveDriftTimer({ sessionKey, timerAnchor: anchor, nextAttemptAt: retryAt, updatedAt: now });
			return;
		}

		// 4. 观测:成功提交的出站消息记指纹,供后续轮重复抑制。
		const hasOutbound =
			ctx.draftMessage.trim().length > 0 || ctx.draftMedia.length > 0 || ctx.draftAttachments.length > 0;
		if (hasOutbound && ctx.driftMessageCommitted) {
			const fingerprint =
				ctx.draftMessage.trim().toLowerCase() ||
				JSON.stringify({ media: ctx.draftMedia, attachments: ctx.draftAttachments });
			store.recordDriftSuccess({ sessionKey, now, fingerprint });
		}
	};

	// 常驻循环;SIGINT/SIGTERM 优雅退出。
	let shuttingDown = false;
	const shutdown = (): void => {
		shuttingDown = true;
		process.exit(0);
	};
	process.once("SIGINT", shutdown);
	process.once("SIGTERM", shutdown);
	for (;;) {
		if (shuttingDown) return;
		try {
			await tick();
		} catch (error) {
			onError(error);
		}
		await new Promise((resolve) => setTimeout(resolve, tickIntervalSeconds * 1000));
	}
}
