/**
 * pi-host adapters for proactive.
 *
 * Builds the wake chat seam from pi-host services (ModelRuntime auth +
 * streaming), replacing the config-based OpenAI-compatible endpoint path.
 */

import type { AssistantMessage, Model, Tool, ToolCall, ToolResultMessage, UserMessage } from "@cogito/ai";
import type {
	ChatCompletionClient,
	ChatCompletionMessage,
	ChatCompletionRequest,
	ChatCompletionResponse,
	ChatCompletionTool,
} from "@cogito/ai/chat";
import type { ModelRuntime } from "@cogito/host";
import type { WakeChatFn } from "./wake/loop-adapter.ts";

/** Options for {@link createHostChatFn}. */
export interface HostChatOptions {
	modelRuntime: ModelRuntime;
	model: Model<any>;
	/** Max tokens per call. Default: 2048. */
	maxTokens?: number;
}

function schemaToTool(schema: Record<string, unknown>): Tool {
	const fn = (schema as { function?: { name?: string; description?: string; parameters?: unknown } }).function;
	return {
		name: typeof fn?.name === "string" ? fn.name : "unknown",
		description: typeof fn?.description === "string" ? fn.description : "",
		parameters: (fn?.parameters ?? { type: "object", properties: {} }) as Tool["parameters"],
	};
}

const EMPTY_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/**
 * Wake chat seam built on pi-host's ModelRuntime. Auth resolution and
 * streaming are handled by the host (streamSimple). Note: streamSimple has no
 * provider-level forced tool choice; phases that force a tool rely on the
 * single-schema list plus wake's existing no-call retry.
 */
export function createHostChatFn(options: HostChatOptions): WakeChatFn {
	const { modelRuntime, model, maxTokens = 2048 } = options;
	return async (messages, tools, _toolChoice) => {
		const systemPrompt = messages
			.filter((message) => message.role === "system")
			.map((message) => message.content)
			.join("\n\n");
		const llmMessages: (UserMessage | AssistantMessage | ToolResultMessage)[] = messages
			.filter((message) => message.role !== "system")
			.map((message) =>
				message.role === "assistant"
					? {
							role: "assistant",
							content: [{ type: "text", text: message.content }],
							api: model.api,
							provider: model.provider,
							model: model.id,
							usage: EMPTY_USAGE,
							stopReason: "stop",
							timestamp: Date.now(),
						}
					: { role: "user", content: message.content, timestamp: Date.now() },
			);
		const response = await modelRuntime.streamSimple(
			model,
			{ systemPrompt, messages: llmMessages, tools: tools.map(schemaToTool) },
			{ maxTokens, temperature: 0 },
		);
		const message = await response.result();
		const toolCalls = message.content
			.filter((part) => part.type === "toolCall")
			.map((part) => ({ name: part.name, arguments: part.arguments as Record<string, unknown> }));
		const content =
			message.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("") || null;
		return { content, toolCalls };
	};
}

// ------------------------------------------------------------------
// ChatCompletionClient adapter(供 default 生命周期 judge/dedupe/resolve/profile 复用)
// ------------------------------------------------------------------

function chatMessageToLlm(
	message: ChatCompletionMessage,
	model: Model<any>,
): UserMessage | AssistantMessage | ToolResultMessage {
	if (message.role === "user") {
		return { role: "user", content: message.content ?? "", timestamp: Date.now() } satisfies UserMessage;
	}
	if (message.role === "assistant") {
		const content: AssistantMessage["content"] = [];
		if (message.content) content.push({ type: "text", text: message.content });
		for (const toolCall of message.toolCalls ?? []) {
			content.push({
				type: "toolCall",
				id: toolCall.id,
				name: toolCall.name,
				arguments: toolCall.arguments as Record<string, unknown>,
			} satisfies ToolCall);
		}
		return {
			role: "assistant",
			content,
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: EMPTY_USAGE,
			stopReason: "stop",
			timestamp: Date.now(),
		} satisfies AssistantMessage;
	}
	// role: "tool" → toolResult
	return {
		role: "toolResult",
		toolCallId: message.toolCallId ?? "tool-call",
		toolName: message.toolName ?? "tool",
		content: [{ type: "text", text: message.content ?? "" }],
		isError: false,
		timestamp: Date.now(),
	} satisfies ToolResultMessage;
}

function chatToolToLlm(tool: ChatCompletionTool): Tool {
	return {
		name: tool.name,
		description: tool.description ?? tool.name,
		parameters: tool.parameters as Tool["parameters"],
	};
}

function assistantToChatCompletion(message: AssistantMessage): ChatCompletionResponse {
	const content = message.content
		.filter((part): part is Extract<AssistantMessage["content"][number], { type: "text" }> => part.type === "text")
		.map((part) => part.text)
		.join("");
	const toolCalls = message.content
		.filter((part): part is ToolCall => part.type === "toolCall")
		.map((part) => ({ id: part.id, name: part.name, arguments: part.arguments as Record<string, unknown> }));
	return { content, toolCalls, message: message as never };
}

/**
 * ChatCompletionClient seam built on pi-host's ModelRuntime. Auth resolution
 * and streaming are handled by the host (streamSimple), mirroring
 * {@link createHostChatFn} for the default-lifecycle stages
 * (judge/dedupe/resolve/profile).
 */
export function createHostChatClient(options: HostChatOptions): ChatCompletionClient {
	const { modelRuntime, model, maxTokens = 2048 } = options;
	return {
		async complete(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
			const systemPrompt = request.messages
				.filter((message) => message.role === "system")
				.map((message) => message.content ?? "")
				.join("\n\n");
			const llmMessages: (UserMessage | AssistantMessage | ToolResultMessage)[] = request.messages
				.filter((message) => message.role !== "system")
				.map((message) => chatMessageToLlm(message, model));
			const response = await modelRuntime.streamSimple(
				model,
				{
					systemPrompt: systemPrompt || undefined,
					messages: llmMessages,
					tools: request.tools?.map(chatToolToLlm),
				},
				{
					maxTokens: request.maxTokens ?? maxTokens,
					temperature: request.temperature ?? 0,
					signal: request.signal,
				},
			);
			return assistantToChatCompletion(await response.result());
		},
	};
}
