/**
 * OutboundDispatcher — routes bus messages to channels with bounded retry and
 * structured delivery receipts.
 *
 * Routing mirrors nanobot's ChannelManager._dispatch_outbound: typed outbound
 * events are dispatched to the channel primitives they map to (progress,
 * reasoning, file edits, streaming), gated by per-channel toggles; consecutive
 * stream deltas for the same (channel, chat_id, stream_id) are coalesced, and
 * duplicate complete replies are suppressed by content fingerprint.
 */

import { createHash } from "node:crypto";
import { type MessageBus, MessageBusClosedError, MessageBusConsumerAbortedError } from "../bus.ts";
import {
	outboundEventFromMessage,
	ProgressEvent,
	RetryWaitEvent,
	RuntimeModelUpdatedEvent,
	StreamDeltaEvent,
	StreamEndEvent,
	StreamedResponseEvent,
} from "../events.ts";
import {
	type ChannelSendResult,
	createMessageId,
	type DeliveryReceipt,
	type OutboundDelta,
	type OutboundMessage,
} from "../types.ts";
import type { BaseChannel } from "./base.ts";

export interface OutboundDispatcherOptions {
	maxAttempts?: number;
	baseDelayMs?: number;
	maxDelayMs?: number;
	logger?: Pick<Console, "warn" | "error">;
}

export class OutboundDispatcher {
	private readonly bus: MessageBus;
	private readonly channels: { get(name: string): BaseChannel | undefined };
	private readonly maxAttempts: number;
	private readonly baseDelayMs: number;
	private readonly maxDelayMs: number;
	private readonly logger: Pick<Console, "warn" | "error">;
	private readonly originReplyFingerprints = new Map<string, string>();
	private running = false;
	private controller: AbortController | undefined;

	constructor(
		bus: MessageBus,
		channels: { get(name: string): BaseChannel | undefined },
		options: OutboundDispatcherOptions = {},
	) {
		this.bus = bus;
		this.channels = channels;
		this.maxAttempts = positiveInteger(options.maxAttempts, 3);
		this.baseDelayMs = nonNegativeNumber(options.baseDelayMs, 1000);
		this.maxDelayMs = nonNegativeNumber(options.maxDelayMs, 30_000);
		this.logger = options.logger ?? console;
	}

	start(): void {
		if (this.running) return;
		this.running = true;
		this.controller = new AbortController();
		try {
			this.bus.recoverOutbound();
		} catch (error) {
			this.logger.error(`[gateway] durable outbound recovery failed: ${formatError(error)}`);
		}
		void this.outboundLoop(this.controller.signal);
		void this.deltaLoop(this.controller.signal);
	}

	stop(): void {
		this.running = false;
		this.controller?.abort();
		this.controller = undefined;
	}

	/**
	 * Send a message directly through a channel (bypassing the bus), with
	 * typed-event routing and optional deadline-based retry (nanobot
	 * _send_with_retry deadline mode). Used for restart notices and other
	 * host-driven sends that must not enter the outbound queue.
	 */
	async sendDirect(
		channel: BaseChannel,
		message: OutboundMessage,
		options: { retryUntilMs?: number; signal?: AbortSignal } = {},
	): Promise<void> {
		const outbound = withMessageId(message);
		const signal = options.signal ?? this.controller?.signal ?? new AbortController().signal;
		const event = outboundEventFromMessage(outbound);
		if (event instanceof ProgressEvent) {
			await this.deliverProgress(channel, outbound, event, signal, options.retryUntilMs);
			return;
		}
		if (event instanceof RetryWaitEvent || event instanceof StreamedResponseEvent) {
			return; // Nothing to render for these.
		}
		await this.deliver(outbound, signal, () => channel.send(outbound), options.retryUntilMs);
	}

	private async outboundLoop(signal: AbortSignal): Promise<void> {
		while (this.running && !signal.aborted) {
			let message: OutboundMessage;
			try {
				message = await this.bus.consumeOutbound(signal);
			} catch (error) {
				if (isExpectedStop(error)) return;
				this.logger.error(`[gateway] outbound consumer failed: ${formatError(error)}`);
				return;
			}
			await this.route(message, signal);
		}
	}

