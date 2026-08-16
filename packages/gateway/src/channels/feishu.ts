/**
 * FeishuChannel — 飞书长连接模式(WebSocket),零依赖。
 *
 * 协议对齐 lark-oapi SDK v1.7.1 的 ws client:
 *   1. POST {domain}/callback/ws/endpoint 用 AppID/AppSecret 换取长连接地址
 *      (URL 自带 device_id / service_id 凭证)
 *   2. WS 帧为 protobuf 编码的 Frame(headers / service / method / payload)
 *      - method: 0 = CONTROL(心跳 ping/pong), 1 = DATA(事件)
 *      - DATA 帧 headers: type / message_id / sum / seq / trace_id
 *      - sum > 1 时按 message_id 分片重组;收到事件后需原帧回 ack {code:200}
 *   3. 心跳:每 PingInterval 秒发 CONTROL 帧 type=ping(服务端通过 pong 下发配置)
 *   4. 发送:POST {domain}/open-apis/im/v1/messages(tenant_access_token 认证)
 *
 * 群聊策略:私聊(p2p)全部响应;群聊仅在 @机器人 或 @所有人 时响应,
 * 并移除文本中的 @占位符(@_user_N / @_all)。
 * 飞书普通文本消息不可编辑,故不支持流式 delta。
 */

import { createDecipheriv, createHash, randomUUID } from "node:crypto";
import type { MessageBus } from "../bus.ts";
import { resolveOutboundMedia, sniffImageMime } from "../media.ts";
import type {
	ChannelAttachment,
	ChannelSendResult,
	ImageAttachment,
	OutboundDelta,
	OutboundMessage,
} from "../types.ts";
import { BaseChannel, type ChannelConfig } from "./base.ts";
import type { ChannelContext } from "./context.ts";
import { GenericWsClient, type WsLike } from "./ws-common.ts";

export interface FeishuConfig extends ChannelConfig {
	appId?: string;
	appSecret?: string;
	/** 事件加密策略的 Encrypt Key(未开启加密可不填)。 */
	encryptKey?: string;
	/** API 域名,默认 https://open.feishu.cn(Lark 国际版 https://open.larksuite.com)。 */
	domain?: string;
	/** 机器人自己的 open_id,群聊 @机器人 判断用(可选)。 */
	botOpenId?: string;
	/** 重连抖动上限(秒),默认 30。 */
	reconnectNonce?: number;
	/** 流式卡片更新节流(ms),默认 250。 */
	streamEditIntervalMs?: number;
	/** 入站消息的 reaction emoji 类型(如 THUMBSUP / OK)。空字符串禁用。默认 "THUMBSUP"。 */
	reactEmoji?: string;
}

/** 飞书 WS 帧(protobuf,字段号见 lark_oapi/ws/pb/pbbp2.proto)。 */
interface FeishuFrame {
	SeqID: number;
	LogID: number;
	service: number;
	method: number;
	headers: Array<[string, string]>;
	payload: Uint8Array;
}

const FRAME_CONTROL = 0;
const FRAME_DATA = 1;

/**
 * 把文本解析为飞书富文本 post 消息的行节点数组。
 * 每行一个数组,`<a href="url">text</a>` 转成链接节点,其余为文本节点。
 */
function parsePostContent(text: string): Array<Array<{ tag: string; text?: string; href?: string }>> {
	const linkRe = /<a href="([^"]+)">([^<]+)<\/a>/g;
	return text.split("\n").map((line) => {
		const nodes: Array<{ tag: string; text?: string; href?: string }> = [];
		let last = 0;
		for (const match of line.matchAll(linkRe)) {
			const index = match.index ?? 0;
			if (index > last) nodes.push({ tag: "text", text: line.slice(last, index) });
			nodes.push({ tag: "a", text: match[2], href: match[1] });
			last = index + match[0].length;
		}
		if (last < line.length) nodes.push({ tag: "text", text: line.slice(last) });
		if (nodes.length === 0) nodes.push({ tag: "text", text: "" });
		return nodes;
	});
}

/** 单个流式回复的累积缓冲(CardKit 卡片)。 */
interface FeishuStreamBuf {
	chatId: string;
	text: string;
	/** 被回复的用户消息 id(引用/回复)。 */
	replyTo?: string;
	cardId?: string;
	sequence: number;
	lastEdit: number;
	failed?: boolean;
	/** 卡片创建中(不阻塞后续 delta 处理,streamEnd 时等待其完成)。 */
	creatingPromise?: Promise<void>;
}

/**
 * 提取飞书富文本 post 消息的纯文本:content JSON 形如
 * `{ title, content: [[{tag:"text",text},{tag:"a",text,href}], ...] }`。
 * 链接以 `text (href)` 形式保留,便于 agent 读取。
 */
function extractPostText(content: Record<string, unknown>): string {
	const lines: string[] = [];
	const rawLines = content.content;
	if (!Array.isArray(rawLines)) return typeof content.title === "string" ? content.title : "";
	for (const rawLine of rawLines) {
		if (!Array.isArray(rawLine)) continue;
		const parts: string[] = [];
		for (const node of rawLine) {
			if (!isRecord(node)) continue;
			const text = typeof node.text === "string" ? node.text : "";
			const href = typeof node.href === "string" ? node.href : "";
			parts.push(href ? `${text} (${href})` : text);
		}
		if (parts.length > 0) lines.push(parts.join(""));
	}
	const title = typeof content.title === "string" && content.title.trim() ? content.title : "";
	return [title, ...lines].filter(Boolean).join("\n");
}

