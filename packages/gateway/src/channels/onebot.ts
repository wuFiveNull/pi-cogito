/**
 * OneBotChannel (QQ) — OneBot v11 WebSocket channel.
 *
 * Connects to a OneBot-compatible server (go-cqhttp / Lagrange / NapCat) over
 * forward WebSocket, normalizes message events (private + group) into
 * InboundMessage, and sends replies via OneBot actions.
 *
 * chatId convention: "group:<id>" for group chats, "user:<id>" for private.
 *
 * The socket layer is injectable for tests; the default is a zero-dependency
 * WebSocket client (RFC 6455, text frames only).
 */

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { type TLSSocket, connect as tlsConnect } from "node:tls";
import { fileURLToPath } from "node:url";
import type { MessageBus } from "../bus.ts";
import type { ImageAttachment, OutboundMessage } from "../types.ts";
import { BaseChannel, type ChannelConfig } from "./base.ts";
import type { ChannelContext } from "./context.ts";

// ---------------------------------------------------------------------------
// WebSocket client (zero dependencies, text frames)
// ---------------------------------------------------------------------------

export interface OneBotSocket {
	connect(url: string, headers?: Record<string, string>): Promise<void>;
	sendAction(action: string, params: Record<string, unknown>): Promise<unknown>;
	onEvent(handler: (event: Record<string, unknown>) => void): void;
	onClose(handler: () => void): void;
	close(): void;
}

export interface OneBotTlsOptions {
	/** Additional CA certificate for a private OneBot WSS endpoint. */
	caFile?: string;
	/** TLS SNI and certificate host name. Defaults to the URL hostname. */
	serverName?: string;
	/** Disable certificate verification only for an explicitly trusted private endpoint. */
	rejectUnauthorized?: boolean;
}

interface PendingAction {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
}

export class WebSocketClient implements OneBotSocket {
	private socket: Socket | TLSSocket | undefined;
	private eventHandler: ((event: Record<string, unknown>) => void) | undefined;
	private closeHandler: (() => void) | undefined;
	private buffer = Buffer.alloc(0);
	private pending = new Map<number, PendingAction>();
	private nextEcho = 1;
	private closed = false;
	private handshakeDone = false;
	private readonly tls: OneBotTlsOptions;

	constructor(tls: OneBotTlsOptions = {}) {
		this.tls = tls;
	}

	connect(url: string, headers: Record<string, string> = {}): Promise<void> {
		this.closed = false;
		this.handshakeDone = false;
		this.buffer = Buffer.alloc(0);
		return new Promise((resolve, reject) => {
			let parsed: URL;
			try {
				parsed = new URL(url);
				validateHandshakeHeaders(headers);
			} catch (error) {
				reject(error instanceof Error ? error : new Error(String(error)));
				return;
			}
			const isTls = parsed.protocol === "wss:";
			if (!isTls && parsed.protocol !== "ws:") {
				reject(new Error(`unsupported OneBot WebSocket protocol: ${parsed.protocol}`));
				return;
			}
			const socket = isTls
				? tlsConnect({
						host: parsed.hostname,
						port: Number(parsed.port || 443),
						servername: this.tls.serverName ?? parsed.hostname,
						...(this.tls.caFile ? { ca: readFileSync(this.tls.caFile) } : {}),
						...(this.tls.rejectUnauthorized === undefined
							? {}
							: { rejectUnauthorized: this.tls.rejectUnauthorized }),
					})
				: createConnection({ host: parsed.hostname, port: Number(parsed.port || 80) });
			this.socket = socket;
			const path = `${parsed.pathname || "/"}${parsed.search}`;

			socket.once(isTls ? "secureConnect" : "connect", () => {
				const key = randomBytes(16).toString("base64");
				const headerLines = [
					`GET ${path} HTTP/1.1`,
					`Host: ${parsed.host}`,
					"Upgrade: websocket",
					"Connection: Upgrade",
					`Sec-WebSocket-Key: ${key}`,
					"Sec-WebSocket-Version: 13",
				];
				for (const [name, value] of Object.entries(headers)) headerLines.push(`${name}: ${value}`);
				socket.write(`${headerLines.join("\r\n")}\r\n\r\n`);
			});
			socket.on("data", (chunk: Buffer) => {
				this.buffer = Buffer.concat([this.buffer, chunk]);
				this.processBuffer(resolve, reject);
			});
			socket.on("error", reject);
			socket.on("close", () => {
				if (this.socket !== socket) return;
				const connected = this.handshakeDone;
				this.handshakeDone = false;
				this.buffer = Buffer.alloc(0);
				this.closed = true;
				if (!connected) reject(new Error("OneBot WebSocket closed before the handshake completed"));
				this.closeHandler?.();
			});
		});
	}