	private async deltaLoop(signal: AbortSignal): Promise<void> {
		// Buffer for messages that couldn't be processed during delta coalescing
		// (the delta queue does not support push-front).
		const pending: OutboundDelta[] = [];
		while (this.running && !signal.aborted) {
			let delta: OutboundDelta;
			try {
				delta = pending.length > 0 ? pending.shift()! : await this.bus.consumeDelta(signal);
			} catch (error) {
				if (isExpectedStop(error)) return;
				this.logger.error(`[gateway] delta consumer failed: ${formatError(error)}`);
				return;
			}
			if (isStreamDelta(delta)) {
				delta = this.coalesceStreamDeltas(delta, pending);
			}
			await this.deliverDelta(delta, signal);
		}
	}

	/** Route one complete outbound message by its typed event. */
	private async route(message: OutboundMessage, signal: AbortSignal): Promise<void> {
		const outbound = withMessageId(message);
		const acceptedAt = Date.now();
		const event = outboundEventFromMessage(outbound);
		if (
			event instanceof RuntimeModelUpdatedEvent &&
			outbound.channel === "websocket" &&
			!this.channels.get("websocket")
		) {
			// WebSocket channel not enabled: nothing to render (nanobot semantics).
			return;
		}
		const channel = this.channels.get(outbound.channel);
		if (!channel) {
			this.publishFailedReceipt(outbound, acceptedAt, 0, `channel is not enabled: ${outbound.channel}`);
			return;
		}
		if (event instanceof ProgressEvent) {
			await this.routeProgress(channel, outbound, event, signal);
			return;
		}
		if (event instanceof RetryWaitEvent) {
			return; // Provider retry wait: nothing to render.
		}
		if (event instanceof StreamedResponseEvent) {
			// Already streamed to the chat; record delivery without resending.
			const receipt: DeliveryReceipt = {
				messageId: outbound.messageId!,
				channel: outbound.channel,
				chatId: outbound.chatId,
				status: "success",
				attempts: 1,
				acceptedAt,
				deliveredAt: Date.now(),
			};
			this.bus.durableOutbound?.markDelivered(receipt);
			this.publishReceipt(receipt);
			return;
		}
		if (this.shouldSuppressOutbound(outbound)) {
			this.logger.warn(`[gateway] suppressing duplicate outbound message to ${outbound.channel}:${outbound.chatId}`);
			const receipt: DeliveryReceipt = {
				messageId: outbound.messageId!,
				channel: outbound.channel,
				chatId: outbound.chatId,
				status: "success",
				attempts: 1,
				acceptedAt,
				deliveredAt: Date.now(),
				detail: "duplicate content suppressed",
			};
			this.bus.durableOutbound?.markDelivered(receipt);
			this.publishReceipt(receipt);
			return;
		}
		await this.deliver(outbound, signal, () => channel.send(outbound));
	}

	private async routeProgress(
		channel: BaseChannel,
		outbound: OutboundMessage,
		event: ProgressEvent,
		signal: AbortSignal,
	): Promise<void> {
		await this.deliverProgress(channel, outbound, event, signal);
	}

	/** Shared progress-event delivery used by both bus routing and sendDirect. */
	private async deliverProgress(
		channel: BaseChannel,
		outbound: OutboundMessage,
		event: ProgressEvent,
		signal: AbortSignal,
		retryUntilMs?: number,
	): Promise<void> {
		if (event.reasoningDelta || event.reasoningEnd || event.reasoning) {
			// Reasoning rides its own channel: only delivered when the
			// destination channel opts in via showReasoning. Channels without
			// a low-emphasis UI affordance keep the base no-op and the
			// content silently drops here (nanobot semantics).
			if (!channel.showReasoningEnabled) return;
			const send = (): Promise<void> => {
				if (event.reasoningDelta) {
					return channel.sendReasoningDelta(outbound.chatId, outbound.content, outbound.metadata, event.streamId);
				}
				if (event.reasoningEnd) {
					return channel.sendReasoningEnd(outbound.chatId, outbound.metadata, event.streamId);
				}
				return channel.sendReasoning(outbound);
			};
			await this.deliver(outbound, signal, send, retryUntilMs);
			return;
		}
		if (event.fileEditEvents && event.fileEditEvents.length > 0) {
			const edits = event.fileEditEvents;
			await this.deliver(
				outbound,
				signal,
				() => channel.sendFileEditEvents(outbound.chatId, edits, outbound.metadata),
				retryUntilMs,
			);
			return;
		}
		if (event.toolHint ? !channel.sendToolHintsEnabled : !channel.sendProgressEnabled) {
			return;
		}
		await this.deliver(outbound, signal, () => channel.sendProgress(outbound), retryUntilMs);
	}