/**
 * 提取分享/交互卡片的可读文本:链接分享卡片取
 * `{ link: { title, desc, link } }`;通用卡片遍历 body.elements 的
 * text/markdown 节点。提取不到时返回 ""。
 */
function extractInteractiveText(content: Record<string, unknown>): string {
	const link = isRecord(content.link) ? content.link : undefined;
	if (link) {
		const title = typeof link.title === "string" ? link.title : "";
		const desc = typeof link.desc === "string" ? link.desc : "";
		const url = typeof link.link === "string" ? link.link : "";
		return [title, desc, url].filter(Boolean).join("\n");
	}
	const body = isRecord(content.body) ? content.body : undefined;
	if (body) {
		const parts: string[] = [];
		collectElementText(body.elements, parts);
		return parts.join("\n").trim();
	}
	return "";
}

function collectElementText(value: unknown, parts: string[]): void {
	if (Array.isArray(value)) {
		for (const item of value) collectElementText(item, parts);
		return;
	}
	if (!isRecord(value)) return;
	if (typeof value.text === "string" && value.text.trim()) parts.push(value.text.trim());
	if (typeof value.content === "string" && value.content.trim()) parts.push(value.content.trim());
	for (const key of ["elements", "element", "fields"]) {
		if (key in value) collectElementText(value[key], parts);
	}
}

/**
 * 把 markdown 表格块渲染为等宽文本盒(飞书文本消息不解析 markdown,
 * 与 telegram 的 `<pre>` 盒同一降级哲学)。
 */
function boxMarkdownTables(content: string): string {
	if (!content) return content;
	return content.replace(/^((?:\|.*(?:\n|$))+)/gm, (match) => {
		const table = match.replace(/\n$/, "");
		const rows = table.split("\n").map((row) =>
			row
				.replace(/^\||\|$/g, "")
				.split("|")
				.map((cell) => cell.trim()),
		);
		if (rows.length < 2) return table;
		const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => (row[column] ?? "").length)));
		const render = (row: string[]): string =>
			`| ${row.map((cell, column) => (cell ?? "").padEnd(widths[column] ?? 0)).join(" | ")} |`;
		return ["```", ...rows.map(render), "```"].join("\n");
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** Resolve the stable logical id carried by proactive/outbound delivery retries. */
function readOutboundIdempotencyKey(message: OutboundMessage): string | undefined {
	const metadata = message.metadata;
	const candidate = metadata?.idempotencyKey ?? metadata?.idempotency_key ?? metadata?.proactiveIdempotencyKey;
	const value = typeof candidate === "string" ? candidate : message.messageId;
	const trimmed = value?.trim();
	return trimmed || undefined;
}

/** Feishu accepts at most 50 characters for the create/reply message uuid. */
function withFeishuUuid(base: string | undefined, part: string): string | undefined {
	if (!base) return undefined;
	const value = `${base}:${part}`;
	return value.length <= 50 ? value : createHash("sha256").update(value).digest("hex").slice(0, 50);
}

// ---------------------------------------------------------------------------
// 最小 protobuf 编解码(仅 Frame / Header)
// ---------------------------------------------------------------------------

function encodeVarint(value: number): number[] {
	const out: number[] = [];
	let v = value >>> 0;
	for (;;) {
		if (v < 0x80) {
			out.push(v);
			return out;
		}
		out.push((v & 0x7f) | 0x80);
		v >>>= 7;
	}
}

function readVarint(bytes: Uint8Array, i: number): { value: number; next: number } {
	let result = 0;
	let shift = 0;
	for (;;) {
		const b = bytes[i]!;
		result |= (b & 0x7f) << shift;
		i++;
		if ((b & 0x80) === 0) break;
		shift += 7;
	}
	return { value: result >>> 0, next: i };
}

export function encodeFeishuFrame(frame: FeishuFrame): Buffer {
	const chunks: Buffer[] = [];
	const pushTag = (tag: number, value: number) => chunks.push(Buffer.from([tag, ...encodeVarint(value)]));
	pushTag(0x08, frame.SeqID);
	pushTag(0x10, frame.LogID);
	pushTag(0x18, frame.service);
	pushTag(0x20, frame.method);
	for (const [key, value] of frame.headers) {
		const keyBuf = Buffer.from(key, "utf-8");
		const valueBuf = Buffer.from(value, "utf-8");
		const header = Buffer.concat([
			Buffer.from([0x0a, ...encodeVarint(keyBuf.length)]),
			keyBuf,
			Buffer.from([0x12, ...encodeVarint(valueBuf.length)]),
			valueBuf,
		]);
		chunks.push(Buffer.from([0x2a, ...encodeVarint(header.length)]), header);
	}
	// payload 字段总是写出(对齐 SDK:即使为空也序列化为 0x42 0x00)
	chunks.push(Buffer.from([0x42, ...encodeVarint(frame.payload.length)]), Buffer.from(frame.payload));
	return Buffer.concat(chunks);
}

export function decodeFeishuFrame(bytes: Uint8Array): FeishuFrame {
	const frame: FeishuFrame = { SeqID: 0, LogID: 0, service: 0, method: 0, headers: [], payload: new Uint8Array(0) };
	let i = 0;
	while (i < bytes.length) {
		const tag = readVarint(bytes, i);
		i = tag.next;
		const field = tag.value >> 3;
		const wire = tag.value & 7;
		if (wire === 0) {
			const value = readVarint(bytes, i);
			i = value.next;
			if (field === 1) frame.SeqID = value.value;
			else if (field === 2) frame.LogID = value.value;
			else if (field === 3) frame.service = value.value;
			else if (field === 4) frame.method = value.value;
		} else if (wire === 2) {
			const len = readVarint(bytes, i);
			i = len.next;
			const data = bytes.subarray(i, i + len.value);
			i += len.value;
			if (field === 5) {
				let j = 0;
				let key = "";
				let value = "";
				while (j < data.length) {
					const t = readVarint(data, j);
					j = t.next;
					const f = t.value >> 3;
					const w = t.value & 7;
					if (w !== 2) break;
					const l = readVarint(data, j);
					j = l.next;
					const part = Buffer.from(data.subarray(j, j + l.value)).toString("utf-8");
					j += l.value;
					if (f === 1) key = part;
					else if (f === 2) value = part;
				}
				frame.headers.push([key, value]);
			} else if (field === 8) {
				frame.payload = Buffer.from(data);
			}
		}
	}
	return frame;
}

