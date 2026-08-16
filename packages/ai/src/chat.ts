import type { TSchema } from "typebox";
import { openAICompletionsApi } from "./api/openai-completions.lazy.ts";
import type { Models } from "./models.ts";
import { createModels, createProvider } from "./models.ts";
import type {
	Api,
	AssistantMessage,
	Context,
	Message,
	Model,
	ProviderHeaders,
	SimpleStreamOptions,
	Tool,
	ToolCall,
	ToolResultMessage,
	UserMessage,
} from "./types.ts";

export type ChatCompletionRole = "system" | "user" | "assistant" | "tool";

export interface ChatCompletionToolCall {
	id: string;
	name: string;
	arguments: string | Record<string, unknown>;
}

export interface ChatCompletionMessage {
	role: ChatCompletionRole;
	content?: string;
	toolCallId?: string;
	toolName?: string;
	toolCalls?: readonly ChatCompletionToolCall[];
}

export interface ChatCompletionTool {
	name: string;
	description?: string;
	parameters: unknown;
}

export type ChatCompletionToolChoice = "auto" | "none" | "required" | { type: "function"; function: { name: string } };

export interface ChatCompletionRequest {
	messages: readonly ChatCompletionMessage[];
	tools?: readonly ChatCompletionTool[];
	toolChoice?: ChatCompletionToolChoice;
	maxTokens: number;
	temperature?: number;
	apiKey?: string;
	headers?: ProviderHeaders;
	signal?: AbortSignal;
	fetchFn?: typeof fetch;
	requestTimeoutMs?: number;
	maxRetries?: number;
}

export interface ChatCompletionResponse {
	content: string;
	toolCalls: readonly ChatCompletionToolCall[];
	message: AssistantMessage;
}

export interface ChatCompletionClient {
	complete(request: ChatCompletionRequest): Promise<ChatCompletionResponse>;
}

/** Normalized request failure that preserves an available provider status code. */
export class ChatCompletionRequestError extends Error {
	readonly status: number | undefined;

	constructor(message: string, status?: number) {
		super(message);
		this.name = "ChatCompletionRequestError";
		this.status = status;
	}
}

/**
 * Provider-neutral chat client backed by an already configured pi-ai Models
 * registry. It can use any pi-ai API/provider, including credential-backed
 * providers, rather than requiring an OpenAI-compatible endpoint.
 */
export class PiAiChatClient implements ChatCompletionClient {
	private readonly models: Models;
	private readonly model: Model<Api>;
	private readonly requestTimeoutMs: number;
	private readonly maxRetries: number;

	constructor(options: {
		models: Models;
		model: Model<Api>;
		requestTimeoutMs?: number;
		maxRetries?: number;
	}) {
		this.models = options.models;
		this.model = options.model;
		this.requestTimeoutMs = Math.max(1, options.requestTimeoutMs ?? 60_000);
		this.maxRetries = Math.max(0, Math.min(5, Math.trunc(options.maxRetries ?? 2)));
	}

	async complete(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
		const context = toAiContext(request.messages, request.tools, this.model);
		const options: SimpleStreamOptions & {
			toolChoice?: ChatCompletionToolChoice;
		} = {
			apiKey: request.apiKey,
			headers: request.headers,
			signal: request.signal,
			fetch: request.fetchFn,
			timeoutMs: request.requestTimeoutMs ?? this.requestTimeoutMs,
			maxRetries: request.maxRetries ?? this.maxRetries,
			maxTokens: request.maxTokens,
			temperature: request.temperature,
			toolChoice: request.toolChoice,
		};
		try {
			const message = await this.models.completeSimple(this.model, context, options);
			return toChatCompletionResponse(message);
		} catch (error) {
			throw toChatCompletionRequestError(error);
		}
	}
}

/** A role-specific runtime client selection. */
export type ChatRuntimeRole = "main" | "light" | "agent" | "vision";

export interface ResilientChatCompletionClientOptions {
	primary: ChatCompletionClient;
	fallback: ChatCompletionClient;
	shouldFallback?: (error: unknown) => boolean;
}

