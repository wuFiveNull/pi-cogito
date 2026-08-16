import type {
	EmbeddingModel,
	EmbeddingResult,
	EmbeddingsApi,
	EmbeddingsContext,
	EmbeddingsFunction,
	EmbeddingsOptions,
} from "./types.ts";

export type EmbeddingsApiFunction = (
	model: EmbeddingModel<EmbeddingsApi>,
	context: EmbeddingsContext,
	options?: EmbeddingsOptions,
) => Promise<EmbeddingResult>;

export interface EmbeddingsApiProvider<
	TApi extends EmbeddingsApi = EmbeddingsApi,
	TOptions extends EmbeddingsOptions = EmbeddingsOptions,
> {
	api: TApi;
	embedTexts: EmbeddingsFunction<TApi, TOptions>;
}

interface EmbeddingsApiProviderInternal {
	api: EmbeddingsApi;
	embedTexts: EmbeddingsApiFunction;
}

type RegisteredEmbeddingsApiProvider = {
	provider: EmbeddingsApiProviderInternal;
	sourceId?: string;
};

const embeddingsApiProviderRegistry = new Map<string, RegisteredEmbeddingsApiProvider>();

function wrapEmbedTexts<TApi extends EmbeddingsApi, TOptions extends EmbeddingsOptions>(
	api: TApi,
	embedTexts: EmbeddingsFunction<TApi, TOptions>,
): EmbeddingsApiFunction {
	return (model, context, options) => {
		if (model.api !== api) {
			throw new Error(`Mismatched api: ${model.api} expected ${api}`);
		}
		return embedTexts(model as EmbeddingModel<TApi>, context, options as TOptions);
	};
}

export function registerEmbeddingsApiProvider<TApi extends EmbeddingsApi, TOptions extends EmbeddingsOptions>(
	provider: EmbeddingsApiProvider<TApi, TOptions>,
	sourceId?: string,
): void {
	embeddingsApiProviderRegistry.set(provider.api, {
		provider: {
			api: provider.api,
			embedTexts: wrapEmbedTexts(provider.api, provider.embedTexts),
		},
		sourceId,
	});
}

export function unregisterEmbeddingsApiProviders(sourceId: string): void {
	for (const [api, entry] of embeddingsApiProviderRegistry) {
		if (entry.sourceId === sourceId) embeddingsApiProviderRegistry.delete(api);
	}
}

export function getEmbeddingsApiProvider(api: EmbeddingsApi): EmbeddingsApiProviderInternal | undefined {
	return embeddingsApiProviderRegistry.get(api)?.provider;
}