function headerValue(frame: FeishuFrame, key: string): string | undefined {
	return frame.headers.find(([k]) => k === key)?.[1];
}

// ---------------------------------------------------------------------------
// Channel
// ---------------------------------------------------------------------------

interface FeishuEventEnvelope {
	header?: { event_type?: string; event_id?: string };
	event?: {
		sender?: { sender_id?: { open_id?: string }; sender_type?: string };
		message?: {
			message_id?: string;
			chat_id?: string;
			chat_type?: string;
			message_type?: string;
			content?: string;
			mentions?: Array<{ key?: string; id?: { open_id?: string }; name?: string }>;
		};
	};
}

export class FeishuChannel extends BaseChannel {
	name = "feishu";
	displayName = "Feishu";

	private readonly cfg: FeishuConfig;
	private readonly socket: WsLike;
	private readonly fetchFn: typeof fetch;
	private token: string | undefined;
	private tokenExpireAt = 0;
	private serviceId = 0;
	private pingInterval = 120;
	private heartbeatTimer: NodeJS.Timeout | undefined;
	private readonly chunks = new Map<string, Uint8Array[]>();
	private connected = false;

	/** CardKit 流式卡片元素 id(对齐 lark-oapi 示例)。 */
	private static readonly STREAM_ELEMENT_ID = "streaming_md";

	private readonly streamBufs = new Map<string, FeishuStreamBuf>();

	/** 入站消息 reaction 追踪:chatId -> 消息 + 已添加的 reaction id。 */
	private readonly reactionTargets = new Map<string, { messageId: string; reactionId?: string }>();

	constructor(
		config: ChannelConfig | undefined,
		bus: MessageBus,
		options: { socket?: WsLike; fetchFn?: typeof fetch } = {},
	) {
		super(config, bus);
		this.cfg = (config ?? {}) as FeishuConfig;
		this.socket = options.socket ?? new GenericWsClient();
		this.fetchFn = options.fetchFn ?? fetch;
	}

	private domain(): string {
		return this.cfg.domain ?? "https://open.feishu.cn";
	}

	async start(context?: ChannelContext): Promise<void> {
		if (this.running) return;
		if (context) this.bindContext(context);
		this.connected = false;
		this.running = true;
		void this.loop();
	}

	override get isReady(): boolean {
		return this.running && this.connected;
	}

	async stop(): Promise<void> {
		this.running = false;
		this.connected = false;
		if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
		this.heartbeatTimer = undefined;
		this.socket.close();
		this.reactionTargets.clear();
	}

	/**
	 * 飞书应用身份来自配置文件(appId/appSecret),无交互式登录。
	 * 覆盖基类钩子以给出明确报错(QR 应用注册属开放平台 onboarding 流程,
	 * 需要开发者账号,不在通道消息能力范围内)。
	 */
	override async login(_force = false): Promise<boolean> {
		if (!this.cfg.appId || !this.cfg.appSecret) {
			this.channelContext.logger?.error(
				"[feishu] missing appId/appSecret; add them to the channel config to enable the channel",
			);
			return false;
		}
		return true;
	}

	// ------------------------------------------------------------------
	// 入站 turn 活动:reaction 打点
	// ------------------------------------------------------------------

	private markTurnActive(chatId: string, messageId: string): void {
		const emoji = this.cfg.reactEmoji ?? "THUMBSUP";
		if (!emoji) return;
		this.reactionTargets.set(chatId, { messageId });
		void this.setReaction(chatId, messageId, emoji);
	}

	private clearTurnActive(chatId: string): void {
		const target = this.reactionTargets.get(chatId);
		this.reactionTargets.delete(chatId);
		if (target?.reactionId) void this.removeReaction(target.messageId, target.reactionId);
	}