	private processBuffer(resolve: () => void, reject: (error: Error) => void): void {
		// Handshake phase: wait for HTTP 101 response.
		if (!this.handshakeDone) {
			const headerEnd = this.buffer.indexOf("\r\n\r\n");
			if (headerEnd === -1) return;
			const header = this.buffer.subarray(0, headerEnd).toString("utf-8");
			if (!header.startsWith("HTTP/1.1 101")) {
				reject(new Error(`WebSocket handshake failed: ${header.split("\n")[0]}`));
				this.socket?.destroy();
				return;
			}
			this.buffer = this.buffer.subarray(headerEnd + 4);
			this.handshakeDone = true;
			resolve();
		}
		// Frame phase.
		for (;;) {
			if (this.buffer.length < 2) return;
			const opcode = this.buffer[0]! & 0x0f;
			let length = this.buffer[1]! & 0x7f;
			let offset = 2;
			if (length === 126) {
				if (this.buffer.length < 4) return;
				length = this.buffer.readUInt16BE(2);
				offset = 4;
			} else if (length === 127) {
				if (this.buffer.length < 10) return;
				length = Number(this.buffer.readBigUInt64BE(2));
				offset = 10;
			}
			if (this.buffer.length < offset + length) return;
			if (opcode === 0x9) {
				// Ping -> pong.
				this.writeFrame(0xa, this.buffer.subarray(offset, offset + length));
			} else if (opcode === 0x1) {
				const text = this.buffer.subarray(offset, offset + length).toString("utf-8");
				this.handlePayload(text);
			}
			this.buffer = this.buffer.subarray(offset + length);
		}
	}

	private handlePayload(text: string): void {
		let message: Record<string, unknown>;
		try {
			message = JSON.parse(text) as Record<string, unknown>;
		} catch {
			return;
		}
		if (typeof message.echo === "number") {
			const pending = this.pending.get(message.echo);
			if (pending) {
				this.pending.delete(message.echo);
				if (message.status === "failed" || (message.retcode !== undefined && Number(message.retcode) !== 0)) {
					pending.reject(new Error(`OneBot action failed: ${JSON.stringify(message)}`));
				} else {
					pending.resolve(message.data);
				}
			}
			return;
		}
		this.eventHandler?.(message);
	}

	/** Client frames must be masked. */
	private writeFrame(opcode: number, payload: Buffer): void {
		const mask = randomBytes(4);
		const masked = Buffer.alloc(payload.length);
		for (let i = 0; i < payload.length; i++) masked[i] = payload[i]! ^ mask[i % 4]!;

		let header: Buffer;
		if (payload.length < 126) {
			header = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
		} else if (payload.length < 65536) {
			header = Buffer.alloc(4);
			header[0] = 0x80 | opcode;
			header[1] = 0x80 | 126;
			header.writeUInt16BE(payload.length, 2);
		} else {
			header = Buffer.alloc(10);
			header[0] = 0x80 | opcode;
			header[1] = 0x80 | 127;
			header.writeBigUInt64BE(BigInt(payload.length), 2);
		}
		this.socket?.write(Buffer.concat([header, mask, masked]));
	}

	async sendAction(action: string, params: Record<string, unknown>): Promise<unknown> {
		const echo = this.nextEcho++;
		return new Promise((resolve, reject) => {
			this.pending.set(echo, { resolve, reject });
			const body = JSON.stringify({ action, params, echo });
			this.writeFrame(0x1, Buffer.from(body, "utf-8"));
			setTimeout(() => {
				if (this.pending.has(echo)) {
					this.pending.delete(echo);
					reject(new Error(`OneBot action timeout: ${action}`));
				}
			}, 15_000);
		});
	}

	onEvent(handler: (event: Record<string, unknown>) => void): void {
		this.eventHandler = handler;
	}

	onClose(handler: () => void): void {
		this.closeHandler = handler;
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		try {
			this.writeFrame(0x8, Buffer.alloc(0)); // close frame
		} catch {
			// ignore
		}
		this.socket?.destroy();
	}
}

