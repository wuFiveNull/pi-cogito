/**
 * 空闲策略(三进程模式:gate 写出;无 gateWriter 时不做事)。
 */

import { type Clock, SystemClock } from "../clock.ts";
import type { DriftGateWriter } from "../drift-gate.ts";
import type { ProactiveStore } from "../store.ts";
import type { IdleStrategy, TurnContext } from "./types.ts";

export interface DriftIdleOptions {
	store: ProactiveStore;
	/** 连续两次 drift 的最小间隔(小时)。0 = 不限。 */
	minIntervalHours: number;
	/** 三进程模式:「允许」许可的 TTL(小时);默认 max(1, minIntervalHours)。 */
	gateTtlHours?: number;
	/** 可注入时钟。 */
	clock?: Clock;
	/** 三进程模式:写 drift_gate 许可。 */
	gateWriter?: DriftGateWriter;
}

export class DriftIdleStrategy implements IdleStrategy {
	readonly id = "drift-idle";
	private readonly options: DriftIdleOptions;
	private readonly clock: Clock;

	constructor(options: DriftIdleOptions) {
		this.options = options;
		this.clock = options.clock ?? SystemClock;
	}

	async run(ctx: TurnContext): Promise<boolean> {
		const { store, gateWriter } = this.options;
		const minHours = Math.max(0, Math.trunc(this.options.minIntervalHours));
		const lastDriftAt = Number(store.getState("lastDriftAt") ?? 0) || null;
		const due = lastDriftAt === null || minHours === 0 || this.clock.nowMs() - lastDriftAt >= minHours * 3600_000;
		// 三进程模式:gate 写出(到期写 allowed,未到期写 suppressed + 剩余 TTL)。
		if (gateWriter) {
			const now = this.clock.now();
			const allowedTtlHours = Math.max(0.25, this.options.gateTtlHours ?? Math.max(1, minHours));
			if (due) {
				await gateWriter({
					sessionKey: ctx.sessionKey,
					verdict: "allowed",
					reason: "idle_due",
					grantedAt: now,
					ttlHours: allowedTtlHours,
				});
				return true;
			}
			const remainingHours =
				lastDriftAt !== null && minHours > 0
					? Math.max(0.25, (lastDriftAt + minHours * 3600_000 - this.clock.nowMs()) / 3600_000)
					: 1;
			await gateWriter({
				sessionKey: ctx.sessionKey,
				verdict: "suppressed",
				reason: "min_interval",
				grantedAt: now,
				ttlHours: remainingHours,
			});
			return false;
		}
		return false;
	}
}
