/**
 * SlackChannel — Socket Mode (WebSocket) + Web API, zero-dependency.
 *
 * Opens a Socket Mode connection via apps.connections.open (app-level token),
 * receives events_api envelopes, acks each envelope, and replies via
 * chat.postMessage (bot token).
 *
 * chatId convention: Slack channel id.
 */

import type { MessageBus } from "../bus.ts";
import { type ChannelMediaCapabilities, resolveOutboundMedia, withMediaFailureNote } from "../media.ts";
import type { ChannelAttachment, ChannelSendResult, OutboundDelta, OutboundMessage } from "../types.ts";
import { BaseChannel, type ChannelConfig } from "./base.ts";
import type { ChannelContext } from "./context.ts";
import { GenericWsClient, type WsLike } from "./ws-common.ts";

export interface SlackConfig extends ChannelConfig {
	/** App-level token (xapp-...), used to open the Socket Mode connection. */
	appToken?: string;
	/** Bot token (xoxb-...), used for chat.postMessage. */
	botToken?: string;
	/** Reconnect delay in ms. Default 5000. */
	reconnectDelayMs?: number;
	/** Bot user id (U...); enables @mention detection in group messages. */
	botUserId?: string;
}

interface SlackEnvelope {
	type?: string;
	envelope_id?: string;
	payload?: {
		type?: string;
		event?: {
			type?: string;
			subtype?: string;
			event_id?: string;
			channel?: string;
			user?: string;
			text?: string;
			ts?: string;
			/** Thread root timestamp; replies inside threads carry it. */
			thread_ts?: string;
		};
		channel?: { id?: string };
		user?: { id?: string };
		message?: { ts?: string };
		actions?: Array<{ action_id?: string; value?: string }>;
		team_id?: string;
	};
}

export class SlackChannel extends BaseChannel {
	name = "slack";
	displayName = "Slack";

	private readonly cfg: SlackConfig;
	private readonly socket: WsLike;
	private readonly fetchFn: typeof fetch;
	/** Recently processed event timestamps (Slack redelivers envelopes). */
	private readonly recentTs = new Set<string>();

	constructor(
		config: ChannelConfig | undefined,
		bus: MessageBus,
		options: { socket?: WsLike; fetchFn?: typeof fetch } = {},
	) {
		super(config, bus);
		this.cfg = (config ?? {}) as SlackConfig;
		this.socket = options.socket ?? new GenericWsClient();
		this.fetchFn = options.fetchFn ?? fetch;
	}

	async start(context?: ChannelContext): Promise<void> {
		if (this.running) return;
		if (context) this.bindContext(context);
		this.running = true;
		void this.loop();
	}

	async stop(): Promise<void> {
		this.running = false;
		this.socket.close();
	}

	private async openUrl(): Promise<string> {
		const response = await this.fetchFn("https://slack.com/api/apps.connections.open", {
			method: "POST",
			headers: { Authorization: `Bearer ${this.cfg.appToken ?? ""}` },
		});
		const body = (await response.json()) as { ok?: boolean; url?: string; error?: string };
		if (!body.ok || !body.url) {
			throw new Error(`apps.connections.open failed: ${body.error ?? response.status}`);
		}
		return body.url;
	}

	private async loop(): Promise<void> {
		while (this.running) {
			try {
				const url = await this.openUrl();
				await this.socket.connect(url);
				this.socket.onMessage(
					(text) =>
						void this.handlePayload(text).catch((error: unknown) => {
							this.channelContext.logger?.error(`[slack] event processing failed: ${formatError(error)}`);
						}),
				);
				await new Promise<void>((resolve) => {
					this.socket.onClose(() => resolve());
				});
			} catch {
				// fall through to reconnect
			}
			if (!this.running) return;
			await new Promise((resolve) => setTimeout(resolve, this.cfg.reconnectDelayMs ?? 5000));
		}
	}