/**
 * Retries a completed request through a fallback client only for recoverable
 * transport/provider failures. This client is non-streaming, so no visible
 * output can have been emitted before the fallback attempt.
 */
export class ResilientChatCompletionClient implements ChatCompletionClient {
	private readonly primary: ChatCompletionClient;
	private readonly fallback: ChatCompletionClient;
	private readonly shouldFallback: (error: unknown) => boolean;

	constructor(options: ResilientChatCompletionClientOptions) {
		this.primary = options.primary;
		this.fallback = options.fallback;
		this.shouldFallback = options.shouldFallback ?? isRecoverableChatCompletionError;
	}

	async complete(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
		try {
			return await this.primary.complete(request);
		} catch (error) {
			if (request.signal?.aborted || !this.shouldFallback(error)) throw error;
			return await this.fallback.complete(request);
		}
	}
}

export interface ChatCompletionRuntimeOptions {
	main: ChatCompletionClient;
	light?: ChatCompletionClient;
	agent?: ChatCompletionClient;
	vision?: ChatCompletionClient;
	/** Fallback used for recoverable light-model failures; defaults to `main`. */
	lightFallback?: ChatCompletionClient;
	shouldFallback?: (error: unknown) => boolean;
}

/**
 * Selects named LLM roles while keeping fallback policy at the shared adapter
 * boundary. Unconfigured roles deliberately fall back to the main client.
 */
export class ChatCompletionRuntime {
	private readonly main: ChatCompletionClient;
	private readonly light: ChatCompletionClient;
	private readonly agent: ChatCompletionClient;
	private readonly vision: ChatCompletionClient;

	constructor(options: ChatCompletionRuntimeOptions) {
		this.main = options.main;
		this.light = options.light
			? new ResilientChatCompletionClient({
					primary: options.light,
					fallback: options.lightFallback ?? options.main,
					shouldFallback: options.shouldFallback,
				})
			: options.main;
		this.agent = options.agent ?? options.main;
		this.vision = options.vision ?? options.main;
	}

	client(role: ChatRuntimeRole = "main"): ChatCompletionClient {
		switch (role) {
			case "light":
				return this.light;
			case "agent":
				return this.agent;
			case "vision":
				return this.vision;
			default:
				return this.main;
		}
	}

	async complete(role: ChatRuntimeRole, request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
		return await this.client(role).complete(request);
	}
}

export interface OpenAICompatibleChatClientOptions {
	model: string;
	baseUrl: string;
	apiKey?: string;
	requestTimeoutMs?: number;
	maxRetries?: number;
	providerId?: string;
}

/**
 * Shared non-streaming chat adapter for OpenAI-compatible endpoints.
 *
 * The transport is delegated to pi-ai's provider implementation so callers do
 * not each need to construct fetch payloads, retries, timeouts, or tool-call
 * normalization themselves.
 */
export class OpenAICompatibleChatClient implements ChatCompletionClient {
	private readonly model: Model<"openai-completions">;
	private readonly models: ReturnType<typeof createModels>;
	private readonly apiKey: string | undefined;
	private readonly requestTimeoutMs: number;
	private readonly maxRetries: number;

	constructor(options: OpenAICompatibleChatClientOptions) {
		const providerId = options.providerId ?? "openai-compatible";
		this.apiKey = options.apiKey;
		this.requestTimeoutMs = Math.max(1, options.requestTimeoutMs ?? 60_000);
		this.maxRetries = Math.max(0, Math.min(5, Math.trunc(options.maxRetries ?? 2)));
		this.model = {
			id: options.model,
			name: options.model,
			api: "openai-completions",
			provider: providerId,
			baseUrl: options.baseUrl,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 16_384,
		};

		const provider = createProvider<"openai-completions">({
			id: providerId,
			name: "OpenAI-compatible",
			models: [this.model],
			auth: {
				apiKey: {
					name: "OpenAI-compatible API key",
					resolve: async () => ({
						auth: { apiKey: options.apiKey ?? "unused" },
						source: options.apiKey ? "request configuration" : "unauthenticated endpoint",
					}),
				},
			},
			api: openAICompletionsApi(),
		});
		this.models = createModels();
		this.models.setProvider(provider);
	}

