/**
 * Daemon 模型选择(三进程模式)。
 *
 * 纯配置驱动:由 settings.json 的 `enabledModels`(官方字段,与 --models
 * CLI flag 同格式:glob 或 "provider/modelId" 精确引用)过滤可用模型列表。
 * 未配置 enabledModels 时保持原行为(取第一个可用模型)。
 */

import type { Model } from "@cogito/ai";
import { minimatch } from "minimatch";

/** 匹配 enabledModels 模式:支持 "provider/id" 或 "id" 的精确引用与 glob。 */
function matchesEnabledPattern(model: Model<any>, pattern: string): boolean {
	const fullId = `${model.provider}/${model.id}`;
	if (pattern.includes("*") || pattern.includes("?") || pattern.includes("[")) {
		return minimatch(fullId, pattern, { nocase: true }) || minimatch(model.id, pattern, { nocase: true });
	}
	return fullId === pattern || model.id === pattern;
}

/**
 * 从可用模型里选出 daemon 模型:
 * - 配置了 enabledModels 时,只在该范围内选(空交集返回 undefined,daemon 拒绝启动);
 * - 未配置时返回第一个可用模型。
 */
export function pickDaemonModel(
	available: readonly Model<any>[],
	enabledModels?: readonly string[],
): Model<any> | undefined {
	if (!enabledModels || enabledModels.length === 0) return available[0];
	return available.find((model) => enabledModels.some((pattern) => matchesEnabledPattern(model, pattern)));
}