	private async handlePayload(text: string): Promise<void> {
		let envelope: SlackEnvelope;
		try {
			envelope = JSON.parse(text) as SlackEnvelope;
		} catch {
			return;
		}
		if (envelope.type === "events_api") {
			const payload = envelope.payload;
			const event = payload?.event;
			if (payload?.type === "block_actions" && payload.channel?.id) {
				// Interactive button callback: feed the label back as a message.
				const label = payload.actions?.find((action) => action.value)?.value ?? "";
				if (label) {
					await this.handleMessage({
						messageId: `${payload.message?.ts ?? envelope.envelope_id ?? "cb"}_${label}`,
						senderId: payload.user?.id ?? "unknown",
						chatId: payload.channel.id,
						content: label,
						metadata: { button: true, ts: payload.message?.ts },
					});
				}
				if (envelope.envelope_id) this.socket.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
				return;
			}
			if (
				event?.type === "message" &&
				!event.subtype &&
				typeof event.channel === "string" &&
				typeof event.text === "string"
			) {
				// Socket Mode redelivers envelopes; dedupe by event ts.
				if (event.ts && this.seenTs(event.ts)) {
					if (envelope.envelope_id) this.socket.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
					return;
				}
				const threadTs = event.thread_ts;
				const metadata: Record<string, unknown> = { ts: event.ts, eventId: event.event_id };
				if (threadTs) metadata.threadId = threadTs;
				if (this.cfg.botUserId && event.text.includes(`<@${this.cfg.botUserId}>`)) {
					metadata.mentionedBot = true;
				}
				const result = await this.handleMessage({
					messageId: event.event_id ?? event.ts,
					senderId: event.user ?? "unknown",
					chatId: event.channel,
					content: event.text,
					metadata,
					sessionKeyOverride: threadTs ? `slack:${event.channel}:thread:${threadTs}` : undefined,
				});
				if (result.status === "rejected") return;
			}
			// Slack Socket Mode has no replay cursor after an envelope is acked.
			// Persist the last accepted envelope/event for diagnostics and durable
			// duplicate suppression across reconnects.
			if (envelope.envelope_id) this.channelContext.offsetStore?.set(this.name, "envelopeId", envelope.envelope_id);
			if (event?.event_id) this.channelContext.offsetStore?.set(this.name, "eventId", event.event_id);
			if (event?.ts) this.channelContext.offsetStore?.set(this.name, "eventTs", event.ts);
			if (envelope.envelope_id) this.socket.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
		}
	}

	override get mediaCapabilities(): ChannelMediaCapabilities {
		return { kinds: ["image", "video", "audio", "file"], urlDirect: false };
	}

	/** Remember a processed event ts; returns false the first time it is seen. */
	private seenTs(ts: string): boolean {
		if (this.recentTs.has(ts)) return true;
		if (this.recentTs.size >= 4096) {
			const oldest = this.recentTs.keys().next().value;
			if (oldest !== undefined) this.recentTs.delete(oldest);
		}
		this.recentTs.add(ts);
		return false;
	}

	async send(message: OutboundMessage): Promise<ChannelSendResult> {
		const failedMedia: string[] = [];
		let providerMessageId: string | undefined;
		for (const item of this.collectOutboundMedia(message)) {
			try {
				providerMessageId = (await this.uploadFile(item, message.chatId, message.replyTo)) ?? providerMessageId;
			} catch (error) {
				this.channelContext.logger?.error(`[slack] media send failed source=${item.source}: ${formatError(error)}`);
				failedMedia.push(item.filename ?? item.source);
			}
		}
		const content = withMediaFailureNote(message.content, failedMedia);
		if (content) {
			providerMessageId =
				(await this.postText(message.chatId, content, message.replyTo, message.buttons)) ?? providerMessageId;
		}
		return failedMedia.length > 0
			? { status: "partial", providerMessageId, detail: `media failed: ${failedMedia.join(", ")}` }
			: { status: "success", providerMessageId };
	}

	// ------------------------------------------------------------------
	// Streaming (chat.update edits), reasoning (context block), buttons
	// ------------------------------------------------------------------

	private readonly streamTs = new Map<string, string>();
	private readonly reasoningBufs = new Map<string, string>();

