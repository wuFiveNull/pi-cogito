/**
 * MochatChannel — mochat.io Claw bot 通道,零依赖。
 *
 * 接收:socket.io v4(EIO=4,JSON,websocket transport)连接
 * {socketUrl}/socket.io/,auth {"token": clawToken};订阅
 * com.claw.im.subscribeSessions / com.claw.im.subscribePanels(带 ack);
 * 处理 claw.session.events / claw.panel.events / notify:chat.message.add /
 * notify:chat.inbox.append 事件。
 * 发送:HTTP POST {baseUrl}/api/claw/sessions/send(X-Claw-Token 认证)。
 * 协议对齐 python-socketio JSON 序列化模式(socket_disable_msgpack)。
 */

import type { MessageBus } from "../bus.ts";
import { type ChannelMediaCapabilities, withMediaFailureNote } from "../media.ts";
import type { ChannelSendResult, OutboundMessage } from "../types.ts";
import { BaseChannel, type ChannelConfig } from "./base.ts";
import type { ChannelContext } from "./context.ts";
import { GenericWsClient, type WsLike } from "./ws-common.ts";

export interface MochatConfig extends ChannelConfig {
	/** 平台地址。默认 https://mochat.io。 */
	baseUrl?: string;
	/** socket.io 地址,默认取 baseUrl。 */
	socketUrl?: string;
	/** socket.io 路径。默认 /socket.io。 */
	socketPath?: string;
	/** Claw token。 */
	clawToken?: string;
	/** 订阅的 session id 列表。 */
	sessions?: string[];
	/** 订阅的 panel id 列表。 */
	panels?: string[];
	/** 机器人自己的用户 id(跳过自身消息)。 */
	agentUserId?: string;
	/** 订阅拉取条数。默认 20。 */
	watchLimit?: number;
	/** 重连延迟 ms。默认 1000。 */
	reconnectDelayMs?: number;
}

interface MochatWatchPayload {
	sessionId?: string;
	cursor?: number;
	events?: Array<{
		type?: string;
		seq?: number;
		payload?: {
			author?: string;
			messageId?: string;
			content?: unknown;
			meta?: unknown;
			createdAt?: unknown;
		};
	}>;
}

interface MochatNotifyPayload {
	groupId?: string;
	converseId?: string;
	panelId?: string;
	_id?: string;
	messageId?: string;
	author?: string;
	content?: unknown;
	createdAt?: unknown;
	type?: string;
	payload?: {
		converseId?: string;
		messageId?: string;
		messageAuthor?: string;
		messagePlainContent?: string;
		groupId?: string;
	};
}

export class MochatChannel extends BaseChannel {
	name = "mochat";
	displayName = "Mochat";

	private readonly cfg: MochatConfig;
	private readonly socket: WsLike;
	private readonly fetchFn: typeof fetch;
	private heartbeatTimer: NodeJS.Timeout | undefined;
	private readonly ackWaiters = new Map<number, (value: unknown) => void>();
	private ackCounter = 0;
	private readonly processedIds = new Set<string>();
	private readonly sessionCursors = new Map<string, number>();

	constructor(
		config: ChannelConfig | undefined,
		bus: MessageBus,
		options: { socket?: WsLike; fetchFn?: typeof fetch } = {},
	) {
		super(config, bus);
		this.cfg = (config ?? {}) as MochatConfig;
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
		if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
		this.heartbeatTimer = undefined;
		this.socket.close();
		for (const resolve of this.ackWaiters.values()) resolve(undefined);
		this.ackWaiters.clear();
	}

