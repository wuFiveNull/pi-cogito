/**
 * Drift 阶段策略接口。
 *
 * 一个阶段 = 一个策略接口 + 可插拔实现;DriftEngine 负责编排。
 * 默认实现包住原 DriftTurnPipeline/DriftStateStore 的行为,替换任意策略
 * 即可改变对应阶段(如技能发现换成 API、执行循环换成固定脚本)。
 */

import type { DriftLlmFn, DriftRunContext } from "../runtime.ts";
import type { SkillMeta } from "../state.ts";

/** 技能发现策略:返回本轮可用的 drift skills。 */
export interface DriftScanStrategy {
	readonly id: string;
	scan(nowUtc?: Date): SkillMeta[];
}

/** 执行策略:一次完整 drift run(Prepare → Execute → Finish)。 */
export interface DriftExecutionStrategy {
	readonly id: string;
	run(ctx: DriftRunContext, llmFn: DriftLlmFn | null, skills: SkillMeta[]): Promise<boolean>;
}
