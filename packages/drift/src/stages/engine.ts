/**
 * DriftEngine — 阶段策略编排(Scan → Execute)。
 */

import type { DriftLlmFn, DriftRunContext } from "../runtime.ts";
import type { DriftExecutionStrategy, DriftScanStrategy } from "./types.ts";

export class DriftEngine {
	private readonly scan: DriftScanStrategy;
	private readonly execute: DriftExecutionStrategy;

	constructor(scan: DriftScanStrategy, execute: DriftExecutionStrategy) {
		this.scan = scan;
		this.execute = execute;
	}

	/** 一次完整 drift run;返回是否进入(有可用 skills)。 */
	async run(ctx: DriftRunContext, llmFn: DriftLlmFn | null): Promise<boolean> {
		const skills = this.scan.scan(ctx.nowUtc);
		if (skills.length === 0) return false;
		return this.execute.run(ctx, llmFn, skills);
	}
}