	private socketUrl(): string {
		const base = (this.cfg.socketUrl ?? this.cfg.baseUrl ?? "https://mochat.io").replace(/\/$/, "");
		const path = (this.cfg.socketPath ?? "/socket.io").replace(/^\//, "");
		return `${base}/${path}/?EIO=4&transport=websocket`;
	}

	private async loop(): Promise<void> {
		let delay = this.cfg.reconnectDelayMs ?? 1000;
		while (this.running) {
			try {
				await this.socket.connect(this.socketUrl());
				this.socket.onMessage(
					(text) =>
						void this.handlePacket(text).catch((error: unknown) => {
							this.channelContext.logger?.error(`[mochat] packet processing failed: ${formatError(error)}`);
						}),
				);
				// Engine.IO: after open ("0..."), connect with auth.
				this.heartbeatTimer = setInterval(() => {
					this.socket.send("2"); // engine.io ping
				}, 25_000);
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

	// ------------------------------------------------------------------
	// Socket.IO v4 JSON packet handling
	// ------------------------------------------------------------------

	private async handlePacket(text: string): Promise<void> {
		if (text === "2") {
			this.socket.send("3"); // engine.io pong
			return;
		}
		if (text === "3") return;
		if (text.startsWith("0")) {
			// Open packet: connect with auth (socket.io v4: "40" + JSON auth).
			this.socket.send(`40${JSON.stringify({ token: this.cfg.clawToken ?? "" })}`);
			return;
		}
		if (text.startsWith("40")) {
			// Connected: subscribe to watched sessions/panels.
			await this.subscribeAll();
			return;
		}
		if (text.startsWith("42")) {
			const payload = text.slice(2);
			let data: unknown;
			try {
				data = JSON.parse(payload);
			} catch {
				return;
			}
			if (!Array.isArray(data) || typeof data[0] !== "string") return;
			const event = data[0] as string;
			const args = data.slice(1);
			await this.handleEvent(event, args[0]);
			return;
		}
		if (text.startsWith("43")) {
			// Ack response: "43" + ackId + JSON.
			const match = /^43(\d+)([\s\S]*)$/.exec(text);
			if (!match) return;
			const resolve = this.ackWaiters.get(Number(match[1]));
			if (!resolve) return;
			this.ackWaiters.delete(Number(match[1]));
			try {
				resolve(JSON.parse(match[2] ?? "null"));
			} catch {
				resolve(undefined);
			}
		}
	}

	private emitWithAck(event: string, payload: unknown, timeoutMs = 10_000): Promise<unknown> {
		const ackId = ++this.ackCounter;
		return new Promise((resolve) => {
			this.ackWaiters.set(ackId, resolve);
			this.socket.send(`421${ackId}${JSON.stringify([event, payload])}`);
			const timer = setTimeout(() => {
				this.ackWaiters.delete(ackId);
				resolve(undefined);
			}, timeoutMs);
			timer.unref?.();
		});
	}

	private async subscribeAll(): Promise<void> {
		const sessions = this.cfg.sessions ?? [];
		const panels = this.cfg.panels ?? [];
		if (sessions.length > 0) {
			const cursors = Object.fromEntries(this.sessionCursors.entries()) as Record<string, number>;
			const ack = (await this.emitWithAck("com.claw.im.subscribeSessions", {
				sessionIds: sessions,
				cursors,
				limit: this.cfg.watchLimit ?? 20,
			})) as { result?: boolean; data?: unknown } | undefined;
			if (!ack?.result) {
				this.channelContext.logger?.warn("[mochat] subscribeSessions failed");
			}
		}
		if (panels.length > 0) {
			const ack = (await this.emitWithAck("com.claw.im.subscribePanels", {
				panelIds: panels,
			})) as { result?: boolean } | undefined;
			if (!ack?.result) {
				this.channelContext.logger?.warn("[mochat] subscribePanels failed");
			}
		}
	}

	private async handleEvent(event: string, payload: unknown): Promise<void> {
		if (event === "claw.session.events" || event === "claw.panel.events") {
			await this.handleWatchPayload(payload as MochatWatchPayload, event === "claw.panel.events");
			return;
		}
		if (event === "notify:chat.message.add" || event === "notify:chat.message.update") {
			await this.handleNotifyMessage(payload as MochatNotifyPayload);
			return;
		}
		if (event === "notify:chat.inbox.append") {
			await this.handleInboxAppend(payload as MochatNotifyPayload);
		}
	}

	private async handleWatchPayload(payload: MochatWatchPayload, isPanel: boolean): Promise<void> {
		const targetId = payload.sessionId;
		if (!targetId || !Array.isArray(payload.events)) return;
		if (!isPanel && typeof payload.cursor === "number" && payload.cursor >= 0) {
			this.sessionCursors.set(targetId, payload.cursor);
		}
		for (const event of payload.events) {
			if (event.type !== "message.add" || !event.payload) continue;
			const message = event.payload;
			const author = message.author ?? "";
			if (!author || (this.cfg.agentUserId && author === this.cfg.agentUserId)) continue;
			if (!this.isAllowed(author)) continue;
			const messageId = message.messageId ?? "";
			const key = `${isPanel ? "panel" : "session"}:${targetId}`;
			if (messageId && this.seenMessage(key, messageId)) continue;
			const content = normalizeContent(message.content);
			if (!content) continue;
			await this.handleMessage({
				messageId: messageId || undefined,
				senderId: author,
				chatId: targetId,
				content,
				metadata: { source: "watch", isPanel, createdAt: message.createdAt },
				isDm: !isPanel,
			});
		}
	}

	private async handleNotifyMessage(payload: MochatNotifyPayload): Promise<void> {
		const panelId = payload.converseId ?? payload.panelId ?? "";
		if (!panelId || !payload.author) return;
		const messageId = String(payload._id ?? payload.messageId ?? "");
		const key = `panel:${panelId}`;
		if (messageId && this.seenMessage(key, messageId)) return;
		const content = normalizeContent(payload.content);
		if (!content) return;
		if (this.cfg.agentUserId && payload.author === this.cfg.agentUserId) return;
		if (!this.isAllowed(payload.author)) return;
		await this.handleMessage({
			messageId: messageId || undefined,
			senderId: payload.author,
			chatId: panelId,
			content,
			metadata: { source: "notify:chat.message", createdAt: payload.createdAt },
			isDm: false,
		});
	}

	private async handleInboxAppend(payload: MochatNotifyPayload): Promise<void> {
		if (payload.type !== "message" || !payload.payload || payload.payload.groupId) return;
		const detail = payload.payload;
		const converseId = detail.converseId ?? "";
		if (!converseId) return;
		const author = detail.messageAuthor ?? "";
		if (!author || (this.cfg.agentUserId && author === this.cfg.agentUserId)) return;
		if (!this.isAllowed(author)) return;
		const messageId = detail.messageId ?? "";
		const key = `session:${converseId}`;
		if (messageId && this.seenMessage(key, messageId)) return;
		const content = (detail.messagePlainContent ?? "").trim();
		if (!content) return;
		await this.handleMessage({
			messageId: messageId || undefined,
			senderId: author,
			chatId: converseId,
			content,
			metadata: { source: "notify:chat.inbox.append", converseId },
			isDm: true,
		});
	}

	private seenMessage(key: string, messageId: string): boolean {
		const full = `${key}:${messageId}`;
		if (this.processedIds.has(full)) return true;
		if (this.processedIds.size >= 4096) {
			const oldest = this.processedIds.keys().next().value;
			if (oldest !== undefined) this.processedIds.delete(oldest);
		}
		this.processedIds.add(full);
		return false;
	}

	// ------------------------------------------------------------------
	// 发送:HTTP /api/claw/sessions/send
	// ------------------------------------------------------------------

	override get mediaCapabilities(): ChannelMediaCapabilities {
		return { kinds: [], urlDirect: false };
	}

	async send(message: OutboundMessage): Promise<ChannelSendResult> {
		const failedMedia = [...(message.media ?? []), ...(message.attachments ?? []).map((a) => a.source)].filter(
			(source) => source.trim().length > 0,
		);
		const content = withMediaFailureNote(message.content, failedMedia);
		if (!content) return { status: "success" };
		const base = (this.cfg.baseUrl ?? "https://mochat.io").replace(/\/$/, "");
		const isPanel = this.cfg.panels?.includes(message.chatId) ?? false;
		const path = isPanel ? "/api/claw/groups/panels/send" : "/api/claw/sessions/send";
		const payload: Record<string, unknown> = {
			...(isPanel ? { panelId: message.chatId } : { sessionId: message.chatId }),
			content,
		};
		if (message.replyTo) payload.replyTo = message.replyTo;
		const response = await this.fetchFn(`${base}${path}`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-Claw-Token": this.cfg.clawToken ?? "" },
			body: JSON.stringify(payload),
		});
		if (!response.ok) {
			throw new Error(`mochat send failed: ${response.status} ${await response.text()}`);
		}
		return failedMedia.length > 0
			? { status: "partial", detail: `media not supported: ${failedMedia.join(", ")}` }
			: { status: "success" };
	}
}

function normalizeContent(value: unknown): string {
	if (typeof value === "string") return value.trim();
	if (typeof value === "object" && value !== null) {
		const record = value as Record<string, unknown>;
		if (typeof record.text === "string") return record.text.trim();
		if (typeof record.content === "string") return record.content.trim();
	}
	return "";
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
