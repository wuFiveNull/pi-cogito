/**
 * QqChannel — QQ 官方开放平台机器人(api-v2),零依赖。
 *
 * 连接 https://api.sgroup.qq.com/gateway 分发的 WS gateway,IDENTIFY
 * (token = "Bot AppID.Token",intents = GROUP_AND_C2C_EVENT 1<<25),心跳,
 * 监听 C2C_MESSAGE_CREATE / GROUP_AT_MESSAGE_CREATE;发送走
 * /v2/users/{openid}/messages 与 /v2/groups/{group_openid}/messages。
 * 群聊消息需 @机器人(平台只投递 at 消息);入站附件下载为
 * images/attachments。
 */

import type { MessageBus } from "../bus.ts";
import { type ChannelMediaCapabilities, withMediaFailureNote } from "../media.ts";
import type { ChannelAttachment, ChannelSendResult, ImageAttachment, OutboundMessage } from "../types.ts";
import { BaseChannel, type ChannelConfig } from "./base.ts";
import type { ChannelContext } from "./context.ts";
import { GenericWsClient, type WsLike } from "./ws-common.ts";

export interface QqConfig extends ChannelConfig {
	/** 开放平台 AppID。 */
	appId?: string;
	/** 机器人令牌(控制台「令牌」;兼容旧字段 secret)。 */
	token?: string;
	/** API 域名。默认 https://api.sgroup.qq.com。 */
	apiBase?: string;
	/** 重连延迟 ms。默认 5000。 */
	reconnectDelayMs?: number;
}

/** GROUP_AND_C2C_EVENT:群聊 @消息 + C2C 消息。 */
const INTENTS = 1 << 25;

interface QqDispatchData {
	t?: string;
	d?:
		| boolean
		| {
				id?: string;
				content?: string;
				author?: { user_openid?: string; member_openid?: string; id?: string };
				group_openid?: string;
				attachments?: Array<{ url?: string; filename?: string; content_type?: string }>;
		  };
	s?: number;
}

export class QqOfficialChannel extends BaseChannel {
	name = "qqofficial";
	displayName = "QQ Official";

	private readonly cfg: QqConfig;
	private readonly socket: WsLike;
	private readonly fetchFn: typeof fetch;
	private heartbeatTimer: NodeJS.Timeout | undefined;
	private sequence: number | undefined;
	private readonly processedIds = new Set<string>();

	constructor(
		config: ChannelConfig | undefined,
		bus: MessageBus,
		options: { socket?: WsLike; fetchFn?: typeof fetch } = {},
	) {
		super(config, bus);
		this.cfg = (config ?? {}) as QqConfig;
		this.socket = options.socket ?? new GenericWsClient();
		this.fetchFn = options.fetchFn ?? fetch;
	}

	private apiBase(): string {
		return this.cfg.apiBase ?? "https://api.sgroup.qq.com";
	}

	private authHeader(): string {
		return `Bot ${this.cfg.appId ?? ""}.${this.cfg.token ?? ""}`;
	}

	async start(context?: ChannelContext): Promise<void> {
		if (this.running) return;
		if (context) this.bindContext(context);
		this.running = true;
		void this.loop();
	}

	async stop(): Promise<void> {
		this.running = false;
		if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
		this.heartbeatTimer = undefined;
		this.socket.close();
	}

	private async gatewayUrl(): Promise<string> {
		const response = await this.fetchFn(`${this.apiBase()}/gateway`, {
			headers: { Authorization: this.authHeader() },
		});
		if (!response.ok) throw new Error(`qq gateway discovery failed: ${response.status}`);
		const body = (await response.json()) as { url?: string };
		if (!body.url) throw new Error("qq gateway discovery returned no url");
		return body.url;
	}

	private async loop(): Promise<void> {
		let delay = this.cfg.reconnectDelayMs ?? 5000;
		while (this.running) {
			try {
				const url = await this.gatewayUrl();
				await this.socket.connect(url);
				this.socket.onMessage(
					(text) =>
						void this.handlePayload(text).catch((error: unknown) => {
							this.channelContext.logger?.error(`[qq] event processing failed: ${formatError(error)}`);
						}),
				);
				await new Promise<void>((resolve) => {
					this.socket.onClose(() => resolve());
				});
			} catch {
				// fall through to reconnect
			}
			if (this.heartbeatTimer) {
				clearInterval(this.heartbeatTimer);
				this.heartbeatTimer = undefined;
			}
			if (!this.running) return;
			await sleep(delay);
			delay = Math.min(delay * 2, 30_000);
		}
	}

	private async handlePayload(text: string): Promise<void> {
		let envelope: QqDispatchData;
		try {
			envelope = JSON.parse(text) as QqDispatchData;
		} catch {
			return;
		}
		const op = (envelope as { op?: number }).op ?? -1;
		if (op === 10) {
			const hello = (envelope as unknown as { d?: { hello?: { heartbeat_interval?: number } } }).d?.hello;
			this.socket.send(JSON.stringify(this.identifyPayload()));
			this.heartbeatTimer = setInterval(() => {
				this.socket.send(JSON.stringify({ op: 1, d: this.sequence ?? 0 }));
			}, hello?.heartbeat_interval ?? 41_250);
			return;
		}
		if (op === 1) {
			this.socket.send(JSON.stringify({ op: 1, d: this.sequence ?? 0 }));
			return;
		}
		if (op === 7 || op === 9) {
			this.socket.close();
			return;
		}
		if (op === 0 && envelope.t !== undefined) {
			const data = envelope.d;
			if (data && typeof data === "object") {
				if (envelope.t === "C2C_MESSAGE_CREATE") {
					await this.handleMessageEvent(data, false);
				} else if (envelope.t === "GROUP_AT_MESSAGE_CREATE") {
					await this.handleMessageEvent(data, true);
				}
			}
			if (envelope.s !== undefined) this.sequence = envelope.s;
		}
	}

