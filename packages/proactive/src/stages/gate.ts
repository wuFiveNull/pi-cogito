/**
 * 准入闸门(akashic ProactiveGateChain port)。
 *
 * 每个 tick 的第一相位:投递冷却 → anyaction 概率闸 → context_only 兜底开关。
 * 任一硬闸被触发则本轮直接结束(不判题、不 drift),与 akashic pregate 相位一致。
 * 单用户本地场景下 no_target / busy 两道闸不适用:pi 无 IM chat_id,
 * 「主 agent 忙」的检查在投递端(extension 只在会话空闲时通知)。
 */

import { type Clock, SystemClock } from "../clock.ts";
import type { ProactiveStore } from "../store.ts";
import { type AnyActionConfig, AnyActionGate } from "./anyaction.ts";
import type { GateVerdict } from "./types.ts";

export interface GateContextOnlyConfig {
	/** agent_tick_context_prob: 本轮开放 context_only 兜底的概率。 */
	probability: number;
	/** context_only_min_interval_hours: 距上次 context_only 的最小间隔。 */
	minIntervalHours: number;
	/** context_only_daily_max: 每日 context_only 上限。 */
	dailyMax: number;
}

export interface GateConfig {
	/** 目标会话 key(akashic session_key;默认 local)。 */
	sessionKey?: string;
	/** agent_tick_delivery_cooldown_hours: 投递冷却(该窗口内有投递则本轮不判题)。 */
	deliveryCooldownHours: number;
	/** 主 agent 忙检查(akashic passive_busy_fn);缺省不检查。 */
	busyFn?: (now: Date) => boolean;
	/** anyaction 概率闸;null = 禁用。 */
	anyAction: AnyActionConfig | null;
	contextOnly: GateContextOnlyConfig;
	rng?: () => number;
	/** 可注入时钟。 */
	clock?: Clock;
}

export class GateChain {
	readonly id = "gate-chain";

	private readonly store: ProactiveStore;
	private readonly config: GateConfig;
	private readonly rng: () => number;
	private readonly clock: Clock;
	private readonly sessionKey: string;
	private readonly anyActionGate: AnyActionGate | null;

	constructor(store: ProactiveStore, config: GateConfig) {
		this.store = store;
		this.config = config;
		this.rng = config.rng ?? Math.random;
		this.clock = config.clock ?? SystemClock;
		this.sessionKey = config.sessionKey ?? "local";
		this.anyActionGate = config.anyAction ? new AnyActionGate(config.anyAction, store, this.rng, this.clock) : null;
	}

	/** 本轮准入判定。blocked 时 reason 写入 tick_log 的 skip_reason。 */
	check(now: Date): GateVerdict {
		// 1. 主 agent 忙(akashic gate: busy)——缺省不启用,由宿主注入。
		if (this.config.busyFn?.(now)) {
			return { blocked: true, reason: "busy", baseScore: null, contextAsFallbackOpen: false };
		}
		// 2. 投递冷却(akashic gate: delivery_cooldown)。
		if (this.store.countDeliveriesInWindow(this.config.deliveryCooldownHours, now.getTime()) > 0) {
			return { blocked: true, reason: "cooldown", baseScore: null, contextAsFallbackOpen: false };
		}
		// 3. AnyAction 概率闸(akashic gate: anyaction)。
		if (this.anyActionGate) {
			const lastUserAt = this.store.getPresence(this.sessionKey).last_user_at;
			const { shouldAct } = this.anyActionGate.shouldAct(now, lastUserAt);
			if (!shouldAct) {
				return { blocked: true, reason: "presence", baseScore: null, contextAsFallbackOpen: false };
			}
		}
		// 4. context_only 兜底开关(akashic gate: context_as_fallback_open)。
		return {
			blocked: false,
			reason: "passed",
			baseScore: null,
			contextAsFallbackOpen: this.contextFallbackOpen(now),
		};
	}

	/** 动作成功后调用(akashic any_action_gate.record_action):投递成功 / 进入 drift。 */
	recordAction(now?: Date): void {
		this.anyActionGate?.recordAction(now ?? this.clock.now());
	}

	private contextFallbackOpen(now: Date): boolean {
		if (this.rng() >= this.config.contextOnly.probability) return false;
		const lastAt = Number(this.store.getState("lastContextOnly") ?? 0) || null;
		if (lastAt !== null && (now.getTime() - lastAt) / 3600_000 < this.config.contextOnly.minIntervalHours) {
			return false;
		}
		// 滚动 24h 窗口(akashic count_context_only_in_window),取代自然日计数。
		return this.store.countContextOnlyInWindow(24, now.getTime()) < this.config.contextOnly.dailyMax;
	}
}
