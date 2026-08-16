import { siliconflowEmbeddingsApi } from "../../api/siliconflow-embeddings.lazy.ts";
import { envApiKeyAuth } from "../../auth/helpers.ts";
import { createEmbeddingsProvider, type EmbeddingsProvider } from "../../embeddings-models.ts";

export function siliconflowEmbeddingsProvider(): EmbeddingsProvider {
	return createEmbeddingsProvider({
		id: "siliconflow",
		name: "SiliconFlow",
		auth: {
			apiKey: envApiKeyAuth("SiliconFlow API key", ["SILICONFLOW_API_KEY"]),
		},
		models: [
			{
				id: "BAAI/bge-m3",
				name: "BAAI: BGE-M3",
				api: "siliconflow-embeddings",
				provider: "siliconflow",
				baseUrl: "https://api.siliconflow.cn/v1",
				dimensions: 1024,
				maxInputTokens: 8192,
				cost: {
					input: 0.7,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
				},
			},
		],
		api: siliconflowEmbeddingsApi(),
	});
}
