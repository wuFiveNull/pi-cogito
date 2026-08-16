/**
 * AgentAdapter — consumes inbound messages, produces outbound replies.
 *
 * The real implementation will bridge to the pi agent core. Tests use a
 * FakeAgent implementing the same interface.
 */

import { type MessageBus, MessageBusConsumerAbortedError } from "./bus.ts";
import { createMessageId, type InboundMessage, type OutboundDelta, type OutboundMessage } from "./types.ts";

export interface AgentAdapter {
	/** Start consuming inbound messages and replying through the bus. */
	start(): void;
	/** Stop consuming. */
	stop(): void;
}

export interface AgentAdapterOptions {
	/** Base delay before replying (ms). */
	replyDelayMs?: number;
	/** Stream replies in chunks when true. */
	stream?: boolean;
}

/** Turn one inbound message into an outbound reply (may be overridden). */
export type ReplyBuilder = (message: InboundMessage) => Promise<{ content: string }>;

/**
 * FakeAgent — deterministic agent core for tests and demos:
 * echoes the message content with a channel-aware prefix.
 */
export class FakeAgent implements AgentAdapter {
	private readonly bus: MessageBus;
	private readonly options: AgentAdapterOptions;
	private readonly buildReply: ReplyBuilder;
	private running = false;
	private controller: AbortController | undefined;

	constructor(
		bus: MessageBus,
		options: AgentAdapterOptions = {},
		buildReply: ReplyBuilder = async (message) => ({
			content: `[${message.channel}] 收到: ${message.content}`,
		}),
	) {
		this.bus = bus;
		this.options = options;
		this.buildReply = buildReply;
	}

	start(): void {
		if (this.running) return;
		this.running = true;
		this.controller = new AbortController();
		void this.loop(this.controller.signal);
	}

	stop(): void {
		this.running = false;
		this.controller?.abort();
		this.controller = undefined;
	}

	private async loop(signal: AbortSignal): Promise<void> {
		while (this.running) {
			let inbound: InboundMessage;
			try {
				inbound = await this.bus.consumeInbound(signal);
			} catch (error) {
				if (error instanceof MessageBusConsumerAbortedError) return;
				throw error;
			}
			if (!this.running) return;
			const reply = await this.buildReply(inbound);

			const outbound: OutboundMessage = {
				messageId: createMessageId("out"),
				channel: inbound.channel,
				chatId: inbound.chatId,
				content: reply.content,
				replyTo: inbound.messageId,
			};

			if (this.options.stream) {
				const chunks = splitChunks(reply.content, 5);
				for (const [index, chunk] of chunks.entries()) {
					const delta: OutboundDelta = {
						channel: inbound.channel,
						chatId: inbound.chatId,
						delta: chunk,
						streamId: `fake-${inbound.sessionKey}`,
						streamEnd: index === chunks.length - 1,
					};
					this.bus.publishDelta(delta);
					await sleep(this.options.replyDelayMs ?? 20);
				}
			} else {
				await sleep(this.options.replyDelayMs ?? 10);
				this.bus.publishOutbound(outbound);
			}
		}
	}
}

function splitChunks(text: string, size: number): string[] {
	const chunks: string[] = [];
	for (let i = 0; i < text.length; i += size) {
		chunks.push(text.slice(i, i + size));
	}
	return chunks;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
