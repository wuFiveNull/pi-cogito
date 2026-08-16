/**
 * ChatDelivery — outbound wrapper over the channel SDK.
 *
 * Shared by the turn handler, message_push, the scheduler, and any other
 * component that needs to send messages or streaming deltas to channels.
 */

import type { ChannelSdk, ChannelSendReceipt, OutboundDelta, OutboundMessage } from "@cogito/gateway";

export interface ChatDeliveryMessage {
	channel: string;
	chatId: string;
	content: string;
	replyTo?: string;
	media?: string[];
	thinking?: string;
	metadata?: Record<string, unknown>;
}

export interface ChatStreamDelta {
	channel: string;
	chatId: string;
	delta: string;
	type?: "text" | "thinking";
	streamId?: string;
	streamEnd?: boolean;
	replyTo?: string;
}

export class ChatDelivery {
	private readonly sdk: ChannelSdk;

	constructor(sdk: ChannelSdk) {
		this.sdk = sdk;
	}

	/** Whether the channel accepts streaming deltas. */
	supportsStreaming(channel: string): boolean {
		return this.sdk.capabilities(channel)?.streaming ?? false;
	}

	/** Send a complete message. */
	async send(message: ChatDeliveryMessage): Promise<ChannelSendReceipt> {
		const outbound: OutboundMessage = {
			channel: message.channel,
			chatId: message.chatId,
			content: message.content,
		};
		if (message.replyTo !== undefined) outbound.replyTo = message.replyTo;
		if (message.media !== undefined && message.media.length > 0) outbound.media = message.media;
		if (message.thinking !== undefined) outbound.thinking = message.thinking;
		if (message.metadata !== undefined) outbound.metadata = message.metadata;
		return this.sdk.send(outbound);
	}

	/** Forward a streaming delta. Errors are swallowed (streaming is best-effort). */
	async sendDelta(delta: ChatStreamDelta): Promise<void> {
		const outbound: OutboundDelta = {
			channel: delta.channel,
			chatId: delta.chatId,
			delta: delta.delta,
		};
		if (delta.type !== undefined) outbound.type = delta.type;
		if (delta.streamId !== undefined) outbound.streamId = delta.streamId;
		if (delta.streamEnd !== undefined) outbound.streamEnd = delta.streamEnd;
		if (delta.replyTo !== undefined) outbound.replyTo = delta.replyTo;
		try {
			await this.sdk.sendDelta(outbound);
		} catch {
			// Streaming must never break the turn.
		}
	}
}