	/**
	 * Suppress duplicate complete replies scoped to a known source message:
	 * repeated content from separate turns is still delivered (nanobot
	 * _should_suppress_outbound).
	 */
	private shouldSuppressOutbound(msg: OutboundMessage): boolean {
		if (outboundEventFromMessage(msg) instanceof ProgressEvent) return false;
		const fingerprint = contentFingerprint(msg.content);
		if (!fingerprint) return false;

		const metadata = msg.metadata ?? {};
		const originMessageId = metadata.originMessageId;
		if (typeof originMessageId === "string" && originMessageId.length > 0) {
			const key = `${msg.channel}:${msg.chatId}:${originMessageId}`;
			if (this.originReplyFingerprints.get(key) === fingerprint) return true;
			this.rememberFingerprint(key, fingerprint);
		}
		const messageId = metadata.messageId;
		if (typeof messageId === "string" && messageId.length > 0) {
			this.rememberFingerprint(`${msg.channel}:${msg.chatId}:${messageId}`, fingerprint);
		}
		return false;
	}

	private rememberFingerprint(key: string, fingerprint: string): void {
		if (this.originReplyFingerprints.size >= 4096) {
			const oldest = this.originReplyFingerprints.keys().next().value;
			if (oldest !== undefined) this.originReplyFingerprints.delete(oldest);
		}
		this.originReplyFingerprints.set(key, fingerprint);
	}

	/**
	 * Coalesce consecutive stream deltas for the same (channel, chat_id,
	 * stream_id) to reduce API calls and improve streaming latency (nanobot
	 * _coalesce_stream_deltas). Non-matching messages go to `pending`.
	 */
	private coalesceStreamDeltas(first: OutboundDelta, pending: OutboundDelta[]): OutboundDelta {
		if (first.event?.kind === "stream_end") return first;
		const targetKey = deltaStreamKey(first);
		const targetType = first.type ?? "text";
		let content = first.delta;
		let endEvent: StreamEndEvent | undefined;
		for (;;) {
			const next = this.bus.tryConsumeDelta();
			if (next === undefined) break;
			if (deltaStreamKey(next) !== targetKey || (next.type ?? "text") !== targetType) {
				pending.push(next);
				break;
			}
			const kind = next.event?.kind;
			if (kind === "stream_end") {
				if (next.delta) content += next.delta;
				const nextEnd = next.event as StreamEndEvent;
				endEvent = new StreamEndEvent({
					content,
					streamId: nextEnd.streamId ?? first.streamId,
					resuming: nextEnd.resuming,
					mergeNext: nextEnd.mergeNext,
				});
				break;
			}
			content += next.delta;
		}
		if (endEvent) {
			return {
				...stripDeltaEvent(first),
				delta: content,
				streamEnd: true,
				event: endEvent,
			};
		}
		return {
			...stripDeltaEvent(first),
			delta: content,
			event: new StreamDeltaEvent({ content, streamId: first.streamId }),
		};
	}

	private async deliver(
		outbound: OutboundMessage,
		signal: AbortSignal,
		// biome-ignore lint/suspicious/noConfusingVoidType: channels may intentionally return no structured receipt
		send: () => Promise<void | ChannelSendResult>,
		retryUntilMs?: number,
	): Promise<void> {
		const acceptedAt = Date.now();
		let lastError: unknown;
		let attempts = 0;
		for (let attempt = 1; ; attempt++) {
			attempts = attempt;
			this.bus.markOutboundAttempt(outbound, attempt);
			if (signal.aborted || !this.running) {
				this.publishCancelledReceipt(outbound, acceptedAt, attempts);
				return;
			}
			try {
				const result = await send();
				const receipt = toReceipt(outbound, acceptedAt, attempt, result);
				if (receipt.status === "success" || receipt.status === "partial") {
					this.bus.durableOutbound?.markDelivered(receipt);
				} else {
					this.bus.durableOutbound?.markFailed(receipt);
				}
				this.publishReceipt(receipt);
				return;
			} catch (error) {
				lastError = error;
				const exhausted = retryUntilMs !== undefined ? Date.now() >= retryUntilMs : attempt >= this.maxAttempts;
				if (exhausted) break;
				const backoff = retryDelay(attempt, this.baseDelayMs, this.maxDelayMs);
				const delay =
					retryUntilMs !== undefined ? Math.min(backoff, Math.max(0, retryUntilMs - Date.now())) : backoff;
				try {
					await wait(delay, signal);
				} catch (waitError) {
					if (isExpectedStop(waitError)) {
						this.publishCancelledReceipt(outbound, acceptedAt, attempts);
						return;
					}
					throw waitError;
				}
			}
		}
		this.publishFailedReceipt(outbound, acceptedAt, attempts, formatError(lastError));
	}

