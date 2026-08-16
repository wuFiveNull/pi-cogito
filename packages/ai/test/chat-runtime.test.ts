import { describe, expect, it } from "vitest";
import {
	type ChatCompletionClient,
	type ChatCompletionRequest,
	ChatCompletionRequestError,
	type ChatCompletionResponse,
	ChatCompletionRuntime,
	PiAiChatClient,
	ResilientChatCompletionClient,
} from "../src/chat.ts";
import type { Models } from "../src/models.ts";
import type { Api, AssistantMessage, Context, Model } from "../src/types.ts";

const model = {
	id: "test-model",
	name: "Test model",
	api: "openai-completions",
	provider: "openai",
	baseUrl: "https://example.invalid/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 4_096,
} satisfies Model<"openai-completions">;

const request: ChatCompletionRequest = {
	messages: [{ role: "user", content: "hello" }],
	maxTokens: 32,
};

function response(content: string): ChatCompletionResponse {
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: content }],
		api: "openai-completions",
		provider: "openai",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
	return { content, toolCalls: [], message };
}

function client(complete: (input: ChatCompletionRequest) => Promise<ChatCompletionResponse>): ChatCompletionClient {
	return { complete };
}

describe("PiAiChatClient", () => {
	it("uses a configured generic pi-ai Models registry", async () => {
		let receivedModel: Model<Api> | undefined;
		let receivedContext: Context | undefined;
		const models = {
			completeSimple: async (nextModel: Model<Api>, context: Context) => {
				receivedModel = nextModel;
				receivedContext = context;
				return response("generic").message;
			},
		} as unknown as Models;
		const chat = new PiAiChatClient({ models, model });

		const result = await chat.complete(request);

		expect(result.content).toBe("generic");
		expect(receivedModel).toBe(model);
		expect(receivedContext?.messages).toHaveLength(1);
	});
});

describe("ResilientChatCompletionClient", () => {
	it("uses the fallback for recoverable failures", async () => {
		let primaryCalls = 0;
		let fallbackCalls = 0;
		const resilient = new ResilientChatCompletionClient({
			primary: client(async () => {
				primaryCalls++;
				throw new ChatCompletionRequestError("service unavailable", 503);
			}),
			fallback: client(async () => {
				fallbackCalls++;
				return response("fallback");
			}),
		});

		const result = await resilient.complete(request);

		expect(result.content).toBe("fallback");
		expect(primaryCalls).toBe(1);
		expect(fallbackCalls).toBe(1);
	});

	it("does not retry aborted or non-recoverable requests", async () => {
		const abortController = new AbortController();
		abortController.abort();
		let fallbackCalls = 0;
		const resilient = new ResilientChatCompletionClient({
			primary: client(async () => {
				throw new ChatCompletionRequestError("invalid request", 400);
			}),
			fallback: client(async () => {
				fallbackCalls++;
				return response("fallback");
			}),
		});

		await expect(resilient.complete({ ...request, signal: abortController.signal })).rejects.toThrow(
			"invalid request",
		);
		expect(fallbackCalls).toBe(0);
	});
});

describe("ChatCompletionRuntime", () => {
	it("routes light work through the main fallback by default", async () => {
		const runtime = new ChatCompletionRuntime({
			main: client(async () => response("main-fallback")),
			light: client(async () => {
				throw new ChatCompletionRequestError("rate limited", 429);
			}),
		});

		const result = await runtime.complete("light", request);

		expect(result.content).toBe("main-fallback");
		expect(runtime.client("agent")).toBe(runtime.client("main"));
	});
});
