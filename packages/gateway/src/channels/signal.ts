/**
 * SignalChannel — signal-cli-rest-api HTTP client, zero-dependency.
 *
 * Receives messages via the daemon's Server-Sent Events endpoint
 * (GET /api/v1/events) and sends via POST /api/v1/send. chatId is the
 * sender's phone number for DMs and the group id (base64) for groups.
 * The HTTP client is injectable for tests.
 */

import type { MessageBus } from "../bus.ts";
import { type ChannelMediaCapabilities, withMediaFailureNote } from "../media.ts";
import type { ChannelSendResult, OutboundMessage } from "../types.ts";
import { BaseChannel, type ChannelConfig } from "./base.ts";
import type { ChannelContext } from "./context.ts";

export interface SignalConfig extends ChannelConfig {
	/** Own registered phone number (e.g. +15551234567), used for validation. */
	phoneNumber?: string;
	/** signal-cli-rest-api host. Default "localhost". */
	daemonHost?: string;
	/** signal-cli-rest-api port. Default 8080. */
	daemonPort?: number;
	/** Reconnect delay in ms. Default 5000. */
	reconnectDelayMs?: number;
	/** Send the typing indicator while a turn is active. Default true. */
	showTyping?: boolean;
}

interface SignalAttachment {
	contentType?: string;
	filename?: string;
}

interface SignalEnvelope {
	sourceNumber?: string;
	source?: string;
	sourceUuid?: string;
	sourceServiceId?: string;
	sourceName?: string;
	timestamp?: number;
	dataMessage?: {
		message?: string;
		attachments?: SignalAttachment[];
		groupInfo?: { groupId?: string };
		groupV2?: { groupId?: string };
	};
	syncMessage?: unknown;
	typingMessage?: unknown;
	receiptMessage?: unknown;
}

interface SignalEvent {
	envelope?: SignalEnvelope;
}

const MAX_MESSAGE_LEN = 2000;

export class SignalChannel extends BaseChannel {
	name = "signal";
	displayName = "Signal";

	private readonly cfg: SignalConfig;
	private readonly fetchFn: typeof fetch;
	private abortController: AbortController | undefined;
	private readonly typingLoops = new Map<string, NodeJS.Timeout>();

	constructor(config: ChannelConfig | undefined, bus: MessageBus, options: { fetchFn?: typeof fetch } = {}) {
		super(config, bus);
		this.cfg = (config ?? {}) as SignalConfig;
		this.fetchFn = options.fetchFn ?? fetch;
	}

	private baseUrl(): string {
		return `http://${this.cfg.daemonHost ?? "localhost"}:${this.cfg.daemonPort ?? 8080}`;
	}

	async start(context?: ChannelContext): Promise<void> {
		if (this.running) return;
		if (context) this.bindContext(context);
		if (!this.cfg.phoneNumber) {
			this.channelContext.logger?.error("[signal] phoneNumber not configured; channel disabled");
			return;
		}
		this.running = true;
		void this.loop();
	}

	async stop(): Promise<void> {
		this.running = false;
		this.abortController?.abort();
		this.abortController = undefined;
		for (const timer of this.typingLoops.values()) clearInterval(timer);
		this.typingLoops.clear();
	}

	private async loop(): Promise<void> {
		let delay = this.cfg.reconnectDelayMs ?? 5000;
		while (this.running) {
			try {
				await this.checkDaemon();
				delay = this.cfg.reconnectDelayMs ?? 5000;
				await this.sseReceiveLoop();
			} catch (error) {
				this.channelContext.logger?.debug(`[signal] receive loop ended: ${formatError(error)}`);
			}
			if (!this.running) return;
			await sleep(delay);
			delay = Math.min(delay * 2, 30_000);
		}
	}

	private async checkDaemon(): Promise<void> {
		const response = await this.fetchFn(`${this.baseUrl()}/api/v1/check`);
		if (!response.ok) throw new Error(`signal daemon check failed: ${response.status}`);
	}

