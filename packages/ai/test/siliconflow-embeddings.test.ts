import { beforeEach, describe, expect, it, vi } from "vitest";
import { embedTexts } from "../src/embeddings.ts";
import { builtinEmbeddingsModels } from "../src/providers/all.ts";
import type { EmbeddingModel, EmbeddingsContext } from "../src/types.ts";

const mockState = vi.hoisted(() => ({
	lastParams: undefined as unknown,
	lastRequestOptions: undefined as unknown,
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		embeddings = {
			create: (params: unknown, requestOptions?: unknown) => {
				mockState.lastParams = params;
				mockState.lastRequestOptions = requestOptions;
				const signal = (requestOptions as { signal?: AbortSignal } | undefined)?.signal;
				if (signal?.aborted) {
					const error = new Error("Request aborted");
					return {
						withResponse: async () => {
							throw error;
						},
					};
				}
				const response = {
					object: "list",
					model: params ? (params as { model: string }).model : "",
					data: [
						{ object: "embedding", embedding: [0.1, 0.2, 0.3], index: 0 },
						{ object: "embedding", embedding: [0.4, 0.5, 0.6], index: 1 },
					],
					usage: { prompt_tokens: 7, total_tokens: 7 },
				};
				return {
					withResponse: async () => ({ data: response, response: { status: 200, headers: new Headers() } }),
				};
			},
		};
	}
	return { default: FakeOpenAI };
});

const model: EmbeddingModel<"siliconflow-embeddings"> = {
	id: "BAAI/bge-m3",
	api: "siliconflow-embeddings",
	provider: "siliconflow",
	baseUrl: "https://api.siliconflow.cn/v1",
	dimensions: 1024,
	cost: { input: 0.7, output: 0, cacheRead: 0, cacheWrite: 0 },
};

const context: EmbeddingsContext = { input: ["first text", "second text"] };

beforeEach(() => {
	mockState.lastParams = undefined;
	mockState.lastRequestOptions = undefined;
});

describe("embedTexts through the siliconflow api", () => {
	it("embeds all inputs and reports usage", async () => {
		const result = await embedTexts(model, context, { apiKey: "test-key" });
		expect(result.stopReason).toBe("stop");
		expect(result.embeddings).toEqual([
			[0.1, 0.2, 0.3],
			[0.4, 0.5, 0.6],
		]);
		expect(result.usage).toEqual(
			expect.objectContaining({
				input: 7,
				totalTokens: 7,
				cost: expect.objectContaining({ total: expect.any(Number) }),
			}),
		);
		expect(mockState.lastParams).toEqual({
			model: "BAAI/bge-m3",
			input: ["first text", "second text"],
			encoding_format: "float",
		});
	});

	it("returns an error result when no API key is set", async () => {
		const result = await embedTexts(model, context);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("No API key");
		expect(result.embeddings).toEqual([]);
	});

	it("marks the result aborted when the signal is aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		const result = await embedTexts(model, context, { apiKey: "test-key", signal: controller.signal });
		expect(result.stopReason).toBe("aborted");
	});
});

describe("EmbeddingsModels provider composition", () => {
	it("registers the built-in siliconflow provider", () => {
		const models = builtinEmbeddingsModels();
		const provider = models.getProvider("siliconflow");
		expect(provider?.name).toBe("SiliconFlow");
		expect(models.getModel("siliconflow", "BAAI/bge-m3")).toMatchObject({ dimensions: 1024 });
		expect(models.getModels().length).toBe(1);
	});

	it("embeds through the provider with auth resolution", async () => {
		const models = builtinEmbeddingsModels();
		const result = await models.embedTexts(model, context, { apiKey: "test-key" });
		expect(result.stopReason).toBe("stop");
		expect(result.embeddings.length).toBe(2);
	});

	it("never rejects: unknown provider yields an error result", async () => {
		const models = builtinEmbeddingsModels();
		const result = await models.embedTexts(
			{ ...model, provider: "unknown" } as EmbeddingModel<"siliconflow-embeddings">,
			context,
		);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Unknown provider");
	});
});