	private publishFailedReceipt(outbound: OutboundMessage, acceptedAt: number, attempts: number, detail: string): void {
		const receipt: DeliveryReceipt = {
			messageId: outbound.messageId!,
			channel: outbound.channel,
			chatId: outbound.chatId,
			status: "failed",
			attempts,
			acceptedAt,
			detail,
		};
		this.bus.durableOutbound?.markFailed(receipt);
		this.publishReceipt(receipt);
	}

	private publishCancelledReceipt(outbound: OutboundMessage, acceptedAt: number, attempts: number): void {
		const receipt: DeliveryReceipt = {
			messageId: outbound.messageId!,
			channel: outbound.channel,
			chatId: outbound.chatId,
			status: "cancelled",
			attempts,
			acceptedAt,
		};
		this.bus.durableOutbound?.markCancelled(receipt);
		this.publishReceipt(receipt);
	}

	private async deliverDelta(delta: OutboundDelta, signal: AbortSignal): Promise<void> {
		const channel = this.channels.get(delta.channel);
		if (!channel || !channel.supportsStreaming) return;
		let lastError: unknown;
		for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
			if (signal.aborted || !this.running) return;
			try {
				await channel.sendDelta(delta);
				return;
			} catch (error) {
				lastError = error;
				if (attempt === this.maxAttempts) break;
				try {
					await wait(retryDelay(attempt, this.baseDelayMs, this.maxDelayMs), signal);
				} catch (waitError) {
					if (isExpectedStop(waitError)) return;
					throw waitError;
				}
			}
		}
		this.logger.warn(
			`[gateway] streaming delivery failed channel=${delta.channel} chat=${delta.chatId} attempts=${this.maxAttempts}: ${formatError(lastError)}`,
		);
	}

	private publishReceipt(receipt: DeliveryReceipt): void {
		this.bus.publishDelivery(receipt);
	}
}

function isStreamDelta(delta: OutboundDelta): boolean {
	const kind = delta.event?.kind;
	return kind === undefined || kind === "stream_delta" || kind === "stream_end";
}

function deltaStreamKey(delta: OutboundDelta): string {
	return `${delta.channel}:${delta.chatId}:${delta.streamId ?? ""}`;
}

/** Copy a delta without its event so coalescing can attach a fresh one. */
function stripDeltaEvent(delta: OutboundDelta): OutboundDelta {
	const { event: _event, ...rest } = delta;
	void _event;
	return rest;
}

function contentFingerprint(content: string): string {
	const normalized = content.trim().split(/\s+/).join(" ");
	return normalized ? createHash("sha1").update(normalized, "utf8").digest("hex") : "";
}

function withMessageId(message: OutboundMessage): OutboundMessage {
	return message.messageId ? message : { ...message, messageId: createMessageId("out") };
}

function toReceipt(
	message: OutboundMessage,
	acceptedAt: number,
	attempts: number,
	// biome-ignore lint/suspicious/noConfusingVoidType: channels may return only a successful void result
	result: void | ChannelSendResult,
): DeliveryReceipt {
	const status = result?.status ?? "success";
	return {
		messageId: message.messageId!,
		channel: message.channel,
		chatId: message.chatId,
		status,
		attempts,
		acceptedAt,
		deliveredAt: status === "success" || status === "partial" ? Date.now() : undefined,
		providerMessageId: result?.providerMessageId,
		canonicalMedia: result?.canonicalMedia,
		detail: result?.detail,
	};
}

function retryDelay(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
	return Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, attempt - 1));
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
	if (milliseconds <= 0) return Promise.resolve();
	return new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, milliseconds);
		const onAbort = (): void => {
			clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
			reject(new MessageBusConsumerAbortedError());
		};
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
	});
}

function isExpectedStop(error: unknown): boolean {
	return error instanceof MessageBusConsumerAbortedError || error instanceof MessageBusClosedError;
}

function positiveInteger(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
}

function nonNegativeNumber(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