	/** Consume the SSE event stream until it closes or the channel stops. */
	private async sseReceiveLoop(): Promise<void> {
		this.abortController = new AbortController();
		const response = await this.fetchFn(`${this.baseUrl()}/api/v1/events`, {
			signal: this.abortController.signal,
		});
		if (!response.ok || !response.body) {
			throw new Error(`signal SSE connection failed: ${response.status}`);
		}
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const events = buffer.split("\n\n");
			buffer = events.pop() ?? "";
			for (const block of events) {
				const data = parseSseData(block);
				if (!data) continue;
				try {
					await this.handleEvent(JSON.parse(data) as SignalEvent);
				} catch (error) {
					this.channelContext.logger?.error(`[signal] event handling failed: ${formatError(error)}`);
				}
			}
		}
		reader.releaseLock();
	}

	private async handleEvent(event: SignalEvent): Promise<void> {
		const envelope = event.envelope;
		if (!envelope) return;
		if (envelope.receiptMessage || envelope.typingMessage) return; // Receipts/typing are noise.
		if (envelope.syncMessage) return; // Messages sent from another device.

		const dataMessage = envelope.dataMessage;
		if (!dataMessage) return;
		const senderParts = collectSenderParts(envelope);
		if (senderParts.length === 0) return;
		const senderId = senderParts.join("|");
		const rawGroupId = extractRawGroupId(dataMessage);
		const groupId = rawGroupId ? `group:${rawGroupId}` : undefined;
		const chatId = groupId ?? primarySenderId(senderParts);
		const isDm = groupId === undefined;
		const messageText = dataMessage.message ?? "";
		const attachmentNames = (dataMessage.attachments ?? [])
			.map((attachment) => attachment.filename ?? attachment.contentType ?? "attachment")
			.filter(Boolean);
		const contentParts = [messageText, ...attachmentNames.map((name) => `[attachment: ${name}]`)].filter(Boolean);
		if (contentParts.length === 0) return;

		const result = await this.handleMessage({
			messageId: envelope.timestamp === undefined ? undefined : String(envelope.timestamp),
			senderId,
			chatId,
			content: contentParts.join("\n"),
			metadata: {
				chatType: isDm ? "private" : "group",
				groupId: rawGroupId,
				timestamp: envelope.timestamp,
			},
			isDm,
		});
		if (result.status === "accepted") this.markTurnActive(chatId);
	}

	// ------------------------------------------------------------------
	// Turn activity: typing indicator (best effort)
	// ------------------------------------------------------------------

	private markTurnActive(chatId: string): void {
		if (this.cfg.showTyping === false) return;
		if (this.typingLoops.has(chatId)) return;
		const send = (): void => {
			try {
				const result = this.fetchFn(`${this.baseUrl()}/api/v1/typing`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(this.recipientParams(chatId, { typing: true })),
				});
				void Promise.resolve(result).catch(() => undefined);
			} catch {
				// Best-effort typing indicator.
			}
		};
		send();
		const timer = setInterval(send, 8000);
		timer.unref?.();
		this.typingLoops.set(chatId, timer);
	}

	private clearTurnActive(chatId: string): void {
		const timer = this.typingLoops.get(chatId);
		if (timer) {
			clearInterval(timer);
			this.typingLoops.delete(chatId);
		}
		try {
			const result = this.fetchFn(`${this.baseUrl()}/api/v1/typing`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(this.recipientParams(chatId, { typing: false })),
			});
			void Promise.resolve(result).catch(() => undefined);
		} catch {
			// Best-effort typing stop.
		}
	}

	// ------------------------------------------------------------------
	// Outbound
	// ------------------------------------------------------------------

	override get mediaCapabilities(): ChannelMediaCapabilities {
		// signal-cli-rest-api attachments need server-side paths; text only.
		return { kinds: [], urlDirect: false };
	}

	async send(message: OutboundMessage): Promise<ChannelSendResult> {
		const failedMedia = this.collectOutboundMediaSafe(message);
		const content = withMediaFailureNote(message.content, failedMedia);
		if (!content) return { status: "success" };
		const chunks = splitLongMessage(content, MAX_MESSAGE_LEN);
		for (const chunk of chunks) {
			const response = await this.fetchFn(`${this.baseUrl()}/api/v1/send`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(this.recipientParams(message.chatId, { message: chunk })),
			});
			const body = (await response.json()) as { error?: string };
			if (!response.ok || body.error) {
				throw new Error(`signal send failed: ${body.error ?? response.status}`);
			}
		}
		this.clearTurnActive(message.chatId);
		return failedMedia.length > 0
			? { status: "partial", detail: `media not supported: ${failedMedia.join(", ")}` }
			: { status: "success" };
	}

	/** Signal has no outbound media; media is surfaced as a note, never dropped. */
	private collectOutboundMediaSafe(message: OutboundMessage): string[] {
		const items = [...(message.media ?? []), ...(message.attachments ?? []).map((a) => a.source)];
		return items.filter((source) => source.trim().length > 0);
	}

	private recipientParams(chatId: string, body: Record<string, unknown>): Record<string, unknown> {
		if (chatId.startsWith("group:")) return { ...body, groupId: chatId.slice("group:".length) };
		return { ...body, recipient: [chatId] };
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract "data:" payloads from one SSE block (multiple data lines join). */
function parseSseData(block: string): string | undefined {
	const lines = block.split("\n");
	const dataLines: string[] = [];
	for (const line of lines) {
		if (line.startsWith("data:")) {
			dataLines.push(line.slice(5).replace(/^ /, ""));
		}
	}
	return dataLines.length > 0 ? dataLines.join("\n") : undefined;
}

function collectSenderParts(envelope: SignalEnvelope): string[] {
	const parts: string[] = [];
	for (const key of ["sourceNumber", "source", "sourceUuid", "sourceServiceId"]) {
		const value = (envelope as Record<string, unknown>)[key];
		if (typeof value === "string" && value.trim() && !parts.includes(value.trim())) parts.push(value.trim());
	}
	return parts;
}

function primarySenderId(parts: string[]): string {
	for (const part of parts) {
		if (part.startsWith("+") || /^\d+$/.test(part)) return part;
	}
	return parts[0] ?? "";
}

function extractRawGroupId(dataMessage: NonNullable<SignalEnvelope["dataMessage"]>): string | undefined {
	for (const group of [dataMessage.groupInfo, dataMessage.groupV2]) {
		if (typeof group?.groupId === "string" && group.groupId) return group.groupId;
	}
	return undefined;
}

function splitLongMessage(text: string, maxLen: number): string[] {
	if (text.length <= maxLen) return [text];
	const chunks: string[] = [];
	let remaining = text;
	while (remaining.length > maxLen) {
		chunks.push(remaining.slice(0, maxLen));
		remaining = remaining.slice(maxLen);
	}
	if (remaining) chunks.push(remaining);
	return chunks;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
