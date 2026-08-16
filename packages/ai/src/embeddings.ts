import "./providers/embeddings/register-builtins.ts";

import { getEmbeddingsApiProvider } from "./embeddings-api-registry.ts";
import type { EmbeddingModel, EmbeddingResult, EmbeddingsApi, EmbeddingsContext, EmbeddingsOptions } from "./types.ts";

function resolveEmbeddingsApiProvider(api: EmbeddingsApi) {
	const provider = getEmbeddingsApiProvider(api);
	if (!provider) {
		throw new Error(`No API provider registered for api: ${api}`);
	}
	return provider;
}

/** Embed a batch of texts through the model's registered embeddings API. */
export async function embedTexts<TApi extends EmbeddingsApi>(
	model: EmbeddingModel<TApi>,
	context: EmbeddingsContext,
	options?: EmbeddingsOptions,
): Promise<EmbeddingResult> {
	const provider = resolveEmbeddingsApiProvider(model.api);
	return provider.embedTexts(model, context, options);
}
