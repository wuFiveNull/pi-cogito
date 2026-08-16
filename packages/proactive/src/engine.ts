/**
 * ProactiveEngine — tick 循环编排。
 *
 * 一次 tick 由生命周期模块图驱动(DefaultRuntime + ProactiveKernel):
 * gate → sense → route(idle/drift)→ judge → resolve → commit → schedule。
 * 替换生命周期/模块即可改变行为(见 lifecycles/default)。
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { EventBus } from "./bus.ts";
import { type Clock, ReplayClock, replayRandom, SystemClock } from "./clock.ts";
import { ProactiveKernel } from "./ext/kernel.ts";
import { ProactiveLoop } from "./ext/loop.ts";
import { type RuntimeSnapshotStore, withRuntimeSnapshot } from "./ext/snapshot.ts";
import { defaultLifecycleSpec } from "./lifecycles/default/index.ts";
import { buildDefaultModules } from "./lifecycles/default/modules.ts";
import { DefaultRuntime, type DefaultRuntimeDeps } from "./lifecycles/default/runtime.ts";
import type { PersonaConfig } from "./persona.ts";
import type { ProfileConfig } from "./profile.ts";
import type { ProactiveRules } from "./rules.ts";
import type { ProactiveRuntimePorts } from "./runtime/ports.ts";
import { DEFAULT_SESSION_KEY } from "./stages/sense.ts";
import type { ProactiveStages, TickResult } from "./stages/types.ts";
import type { ProactiveStore } from "./store.ts";

export interface ProactiveEngineOptions {
	sessionKey?: string;
	/** rate trace jsonl 输出路径(可选)。 */
	tracePath?: string;
	contextOnlyDailyMax?: number;
	/** 每轮候选上限(akashic agent_tick_content_limit,默认 5)。 */
	contentLimit?: number;
	rules: ProactiveRules;
	profileConfig?: ProfileConfig;
	memoryDbPath?: string;
	staticInterests?: string;
	persona?: PersonaConfig;
	/** 可注入时钟(测试用固定时间;默认系统时钟)。 */
	clock?: Clock;
	/** 事件总线(tick 终局 / 投递成功通知)。 */
	eventBus?: EventBus;
	/** Host-owned runtime ports used by the default lifecycle. */
	runtimePorts?: ProactiveRuntimePorts;
	/** 空候选闲聊分支开关(akashic get_recent_chat 低概率路径)。 */
	chatLevity?: boolean;
	/** 空候选闲聊分支触发概率(默认 0.1)。 */
	chatLevityProbability?: number;
	/** 外部组装好的 kernel(插件装配路径);缺省时按 default 生命周期自建。 */
	kernel?: ProactiveKernel;
	/** 为每个 tick 提供 snapshot lease/context 绑定。 */
	snapshotStore?: RuntimeSnapshotStore<ProactiveKernel>;
}

export class ProactiveEngine {
	private readonly stages: ProactiveStages;
	private readonly store: ProactiveStore;
	private readonly options: ProactiveEngineOptions;
	private readonly sessionKey: string;
	private readonly clock: Clock;
	private readonly runtime: DefaultRuntime | undefined;
	private readonly kernel: ProactiveKernel;
	private readonly snapshotStore: RuntimeSnapshotStore<ProactiveKernel> | undefined;
	private readonly loop: ProactiveLoop;

