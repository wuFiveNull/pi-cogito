/**
 * MatrixChannel — Client-Server API sync (long polling), zero-dependency.
 *
 * Polls /_matrix/client/v3/sync with an access token, normalizes
 * m.room.message events (m.text/m.notice) into InboundMessage, and replies
 * via PUT /rooms/{roomId}/send/m.room.message/{txn}.
 *
 * chatId convention: room id.
 */

import type { MessageBus } from "../bus.ts";
import { type ChannelMediaCapabilities, resolveOutboundMedia, withMediaFailureNote } from "../media.ts";
import type { ChannelAttachment, ChannelSendResult, OutboundDelta, OutboundMessage } from "../types.ts";
import { BaseChannel, type ChannelConfig } from "./base.ts";
import type { ChannelContext } from "./context.ts";

export interface MatrixConfig extends ChannelConfig {
	/** Homeserver base URL, e.g. https://matrix.org. */
	homeserver?: string;
	accessToken?: string;
	/** Own user id (@user:server) — own messages are skipped. */
	userId?: string;
	/** Sync poll interval in ms. Default 30000. */
	pollIntervalMs?: number;
	/** Sync long-poll timeout in ms. Default 30000. */
	syncTimeoutMs?: number;
	/** Join rooms when invited. Default false. */
	autoJoinInvites?: boolean;
	/** Maximum inbound media size in bytes. Default 20MiB. */
	maxMediaBytes?: number;
}

interface SyncResponse {
	next_batch?: string;
	rooms?: {
		join?: Record<string, { timeline?: { events?: MatrixEvent[] } }>;
		invite?: Record<string, unknown>;
	};
}

interface MatrixEvent {
	type?: string;
	sender?: string;
	event_id?: string;
	content?: {
		msgtype?: string;
		body?: string;
		url?: string;
		info?: { mimetype?: string; size?: number };
		"m.relates_to"?: {
			"m.in_reply_to"?: { event_id?: string };
		};
	};
}

export class MatrixChannel extends BaseChannel {
	name = "matrix";
	displayName = "Matrix";

	private readonly cfg: MatrixConfig;
	private readonly fetchFn: typeof fetch;
	private timer: NodeJS.Timeout | undefined;
	private since: string | undefined;

	constructor(config: ChannelConfig | undefined, bus: MessageBus, options: { fetchFn?: typeof fetch } = {}) {
		super(config, bus);
		this.cfg = (config ?? {}) as MatrixConfig;
		this.fetchFn = options.fetchFn ?? fetch;
	}

	async start(context?: ChannelContext): Promise<void> {
		if (this.running) return;
		if (context) this.bindContext(context);
		this.since = this.channelContext.offsetStore?.get(this.name, "since");
		this.running = true;
		void this.pollOnce();
		this.timer = setInterval(() => void this.pollOnce(), this.cfg.pollIntervalMs ?? 30_000);
		this.timer.unref?.();
	}

	async stop(): Promise<void> {
		this.running = false;
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}

	private async pollOnce(): Promise<void> {
		if (!this.running) return;
		try {
			const base = this.cfg.homeserver ?? "";
			const params = new URLSearchParams({ timeout: String(this.cfg.syncTimeoutMs ?? 30_000) });
			if (this.since) params.set("since", this.since);
			const response = await this.fetchFn(`${base}/_matrix/client/v3/sync?${params}`, {
				headers: { Authorization: `Bearer ${this.cfg.accessToken ?? ""}` },
			});
			if (!response.ok) return;
			const body = (await response.json()) as SyncResponse;
			for (const roomId of Object.keys(body.rooms?.invite ?? {})) {
				if (this.cfg.autoJoinInvites === true) {
					await this.fetchFn(`${base}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`, {
						method: "POST",
						headers: { Authorization: `Bearer ${this.cfg.accessToken ?? ""}` },
					});
				} else {
					this.channelContext.logger?.info(`[matrix] ignoring invite to ${roomId} (set autoJoinInvites to join)`);
				}
			}
			for (const [roomId, room] of Object.entries(body.rooms?.join ?? {})) {
				for (const event of room.timeline?.events ?? []) {
					if (event.sender === this.cfg.userId) continue;
					if (event.type === "m.room.encrypted") continue; // E2EE deferred.
					if (event.type !== "m.room.message") continue;
					const msgtype = event.content?.msgtype;
					if (msgtype === "m.text" || msgtype === "m.notice") {
						if (typeof event.content?.body !== "string") continue;
						const replyTo = event.content["m.relates_to"]?.["m.in_reply_to"]?.event_id;
						const metadata: Record<string, unknown> = { eventId: event.event_id };
						if (replyTo) {
							metadata.threadId = replyTo;
							metadata.replyMessageId = replyTo;
						}
						await this.handleMessage({
							senderId: event.sender ?? "unknown",
							chatId: roomId,
							content: event.content.body,
							metadata,
							sessionKeyOverride: replyTo ? `matrix:${roomId}:thread:${replyTo}` : undefined,
						});
						continue;
					}
					if (msgtype === "m.image" || msgtype === "m.file" || msgtype === "m.audio" || msgtype === "m.video") {
						await this.handleMediaEvent(roomId, event);
					}
				}
			}
			if (body.next_batch) {
				this.since = body.next_batch;
				this.channelContext.offsetStore?.set(this.name, "since", body.next_batch);
			}
		} catch {
			// Poll errors are non-fatal.
		}
	}