	async complete(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
		const context = toAiContext(request.messages, request.tools, this.model);
		const options: SimpleStreamOptions & {
			toolChoice?: ChatCompletionToolChoice;
		} = {
			apiKey: request.apiKey ?? this.apiKey,
			headers: request.headers,
			signal: request.signal,
			fetch: normalizeCompatibleFetch(request.fetchFn ?? globalThis.fetch),
			timeoutMs: request.requestTimeoutMs ?? this.requestTimeoutMs,
			maxRetries: request.maxRetries ?? this.maxRetries,
			maxTokens: request.maxTokens,
			temperature: request.temperature,
			toolChoice: request.toolChoice,
		};
		const message = await this.models.complete(this.model, context, options);
		return toChatCompletionResponse(message);
	}
}

function toAiContext(
	messages: readonly ChatCompletionMessage[],
	tools: readonly ChatCompletionTool[] | undefined,
	assistantModel: Pick<Model<Api>, "api" | "provider" | "id">,
): Context {
	let systemPrompt = "";
	const converted: Message[] = [];
	for (const message of messages) {
		if (message.role === "system") {
			if (message.content) systemPrompt = systemPrompt ? `${systemPrompt}\n\n${message.content}` : message.content;
			continue;
		}
		if (message.role === "user") {
			converted.push({ role: "user", content: message.content ?? "", timestamp: Date.now() } satisfies UserMessage);
			continue;
		}
		if (message.role === "assistant") {
			const content: AssistantMessage["content"] = [];
			if (message.content) content.push({ type: "text", text: message.content });
			for (const toolCall of message.toolCalls ?? []) {
				content.push({
					type: "toolCall",
					id: toolCall.id,
					name: toolCall.name,
					arguments: parseToolArguments(toolCall.arguments),
				});
			}
			converted.push({
				role: "assistant",
				content,
				api: assistantModel.api,
				provider: assistantModel.provider,
				model: assistantModel.id,
				usage: emptyUsage(),
				stopReason: "stop",
				timestamp: Date.now(),
			});
			continue;
		}
		const toolMessage: ToolResultMessage = {
			role: "toolResult",
			toolCallId: message.toolCallId ?? "tool-call",
			toolName: message.toolName ?? "tool",
			content: [{ type: "text", text: message.content ?? "" }],
			isError: false,
			timestamp: Date.now(),
		};
		converted.push(toolMessage);
	}
	return {
		systemPrompt: systemPrompt || undefined,
		messages: converted,
		tools: tools?.map((tool) => ({
			name: tool.name,
			description: tool.description ?? tool.name,
			parameters: tool.parameters as TSchema,
		})) satisfies Tool[] | undefined,
	};
}

function toChatCompletionResponse(message: AssistantMessage): ChatCompletionResponse {
	if (message.stopReason === "error" || message.stopReason === "aborted") {
		throw new ChatCompletionRequestError(message.errorMessage ?? `chat request ${message.stopReason}`);
	}
	return {
		content: message.content
			.filter(
				(block): block is Extract<AssistantMessage["content"][number], { type: "text" }> => block.type === "text",
			)
			.map((block) => block.text)
			.join(""),
		toolCalls: message.content
			.filter((block): block is ToolCall => block.type === "toolCall")
			.map((block) => ({ id: block.id, name: block.name, arguments: block.arguments })),
		message,
	};
}

/** True only for failures that can safely retry through a separate model role. */
export function isRecoverableChatCompletionError(error: unknown): boolean {
	if (error instanceof Error && error.name === "AbortError") return false;
	const status = errorStatus(error);
	if (status !== undefined) {
		return status === 408 || status === 409 || status === 429 || status >= 500;
	}
	if (!(error instanceof Error)) return false;
	const text = `${error.name} ${error.message}`.toLowerCase();
	return (
		error.name === "TypeError" ||
		text.includes("timeout") ||
		text.includes("network") ||
		text.includes("connection") ||
		text.includes("fetch failed") ||
		text.includes("econn") ||
		text.includes("rate limit")
	);
}

