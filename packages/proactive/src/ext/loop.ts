/**
 * ProactiveLoop — 通用 kernel 循环(akashic ProactiveLoop._run_loop 的最小形态)。
 *
 * 首轮立即 tick,之后按 kernel 返回的 nextIntervalSeconds 或生命周期提供的
 * intervalFor 休眠;单 tick 异常不终止循环(无调度 hook 时等待 60s 重试)。
 * default、wake 和自定义生命周期共用这一层,差异只放在 intervalFor。
 */

import type { ProactiveTickResult } from "./frame.ts";
import type { ProactiveKernel } from "./kernel.ts";
import { type RuntimeSnapshotStore, withRuntimeSnapshot } from "./snapshot.ts";

export interface ProactiveLoopOptions {
	/** Used when a lifecycle does not return a next interval. */
	defaultIntervalSeconds?: number;
	/** Backoff after a tick or interval calculation fails. */
	errorIntervalSeconds?: number;
	/** Shared scheduling hook used by the default lifecycle's presence policy. */
	intervalFor?(result: ProactiveTickResult | null): number | Promise<number>;
}

export class ProactiveLoop {
	private readonly kernel: ProactiveKernel;
	private readonly sessionKey: string;
	private readonly snapshotStore: RuntimeSnapshotStore<ProactiveKernel> | undefined;
	private readonly options: ProactiveLoopOptions;
	private running = false;
	private wakeSleep: (() => void) | undefined;

	constructor(
		kernel: ProactiveKernel,
		sessionKey = "local",
		snapshotStore?: RuntimeSnapshotStore<ProactiveKernel>,
		options: ProactiveLoopOptions = {},
	) {
		this.kernel = kernel;
		this.sessionKey = sessionKey;
		this.snapshotStore = snapshotStore;
		this.options = options;
	}

	async run(): Promise<void> {
		this.running = true;
		let pendingIntervalSeconds: number | null = 0;
		let lastResult: ProactiveTickResult | null = null;
		while (this.running) {
			try {
				const interval =
					pendingIntervalSeconds ??
					(await this.options.intervalFor?.(lastResult)) ??
					lastResult?.nextIntervalSeconds ??
					this.options.defaultIntervalSeconds ??
					300;
				pendingIntervalSeconds = null;
				if (interval > 0) await this.sleep(Math.max(1, interval) * 1000);
				if (!this.running) return;
				lastResult = await this.runTick();
			} catch (error) {
				// 单 tick 异常不终止循环(akashic _run_loop 同),但必须先
				// 交给 runtime 收口,否则 wake/custom 生命周期没有错误 tick。
				try {
					await this.kernel.onTickError?.(error);
				} catch (handlerError) {
					console.error(
						`proactive tick error handler failed: ${handlerError instanceof Error ? handlerError.message : String(handlerError)}`,
					);
				}
				if (!this.running) return;
				lastResult = null;
				try {
					pendingIntervalSeconds =
						(await this.options.intervalFor?.(null)) ?? this.options.errorIntervalSeconds ?? 60;
				} catch {
					pendingIntervalSeconds = this.options.errorIntervalSeconds ?? 60;
				}
			}
			if (!this.running) return;
		}
	}

	private async runTick() {
		if (!this.snapshotStore) return this.kernel.runTickResult(this.sessionKey);
		const lease = await this.snapshotStore.acquire();
		try {
			return await withRuntimeSnapshot(lease, () => lease.resource.runTickResult(this.sessionKey));
		} finally {
			await lease.release();
		}
	}

	stop(): void {
		this.running = false;
		this.wakeSleep?.();
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
