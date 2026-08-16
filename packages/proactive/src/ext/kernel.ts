/**
 * ProactiveKernel — 生命周期执行器(akashic agent/core/proactive_kernel.py 移植)。
 *
 * 持有编译后的生命周期;start/stop 生命周期;runTickResult 新建一帧、
 * 注入初始 slots、按序运行模块,返回 output。
 */

import { newProactiveFrame, type ProactiveFrame, type ProactiveTickResult } from "./frame.ts";
import { ProactiveLifecycleBuilder, type ProactiveLifecycleSpec } from "./lifecycle.ts";
import type { PhaseModule } from "./phase.ts";

export class ProactiveKernel {
	private readonly lifecycle: ReturnType<ProactiveLifecycleBuilder["build"]>;
	private readonly initialSlotsFn: ((sessionKey: string) => Record<string, unknown>) | undefined;
	private _lastResult: ProactiveTickResult | null = null;
	/** tick 异常收口回调(由装配方设置;如 default runtime 的 error tick 日志)。 */
	onTickError: ((error: unknown) => void | Promise<void>) | undefined;

	constructor(
		modules: readonly PhaseModule[],
		options: {
			lifecycle: ProactiveLifecycleSpec;
			initialSlotsFn?: (sessionKey: string) => Record<string, unknown>;
		},
	) {
		this.lifecycle = new ProactiveLifecycleBuilder().build(options.lifecycle, modules);
		this.initialSlotsFn = options.initialSlotsFn;
	}

	async start(): Promise<void> {
		await this.lifecycle.start();
	}

	async stop(): Promise<void> {
		await this.lifecycle.stop();
	}

	/** 执行一次 tick,返回 base_score(null = 无法计算)。 */
	async runTick(sessionKey: string): Promise<number | null> {
		const result = await this.runTickResult(sessionKey);
		return result?.baseScore ?? null;
	}

	/** 执行一次 tick,返回完整结果(含下次间隔)。 */
	async runTickResult(sessionKey: string): Promise<ProactiveTickResult | null> {
		const initialSlots = this.initialSlotsFn ? this.initialSlotsFn(sessionKey) : null;
		const frame = newProactiveFrame(sessionKey, initialSlots);
		const final = await this.runFrame(frame);
		this._lastResult = final.output;
		return this._lastResult;
	}

	/** 运行一帧(便于测试直接喂入)。 */
	async runFrame(frame: ProactiveFrame): Promise<ProactiveFrame> {
		return this.lifecycle.run(frame);
	}

	get lastResult(): ProactiveTickResult | null {
		return this._lastResult;
	}

	inspect(): string {
		return this.lifecycle.inspect();
	}
}
