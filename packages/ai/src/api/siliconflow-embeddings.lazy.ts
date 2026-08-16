import type { EmbeddingModel, ProviderEmbeddings } from "../types.ts";

export const siliconflowEmbeddingsApi = (): ProviderEmbeddings => ({
	embedTexts: async (model, context, options) =>
		(await import("./siliconflow-embeddings.ts")).embedTexts(
			model as EmbeddingModel<"siliconflow-embeddings">,
			context,
			options,
		),
});
