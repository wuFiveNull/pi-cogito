/**
 * Wake 语义兴趣嵌入(pi-ai embedTexts 适配)。
 *
 * 默认 BAAI/bge-m3(siliconflow-embeddings,SILICONFLOW_API_KEY 或显式 apiKey);
 * 通过 builtinEmbeddingsModels 查找模型,找不到时按配置构造。
 * 对应 akashic 的 memory.embedding_api.embed_batch。
 */

import type { EmbeddingModel } from "@cogito/ai";
import { builtinEmbeddingsModels } from "@cogito/ai/providers/embeddings/all";
import type { WakeRuntimeDeps } from "./runtime.ts";

export interface WakeEmbeddingsConfig {
	enabled?: boolean;
	/** 嵌入模型 id,默认 BAAI/bge-m3。 */
	model?: string;
	/** API 地址,默认硅基流动。 */
	apiBaseUrl?: string;
	/** API key;缺省读 SILICONFLOW_API_KEY。 */
	apiKey?: string;
}

/** 构建嵌入 API;未配置或无 key 时返回 undefined(语义兴趣跳过,akashic 同条件)。 */
export function buildEmbeddingApi(
	config: WakeEmbeddingsConfig | undefined,
): WakeRuntimeDeps["embeddingApi"] | undefined {
	if (!config || config.enabled === false) return undefined;
	const apiKey = config.apiKey ?? process.env.SILICONFLOW_API_KEY;
	if (!apiKey) return undefined;

	const modelId = config.model ?? "BAAI/bge-m3";
	const models = builtinEmbeddingsModels();
	const found = models.getModels().find((model) => model.id === modelId) as
		| EmbeddingModel<"siliconflow-embeddings">
		| undefined;
	const model: EmbeddingModel<"siliconflow-embeddings"> = found ?? {
		id: modelId,
		api: "siliconflow-embeddings",
		provider: "siliconflow",
		baseUrl: config.apiBaseUrl ?? "https://api.siliconflow.cn/v1",
		dimensions: 1024,
		maxInputTokens: 8192,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};

	return {
		modelId: model.id,
		embedBatch: async (texts) => {
			const result = await models.embedTexts(model, { input: texts }, { apiKey });
			if (result.stopReason === "error" || result.errorMessage) {
				throw new Error(result.errorMessage ?? "embedding failed");
			}
			return result.embeddings;
		},
	};
}
