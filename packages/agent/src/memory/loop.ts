/**
 * 记忆优化循环(akashic memory_optimizer.py MemoryOptimizerLoop 移植)。
 *
 * 对齐整点间隔运行:默认 64800s(18h),计算距下一个 interval 对齐点的秒数,
 * 避免漂移;单轮失败只记日志不终止。
 */

import type { MemoryOptimizer } from "./optimizer.ts";

const DEFAULT_INTERVAL_SECONDS = 64800; // 每 18 小时整点

/** 距下一个 interval 对齐整点的秒数(akashic _seconds_until_next_tick)。 */
export function secondsUntilAlignedInterval(now: Date, interval: number): number {
	const nowSeconds = Math.floor(now.getTime() / 1000);
	const aligned = Math.floor(nowSeconds / interval) * interval;
	return Math.max(1, aligned + interval - nowSeconds);
}

export class MemoryOptimizerLoop {
	private readonly optimizer: MemoryOptimizer | null;
	private readonly interval: number;
	private readonly nowFn: () => Date;
	private running = false;
	private wakeSleep: (() => void) | undefined;
	private optimizePromise: Promise<void> | undefined;

	constructor(options: { optimizer: MemoryOptimizer | null; intervalSeconds?: number; nowFn?: () => Date }) {
		this.optimizer = options.optimizer;
		this.interval = Math.max(60, options.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS);
		this.nowFn = options.nowFn ?? (() => new Date());
	}

	async run(): Promise<void> {
		this.running = true;
		while (this.running) {
			const seconds = this.secondsUntilNextTick();
			await this.sleep(seconds * 1000);
			if (!this.running) break;
			try {
				await this.optimizeNow();
			} catch {
				// 单轮失败不终止循环。
			}
		}
	}

	/** 立即执行一轮优化；与定时循环串行，避免同时修改 MEMORY/SELF。 */
	async optimizeNow(): Promise<void> {
		if (!this.optimizer) return;
		if (this.optimizePromise) return this.optimizePromise;
		const running = this.optimizer.optimize();
		this.optimizePromise = running;
		try {
			await running;
		} finally {
			if (this.optimizePromise === running) this.optimizePromise = undefined;
		}
	}

	stop(): void {
		this.running = false;
		this.wakeSleep?.();
	}

	/** 距下一个对齐整点的秒数(akashic _seconds_until_next_tick)。 */
	secondsUntilNextTick(): number {
		return secondsUntilAlignedInterval(this.nowFn(), this.interval);
	}

	private sleep(ms: number): Promise<void> {
		return new Promise<void>((resolve) => {
			this.wakeSleep = resolve;
			setTimeout(() => {
				this.wakeSleep = undefined;
				resolve();
			}, ms);
		});
	}
}
