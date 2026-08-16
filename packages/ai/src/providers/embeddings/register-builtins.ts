import type { embedTexts as embedTextsSiliconFlowFunction } from "../../api/siliconflow-embeddings.ts";
import { registerEmbeddingsApiProvider } from "../../embeddings-api-registry.ts";
import type {
	EmbeddingModel,
	EmbeddingResult,
	EmbeddingsContext,
	EmbeddingsFunction,
	EmbeddingsOptions,
} from "../../types.ts";

interface SiliconFlowEmbeddingsModule {
	embedTexts: typeof embedTextsSiliconFlowFunction;
}

let siliconFlowEmbeddingsModulePromise: Promise<SiliconFlowEmbeddingsModule> | undefined;

function createLazyLoadErrorEmbedding(
	model: EmbeddingModel<"siliconflow-embeddings">,
	error: unknown,
): EmbeddingResult {
	return {
		api: model.api,
		provider: model.provider,
		model: model.id,
		embeddings: [],
		stopReason: "error",
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp: Date.now(),
	};
}

function loadSiliconFlowEmbeddingsModule(): Promise<SiliconFlowEmbeddingsModule> {
	siliconFlowEmbeddingsModulePromise ||= import("../../api/siliconflow-embeddings.ts").then(
		(module) => module as SiliconFlowEmbeddingsModule,
	);
	return siliconFlowEmbeddingsModulePromise;
}

export const embedTextsSiliconFlow: EmbeddingsFunction<"siliconflow-embeddings", EmbeddingsOptions> = async (
	model: EmbeddingModel<"siliconflow-embeddings">,
	context: EmbeddingsContext,
	options?: EmbeddingsOptions,
) => {
	try {
		const module = await loadSiliconFlowEmbeddingsModule();
		return await module.embedTexts(model, context, options);
	} catch (error) {
		return createLazyLoadErrorEmbedding(model, error);
	}
};

export function registerBuiltInEmbeddingsApiProviders(): void {
	registerEmbeddingsApiProvider({
		api: "siliconflow-embeddings",
		embedTexts: embedTextsSiliconFlow,
	});
}

registerBuiltInEmbeddingsApiProviders();