	private identifyPayload(): Record<string, unknown> {
		return {
			op: 2,
			d: {
				token: this.authHeader(),
				intents: INTENTS,
				shard: [0, 1],
				properties: { os: "linux", browser: "agent-gateway", device: "agent-gateway" },
			},
		};
	}

	private async handleMessageEvent(
		data: NonNullable<Extract<QqDispatchData["d"], object>>,
		isGroup: boolean,
	): Promise<void> {
		if (!data.id || !data.content) return;
		if (this.processedIds.has(data.id)) return;
		this.processedIds.add(data.id);
		if (this.processedIds.size > 4096) {
			const oldest = this.processedIds.keys().next().value;
			if (oldest !== undefined) this.processedIds.delete(oldest);
		}
		const chatId = isGroup
			? (data.group_openid ?? "unknown")
			: (data.author?.user_openid ?? data.author?.id ?? "unknown");
		const senderId = isGroup ? (data.author?.member_openid ?? "unknown") : (data.author?.user_openid ?? "unknown");
		const content = data.content
			.replace(/<@!\d+>/g, "")
			.replace(/<@\d+>/g, "")
			.trim();
		if (!content) return;

		const attachments: ChannelAttachment[] = [];
		const images: ImageAttachment[] = [];
		for (const attachment of data.attachments ?? []) {
			if (!attachment.url) continue;
			const downloaded = await this.downloadAttachment(attachment.url, attachment.content_type ?? "");
			if (!downloaded) continue;
			if (downloaded.kind === "image") images.push(downloaded.image);
			else attachments.push(downloaded.attachment);
		}

		const result = await this.handleMessage({
			messageId: data.id,
			senderId,
			chatId,
			content,
			attachments: attachments.length > 0 ? attachments : undefined,
			images: images.length > 0 ? images : undefined,
			metadata: { messageId: data.id, chatType: isGroup ? "group" : "c2c", groupOpenId: data.group_openid },
			isDm: !isGroup,
		});
		if (result.status === "rejected") {
			this.channelContext.logger?.warn(`[qq] message rejected: ${result.detail ?? "unauthorized"}`);
		}
	}

	private async downloadAttachment(
		url: string,
		contentType: string,
	): Promise<{ kind: "image"; image: ImageAttachment } | { kind: "file"; attachment: ChannelAttachment } | undefined> {
		try {
			const response = await this.fetchFn(url);
			if (!response.ok) return undefined;
			const data = new Uint8Array(await response.arrayBuffer());
			if (data.byteLength > 20 * 1024 * 1024) return undefined;
			const mimeType = sniffImageMime(data) ?? contentType;
			if (mimeType.startsWith("image/")) {
				return { kind: "image", image: { type: "image", data: toBase64(data), mimeType } };
			}
			return {
				kind: "file",
				attachment: {
					kind: "file",
					source: `data:${mimeType || "application/octet-stream"};base64,${toBase64(data)}`,
					filename: `qq-attachment-${Date.now()}`,
					mimeType: mimeType || undefined,
					sizeBytes: data.byteLength,
				},
			};
		} catch {
			return undefined;
		}
	}

	// ------------------------------------------------------------------
	// 发送
	// ------------------------------------------------------------------

	override get mediaCapabilities(): ChannelMediaCapabilities {
		// 富媒体需先走 /v2/rich-media 上传换取 media_id;先支持文本。
		return { kinds: [], urlDirect: false };
	}

	async send(message: OutboundMessage): Promise<ChannelSendResult> {
		const failedMedia = [...(message.media ?? []), ...(message.attachments ?? []).map((a) => a.source)].filter(
			(source) => source.trim().length > 0,
		);
		const content = withMediaFailureNote(message.content, failedMedia);
		if (!content) return { status: "success" };
		const isGroup = message.chatId.startsWith("group:");
		const path = isGroup
			? `/v2/groups/${encodeURIComponent(message.chatId.slice("group:".length))}/messages`
			: `/v2/users/${encodeURIComponent(message.chatId)}/messages`;
		const response = await this.fetchFn(`${this.apiBase()}${path}`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: this.authHeader() },
			body: JSON.stringify({
				content,
				msg_type: 0,
				...(message.replyTo ? { msg_id: message.replyTo } : {}),
			}),
		});
		if (!response.ok) {
			throw new Error(`qq send failed: ${response.status} ${await response.text()}`);
		}
		const body = (await response.json()) as { id?: string };
		return failedMedia.length > 0
			? { status: "partial", providerMessageId: body.id, detail: `media not supported: ${failedMedia.join(", ")}` }
			: { status: "success", providerMessageId: body.id };
	}
}

function toBase64(data: Uint8Array): string {
	return Buffer.from(data).toString("base64");
}

function sniffImageMime(bytes: Uint8Array): string | undefined {
	if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
	if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
		return "image/png";
	}
	return undefined;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
