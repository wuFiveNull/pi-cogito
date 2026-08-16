/**
 * MattermostChannel — WebSocket + REST API, zero-dependency.
 *
 * Connects to {serverUrl}/api/v4/websocket with a personal access token,
 * listens for "posted" events, and replies via POST /api/v4/posts.
 *
 * chatId convention: channel_id.
 */

import type { MessageBus } from "../bus.ts";
import { type ChannelMediaCapabilities, resolveOutboundMedia, withMediaFailureNote } from "../media.ts";
import type { ChannelAttachment, ChannelSendResult, OutboundDelta, OutboundMessage } from "../types.ts";
import { BaseChannel, type ChannelConfig } from "./base.ts";
import { GenericWsClient, type WsLike } from "./ws-common.ts";

export interface MattermostConfig extends ChannelConfig {
	serverUrl?: string;
	token?: string;
	/** User id of the bot (its own posts are ignored). */
	botUserId?: string;
	/** Auto-reconnect delay in ms. Default 5000. */
	reconnectDelayMs?: number;
}

interface MattermostPosted {
	event?: string;
	data?: { post?: string; sender_name?: string };
}

export class MattermostChannel extends BaseChannel {
	name = "mattermost";
	displayName = "Mattermost";

	private readonly cfg: MattermostConfig;
	private readonly socket: WsLike;
	private readonly fetchFn: typeof fetch;

	constructor(
		config: ChannelConfig | undefined,
		bus: MessageBus,
		options: { socket?: WsLike; fetchFn?: typeof fetch } = {},
	) {
		super(config, bus);
		this.cfg = (config ?? {}) as MattermostConfig;
		this.socket = options.socket ?? new GenericWsClient();
		this.fetchFn = options.fetchFn ?? fetch;
	}

	async start(): Promise<void> {
		if (this.running) return;
		this.running = true;
		void this.loop();
	}

	async stop(): Promise<void> {
		this.running = false;
		this.socket.close();
	}

	private wsUrl(): string {
		const base = this.cfg.serverUrl ?? "";
		const wsBase = base.replace(/^https:/, "wss:").replace(/^http:/, "ws:");
		return `${wsBase.replace(/\/$/, "")}/api/v4/websocket`;
	}

	private async loop(): Promise<void> {
		while (this.running) {
			try {
				await this.socket.connect(this.wsUrl(), { Authorization: `Bearer ${this.cfg.token ?? ""}` });
				this.socket.onMessage((text) => void this.handlePayload(text));
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

	private handlePayload(text: string): void {
		let envelope: MattermostPosted;
		try {
			envelope = JSON.parse(text) as MattermostPosted;
		} catch {
			return;
		}
		if (envelope.event !== "posted" || !envelope.data?.post) return;
		let post: { id?: string; channel_id?: string; user_id?: string; message?: string; type?: string };
		try {
			post = JSON.parse(envelope.data.post) as typeof post;
		} catch {
			return;
		}
		if (!post.channel_id || typeof post.message !== "string") return;
		if (post.type && post.type !== "") return; // system posts
		if (this.cfg.botUserId && post.user_id === this.cfg.botUserId) return;

		void this.handleMessage({
			messageId: post.id,
			senderId: post.user_id ?? "unknown",
			chatId: post.channel_id,
			content: post.message,
		});
	}

	override get mediaCapabilities(): ChannelMediaCapabilities {
		return { kinds: ["image", "video", "audio", "file"], urlDirect: false };
	}

	async send(message: OutboundMessage): Promise<ChannelSendResult> {
		const fileIds: string[] = [];
		const failedMedia: string[] = [];
		for (const item of this.collectOutboundMedia(message)) {
			try {
				const fileId = await this.uploadFile(message.chatId, item);
				if (fileId) fileIds.push(fileId);
			} catch (error) {
				this.channelContext.logger?.error(
					`[mattermost] media send failed source=${item.source}: ${formatError(error)}`,
				);
				failedMedia.push(item.filename ?? item.source);
			}
		}
		const response = await this.fetchFn(`${this.cfg.serverUrl ?? ""}/api/v4/posts`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${this.cfg.token ?? ""}`,
			},
			body: JSON.stringify({
				channel_id: message.chatId,
				message: withMediaFailureNote(message.content, failedMedia),
				...(fileIds.length > 0 ? { file_ids: fileIds } : {}),
				...(message.replyTo ? { root_id: message.replyTo } : {}),
			}),
		});
		if (!response.ok) {
			throw new Error(`Mattermost post failed: ${response.status} ${await response.text()}`);
		}
		const body = (await response.json()) as { id?: string };
		return failedMedia.length > 0
			? { status: "partial", providerMessageId: body.id, detail: `media failed: ${failedMedia.join(", ")}` }
			: { status: "success", providerMessageId: body.id };
	}

	// ------------------------------------------------------------------
	// Streaming: first delta posts, later deltas edit the post
	// ------------------------------------------------------------------

	private readonly streamIds = new Map<string, string>();

	async sendDelta(delta: OutboundDelta): Promise<void> {
		const existing = this.streamIds.get(delta.chatId);
		if (existing === undefined) {
			const response = await this.fetchFn(`${this.cfg.serverUrl ?? ""}/api/v4/posts`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${this.cfg.token ?? ""}`,
				},
				body: JSON.stringify({
					channel_id: delta.chatId,
					message: delta.delta,
					...(delta.replyTo ? { root_id: delta.replyTo } : {}),
				}),
			});
			if (!response.ok) {
				throw new Error(`Mattermost post failed: ${response.status} ${await response.text()}`);
			}
			const body = (await response.json()) as { id?: string };
			if (body.id) this.streamIds.set(delta.chatId, body.id);
			return;
		}
		const response = await this.fetchFn(`${this.cfg.serverUrl ?? ""}/api/v4/posts/${existing}`, {
			method: "PUT",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${this.cfg.token ?? ""}`,
			},
			body: JSON.stringify({ message: delta.delta }),
		});
		if (!response.ok) {
			throw new Error(`Mattermost edit failed: ${response.status} ${await response.text()}`);
		}
		if (delta.streamEnd) this.streamIds.delete(delta.chatId);
	}

	private async uploadFile(channelId: string, item: ChannelAttachment): Promise<string | undefined> {
		const media = await resolveOutboundMedia(item, { fetchFn: this.fetchFn });
		const form = new FormData();
		form.append("channel_id", channelId);
		form.append("files", new Blob([media.data], { type: media.mimeType }), media.filename);
		const response = await this.fetchFn(`${this.cfg.serverUrl ?? ""}/api/v4/files`, {
			method: "POST",
			headers: { Authorization: `Bearer ${this.cfg.token ?? ""}` },
			body: form,
		});
		if (!response.ok) {
			throw new Error(`Mattermost file upload failed: ${response.status} ${await response.text()}`);
		}
		const body = (await response.json()) as { file_infos?: Array<{ id?: string }> };
		return body.file_infos?.[0]?.id;
	}
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