function toChatCompletionRequestError(error: unknown): ChatCompletionRequestError {
	if (error instanceof ChatCompletionRequestError) return error;
	const message = error instanceof Error ? error.message : String(error);
	return new ChatCompletionRequestError(message, errorStatus(error));
}

function errorStatus(error: unknown): number | undefined {
	if (typeof error !== "object" || error === null || !("status" in error)) return undefined;
	const status = error.status;
	return typeof status === "number" ? status : undefined;
}

function parseToolArguments(value: string | Record<string, unknown>): Record<string, unknown> {
	if (typeof value !== "string") return value;
	try {
		const parsed = JSON.parse(value) as unknown;
		return isRecord(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emptyUsage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function normalizeCompatibleFetch(fetchFn: typeof fetch): typeof fetch {
	return async (input, init) => {
		const response = await fetchFn(input, init);
		const contentType = response.headers?.get("content-type")?.toLowerCase() ?? "";
		if (response.ok === false || contentType.includes("text/event-stream")) return response;

		const body = await readResponseBody(response);
		if (body === undefined) return response;
		if (body.trimStart().startsWith("data:")) return responseWithBody(response, body);
		const payload = parseJsonRecord(body);
		if (!payload || !Array.isArray(payload.choices)) {
			return responseWithBody(response, body);
		}

		return responseWithBody(response, toSseBody(payload), "text/event-stream");
	};
}

async function readResponseBody(response: Response): Promise<string | undefined> {
	if (typeof response.text === "function") return response.text();
	if (typeof response.json === "function") return JSON.stringify(await response.json());
	return undefined;
}

function parseJsonRecord(value: string): Record<string, unknown> | undefined {
	try {
		const parsed = JSON.parse(value) as unknown;
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function responseWithBody(response: Response, body: string, contentType?: string): Response {
	const headers = new Headers();
	response.headers?.forEach((value, key) => {
		headers.set(key, value);
	});
	if (contentType) headers.set("content-type", contentType);
	headers.delete("content-length");
	return new Response(body, {
		status: response.status >= 200 && response.status <= 599 ? response.status : 200,
		statusText: response.statusText,
		headers,
	});
}

function toSseBody(payload: Record<string, unknown>): string {
	const choices = payload.choices as unknown[];
	const choice = isRecord(choices[0]) ? choices[0] : {};
	const message = isRecord(choice.message) ? choice.message : {};
	const toolCalls = Array.isArray(message.tool_calls)
		? message.tool_calls.flatMap((value, index) => {
				const call = isRecord(value) ? value : undefined;
				const fn = isRecord(call?.function) ? call.function : undefined;
				if (!fn || typeof fn.name !== "string") return [];
				return [
					{
						index,
						id: typeof call?.id === "string" ? call.id : `call-${index}`,
						type: "function",
						function: {
							name: fn.name,
							arguments: typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
						},
					},
				];
			})
		: [];
	const delta: Record<string, unknown> = { role: "assistant" };
	if (typeof message.content === "string") delta.content = message.content;
	if (toolCalls.length > 0) delta.tool_calls = toolCalls;
	const id = typeof payload.id === "string" ? payload.id : "chat-completion";
	const model = typeof payload.model === "string" ? payload.model : undefined;
	const finishReason =
		typeof choice.finish_reason === "string" ? choice.finish_reason : toolCalls.length > 0 ? "tool_calls" : "stop";
	const firstChunk = {
		id,
		object: "chat.completion.chunk",
		...(model ? { model } : {}),
		choices: [{ index: 0, delta, finish_reason: null }],
	};
	const usageChunk = isRecord(payload.usage)
		? {
				id,
				object: "chat.completion.chunk",
				...(model ? { model } : {}),
				choices: [],
				usage: payload.usage,
			}
		: undefined;
	const finalChunk = {
		id,
		object: "chat.completion.chunk",
		...(model ? { model } : {}),
		choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
	};
	return [firstChunk, usageChunk, finalChunk]
		.filter((chunk): chunk is typeof firstChunk => chunk !== undefined)
		.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
		.concat("data: [DONE]\n\n")
		.join("");
}