	/** Download mxc media from an inbound event (images become multimodal input). */
	private async handleMediaEvent(roomId: string, event: MatrixEvent): Promise<void> {
		const url = event.content?.url;
		if (!url || !url.startsWith("mxc://")) return;
		const [server, mediaId] = url.slice("mxc://".length).split("/", 2);
		if (!server || !mediaId) return;
		const base = this.cfg.homeserver ?? "";
		const maxBytes = this.cfg.maxMediaBytes ?? 20 * 1024 * 1024;
		try {
			const response = await this.fetchFn(
				`${base}/_matrix/media/v3/download/${encodeURIComponent(server)}/${encodeURIComponent(mediaId)}`,
				{ headers: { Authorization: `Bearer ${this.cfg.accessToken ?? ""}` } },
			);
			if (!response.ok) return;
			const data = new Uint8Array(await response.arrayBuffer());
			if (data.byteLength > maxBytes) return;
			const filename = event.content?.body ?? "attachment";
			const mimeType = event.content?.info?.mimetype;
			const msgtype = event.content?.msgtype;
			if (msgtype === "m.image" && mimeType?.startsWith("image/")) {
				await this.handleMessage({
					senderId: event.sender ?? "unknown",
					chatId: roomId,
					content: filename,
					images: [{ type: "image", data: toBase64(data), mimeType }],
					metadata: { eventId: event.event_id },
				});
				return;
			}
			await this.handleMessage({
				senderId: event.sender ?? "unknown",
				chatId: roomId,
				content: filename,
				attachments: [
					{
						kind: "file",
						source: `data:${mimeType ?? "application/octet-stream"};base64,${toBase64(data)}`,
						filename,
						mimeType,
						sizeBytes: data.byteLength,
					},
				],
				metadata: { eventId: event.event_id },
			});
		} catch {
			// Media download failures are non-fatal.
		}
	}

	override get mediaCapabilities(): ChannelMediaCapabilities {
		return { kinds: ["image", "video", "audio", "file"], urlDirect: false };
	}

	async send(message: OutboundMessage): Promise<ChannelSendResult> {
		const base = this.cfg.homeserver ?? "";
		const failedMedia: string[] = [];
		let providerMessageId: string | undefined;
		for (const item of this.collectOutboundMedia(message)) {
			try {
				providerMessageId =
					(await this.sendMedia(base, message.chatId, item, message.replyTo)) ?? providerMessageId;
			} catch (error) {
				this.channelContext.logger?.error(
					`[matrix] media send failed source=${item.source}: ${formatError(error)}`,
				);
				failedMedia.push(item.filename ?? item.source);
			}
		}
		const content = withMediaFailureNote(message.content, failedMedia);
		if (content) {
			providerMessageId =
				(await this.sendText(base, message.chatId, content, message.replyTo, message.threadId)) ??
				providerMessageId;
		}
		return failedMedia.length > 0
			? { status: "partial", providerMessageId, detail: `media failed: ${failedMedia.join(", ")}` }
			: { status: "success", providerMessageId };
	}

