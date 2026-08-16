/**
 * Drift's LLM boundary.
 *
 * Transport and OpenAI-compatible payload handling live in pi-ai. Drift only
 * keeps the small tool-call contract it needs for its turn pipeline.
 */

import {
	type ChatCompletionClient,
	type ChatCompletionMessage,
	type ChatCompletionTool,
	type ChatCompletionToolChoice,
	OpenAICompatibleChatClient,
} from "@cogito/ai/chat";

export type DriftChatToolChoice = string | { type: string; function: { name: string } };

export interface DriftChatRequest {
	messages: readonly Record<string, unknown>[];
	schemas: readonly Record<string, unknown>[];
	toolChoice: DriftChatToolChoice;
	maxTokens: number;
	temperature?: number;
}

export interface DriftChatToolCall {
	id: string;
	name: string;
	arguments: string | Record<string, unknown>;
}

export interface DriftChatResponse {
	toolCalls: readonly DriftChatToolCall[];
	/** LLM usage(cache read/write;akashic record_llm_cache 的 pi 形态)。 */
	usage?: { cacheRead: number; cacheWrite: number };
}

export interface DriftChatClient {
	complete(request: DriftChatRequest): Promise<DriftChatResponse | null>;
}

export class DriftLlmRequestError extends Error {
	readonly status: number | undefined;

	constructor(message: string, status?: number) {
		super(message);
		this.name = "DriftLlmRequestError";
		this.status = status;
	}
}

export interface OpenAICompatibleDriftChatClientOptions {
	model: string;
	baseUrl: string;
	apiKey?: string;
	requestTimeoutMs?: number;
	maxRetries?: number;
	/** Kept for host compatibility; retry timing is owned by pi-ai. */
	retryDelayMs?: number;
	fetchFn?: typeof fetch;
	/** Optional shared runtime role client, including fallback policy. */
	client?: ChatCompletionClient;
}

/** Drift adapter backed by the shared pi-ai OpenAI-compatible client. */
export class OpenAICompatibleDriftChatClient implements DriftChatClient {
	private readonly client: ChatCompletionClient;
	private readonly fetchFn: typeof fetch | undefined;

	constructor(options: OpenAICompatibleDriftChatClientOptions) {
		this.fetchFn = options.fetchFn;
		this.client =
			options.client ??
			new OpenAICompatibleChatClient({
				model: options.model,
				baseUrl: options.baseUrl,
				apiKey: options.apiKey,
				requestTimeoutMs: options.requestTimeoutMs,
				maxRetries: options.maxRetries,
			});
	}

	async complete(request: DriftChatRequest): Promise<DriftChatResponse | null> {
		const response = await this.client.complete({
			messages: request.messages.map(toChatMessage),
			tools: request.schemas.map(toChatTool),
			toolChoice: toChatToolChoice(request.toolChoice),
			maxTokens: request.maxTokens,
			temperature: request.temperature,
			fetchFn: this.fetchFn,
		});
		return {
			toolCalls: response.toolCalls.map((call) => ({
				id: call.id,
				name: call.name,
				arguments: typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments),
			})),
			usage: response.message.usage
				? {
						cacheRead: response.message.usage.cacheRead ?? 0,
						cacheWrite: response.message.usage.cacheWrite ?? 0,
					}
				: undefined,
		};
	}
}

function toChatMessage(value: Record<string, unknown>): ChatCompletionMessage {
	const role = value.role;
	if (role === "system" || role === "user") {
		return { role, content: typeof value.content === "string" ? value.content : "" };
	}
	if (role === "assistant") {
		const rawCalls = Array.isArray(value.tool_calls) ? value.tool_calls : [];
		return {
			role,
			content: typeof value.content === "string" ? value.content : undefined,
			toolCalls: rawCalls.flatMap((raw) => {
				const call = asRecord(raw);
				const fn = asRecord(call?.function);
				const id = typeof call?.id === "string" ? call.id : "drift-call";
				const name = typeof fn?.name === "string" ? fn.name : "";
				return name ? [{ id, name, arguments: typeof fn?.arguments === "string" ? fn.arguments : {} }] : [];
			}),
		};
	}
	return {
		role: "tool",
		content: typeof value.content === "string" ? value.content : "",
		toolCallId: typeof value.tool_call_id === "string" ? value.tool_call_id : undefined,
	};
}

function toChatTool(value: Record<string, unknown>): ChatCompletionTool {
	const fn = asRecord(value.function) ?? value;
	return {
		name: typeof fn.name === "string" ? fn.name : "tool",
		description: typeof fn.description === "string" ? fn.description : undefined,
		parameters: fn.parameters ?? { type: "object" },
	};
}

function toChatToolChoice(value: DriftChatToolChoice): ChatCompletionToolChoice {
	if (value === "auto" || value === "none" || value === "required") return value;
	if (typeof value === "object" && value.type === "function") {
		return { type: "function", function: { name: value.function.name } };
	}
	return "auto";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}
