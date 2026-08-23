/**
 * ChatTurn — bridge InboundMessage to an AgentSession prompt and back.
 *
 * Equivalent to akashic's PassiveMessageWorker._run_message: convert the
 * normalized channel message into a turn, resolve the final assistant text,
 * and return the outbound reply. Optional streaming forwards deltas first.
 */

import type { AgentMessage } from "@cogito/agent-core";
import type { ImageContent } from "@cogito/ai";
import type { ChannelReplyHandler, InboundMessage } from "@cogito/gateway";
import type { ToolChainCall } from "@cogito/host";
import type { ChatDelivery } from "./delivery.ts";
import type { AgentSession, ChatSessionPool } from "./session-pool.ts";
import { forwardStreamDeltas } from "./streaming.ts";

/** 一轮对话结束后的异步信息(post-response 记忆失效等)。 */
export interface AfterTurnInfo {
	userMessage: string;
	messages: AgentMessage[];
	scope: { channel: string; chatId: string };
}

export interface ChatTurnOptions {
	pool: ChatSessionPool;
	delivery: ChatDelivery;
	/** Forward assistant deltas to streaming-capable channels. Default true. */
	streaming?: boolean;
	/** Inbound user-message hook (presence heartbeat, analytics, ...). */
	onUserMessage?: (message: InboundMessage) => void;
	/** 轮结束后异步回调(不阻塞回复;失败由调用方自行消化)。 */
	afterTurn?: (info: AfterTurnInfo) => void | Promise<void>;
	log?: (message: string) => void;
}

export function createChatMessageHandler(options: ChatTurnOptions): ChannelReplyHandler {
	return async (message, signal) => {
		const images = toAgentImages(message);
		options.onUserMessage?.(message);
		options.log?.(
			`received channel=${message.channel} chat=${message.chatId} id=${messageId(message) ?? "none"} chars=${message.content.length} images=${images?.length ?? 0}`,
		);
		try {
			const session = await options.pool.getOrCreate(message);
			const streaming = options.streaming !== false && options.delivery.supportsStreaming(message.channel);
			const forward = streaming
				? forwardStreamDeltas({
						session,
						delivery: options.delivery,
						channel: message.channel,
						chatId: message.chatId,
						streamId: `chat-${message.messageId ?? Date.now().toString(36)}`,
						replyTo: messageId(message),
						log: options.log,
					})
				: undefined;
			try {
				const content = await promptSession(session, message.content, images, signal, {
					afterTurn: options.afterTurn,
					scope: { channel: message.channel, chatId: message.chatId },
				});
				options.log?.(`replied channel=${message.channel} chat=${message.chatId} chars=${content.length}`);
				return {
					channel: message.channel,
					chatId: message.chatId,
					content,
					replyTo: messageId(message),
				};
			} finally {
				forward?.();
			}
		} catch (error) {
			if (signal?.aborted) throw error;
			const detail = formatError(error);
			options.log?.(`prompt failed channel=${message.channel} chat=${message.chatId}: ${detail}`);
			return {
				channel: message.channel,
				chatId: message.chatId,
				content: `Cogito 处理失败：${detail}`,
				replyTo: messageId(message),
			};
		}
	};
}

/** 会话空跑/超时无文本输出时的兜底回复。 */
export const FALLBACK_EMPTY_REPLY = "我暂时没有生成可发送的回复。";

/**
 * Run one prompt on a session and resolve the final assistant text.
 * Used by the turn handler and the scheduler's soft-tier generation.
 */
export function promptSession(
	session: AgentSession,
	text: string,
	images?: ImageContent[],
	signal?: AbortSignal,
	options?: { afterTurn?: (info: AfterTurnInfo) => void | Promise<void>; scope?: { channel: string; chatId: string } },
): Promise<string> {
	return new Promise((resolveReply, rejectReply) => {
		let settled = false;
		let unsubscribe = () => {};
		const abortPrompt = (): void => {
			if (settled) return;
			session.abort();
			finish(() => rejectReply(new Error("channel turn interrupted")));
		};
		const finish = (finishReply: () => void): void => {
			if (settled) return;
			settled = true;
			unsubscribe();
			signal?.removeEventListener("abort", abortPrompt);
			finishReply();
		};

		unsubscribe = session.subscribe((event) => {
			if (event.type !== "agent_end" || event.willRetry) return;
			const assistant = [...event.messages].reverse().find((message) => isAssistantMessage(message));
			finish(() => resolveReply(extractText(assistant) || FALLBACK_EMPTY_REPLY));
			// 轮结束后的异步增强(记忆失效等):fire-and-forget,不阻塞回复。
			if (options?.afterTurn) {
				void options.afterTurn({
					userMessage: text,
					messages: event.messages,
					scope: options.scope ?? { channel: "", chatId: "" },
				});
			}
		});
		if (signal?.aborted) {
			abortPrompt();
			return;
		}
		signal?.addEventListener("abort", abortPrompt, { once: true });

		void session.prompt(text, { source: "interactive", ...(images ? { images } : {}) }).then(
			() => {
				if (!settled) finish(() => resolveReply(FALLBACK_EMPTY_REPLY));
			},
			(error: unknown) => finish(() => rejectReply(error)),
		);
	});
}

/**
 * 从一轮对话的消息中提取工具链(memorize 调用 + 结果),供 post-response 记忆失效使用。
 */
export function extractToolChain(messages: readonly AgentMessage[]): ToolChainCall[] {
	const resultsByCallId = new Map<string, unknown>();
	for (const message of messages) {
		if (message.role !== "toolResult") continue;
		const text = toolResultText(message.content);
		resultsByCallId.set(message.toolCallId, text);
	}
	const calls: ToolChainCall[] = [];
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const part of message.content) {
			if (part.type !== "toolCall") continue;
			calls.push({ name: part.name, result: resultsByCallId.get(part.id) });
		}
	}
	return calls;
}

function toolResultText(content: readonly unknown[]): string {
	// ToolResultMessage.content 是 TextContent|ImageContent[]。
	return (Array.isArray(content) ? content : [])
		.filter((part): part is { type: string; text?: string } => typeof part === "object" && part !== null)
		.map((part) => (part.type === "text" ? (part.text ?? "") : ""))
		.join(" ")
		.trim();
}

function toAgentImages(message: InboundMessage): ImageContent[] | undefined {
	const metadataImages = isRecord(message.metadata) ? message.metadata.images : undefined;
	const candidates: unknown = message.images ?? metadataImages;
	if (!Array.isArray(candidates)) return undefined;
	const images = candidates.filter(isImageContent).map((image) => ({
		type: "image" as const,
		data: image.data,
		mimeType: image.mimeType,
	}));
	return images.length > 0 ? images : undefined;
}

function isImageContent(value: unknown): value is ImageContent {
	return (
		isRecord(value) &&
		value.type === "image" &&
		typeof value.data === "string" &&
		value.data.length > 0 &&
		typeof value.mimeType === "string" &&
		value.mimeType.startsWith("image/")
	);
}

export function messageId(message: InboundMessage): string | undefined {
	if (message.messageId) return message.messageId;
	const value = message.metadata?.messageId;
	return typeof value === "string" && value ? value : undefined;
}

export function isAssistantMessage(message: unknown): boolean {
	return isRecord(message) && message.role === "assistant";
}

function extractText(message: unknown): string {
	if (!isRecord(message)) return "";
	const content = message.content;
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is Record<string, unknown> => isRecord(part) && part.type === "text")
		.map((part) => (typeof part.text === "string" ? part.text : ""))
		.join("")
		.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
