/**
 * StreamForwarder — forward AgentSession streaming deltas to the channel.
 *
 * Subscribes to the session's message_update events and relays text/thinking
 * deltas through ChatDelivery.sendDelta. The final full reply is always sent
 * separately by the turn handler (channels commit the stream on it).
 */

import type { ChatDelivery } from "./delivery.ts";
import type { AgentSession } from "./session-pool.ts";

export interface StreamForwardOptions {
	session: AgentSession;
	delivery: ChatDelivery;
	channel: string;
	chatId: string;
	streamId: string;
	replyTo?: string;
	log?: (message: string) => void;
}

/** Subscribe and forward deltas; returns an unsubscribe function. */
export function forwardStreamDeltas(options: StreamForwardOptions): () => void {
	const { session, delivery, channel, chatId, streamId, replyTo } = options;
	return session.subscribe((event) => {
		if (event.type !== "message_update") return;
		if (!isAssistantMessage(event.message)) return;
		const streamEvent = event.assistantMessageEvent;
		if (streamEvent.type === "thinking_delta" && streamEvent.delta.length > 0) {
			void delivery.sendDelta({
				channel,
				chatId,
				delta: streamEvent.delta,
				type: "thinking",
				streamId,
				replyTo,
			});
		} else if (streamEvent.type === "text_delta" && streamEvent.delta.length > 0) {
			void delivery.sendDelta({
				channel,
				chatId,
				delta: streamEvent.delta,
				type: "text",
				streamId,
				replyTo,
			});
		}
	});
}

function isAssistantMessage(message: unknown): boolean {
	return isRecord(message) && message.role === "assistant";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
