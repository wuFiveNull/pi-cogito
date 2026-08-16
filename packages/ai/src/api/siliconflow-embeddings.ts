import OpenAI from "openai";
import type { EmbeddingCreateParams } from "openai/resources/embeddings.js";
import type {
	EmbeddingModel,
	EmbeddingResult,
	EmbeddingsContext,
	EmbeddingsFunction,
	EmbeddingsOptions,
	ProviderHeaders,
} from "../types.ts";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import { headersToRecord, providerHeadersToRecord } from "../utils/headers.ts";
import { retryProviderRequest } from "../utils/provider-retry.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";

export const embedTexts: EmbeddingsFunction<"siliconflow-embeddings", EmbeddingsOptions> = async (
	model: EmbeddingModel<"siliconflow-embeddings">,
	context: EmbeddingsContext,
	options?: EmbeddingsOptions,
) => {
	const result: EmbeddingResult = {
		api: model.api,
		provider: model.provider,
		model: model.id,
		embeddings: [],
		stopReason: "stop",
		timestamp: Date.now(),
	};

	try {
		const apiKey = options?.apiKey;
		if (!apiKey) {
			throw new Error(`No API key for provider: ${model.provider}`);
		}
		const client = createClient(model, apiKey, options?.headers, options?.fetch);
		let params = buildParams(model, context);
		const nextParams = await options?.onPayload?.(params, model);
		if (nextParams !== undefined) {
			params = nextParams as typeof params;
		}
		const requestOptions = {
			...(options?.signal ? { signal: options.signal } : {}),
			...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
			maxRetries: 0,
		};
		const { data: response, response: rawResponse } = await retryProviderRequest(
			() => client.embeddings.create(params as unknown as EmbeddingCreateParams, requestOptions).withResponse(),
			{
				maxRetries: options?.maxRetries,
				maxRetryDelayMs: options?.maxRetryDelayMs,
				signal: options?.signal,
			},
		);
		await options?.onResponse?.({ status: rawResponse.status, headers: headersToRecord(rawResponse.headers) }, model);

		result.embeddings = response.data.map((item) => item.embedding);
		if (response.usage) {
			const input = response.usage.prompt_tokens ?? 0;
			result.usage = {
				input,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: input,
				cost: {
					input: (model.cost.input / 1_000_000) * input,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					total: (model.cost.input / 1_000_000) * input,
				},
			};
		}
		return result;
	} catch (error) {
		result.stopReason = options?.signal?.aborted ? "aborted" : "error";
		result.errorMessage = formatProviderError(normalizeProviderError(error));
		return result;
	}
};

function createClient(
	model: EmbeddingModel<"siliconflow-embeddings">,
	apiKey: string,
	optionsHeaders?: ProviderHeaders,
	fetch?: typeof globalThis.fetch,
): OpenAI {
	return new OpenAI({
		apiKey,
		baseURL: model.baseUrl,
		dangerouslyAllowBrowser: true,
		fetch,
		defaultHeaders: providerHeadersToRecord({ ...model.headers, ...optionsHeaders }),
	});
}

function buildParams(
	model: EmbeddingModel<"siliconflow-embeddings">,
	context: EmbeddingsContext,
): EmbeddingCreateParams {
	return {
		model: model.id,
		input: context.input.map((text) => sanitizeSurrogates(text)),
		encoding_format: "float",
	};
}
