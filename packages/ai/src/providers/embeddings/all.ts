import {
	createEmbeddingsModels,
	type EmbeddingsProvider,
	type MutableEmbeddingsModels,
} from "../../embeddings-models.ts";
import type { CreateModelsOptions } from "../../models.ts";
import { siliconflowEmbeddingsProvider } from "./siliconflow.ts";

/** All built-in embeddings providers, freshly constructed. */
export function builtinEmbeddingsProviders(): EmbeddingsProvider[] {
	return [siliconflowEmbeddingsProvider()];
}

/** An `EmbeddingsModels` collection with every built-in embeddings provider registered. */
export function builtinEmbeddingsModels(options?: CreateModelsOptions): MutableEmbeddingsModels {
	const models = createEmbeddingsModels(options);
	for (const provider of builtinEmbeddingsProviders()) {
		models.setProvider(provider);
	}
	return models;
}
