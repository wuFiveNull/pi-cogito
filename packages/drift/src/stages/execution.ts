/**
 * 默认执行策略:DriftTurnPipeline(LLM 工具循环)。
 */

import type { DriftLlmFn, DriftRunContext, DriftTurnPipelineDeps } from "../runtime.ts";
import { DriftTurnPipeline } from "../runtime.ts";
import type { SkillMeta } from "../state.ts";
import type { DriftExecutionStrategy } from "./types.ts";

export class TurnPipelineExecutionStrategy implements DriftExecutionStrategy {
	readonly id = "turn-pipeline";
	private readonly pipeline: DriftTurnPipeline;

	constructor(deps: DriftTurnPipelineDeps) {
		this.pipeline = new DriftTurnPipeline(deps);
	}

	async run(ctx: DriftRunContext, llmFn: DriftLlmFn | null, skills: SkillMeta[]): Promise<boolean> {
		if (llmFn === null) return false;
		return this.pipeline.run(ctx, llmFn, skills);
	}
}