	/** 给消息添加 reaction(记录 reaction_id 供移除;失败静默)。 */
	private async setReaction(chatId: string, messageId: string, emoji: string): Promise<void> {
		try {
			const token = await this.tenantAccessToken();
			const response = await this.fetchFn(`${this.domain()}/open-apis/im/v1/messages/${messageId}/reactions`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
				body: JSON.stringify({ reaction_type: { type: "emoji", emoji } }),
			});
			const body = (await response.json()) as { code?: number; data?: { reaction_id?: string } };
			if (body.code === 0 && body.data?.reaction_id) {
				const target = this.reactionTargets.get(chatId);
				if (target) target.reactionId = body.data.reaction_id;
			}
		} catch {
			// Best-effort reaction; failures are never fatal.
		}
	}

	private async removeReaction(messageId: string, reactionId: string): Promise<void> {
		try {
			const token = await this.tenantAccessToken();
			await this.fetchFn(`${this.domain()}/open-apis/im/v1/messages/${messageId}/reactions/${reactionId}`, {
				method: "DELETE",
				headers: { Authorization: `Bearer ${token}` },
			});
		} catch {
			// Best-effort reaction removal.
		}
	}

	// ------------------------------------------------------------------
	// 长连接
	// ------------------------------------------------------------------

	private async loop(): Promise<void> {
		while (this.running) {
			try {
				const url = await this.discoverEndpoint();
				const closed = new Promise<void>((resolve) => {
					this.socket.onClose(() => {
						this.connected = false;
						resolve();
					});
				});
				await this.socket.connect(url);
				if (!this.running) {
					this.socket.close();
					return;
				}
				this.connected = true;
				const serviceId = new URL(url).searchParams.get("service_id");
				this.serviceId = serviceId ? Number(serviceId) : 0;
				this.socket.onMessage((text) => this.handleText(text));
				this.socket.onBinary?.(
					(data) =>
						void this.handleFrame(Buffer.from(data)).catch((error: unknown) => {
							this.channelContext.logger?.error(`[feishu] event processing failed: ${formatError(error)}`);
						}),
				);
				this.startHeartbeat();
				console.log(`[feishu] connected (service_id=${this.serviceId})`);
				await closed;
				console.log("[feishu] connection closed, reconnecting...");
			} catch (error) {
				this.connected = false;
				console.error(`[feishu] connect failed: ${error instanceof Error ? error.message : String(error)}`);
			}
			this.stopHeartbeat();
			if (!this.running) return;
			// 首次重连随机抖动(对齐 SDK 的 ReconnectNonce)
			const nonce = (this.cfg.reconnectNonce ?? 30) * 1000;
			await new Promise((resolve) => setTimeout(resolve, 1000 + Math.random() * nonce));
		}
	}

	private async discoverEndpoint(): Promise<string> {
		const response = await this.fetchFn(`${this.domain()}/callback/ws/endpoint`, {
			method: "POST",
			headers: { "Content-Type": "application/json", locale: "zh" },
			body: JSON.stringify({ AppID: this.cfg.appId, AppSecret: this.cfg.appSecret }),
		});
		const body = (await response.json()) as {
			code?: number;
			msg?: string;
			// 注意:飞书返回大写键(对齐 lark-oapi SDK 的模型字段)
			data?: { URL?: string; ClientConfig?: { PingInterval?: number; ReconnectNonce?: number } };
		};
		if (body.code !== 0 || !body.data?.URL) {
			throw new Error(`feishu endpoint failed: ${body.code} ${body.msg ?? ""}`);
		}
		const config = body.data.ClientConfig;
		if (config?.PingInterval) this.pingInterval = config.PingInterval;
		return body.data.URL;
	}

	private startHeartbeat(): void {
		this.stopHeartbeat();
		this.heartbeatTimer = setInterval(() => {
			const ping = encodeFeishuFrame({
				SeqID: 0,
				LogID: 0,
				service: this.serviceId,
				method: FRAME_CONTROL,
				headers: [["type", "ping"]],
				payload: new Uint8Array(0),
			});
			this.socket.sendBinary?.(ping);
		}, this.pingInterval * 1000);
		this.heartbeatTimer.unref?.();
	}

	private stopHeartbeat(): void {
		if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
		this.heartbeatTimer = undefined;
	}

	private handleText(text: string): void {
		// 服务端可能以文本帧发送?SDK 只处理二进制;防御性忽略。
		void text;
	}

	// ------------------------------------------------------------------
	// 帧处理
	// ------------------------------------------------------------------

	private async handleFrame(bytes: Buffer): Promise<void> {
		let frame: FeishuFrame;
		try {
			frame = decodeFeishuFrame(bytes);
		} catch {
			return;
		}
		if (frame.method === FRAME_CONTROL) {
			const type = headerValue(frame, "type");
			if (type === "pong" && frame.payload.length > 0) {
				// 服务端经 pong 下发连接配置
				try {
					const config = JSON.parse(Buffer.from(frame.payload).toString("utf-8")) as {
						PingInterval?: number;
					};
					if (config.PingInterval) this.pingInterval = config.PingInterval;
				} catch {
					// ignore malformed config
				}
			}
			return; // ping 无需回应(对齐 SDK)
		}
		if (frame.method === FRAME_DATA) {
			await this.handleDataFrame(frame);
		}
	}

	private async handleDataFrame(frame: FeishuFrame): Promise<void> {
		const type = headerValue(frame, "type");
		const messageId = headerValue(frame, "message_id") ?? "";
		const sum = Number(headerValue(frame, "sum") ?? "1");
		const seq = Number(headerValue(frame, "seq") ?? "0");

		let payload = frame.payload;
		if (sum > 1) {
			const parts = this.chunks.get(messageId) ?? new Array<Uint8Array>(sum);
			parts[seq] = payload;
			let complete = true;
			for (const part of parts) {
				if (part === undefined) {
					complete = false;
					break;
				}
			}
			if (!complete) {
				this.chunks.set(messageId, parts);
				return; // 等分片齐了再处理(不 ack 部分帧)
			}
			this.chunks.delete(messageId);
			payload = Buffer.concat(parts.map((part) => Buffer.from(part as Uint8Array)));
		}

		if (type === "event") {
			const raw = Buffer.from(payload).toString("utf-8");
			try {
				await this.handleEvent(raw);
			} finally {
				this.ack(frame);
			}
			return;
		}
		this.ack(frame);
	}

	/** 原帧回 ack(对齐 SDK:payload 置 {"code":200},附加 biz_rt 头)。 */
	private ack(frame: FeishuFrame): void {
		const response = encodeFeishuFrame({
			...frame,
			headers: [...frame.headers, ["biz_rt", String(Date.now() % 100_000)]],
			payload: Buffer.from('{"code":200}', "utf-8"),
		});
		this.socket.sendBinary?.(response);
	}

	// ------------------------------------------------------------------
	// 事件处理
	// ------------------------------------------------------------------

	private async handleEvent(raw: string): Promise<void> {
		let text = raw;
		if (this.cfg.encryptKey) {
			try {
				text = this.decrypt(raw);
			} catch {
				return;
			}
		}
		let envelope: FeishuEventEnvelope;
		try {
			envelope = JSON.parse(text) as FeishuEventEnvelope;
		} catch {
			return;
		}
		if (envelope.header?.event_type !== "im.message.receive_v1") return;
		console.log(
			`[feishu] event: ${envelope.header.event_type} chat=${envelope.event?.message?.chat_id} type=${envelope.event?.message?.message_type}`,
		);
		const message = envelope.event?.message;
		const sender = envelope.event?.sender;
		const openId = sender?.sender_id?.open_id;
		if (!message || !openId || !message.chat_id) return;
		const eventId = envelope.header?.event_id ?? message.message_id;

		if (message.chat_type === "group") {
			const mentions = message.mentions ?? [];
			const isAll = mentions.some((m) => m.key === "@_all");
			const isBot = this.cfg.botOpenId ? mentions.some((m) => m.id?.open_id === this.cfg.botOpenId) : false;
			if (!isAll && !isBot) {
				this.persistEventCursor(eventId);
				return;
			}
		}
		if (message.message_type === "image") {
			// 图片消息:下载图片并以 base64 传入 metadata.images,供 agent 识别
			let imageKey = "";
			try {
				imageKey = (JSON.parse(message.content ?? "{}") as { image_key?: string }).image_key ?? "";
			} catch {
				return;
			}
			if (!imageKey) return;
			const image = await this.downloadImage(message.message_id!, imageKey);
			const images = image ? [image] : undefined;
			const result = await this.handleMessage({
				senderId: openId,
				chatId: message.chat_id,
				content: "[图片]",
				images,
				metadata: {
					messageId: message.message_id,
					chatType: message.chat_type,
					images,
				},
			});
			if (result.status === "accepted" && message.message_id) {
				this.markTurnActive(message.chat_id, message.message_id);
			}
			if (result.status !== "rejected") this.persistEventCursor(eventId);
			return;
		}
		if (message.message_type === "post") {
			// 富文本消息:提取全部文本与链接
			let content = "";
			try {
				content = extractPostText(JSON.parse(message.content ?? "{}") as Record<string, unknown>);
			} catch {
				return;
			}
			if (!content) return;
			const result = await this.handleMessage({
				senderId: openId,
				chatId: message.chat_id,
				content,
				metadata: { messageId: message.message_id, chatType: message.chat_type },
			});
			if (result.status === "accepted" && message.message_id) {
				this.markTurnActive(message.chat_id, message.message_id);
			}
			if (result.status !== "rejected") this.persistEventCursor(eventId);
			return;
		}
		if (message.message_type === "interactive") {
			// 分享卡片/交互卡片:提取标题、描述与链接
			let content = "";
			try {
				content = extractInteractiveText(JSON.parse(message.content ?? "{}") as Record<string, unknown>);
			} catch {
				return;
			}
			if (!content) return;
			const result = await this.handleMessage({
				senderId: openId,
				chatId: message.chat_id,
				content,
				metadata: { messageId: message.message_id, chatType: message.chat_type },
			});
			if (result.status === "accepted" && message.message_id) {
				this.markTurnActive(message.chat_id, message.message_id);
			}
			if (result.status !== "rejected") this.persistEventCursor(eventId);
			return;
		}
		if (message.message_type !== "text") return;

		let content: string;
		try {
			content = (JSON.parse(message.content ?? "{}") as { text?: string }).text ?? "";
		} catch {
			return;
		}
		content = content
			.replace(/@_user_\d+/g, "")
			.replace(/@_all/g, "")
			.replace(/\s{2,}/g, " ")
			.trim();
		if (!content) return;

		const result = await this.handleMessage({
			senderId: openId,
			chatId: message.chat_id,
			content,
			metadata: { messageId: message.message_id, chatType: message.chat_type },
		});
		if (result.status === "accepted" && message.message_id) {
			this.markTurnActive(message.chat_id, message.message_id);
		}
		if (result.status !== "rejected") this.persistEventCursor(eventId);
	}

	private persistEventCursor(eventId: string | undefined): void {
		if (eventId) this.channelContext.offsetStore?.set(this.name, "eventId", eventId);
	}

	/** 下载飞书消息中的图片(GET /im/v1/messages/:id/resources/:key?type=image)。 */
	private async downloadImage(messageId: string, imageKey: string): Promise<ImageAttachment | undefined> {
		try {
			const token = await this.tenantAccessToken();
			const response = await this.fetchFn(
				`${this.domain()}/open-apis/im/v1/messages/${messageId}/resources/${imageKey}?type=image`,
				{ headers: { Authorization: `Bearer ${token}` } },
			);
			if (!response.ok) {
				console.error(`[feishu] download image failed: ${response.status}`);
				return undefined;
			}
			const buffer = Buffer.from(await response.arrayBuffer());
			return { type: "image", data: buffer.toString("base64"), mimeType: sniffImageMime(buffer) ?? "image/jpeg" };
		} catch (error) {
			console.error(`[feishu] download image error: ${(error as Error).message}`);
			return undefined;
		}
	}

	/** 事件加密:base64(iv(16) + AES-256-CBC(sha256(encryptKey))),PKCS7。
	 * 注意:Node 的 decipher 默认 autoPadding,final() 已自动去除 PKCS7 填充。 */
	private decrypt(enc: string): string {
		const raw = Buffer.from(enc, "base64");
		if (raw.length < 32 || raw.length % 16 !== 0) throw new Error("invalid ciphertext length");
		const iv = raw.subarray(0, 16);
		const key = createHash("sha256").update(this.cfg.encryptKey!).digest();
		const decipher = createDecipheriv("aes-256-cbc", key, iv);
		return Buffer.concat([decipher.update(raw.subarray(16)), decipher.final()]).toString("utf-8");
	}

	// ------------------------------------------------------------------
	// 发送
	// ------------------------------------------------------------------

	async send(message: OutboundMessage): Promise<ChannelSendResult> {
		// 带 streamId 的是流式回复的完整版:内容已由流式卡片(或失败回退)发送,跳过。
		// 非流式回复(错误、主动推送)不带 streamId,正常发送。
		if (message.metadata?.streamId) return { status: "success" };
		try {
			const media = message.media ?? [];
			const attachments = message.attachments ?? [];
			const idempotencyKey = readOutboundIdempotencyKey(message);
			let providerMessageId: string | undefined;
			if (message.content || (media.length === 0 && attachments.length === 0)) {
				// markdown 表格渲染为等宽文本盒(飞书文本消息不解析 markdown,
				// 与 telegram 的 <pre> 盒同一降级哲学)
				const content = boxMarkdownTables(message.content);
				providerMessageId = await this.sendTextMessage(
					message.chatId,
					content,
					message.replyTo,
					withFeishuUuid(idempotencyKey, "text"),
				);
			}
			for (const [index, source] of media.entries()) {
				if (source.trim()) {
					providerMessageId = await this.sendImageMessage(
						message.chatId,
						source,
						message.replyTo,
						withFeishuUuid(idempotencyKey, `media-${index}`),
					);
				}
			}
			for (const [index, attachment] of attachments.entries()) {
				if (attachment.kind === "image") {
					providerMessageId = await this.sendImageMessage(
						message.chatId,
						attachment.source,
						message.replyTo,
						withFeishuUuid(idempotencyKey, `attachment-${index}`),
					);
				} else if (attachment.kind === "file") {
					providerMessageId = await this.sendFileMessage(
						message.chatId,
						attachment,
						message.replyTo,
						withFeishuUuid(idempotencyKey, `attachment-${index}`),
					);
				} else {
					throw new Error(`feishu outbound attachment kind is not supported: ${attachment.kind}`);
				}
			}
			this.clearTurnActive(message.chatId);
			return {
				status: "success",
				providerMessageId,
				canonicalMedia: [...media, ...attachments.map((attachment) => attachment.source)],
			};
		} catch (error) {
			// A rejected token or a transient API failure must not poison the next
			// SDK retry with the same cached tenant token.
			this.token = undefined;
			this.tokenExpireAt = 0;
			throw error;
		}
	}

	private async sendTextMessage(
		chatId: string,
		text: string,
		replyTo?: string,
		uuid?: string,
	): Promise<string | undefined> {
		const token = await this.tenantAccessToken();
		// 有被回复消息时走 Reply API,在消息下回复(带引用)
		const url = replyTo
			? `${this.domain()}/open-apis/im/v1/messages/${replyTo}/reply`
			: `${this.domain()}/open-apis/im/v1/messages?receive_id_type=chat_id`;
		// 含 <a href="...">...</a> 时用富文本 post 消息(文本消息不解析该标签)
		const hasLink = /<a href="[^"]+">[^<]+<\/a>/.test(text);
		const bodyPayload: Record<string, string> = replyTo
			? {
					msg_type: hasLink ? "post" : "text",
					content: JSON.stringify(hasLink ? { zh_cn: { content: parsePostContent(text) } } : { text }),
				}
			: {
					receive_id: chatId,
					msg_type: hasLink ? "post" : "text",
					content: JSON.stringify(hasLink ? { zh_cn: { content: parsePostContent(text) } } : { text }),
				};
		if (uuid) bodyPayload.uuid = uuid;
		const response = await this.fetchFn(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${token}`,
			},
			body: JSON.stringify(bodyPayload),
		});
		const body = (await response.json()) as { code?: number; msg?: string; data?: { message_id?: string } };
		if (body.code !== 0) {
			throw new Error(`feishu send failed: ${body.code} ${body.msg ?? ""}`);
		}
		console.log(
			`[feishu] message sent: chat=${chatId} len=${text.length} type=${hasLink ? "post" : "text"}${replyTo ? ` replyTo=${replyTo}` : ""}`,
		);
		return body.data?.message_id;
	}

	private async sendImageMessage(
		chatId: string,
		source: string,
		replyTo?: string,
		uuid?: string,
	): Promise<string | undefined> {
		const token = await this.tenantAccessToken();
		const media = await this.readOutboundMedia(source, "image", "image/jpeg");
		const form = new FormData();
		form.append("image_type", "message");
		form.append("image", new Blob([media.data], { type: media.mimeType }), media.filename);
		const uploadResponse = await this.fetchFn(`${this.domain()}/open-apis/im/v1/images`, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}` },
			body: form,
		});
		const uploadBody = (await uploadResponse.json()) as {
			code?: number;
			msg?: string;
			data?: { image_key?: string };
		};
		const imageKey = uploadBody.data?.image_key;
		if (uploadBody.code !== 0 || !imageKey) {
			throw new Error(`feishu image upload failed: ${uploadBody.code} ${uploadBody.msg ?? ""}`);
		}

		const url = replyTo
			? `${this.domain()}/open-apis/im/v1/messages/${replyTo}/reply`
			: `${this.domain()}/open-apis/im/v1/messages?receive_id_type=chat_id`;
		const bodyPayload: Record<string, string> = replyTo
			? { msg_type: "image", content: JSON.stringify({ image_key: imageKey }) }
			: {
					receive_id: chatId,
					msg_type: "image",
					content: JSON.stringify({ image_key: imageKey }),
				};
		if (uuid) bodyPayload.uuid = uuid;
		const response = await this.fetchFn(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${token}`,
			},
			body: JSON.stringify(bodyPayload),
		});
		const body = (await response.json()) as { code?: number; msg?: string; data?: { message_id?: string } };
		if (body.code !== 0) {
			throw new Error(`feishu image send failed: ${body.code} ${body.msg ?? ""}`);
		}
		console.log(`[feishu] image sent: chat=${chatId} source=${source}${replyTo ? ` replyTo=${replyTo}` : ""}`);
		return body.data?.message_id;
	}

	private async sendFileMessage(
		chatId: string,
		attachment: ChannelAttachment,
		replyTo?: string,
		uuid?: string,
	): Promise<string | undefined> {
		const token = await this.tenantAccessToken();
		const media = await this.readOutboundMedia(
			attachment.source,
			attachment.filename ?? "file",
			attachment.mimeType ?? "application/octet-stream",
		);
		const form = new FormData();
		form.append("file_type", "stream");
		form.append("file_name", media.filename);
		form.append("file", new Blob([media.data], { type: media.mimeType }), media.filename);
		const uploadResponse = await this.fetchFn(`${this.domain()}/open-apis/im/v1/files`, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}` },
			body: form,
		});
		const uploadBody = (await uploadResponse.json()) as {
			code?: number;
			msg?: string;
			data?: { file_key?: string };
		};
		const fileKey = uploadBody.data?.file_key;
		if (uploadBody.code !== 0 || !fileKey) {
			throw new Error(`feishu file upload failed: ${uploadBody.code} ${uploadBody.msg ?? ""}`);
		}

		const url = replyTo
			? `${this.domain()}/open-apis/im/v1/messages/${replyTo}/reply`
			: `${this.domain()}/open-apis/im/v1/messages?receive_id_type=chat_id`;
		const bodyPayload: Record<string, string> = replyTo
			? { msg_type: "file", content: JSON.stringify({ file_key: fileKey }) }
			: {
					receive_id: chatId,
					msg_type: "file",
					content: JSON.stringify({ file_key: fileKey }),
				};
		if (uuid) bodyPayload.uuid = uuid;
		const response = await this.fetchFn(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${token}`,
			},
			body: JSON.stringify(bodyPayload),
		});
		const body = (await response.json()) as { code?: number; msg?: string; data?: { message_id?: string } };
		if (body.code !== 0) {
			throw new Error(`feishu file send failed: ${body.code} ${body.msg ?? ""}`);
		}
		console.log(
			`[feishu] file sent: chat=${chatId} source=${attachment.source}${replyTo ? ` replyTo=${replyTo}` : ""}`,
		);
		return body.data?.message_id;
	}

	/** 用公共媒体管线把 source 解析为字节(fallback 参数保持原有语义)。 */
	private async readOutboundMedia(
		source: string,
		fallbackFilename: string,
		fallbackMimeType: string,
	): Promise<{ data: Buffer; filename: string; mimeType: string }> {
		return resolveOutboundMedia(
			{
				kind: fallbackMimeType.startsWith("image/") ? "image" : "file",
				source,
				filename: fallbackFilename,
				mimeType: fallbackMimeType,
			},
			{ fetchFn: this.fetchFn },
		);
	}

	// ------------------------------------------------------------------
	// 推理内容:累积后以低强调的引用块文本发送(不丢弃)
	// ------------------------------------------------------------------

	private readonly reasoningBufs = new Map<string, string>();

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
			await this.sendTextMessage(chatId, `> ${text.trim()}`);
		}
	}

	// ------------------------------------------------------------------
	// 流式(CardKit 卡片):首帧创建卡片,后续更新 markdown 元素内容
	// ------------------------------------------------------------------

	override async sendDelta(delta: OutboundDelta): Promise<void> {
		if (delta.type === "thinking")
			return this.sendReasoningDelta(delta.chatId, delta.delta, undefined, delta.streamId);
		const key = delta.streamId ?? delta.chatId;
		let buf = this.streamBufs.get(key);
		if (!buf) {
			buf = { chatId: delta.chatId, text: "", sequence: 0, lastEdit: 0 };
			this.streamBufs.set(key, buf);
		}
		buf.replyTo = delta.replyTo ?? buf.replyTo;
		buf.text += delta.delta;

		if (delta.streamEnd) {
			this.streamBufs.delete(key);
			await this.finalizeStream(buf);
			return;
		}
		if (!buf.text.trim()) return;

		const now = Date.now();
		const interval = this.cfg.streamEditIntervalMs ?? 250;
		// 首帧触发创建卡片(后台执行,不阻塞后续 delta);创建完成后按节流更新
		if (buf.cardId === undefined && !buf.failed) {
			if (!buf.creatingPromise) {
				buf.creatingPromise = this.ensureStreamCard(buf).finally(() => {
					buf.creatingPromise = undefined;
				});
			}
		} else if (buf.cardId && now - buf.lastEdit >= interval) {
			buf.sequence++;
			const ok = await this.updateCardContent(buf.cardId, buf.text, buf.sequence);
			if (ok) buf.lastEdit = now;
		}
	}

	/** 创建流式卡片并作为 interactive 消息发送(失败则标记,结束时回退普通文本)。 */
	private async ensureStreamCard(buf: FeishuStreamBuf): Promise<void> {
		const token = await this.tenantAccessToken();
		const cardJson = JSON.stringify({
			schema: "2.0",
			config: { wide_screen_mode: true, update_multi: true, streaming_mode: true },
			body: {
				elements: [{ tag: "markdown", content: buf.text, element_id: FeishuChannel.STREAM_ELEMENT_ID }],
			},
		});
		const response = await this.fetchFn(`${this.domain()}/open-apis/cardkit/v1/cards`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
			body: JSON.stringify({ type: "card_json", data: cardJson }),
		});
		const body = (await response.json()) as { code?: number; msg?: string; data?: { card_id?: string } };
		const cardId = body.code === 0 ? body.data?.card_id : undefined;
		if (!cardId) {
			console.error(`[feishu] create streaming card failed: ${body.code} ${body.msg ?? ""}`);
			buf.failed = true;
			return;
		}
		buf.cardId = cardId;
		buf.sequence++;
		console.log(`[feishu] streaming card created: ${cardId}`);

		// 卡片创建后需作为 interactive 消息发送到聊天(有 replyTo 则回复到原消息下)
		const sent = await this.sendCardMessage(buf.chatId, cardId, buf.replyTo);
		if (!sent) buf.failed = true;
	}

	private async sendCardMessage(chatId: string, cardId: string, replyTo?: string): Promise<boolean> {
		const token = await this.tenantAccessToken();
		// 有被回复消息时走 Reply API,流式卡片直接回复在用户消息下
		const url = replyTo
			? `${this.domain()}/open-apis/im/v1/messages/${replyTo}/reply`
			: `${this.domain()}/open-apis/im/v1/messages?receive_id_type=chat_id`;
		const bodyPayload = replyTo
			? { msg_type: "interactive", content: JSON.stringify({ type: "card", data: { card_id: cardId } }) }
			: {
					receive_id: chatId,
					msg_type: "interactive",
					content: JSON.stringify({ type: "card", data: { card_id: cardId } }),
				};
		const response = await this.fetchFn(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${token}`,
			},
			body: JSON.stringify(bodyPayload),
		});
		const body = (await response.json()) as { code?: number; msg?: string };
		if (body.code !== 0) {
			console.error(`[feishu] send streaming card failed: ${body.code} ${body.msg ?? ""}`);
			return false;
		}
		return true;
	}

	/** 更新卡片 markdown 元素内容(sequence 必须严格递增)。 */
	private async updateCardContent(cardId: string, content: string, sequence: number): Promise<boolean> {
		const token = await this.tenantAccessToken();
		const response = await this.fetchFn(
			`${this.domain()}/open-apis/cardkit/v1/cards/${cardId}/elements/${FeishuChannel.STREAM_ELEMENT_ID}/content`,
			{
				method: "PUT",
				headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
				body: JSON.stringify({ content, sequence }),
			},
		);
		const body = (await response.json()) as { code?: number; msg?: string };
		if (body.code !== 0) {
			console.error(`[feishu] card content update failed: ${body.code} ${body.msg ?? ""}`);
		} else {
			console.log(`[feishu] card update #${sequence}: ${content.length} chars`);
		}
		return body.code === 0;
	}

	/** 开关卡片 streaming_mode(结束时关闭,让会话列表退出生成中占位)。 */
	private async setStreamingMode(cardId: string, enabled: boolean, sequence: number): Promise<boolean> {
		const token = await this.tenantAccessToken();
		const response = await this.fetchFn(`${this.domain()}/open-apis/cardkit/v1/cards/${cardId}/settings`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
			body: JSON.stringify({
				settings: JSON.stringify({ config: { streaming_mode: enabled } }),
				sequence,
				uuid: randomUUID(),
			}),
		});
		const body = (await response.json()) as { code?: number; msg?: string };
		if (body.code !== 0) {
			console.error(`[feishu] card settings failed: ${body.code} ${body.msg ?? ""}`);
		}
		return body.code === 0;
	}

	/** 流结束:最终更新内容,关闭流式模式;未建卡(失败/过短)则回退普通文本。 */
	private async finalizeStream(buf: FeishuStreamBuf): Promise<void> {
		console.log(`[feishu] stream end (card=${buf.cardId ?? "none"}, text=${buf.text.length} chars)`);
		if (buf.creatingPromise) await buf.creatingPromise; // 等卡片创建完成,避免卡片+文本重复
		this.clearTurnActive(buf.chatId);
		if (!buf.cardId || buf.failed) {
			if (buf.text.trim()) {
				await this.sendTextMessage(buf.chatId, buf.text.trim(), buf.replyTo);
			}
			return;
		}
		buf.sequence++;
		await this.updateCardContent(buf.cardId, buf.text, buf.sequence);
		buf.sequence++;
		await this.setStreamingMode(buf.cardId, false, buf.sequence);
	}

	private async tenantAccessToken(): Promise<string> {
		if (this.token && this.tokenExpireAt > Date.now() + 30_000) return this.token;
		const response = await this.fetchFn(`${this.domain()}/open-apis/auth/v3/tenant_access_token/internal`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ app_id: this.cfg.appId, app_secret: this.cfg.appSecret }),
		});
		const body = (await response.json()) as {
			code?: number;
			tenant_access_token?: string;
			expire?: number;
			msg?: string;
		};
		if (body.code !== 0 || !body.tenant_access_token) {
			throw new Error(`tenant_access_token failed: ${body.code} ${body.msg ?? ""}`);
		}
		this.token = body.tenant_access_token;
		this.tokenExpireAt = Date.now() + (body.expire ?? 7200) * 1000;
		return this.token;
	}
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