	constructor(stages: ProactiveStages, store: ProactiveStore, options: ProactiveEngineOptions) {
		this.stages = stages;
		this.store = store;
		this.options = options;
		this.sessionKey = options.sessionKey ?? DEFAULT_SESSION_KEY;
		this.clock = options.clock ?? SystemClock;
		this.snapshotStore = options.snapshotStore;
		if (options.kernel) {
			// 插件装配路径:kernel 由装配方构建(runtime 也在其内部)。
			this.kernel = options.kernel;
		} else {
			const runtimeDeps: DefaultRuntimeDeps = {
				stages,
				store,
				rules: options.rules,
				contextOnlyDailyMax: options.contextOnlyDailyMax ?? 1,
				contentLimit: options.contentLimit,
				clock: this.clock,
				eventBus: options.eventBus,
				profileConfig: options.profileConfig,
				memoryDbPath: options.memoryDbPath,
				staticInterests: options.staticInterests,
				persona: options.persona,
				runtimePorts: options.runtimePorts,
				chatLevity: options.chatLevity,
				chatLevityProbability: options.chatLevityProbability,
				random: this.clock instanceof ReplayClock ? replayRandom(this.clock, "default-chat-levity") : undefined,
			};
			this.runtime = new DefaultRuntime(runtimeDeps);
			this.kernel = new ProactiveKernel(buildDefaultModules(this.runtime), {
				lifecycle: defaultLifecycleSpec,
				initialSlotsFn: (sessionKey) => ({
					"proactive:session_key": sessionKey,
					"proactive:started_at": this.clock.now(),
					"proactive:last_user_at": this.store.getPresence(sessionKey).last_user_at,
				}),
			});
			this.kernel.onTickError = (error) => this.runtime?.abortError(error);
		}
		this.loop = new ProactiveLoop(this.kernel, this.sessionKey, this.snapshotStore, {
			intervalFor: async (result) => {
				const state = await this.stages.sense.sense();
				const interval =
					result?.nextIntervalSeconds ??
					this.stages.schedule.nextInterval({
						...state,
						baseScore: result?.baseScore ?? state.baseScore,
					});
				const mode = state.lastUserAt === null ? "fixed_no_presence" : "adaptive";
				this.appendTrace({
					mode,
					base_score: Math.round((result?.baseScore ?? state.baseScore) * 10000) / 10000,
					interval_seconds: interval,
					...this.stages.schedule.traceContext?.(),
				});
				return interval;
			},
		});
	}

	/** 启动 tick 循环(自适应间隔)。返回 stop 函数。 */
	async start(): Promise<{ stop: () => Promise<void> }> {
		// 启动时落一份配置快照 trace(akashic _trace_proactive_config_snapshot)。
		this.appendConfigTrace();
		const loopPromise = this.loop.run();
		return {
			stop: async () => {
				this.loop.stop();
				await loopPromise;
			},
		};
	}

	/** Execute exactly one tick without starting the wall-clock loop. */
	async runOnce(): Promise<TickResult | null> {
		return await this.tick();
	}

	// ------------------------------------------------------------------
	// Tick(生命周期模块图驱动)
	// ------------------------------------------------------------------

	private async tick(): Promise<TickResult | null> {
		try {
			const result = await this.runTickResult();
			if (!result) return { baseScore: null };
			return {
				baseScore: result.baseScore,
				nextIntervalSeconds: result.nextIntervalSeconds,
			};
		} catch (error) {
			// tick 异常:由 kernel 装配方收口(如 default runtime 的 error tick 日志),
			// 下次间隔回到 presence 驱动。
			await this.kernel.onTickError?.(error);
			return null;
		}
	}

	private async runTickResult() {
		if (!this.snapshotStore) return this.kernel.runTickResult(this.sessionKey);
		const lease = await this.snapshotStore.acquire();
		try {
			return await withRuntimeSnapshot(lease, () => lease.resource.runTickResult(this.sessionKey));
		} finally {
			await lease.release();
		}
	}

	private appendTrace(payload: Record<string, unknown>): void {
		const path = this.options.tracePath;
		if (!path) return;
		try {
			mkdirSync(join(path, ".."), { recursive: true });
			// 信封化(akashic strategy_trace envelope):trace_type/source/subject/ts/payload。
			const line = JSON.stringify({
				trace_type: "proactive_rate",
				source: "proactive.rate",
				subject: { kind: "global", id: "rate" },
				ts: new Date(this.clock.nowMs()).toISOString(),
				payload,
			});
			appendFileSync(path, `${line}\n`, "utf-8");
		} catch {
			// Trace is best-effort.
		}
	}

	/** 启动时写配置快照(akashic proactive_config_trace.jsonl)。 */
	private appendConfigTrace(): void {
		const path = this.options.tracePath;
		if (!path) return;
		try {
			mkdirSync(join(path, ".."), { recursive: true });
			const configPath = join(dirname(path), "proactive_config_trace.jsonl");
			const payload = {
				enabled: true,
				...this.stages.schedule.traceContext?.(),
			};
			const line = JSON.stringify({
				trace_type: "proactive_config",
				source: "proactive.config",
				subject: { kind: "global", id: "config" },
				ts: new Date(this.clock.nowMs()).toISOString(),
				payload,
			});
			appendFileSync(configPath, `${line}\n`, "utf-8");
		} catch {
			// Trace is best-effort.
		}
	}
}