	private async sendText(
		base: string,
		roomId: string,
		text: string,
		replyTo?: string,
		threadId?: string,
	): Promise<string | undefined> {
		const txn = matrixTxn();
		const relatesTo = threadId
			? {
					"m.in_reply_to": { event_id: threadId },
					"m.thread": { event_id: threadId },
				}
			: replyTo
				? { "m.in_reply_to": { event_id: replyTo } }
				: undefined;
		const response = await this.fetchFn(
			`${base}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txn}`,
			{
				method: "PUT",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${this.cfg.accessToken ?? ""}`,
				},
				body: JSON.stringify({
					msgtype: "m.text",
					body: text,
					...(relatesTo ? { "m.relates_to": relatesTo } : {}),
				}),
			},
		);
		if (!response.ok) {
			throw new Error(`Matrix send failed: ${response.status} ${await response.text()}`);
		}
		const body = (await response.json()) as { event_id?: string };
		return body.event_id;
	}

	private async sendMedia(
		base: string,
		roomId: string,
		item: ChannelAttachment,
		replyTo?: string,
	): Promise<string | undefined> {
		const media = await resolveOutboundMedia(item, { fetchFn: this.fetchFn });
		const filename = encodeURIComponent(media.filename);
		const uploadResponse = await this.fetchFn(`${base}/_matrix/media/v3/upload?filename=${filename}`, {
			method: "POST",
			headers: {
				"Content-Type": media.mimeType,
				Authorization: `Bearer ${this.cfg.accessToken ?? ""}`,
			},
			body: media.data,
		});
		if (!uploadResponse.ok) {
			throw new Error(`Matrix media upload failed: ${uploadResponse.status} ${await uploadResponse.text()}`);
		}
		const uploadBody = (await uploadResponse.json()) as { content_uri?: string };
		if (!uploadBody.content_uri) {
			throw new Error("Matrix media upload returned no content_uri");
		}
		const txn = matrixTxn();
		const response = await this.fetchFn(
			`${base}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txn}`,
			{
				method: "PUT",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${this.cfg.accessToken ?? ""}`,
				},
				body: JSON.stringify({
					msgtype: MATRIX_MSGTYPE[item.kind] ?? "m.file",
					body: media.filename,
					url: uploadBody.content_uri,
					info: { mimetype: media.mimeType, size: media.data.length },
					...(replyTo ? { "m.relates_to": { "m.in_reply_to": { event_id: replyTo } } } : {}),
				}),
			},
		);
		if (!response.ok) {
			throw new Error(`Matrix send failed: ${response.status} ${await response.text()}`);
		}
		const body = (await response.json()) as { event_id?: string };
		return body.event_id;
	}

	// ------------------------------------------------------------------
	// Streaming: first delta sends, later deltas edit via m.replace
	// ------------------------------------------------------------------

	private readonly streamIds = new Map<string, string>();

	async sendDelta(delta: OutboundDelta): Promise<void> {
		const base = this.cfg.homeserver ?? "";
		const existing = this.streamIds.get(delta.chatId);
		if (existing === undefined) {
			const sent = await this.sendText(base, delta.chatId, delta.delta, delta.replyTo);
			if (sent) this.streamIds.set(delta.chatId, sent);
			return;
		}
		const txn = matrixTxn();
		const response = await this.fetchFn(
			`${base}/_matrix/client/v3/rooms/${encodeURIComponent(delta.chatId)}/send/m.room.message/${txn}`,
			{
				method: "PUT",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${this.cfg.accessToken ?? ""}`,
				},
				body: JSON.stringify({
					msgtype: "m.text",
					body: delta.delta,
					"m.new_content": { msgtype: "m.text", body: delta.delta },
					"m.relates_to": { rel_type: "m.replace", event_id: existing },
				}),
			},
		);
		if (!response.ok) {
			throw new Error(`Matrix edit failed: ${response.status} ${await response.text()}`);
		}
		if (delta.streamEnd) this.streamIds.delete(delta.chatId);
	}
}

const MATRIX_MSGTYPE: Record<string, string> = {
	image: "m.image",
	video: "m.video",
	audio: "m.audio",
	file: "m.file",
};

function matrixTxn(): string {
	return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function toBase64(data: Uint8Array): string {
	return Buffer.from(data).toString("base64");
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