// ---------------------------------------------------------------------------
// Channel
// ---------------------------------------------------------------------------

export interface OneBotConfig extends ChannelConfig {
	/** OneBot forward WebSocket URL, e.g. ws://127.0.0.1:6700 or wss://onebot.example/ws */
	wsUrl?: string;
	/** OneBot access token sent as `Authorization: Bearer <token>` during the WebSocket handshake. */
	accessToken?: string;
	/** TLS settings for private WSS endpoints. */
	tls?: OneBotTlsOptions;
	/** Auto-reconnect delay in ms. Default 5000. */
	reconnectDelayMs?: number;
}

interface OneBotMessageEvent {
	post_type?: string;
	message_type?: string;
	user_id?: number;
	group_id?: number;
	message_id?: number;
	message?: unknown;
}

interface NormalizedOneBotMessage {
	text: string;
	images: ImageAttachment[];
	hasImage: boolean;
}

export class OneBotChannel extends BaseChannel {
	name = "onebot";
	displayName = "QQ (OneBot)";

	private socket: OneBotSocket;
	private reconnectTimer: NodeJS.Timeout | undefined;
	private readonly reconnectDelayMs: number;
	private readonly config2: OneBotConfig;
	private connected = false;

	private readonly fetchFn: typeof fetch;

	constructor(
		config: OneBotConfig | undefined,
		bus: MessageBus,
		options: { socket?: OneBotSocket; fetchFn?: typeof fetch } = {},
	) {
		super(config, bus);
		this.config2 = config ?? {};
		this.socket = options.socket ?? new WebSocketClient(this.config2.tls);
		this.fetchFn = options.fetchFn ?? fetch;
		this.reconnectDelayMs = this.config2.reconnectDelayMs ?? 5000;
	}

	async start(context?: ChannelContext): Promise<void> {
		if (this.running) return;
		if (!this.config2.wsUrl) throw new Error("onebot wsUrl not configured");
		if (context) this.bindContext(context);
		this.running = true;
		this.socket.onEvent(
			(event) =>
				void this.processEvent(event).catch((error: unknown) => {
					this.channelContext.logger?.error(`[onebot] event processing failed: ${formatOneBotError(error)}`);
				}),
		);
		this.socket.onClose(() => {
			this.connected = false;
			this.scheduleReconnect();
		});
		await this.connectOnce();
	}

	override get isReady(): boolean {
		return this.running && this.connected;
	}

	private async connectOnce(): Promise<void> {
		try {
			await this.socket.connect(this.config2.wsUrl!, oneBotHeaders(this.config2.accessToken));
			if (!this.running) {
				this.socket.close();
				return;
			}
			this.connected = true;
		} catch {
			this.connected = false;
			this.scheduleReconnect();
		}
	}