	async sendDelta(delta: OutboundDelta): Promise<void> {
		const ts = this.streamTs.get(delta.chatId);
		if (ts === undefined) {
			const sent = await this.postText(delta.chatId, delta.delta, delta.replyTo);
			if (sent) this.streamTs.set(delta.chatId, sent);
			return;
		}
		await this.updateText(delta.chatId, ts, delta.delta);
		if (delta.streamEnd) this.streamTs.delete(delta.chatId);
	}

	override async sendReasoningDelta(
		chatId: string,
		delta: string,
		_metadata?: Record<string, unknown>,
		streamId?: string,
	): Promise<void> {
		const key = streamId ?? chatId;
		const buf = this.reasoningBufs.get(key) ?? "";
		this.reasoningBufs.set(key, buf + delta);
	}

	override async sendReasoningEnd(
		chatId: string,
		_metadata?: Record<string, unknown>,
		streamId?: string,
	): Promise<void> {
		const key = streamId ?? chatId;
		const text = this.reasoningBufs.get(key);
		this.reasoningBufs.delete(key);
		if (text?.trim()) {
			await this.postContextBlock(chatId, text.trim());
		}
	}

	private async updateText(channelId: string, ts: string, text: string): Promise<void> {
		const response = await this.fetchFn("https://slack.com/api/chat.update", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${this.cfg.botToken ?? ""}`,
			},
			body: JSON.stringify({ channel: channelId, ts, text }),
		});
		const body = (await response.json()) as { ok?: boolean; error?: string };
		if (!body.ok) {
			throw new Error(`chat.update failed: ${body.error ?? response.status}`);
		}
	}

	private async postContextBlock(channelId: string, text: string): Promise<void> {
		const response = await this.fetchFn("https://slack.com/api/chat.postMessage", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${this.cfg.botToken ?? ""}`,
			},
			body: JSON.stringify({
				channel: channelId,
				text,
				blocks: [{ type: "context", elements: [{ type: "mrkdwn", text }] }],
			}),
		});
		const body = (await response.json()) as { ok?: boolean; error?: string };
		if (!body.ok) {
			throw new Error(`chat.postMessage (context block) failed: ${body.error ?? response.status}`);
		}
	}

	private async postText(
		channelId: string,
		text: string,
		threadTs?: string,
		buttons?: string[][],
	): Promise<string | undefined> {
		const response = await this.fetchFn("https://slack.com/api/chat.postMessage", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${this.cfg.botToken ?? ""}`,
			},
			body: JSON.stringify({
				channel: channelId,
				text,
				...(threadTs ? { thread_ts: threadTs } : {}),
				...(buttons && buttons.length > 0 ? { blocks: [buttonActionsBlock(buttons)] } : {}),
			}),
		});
		const body = (await response.json()) as { ok?: boolean; error?: string; ts?: string };
		if (!body.ok) {
			throw new Error(`chat.postMessage failed: ${body.error ?? response.status}`);
		}
		return body.ts;
	}

	private async uploadFile(
		item: ChannelAttachment,
		channelId: string,
		threadTs?: string,
	): Promise<string | undefined> {
		const media = await resolveOutboundMedia(item, { fetchFn: this.fetchFn });
		const form = new FormData();
		form.append("channel_id", channelId);
		form.append("filename", media.filename);
		form.append("file", new Blob([media.data], { type: media.mimeType }), media.filename);
		if (threadTs) form.append("thread_ts", threadTs);
		const response = await this.fetchFn("https://slack.com/api/files.upload", {
			method: "POST",
			headers: { Authorization: `Bearer ${this.cfg.botToken ?? ""}` },
			body: form,
		});
		const body = (await response.json()) as { ok?: boolean; error?: string; file?: { id?: string } };
		if (!body.ok) {
			throw new Error(`files.upload failed: ${body.error ?? response.status}`);
		}
		return body.file?.id;
	}
}

function buttonActionsBlock(buttons: string[][]): Record<string, unknown> {
	return {
		type: "actions",
		block_id: "cogito_buttons",
		elements: buttons.flatMap((row) =>
			row.map((label) => ({
				type: "button",
				text: { type: "plain_text", text: label.slice(0, 75) },
				action_id: label.slice(0, 255),
				value: label.slice(0, 2000),
			})),
		),
	};
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
