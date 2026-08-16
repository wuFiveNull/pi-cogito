/**
 * Wake agent-loop adapter.
 *
 * Drives one wake phase's LLM call through pi-agent-core's runAgentLoop,
 * reusing the agent runtime (turn orchestration, streaming protocol, abort,
 * message conversion) instead of the bespoke single-call path.
 *
 * Each wake phase stays single-turn: the loop stops after the first turn
 * (shouldStopAfterTurn), and tool execution remains in the wake runtime
 * (executeWakeTool / executeEventTool), preserving wake's retry and phase
 * validation semantics. The chat seam (WakeRuntimeDeps.chat) is unchanged.
 */

import type { AgentLoopConfig, AgentMessage, StreamFn } from "@cogito/agent-core";
import { runAgentLoop } from "@cogito/agent-core";
import type { AssistantMessage, AssistantMessageEvent, Model } from "@cogito/ai";
import { EventStream } from "@cogito/ai/utils/event-stream";
import type { ChatToolCall } from "./runtime.ts";

/** One wake chat invocation (identical to WakeRuntimeDeps.chat's contract). */
export type WakeChatFn = (
	messages: Array<{ role: string; content: string }>,
	tools: Array<{
		type: "function";
		function: { name: string; description: string; parameters: Record<string, unknown> };
	}>,
	toolChoice: "required" | "auto" | { type: "function"; function: { name: string } },
) => Promise<{ content: string | null; toolCalls: ChatToolCall[] }>;

/** Options for {@link runWakeTurn}. */
export interface WakeTurnOptions {
	chat: WakeChatFn;
	/** LLM-facing schemas for this phase (function format). */
	schemas: Array<{
		type: "function";
		function: { name: string; description: string; parameters: Record<string, unknown> };
	}>;
	toolChoice: "required" | "auto" | { type: "function"; function: { name: string } };
	/** Raw wake messages ({role, content}), including the leading system prompt. */
	messages: Array<{ role: string; content: string }>;
}

const DEFAULT_MODEL: Model<any> = {
	id: "unknown",
	name: "unknown",
	api: "unknown",
	provider: "unknown",
	baseUrl: "",
	reasoning: false,
	input: [],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 0,
	maxTokens: 0,
};

const EMPTY_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** Stream that immediately yields the synthesized assistant message. */
class WakeTurnStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor(message: AssistantMessage) {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected wake turn stream event");
			},
		);
		this.push({ type: "start", partial: message });
		this.push({
			type: "done",
			reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
			message,
		});
	}
}

/**
 * Run one single-turn wake LLM call through runAgentLoop and return the chat
 * response shape ({content, toolCalls}). Chat errors propagate (the caller's
 * retry loop handles them).
 */
export async function runWakeTurn(options: WakeTurnOptions): Promise<{
	content: string | null;
	toolCalls: ChatToolCall[];
}> {
	const { chat, schemas, toolChoice, messages } = options;

	const streamFn: StreamFn = async (model) => {
		const response = await chat(messages, schemas, toolChoice);
		const message = synthesizeAssistantMessage(model, response.content, response.toolCalls);
		return new WakeTurnStream(message);
	};

	const config: AgentLoopConfig = {
		model: DEFAULT_MODEL,
		convertToLlm: (llmMessages) =>
			llmMessages.filter(
				(message) => message.role === "user" || message.role === "assistant" || message.role === "toolResult",
			),
		shouldStopAfterTurn: async () => true,
		getFollowUpMessages: async () => [],
	};

	const systemPrompt = messages
		.filter((message) => message.role === "system")
		.map((message) => message.content)
		.join("\n\n");
	const agentMessages: AgentMessage[] = messages
		.filter((message) => message.role === "user" || message.role === "assistant")
		.map((message) =>
			message.role === "assistant"
				? {
						role: "assistant",
						content: [{ type: "text", text: message.content }],
						api: DEFAULT_MODEL.api,
						provider: DEFAULT_MODEL.provider,
						model: DEFAULT_MODEL.id,
						usage: EMPTY_USAGE,
						stopReason: "stop",
						timestamp: Date.now(),
					}
				: { role: "user", content: message.content, timestamp: Date.now() },
		);

	const newMessages = await runAgentLoop(
		agentMessages,
		{ systemPrompt, messages: [], tools: [] },
		config,
		async () => {},
		undefined,
		streamFn,
	);

	const lastAssistant = [...newMessages].reverse().find((message) => message.role === "assistant");
	if (!lastAssistant || lastAssistant.role !== "assistant") {
		return { content: null, toolCalls: [] };
	}
	const toolCalls: ChatToolCall[] = lastAssistant.content
		.filter((part) => part.type === "toolCall")
		.map((part) => ({ name: part.name, arguments: part.arguments as Record<string, unknown> }));
	const content =
		lastAssistant.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("") || null;
	return { content, toolCalls };
}

function synthesizeAssistantMessage(
	model: Model<any>,
	content: string | null,
	toolCalls: ChatToolCall[],
): AssistantMessage {
	const blocks: AssistantMessage["content"] = [];
	if (content !== null && content.length > 0) {
		blocks.push({ type: "text", text: content });
	}
	for (const call of toolCalls) {
		blocks.push({
			type: "toolCall",
			id: `wake-${Math.random().toString(36).slice(2, 10)}`,
			name: call.name,
			arguments: call.arguments,
		});
	}
	return {
		role: "assistant",
		content: blocks,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: EMPTY_USAGE,
		stopReason: toolCalls.length > 0 ? "toolUse" : "stop",
		timestamp: Date.now(),
	};
}