	private scheduleReconnect(): void {
		if (!this.running || this.reconnectTimer) return;
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = undefined;
			void this.connectOnce();
		}, this.reconnectDelayMs);
		this.reconnectTimer.unref?.();
	}

	async stop(): Promise<void> {
		if (!this.running) return;
		this.running = false;
		this.connected = false;
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = undefined;
		}
		this.socket.close();
	}

	private async processEvent(event: OneBotMessageEvent): Promise<void> {
		if (event.post_type !== "message") return;
		const senderId = String(event.user_id ?? "");
		if (!senderId) return;

		const isGroup = event.message_type === "group" && event.group_id !== undefined;
		const chatId = isGroup ? `group:${event.group_id}` : `user:${senderId}`;
		const normalized = await this.normalizeMessage(event.message);
		if (!normalized.text && !normalized.hasImage) return;

		const result = await this.handleMessage({
			senderId,
			chatId,
			content: normalized.text || "[图片]",
			images: normalized.images.length > 0 ? normalized.images : undefined,
			metadata: { messageId: String(event.message_id ?? "") },
		});
		if (result.status !== "rejected" && event.message_id !== undefined) {
			this.channelContext.offsetStore?.set(this.name, "messageId", String(event.message_id));
		}
	}

	private async normalizeMessage(message: unknown): Promise<NormalizedOneBotMessage> {
		if (typeof message === "string") {
			return this.normalizeCqString(message);
		}
		if (!Array.isArray(message)) {
			return { text: "", images: [], hasImage: false };
		}

		const texts: string[] = [];
		const images: ImageAttachment[] = [];
		let hasImage = false;
		for (const segment of message) {
			if (!isRecord(segment)) continue;
			const type = stringField(segment, "type");
			if (type === "text") {
				const data = isRecord(segment.data) ? segment.data : undefined;
				const text = data ? stringField(data, "text") : undefined;
				if (text) texts.push(text);
				continue;
			}
			if (type !== "image") continue;
			hasImage = true;
			const data = isRecord(segment.data) ? segment.data : {};
			const image = await this.loadImage(data);
			if (image) images.push(image);
		}

		return { text: texts.join("").trim(), images, hasImage };
	}

	private async normalizeCqString(message: string): Promise<NormalizedOneBotMessage> {
		const imageMatches = [...message.matchAll(/\[CQ:image(?:,([^\]]*))?\]/g)];
		if (imageMatches.length === 0) return { text: message.trim(), images: [], hasImage: false };

		const images: ImageAttachment[] = [];
		for (const match of imageMatches) {
			const image = await this.loadImage(parseCqImageData(match[1] ?? ""));
			if (image) images.push(image);
		}
		return {
			text: message.replace(/\[CQ:image(?:,[^\]]*)?\]/g, "").trim(),
			images,
			hasImage: true,
		};
	}

	private async loadImage(data: Record<string, unknown>): Promise<ImageAttachment | undefined> {
		const mimeType = stringField(data, "mimeType") ?? stringField(data, "mime_type");
		const inline = stringField(data, "base64");
		if (inline) {
			const image = decodeBase64Image(inline, mimeType);
			if (image) return image;
		}

		const url = stringField(data, "url");
		if (url && isHttpUrl(url)) {
			const image = await this.downloadImage(url);
			if (image) return image;
		}

		const file = stringField(data, "file") ?? stringField(data, "file_id") ?? stringField(data, "id") ?? url;
		if (!file) return undefined;
		if (file.startsWith("base64://")) return decodeBase64Image(file.slice("base64://".length), mimeType);

		try {
			const result = await this.socket.sendAction("get_image", { file });
			return this.resolveImageResult(result, mimeType);
		} catch (error) {
			console.error(`[onebot] get image failed: ${formatOneBotError(error)}`);
			return undefined;
		}
	}

	private async resolveImageResult(
		value: unknown,
		mimeType: string | undefined,
	): Promise<ImageAttachment | undefined> {
		if (typeof value === "string") {
			if (isHttpUrl(value)) return this.downloadImage(value);
			return decodeBase64Image(value, mimeType);
		}
		if (!isRecord(value)) return undefined;
		if (typeof value.data === "string") {
			if (isHttpUrl(value.data)) return this.downloadImage(value.data);
			const image = decodeBase64Image(value.data, mimeType);
			if (image) return image;
		}

		const data = isRecord(value.data) ? value.data : value;
		const inline = stringField(data, "base64");
		if (inline) {
			const image = decodeBase64Image(inline, mimeType);
			if (image) return image;
		}
		const url = stringField(data, "url");
		if (url && isHttpUrl(url)) return this.downloadImage(url);
		const file = stringField(data, "file") ?? stringField(data, "file_id");
		if (file?.startsWith("base64://")) return decodeBase64Image(file.slice("base64://".length), mimeType);
		if (file && isHttpUrl(file)) return this.downloadImage(file);
		return undefined;
	}

	private async downloadImage(url: string): Promise<ImageAttachment | undefined> {
		try {
			const response = await this.fetchFn(url);
			if (!response.ok) {
				console.error(`[onebot] download image failed: ${response.status}`);
				return undefined;
			}
			const buffer = Buffer.from(await response.arrayBuffer());
			if (buffer.length === 0) return undefined;
			const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
			return {
				type: "image",
				data: buffer.toString("base64"),
				mimeType: contentType?.startsWith("image/") ? contentType : sniffOneBotImageMime(buffer),
			};
		} catch (error) {
			console.error(`[onebot] download image error: ${formatOneBotError(error)}`);
			return undefined;
		}
	}

	async send(message: OutboundMessage): Promise<void> {
		const payload = this.buildSendPayload(message);
		if (message.chatId.startsWith("group:")) {
			await this.socket.sendAction("send_group_msg", {
				group_id: Number(message.chatId.slice(6)),
				...payload,
			});
		} else if (message.chatId.startsWith("user:")) {
			await this.socket.sendAction("send_private_msg", {
				user_id: Number(message.chatId.slice(5)),
				...payload,
			});
		} else {
			throw new Error(`unknown onebot chatId: ${message.chatId}`);
		}
	}

	/**
	 * Build the OneBot v11 `message` payload for an outbound message.
	 *
	 * With media, emits a segment array (images first, then text), mirroring
	 * the napcat channel of nanobot. Without media, keeps the plain-text
	 * string form for compatibility.
	 */
	private buildSendPayload(message: OutboundMessage): { message: unknown } {
		const text = message.content?.trim();
		const images = (message.media ?? []).map((ref) => this.toImageSegment(ref)).filter(isImageSegment);
		if (images.length === 0) {
			return { message: message.content };
		}
		const segments: unknown[] = [...images];
		if (text) segments.push({ type: "text", data: { text } });
		return { message: segments };
	}

	/** Media ref (local path / file:// / http(s) URL) → OneBot image segment. */
	private toImageSegment(ref: string): OneBotImageSegment | undefined {
		const value = String(ref ?? "").trim();
		if (!value) return undefined;
		if (value.startsWith("http://") || value.startsWith("https://")) {
			try {
				new URL(value);
			} catch {
				return undefined;
			}
			return { type: "image", data: { file: value } };
		}
		const local = value.startsWith("file://") ? fileURLToPath(value) : value;
		if (!existsSync(local)) return undefined;
		return { type: "image", data: { file: local } };
	}
}

interface OneBotImageSegment {
	type: "image";
	data: { file: string };
}

function isImageSegment(value: OneBotImageSegment | undefined): value is OneBotImageSegment {
	return value !== undefined;
}

function oneBotHeaders(accessToken: string | undefined): Record<string, string> {
	return accessToken ? { Authorization: `Bearer ${accessToken}` } : {};
}

function validateHandshakeHeaders(headers: Record<string, string>): void {
	for (const [name, value] of Object.entries(headers)) {
		if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) {
			throw new Error(`invalid OneBot WebSocket header name: ${name}`);
		}
		if (/\r|\n/.test(value)) throw new Error(`invalid OneBot WebSocket header value: ${name}`);
	}
}

function parseCqImageData(params: string): Record<string, unknown> {
	const data: Record<string, unknown> = {};
	for (const pair of params.split(",")) {
		const separator = pair.indexOf("=");
		if (separator <= 0) continue;
		const key = pair.slice(0, separator);
		const value = pair.slice(separator + 1);
		try {
			data[key] = decodeURIComponent(value);
		} catch {
			data[key] = value;
		}
	}
	return data;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isHttpUrl(value: string): boolean {
	return value.startsWith("http://") || value.startsWith("https://");
}

function decodeBase64Image(value: string, mimeType: string | undefined): ImageAttachment | undefined {
	let encoded = value.trim();
	let resolvedMime = mimeType;
	const dataUrl = encoded.match(/^data:(image\/[^;]+);base64,(.+)$/i);
	if (dataUrl) {
		resolvedMime = dataUrl[1];
		encoded = dataUrl[2]!;
	}
	if (!encoded || encoded.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return undefined;
	const buffer = Buffer.from(encoded, "base64");
	if (buffer.length === 0) return undefined;
	return {
		type: "image",
		data: buffer.toString("base64"),
		mimeType: resolvedMime?.startsWith("image/") ? resolvedMime : sniffOneBotImageMime(buffer),
	};
}

function sniffOneBotImageMime(buffer: Buffer): string {
	if (
		buffer.length >= 8 &&
		buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
	)
		return "image/png";
	if (buffer.length >= 3 && buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "image/jpeg";
	if (
		buffer.length >= 6 &&
		(buffer.subarray(0, 6).toString() === "GIF87a" || buffer.subarray(0, 6).toString() === "GIF89a")
	)
		return "image/gif";
	if (
		buffer.length >= 12 &&
		buffer.subarray(0, 4).toString() === "RIFF" &&
		buffer.subarray(8, 12).toString() === "WEBP"
	)
		return "image/webp";
	if (buffer.length >= 2 && buffer.subarray(0, 2).toString() === "BM") return "image/bmp";
	return "image/jpeg";
}

function formatOneBotError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** OneBot v11 alias: QQ (go-cqhttp / Lagrange). */
export class QqChannel extends OneBotChannel {
	override name = "qq";
	override displayName = "QQ";
}

/** OneBot v11 alias: NapCat. */
export class NapCatChannel extends OneBotChannel {
	override name = "napcat";
	override displayName = "NapCat";
}
