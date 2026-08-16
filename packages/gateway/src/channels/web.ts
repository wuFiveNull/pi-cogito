/**
 * WebChannel — zero-dependency HTTP + SSE channel.
 *
 * - POST /api/messages      receive { senderId, chatId, content, media? }
 *                           -> normalize -> bus (202 on accepted)
 * - GET  /api/stream        SSE stream; client subscribes with ?chatId=
 *                           receives "message" (complete reply) and "delta"
 *                           (streaming chunks) events.
 * - GET  /api/health        {"ok": true}
 * - registerApi()           host-provided extra endpoints (e.g. /api/sessions)
 *                           or mounted UIs (UiRegistry, see pi-ui).
 *
 * Web pages are not served here — mount them via registerApi with a trailing
 * "*" route (e.g. pi-ui's UiRegistry: registerApi("GET", "/*", ui.handle)).
 *
 * Replies fan out to all SSE connections subscribed to the target chatId.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { extname, join } from "node:path";
import { isAuthorizedRequest, verifyBodySignature } from "../auth.ts";
import type { MessageBus } from "../bus.ts";
import {
	outboundEventFromMessage,
	ProgressEvent,
	RuntimeModelUpdatedEvent,
	SessionUpdatedEvent,
	TurnEndEvent,
} from "../events.ts";
import type { GatewayManagement } from "../management.ts";
import type { ChannelMessageQuery, ChannelMessageRecord, ChannelMessageStatus } from "../messages.ts";
import type { OutboxStatus } from "../outbox.ts";
import { SlidingWindowRateLimiter } from "../rate-limit.ts";
import { type ChannelTlsOptions, readTlsOptions } from "../tls.ts";
import {
	buildSessionKey,
	type ChannelAttachment,
	type OutboundDelta,
	type OutboundMessage,
	type ReplyReference,
} from "../types.ts";
import { BaseChannel, type ChannelConfig } from "./base.ts";
import type { ChannelContext } from "./context.ts";

interface SseClient {
	res: ServerResponse;
	chatId: string;
}

interface ChannelLifecycleEvent {
	channel?: string;
	sessionKey?: string;
	chatId?: string;
	turnId?: string;
	[key: string]: unknown;
}

/** Host-provided API route handler (e.g. session listing endpoints or mounted UIs). */
export type ApiRouteHandler = (url: URL, res: ServerResponse, req: IncomingMessage) => void | Promise<void>;

export class WebChannel extends BaseChannel {
	name = "web";
	displayName = "Web";

	private server: Server | undefined;
	private readonly subscribers = new Set<SseClient>();
	private lifecycleUnregisters: Array<() => void> = [];
	/** Host-registered extra API routes: `${method} ${pathname}` -> handler. */
	private readonly apiRoutes = new Map<string, ApiRouteHandler>();

	/** Register an extra API endpoint handled by the host (e.g. /api/sessions). */
	registerApi(method: "GET" | "POST", path: string, handler: ApiRouteHandler): void {
		this.apiRoutes.set(`${method} ${path}`, handler);
	}

	// 监控统计(dashboard 用)
	private readonly startedAt = Date.now();
	private stats = { messagesIn: 0, messagesOut: 0, deltasOut: 0 };
	private readonly chatStats = new Map<string, { in: number; out: number }>();
	/** 最近消息环形缓冲(每 chat 保留最近 100 条)。 */
	private readonly history = new Map<
		string,
		Array<{ role: "user" | "assistant" | "system"; content: string; timestamp: number }>
	>();

	private bumpChat(chatId: string, dir: "in" | "out"): void {
		const entry = this.chatStats.get(chatId) ?? { in: 0, out: 0 };
		entry[dir]++;
		this.chatStats.set(chatId, entry);
	}

	private pushHistory(chatId: string, role: "user" | "assistant" | "system", content: string): void {
		const list = this.history.get(chatId) ?? [];
		list.push({ role, content, timestamp: Date.now() });
		if (list.length > 100) list.shift();
		this.history.set(chatId, list);
	}

	private readonly options: { host?: string; port?: number; uploadsDir?: string; tls?: ChannelTlsOptions };
	private readonly management: GatewayManagement | undefined;
	private readonly requestRateLimiter: SlidingWindowRateLimiter;

	constructor(
		config: ChannelConfig | undefined,
		bus: MessageBus,
		options: { host?: string; port?: number; uploadsDir?: string; tls?: ChannelTlsOptions } = {},
		dependencies: { management?: GatewayManagement } = {},
	) {
		super(config, bus);
		this.options = options;
		this.management = dependencies.management;
		this.requestRateLimiter = new SlidingWindowRateLimiter(this.config.rateLimit);
	}

	private static async readBody(req: IncomingMessage, limitBytes: number): Promise<string> {
		let body = "";
		for await (const chunk of req) {
			body += chunk;
			if (body.length > limitBytes) {
				throw new Error("body too large");
			}
		}
		return body;
	}

	async start(context?: ChannelContext): Promise<void> {
		if (this.running) return;
		if (context) this.bindContext(context);
		this.bindLifecycleEvents();
		const handler = (req: IncomingMessage, res: ServerResponse): void => this.route(req, res);
		this.server = this.options.tls
			? createHttpsServer(readTlsOptions(this.options.tls), handler)
			: createHttpServer(handler);
		await new Promise<void>((resolve) => {
			this.server!.listen(this.options.port ?? 0, this.options.host ?? "127.0.0.1", resolve);
		});
		this.running = true;
	}

	async stop(): Promise<void> {
		this.unbindLifecycleEvents();
		if (!this.running) return;
		this.running = false;
		for (const client of this.subscribers) {
			client.res.end();
		}
		this.subscribers.clear();
		await new Promise<void>((resolve) => this.server?.close(() => resolve()));
		this.server = undefined;
	}

	/** Bound port (0 = ephemeral). Available after start(). */
	get port(): number {
		const address = this.server?.address();
		return typeof address === "object" && address !== null ? address.port : 0;
	}

	// ------------------------------------------------------------------
	// Outbound delivery
	// ------------------------------------------------------------------

	async send(message: OutboundMessage): Promise<void> {
		this.stats.messagesOut++;
		this.bumpChat(message.chatId, "out");
		this.pushHistory(message.chatId, "assistant", message.content);
		const event = outboundEventFromMessage(message);
		if (event instanceof ProgressEvent) {
			if (event.reasoningDelta || event.reasoningEnd || event.reasoning) {
				this.broadcast(message.chatId, "reasoning", { ...message, kind: "reasoning" });
			} else if (event.fileEditEvents) {
				this.broadcast(message.chatId, "progress", {
					...message,
					kind: "file_edits",
					fileEditEvents: event.fileEditEvents,
				});
			} else {
				this.broadcast(message.chatId, "progress", { ...message, kind: event.toolHint ? "tool_hint" : "progress" });
			}
			return;
		}
		if (
			event instanceof TurnEndEvent ||
			event instanceof SessionUpdatedEvent ||
			event instanceof RuntimeModelUpdatedEvent
		) {
			this.broadcast(message.chatId, "turn_end", { ...message, kind: event.kind });
			return;
		}
		this.broadcast(message.chatId, "message", message);
	}

	async sendDelta(delta: OutboundDelta): Promise<void> {
		this.stats.deltasOut++;
		this.broadcast(delta.chatId, "delta", delta);
	}

	private broadcast(
		chatId: string,
		event: "message" | "delta" | "progress" | "reasoning" | "turn_end" | "stopped" | "turn",
		payload: unknown,
	): void {
		const body = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
		for (const client of this.subscribers) {
			if (client.chatId !== chatId) continue;
			client.res.write(body);
		}
	}

	private bindLifecycleEvents(): void {
		if (this.lifecycleUnregisters.length > 0) return;
		const eventBus = this.channelContext.eventBus;
		if (!eventBus) return;
		for (const eventName of ["turn.started", "turn.completed", "turn.failed", "turn.interrupted"]) {
			const unregister = eventBus.on<ChannelLifecycleEvent>(eventName, (event) => {
				if (event.channel !== this.name || typeof event.chatId !== "string") return;
				this.broadcast(event.chatId, "turn", { type: eventName, ...event });
			});
			this.lifecycleUnregisters.push(unregister);
			this.channelContext.registerCleanup(unregister);
		}
	}

	private unbindLifecycleEvents(): void {
		for (const unregister of this.lifecycleUnregisters.splice(0)) unregister();
	}

	// ------------------------------------------------------------------
	// HTTP routing
	// ------------------------------------------------------------------

	private route(req: IncomingMessage, res: ServerResponse): void {
		const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
		try {
			if (req.method === "GET" && url.pathname === "/api/health") {
				this.handleHealth(res);
				return;
			}
			// Only management endpoints require the channel token. Everything else
			// (dashboard pages, host-registered UI routes, chat and SSE endpoints)
			// stays usable from a browser on the loopback host.
			if (
				isManagementPath(req.method ?? "GET", url.pathname) &&
				!isAuthorizedRequest(this.config.auth, req.headers, url)
			) {
				res.writeHead(401, { "Content-Type": "application/json", "WWW-Authenticate": "Bearer" });
				res.end(JSON.stringify({ error: "unauthorized" }));
				return;
			}
			const rateKey = req.socket.remoteAddress ?? "unknown";
			if (!this.requestRateLimiter.allow(rateKey)) {
				const retryAfter = this.requestRateLimiter.retryAfterMs(rateKey);
				res.writeHead(429, {
					"Content-Type": "application/json",
					...(retryAfter ? { "Retry-After": String(Math.ceil(retryAfter / 1000)) } : {}),
				});
				res.end(JSON.stringify({ error: "rate limit exceeded" }));
				return;
			}
			if (req.method === "POST" && url.pathname === "/api/messages") {
				void this.handlePostMessages(req, res, url);
				return;
			}
			if (req.method === "GET" && url.pathname === "/api/messages") {
				this.handleMessages(url, res);
				return;
			}
			if (req.method === "GET" && url.pathname === "/api/stream") {
				this.handleStream(url, res);
				return;
			}
			if (req.method === "POST" && url.pathname === "/api/uploads") {
				void this.handleUploads(req, res);
				return;
			}
			if (req.method === "POST" && url.pathname === "/api/stop") {
				void this.handleStop(req, res);
				return;
			}
			if (req.method === "GET" && url.pathname === "/api/media") {
				this.handleMedia(url, res);
				return;
			}
			if (req.method === "GET" && url.pathname === "/api/status") {
				this.handleStatus(res);
				return;
			}
			if (req.method === "GET" && url.pathname === "/api/metrics") {
				this.handleMetrics(res);
				return;
			}
			if (req.method === "GET" && url.pathname === "/metrics") {
				this.handlePrometheusMetrics(res);
				return;
			}
			if (req.method === "GET" && url.pathname === "/api/outbox") {
				this.handleOutbox(url, res);
				return;
			}
			if (req.method === "POST" && url.pathname === "/api/outbox/retry") {
				void this.handleOutboxRetry(req, res);
				return;
			}
			if (req.method === "POST" && url.pathname === "/api/outbox/cleanup") {
				void this.handleOutboxCleanup(req, res);
				return;
			}
			if (req.method === "GET" && url.pathname === "/api/inbound-dlq") {
				this.handleInboundDeadLetters(res);
				return;
			}
			if (req.method === "POST" && url.pathname === "/api/inbound-dlq/retry") {
				void this.handleInboundDeadLetterRetry(req, res);
				return;
			}
			if (req.method === "POST" && url.pathname === "/api/deliver") {
				void this.handleDeliver(req, res);
				return;
			}
			if (req.method === "GET" && url.pathname === "/api/pairing") {
				this.handlePairingList(res);
				return;
			}
			if (req.method === "POST" && url.pathname === "/api/pairing/approve") {
				void this.handlePairingAction(req, res, true);
				return;
			}
			if (req.method === "POST" && url.pathname === "/api/pairing/deny") {
				void this.handlePairingAction(req, res, false);
				return;
			}
			if (req.method === "GET" && url.pathname === "/api/history") {
				this.handleHistory(url, res);
				return;
			}
			const apiHandler = this.matchApiRoute(req.method ?? "GET", url.pathname);
			if (apiHandler) {
				void Promise.resolve(apiHandler(url, res, req)).catch((error) => {
					res.writeHead(500, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
				});
				return;
			}
			res.writeHead(404);
			res.end("not found");
		} catch (error) {
			res.writeHead(500);
			res.end(error instanceof Error ? error.message : String(error));
		}
	}

	private async handlePostMessages(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
		let body: string;
		try {
			body = await WebChannel.readBody(req, 2 * 1024 * 1024);
		} catch {
			res.writeHead(413, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "body too large" }));
			return;
		}
		if (
			this.config.auth?.signature &&
			!isAuthorizedRequest(this.config.auth, req.headers, url) &&
			!verifyBodySignature(this.config.auth, req.headers, body)
		) {
			res.writeHead(401, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "invalid webhook signature" }));
			return;
		}
		let parsed: {
			messageId?: unknown;
			clientMessageId?: unknown;
			senderId?: unknown;
			chatId?: unknown;
			content?: unknown;
			threadId?: unknown;
			media?: unknown;
			attachments?: unknown;
			replyTo?: unknown;
			metadata?: unknown;
		};
		try {
			parsed = JSON.parse(body) as typeof parsed;
		} catch {
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "invalid JSON" }));
			return;
		}

		const senderId = typeof parsed.senderId === "string" ? parsed.senderId : undefined;
		const chatId = typeof parsed.chatId === "string" ? parsed.chatId : undefined;
		const content = typeof parsed.content === "string" ? parsed.content : undefined;
		if (!senderId || !chatId || !content) {
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "senderId, chatId and content are required" }));
			return;
		}

		const result = await this.handleMessage({
			messageId: typeof parsed.messageId === "string" ? parsed.messageId : undefined,
			clientMessageId: typeof parsed.clientMessageId === "string" ? parsed.clientMessageId : undefined,
			senderId,
			chatId,
			content,
			threadId: typeof parsed.threadId === "string" ? parsed.threadId : undefined,
			media: Array.isArray(parsed.media) ? parsed.media.map(String) : undefined,
			attachments: parseAttachments(parsed.attachments),
			replyTo: parseReplyReference(parsed.replyTo),
			metadata:
				parsed.metadata && typeof parsed.metadata === "object"
					? (parsed.metadata as Record<string, unknown>)
					: undefined,
		});
		if (result.status === "rejected") {
			res.writeHead(503, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify({
					accepted: false,
					messageId: result.messageId,
					error: result.detail ?? "inbound queue unavailable",
				}),
			);
			return;
		}
		if (result.status === "accepted") {
			this.stats.messagesIn++;
			this.bumpChat(chatId, "in");
			this.pushHistory(chatId, "user", content);
		}

		res.writeHead(result.status === "duplicate" ? 200 : 202, { "Content-Type": "application/json" });
		res.end(
			JSON.stringify({
				accepted: result.status === "accepted",
				duplicate: result.status === "duplicate",
				messageId: result.messageId,
			}),
		);
	}

	/**
	 * 通知该 chat 的 SSE 订阅者停止当前生成(客户端侧中断标记)。
	 * agent 侧的真实取消由 bus 层提供,这里广播 stopped 事件让 UI 收敛。
	 */
	private async handleStop(req: IncomingMessage, res: ServerResponse): Promise<void> {
		let body: string;
		try {
			body = await WebChannel.readBody(req, 64 * 1024);
		} catch {
			res.writeHead(413, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "body too large" }));
			return;
		}
		let parsed: { chatId?: unknown };
		try {
			parsed = JSON.parse(body) as typeof parsed;
		} catch {
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "invalid JSON" }));
			return;
		}
		const chatId = typeof parsed.chatId === "string" ? parsed.chatId : undefined;
		if (!chatId) {
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "chatId is required" }));
			return;
		}
		const sessionKey = buildSessionKey(this.name, chatId);
		const interrupt = this.channelContext.interruptController?.requestInterrupt({
			sessionKey,
			reason: "web channel requested stop",
		});
		this.broadcast(chatId, "stopped", { chatId, sessionKey, status: interrupt?.status ?? "not_found" });
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(
			JSON.stringify({
				ok: true,
				interrupted: interrupt?.status === "interrupted",
				status: interrupt?.status ?? "not_found",
			}),
		);
	}

	private async handleUploads(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const uploadsDir = this.options.uploadsDir;
		const attachmentStore = this.channelContext.attachmentStore;
		if (!uploadsDir && !attachmentStore) {
			res.writeHead(501, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "uploads not enabled" }));
			return;
		}
		let body: string;
		try {
			body = await WebChannel.readBody(req, 12 * 1024 * 1024);
		} catch {
			res.writeHead(413, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "body too large" }));
			return;
		}
		let parsed: { filename?: unknown; data?: unknown; mimeType?: unknown };
		try {
			parsed = JSON.parse(body) as typeof parsed;
		} catch {
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "invalid JSON" }));
			return;
		}
		const filename = typeof parsed.filename === "string" ? parsed.filename.trim() : "";
		const data = typeof parsed.data === "string" ? parsed.data : "";
		if (!filename || !data) {
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "filename and data (base64) are required" }));
			return;
		}
		let buffer: Buffer;
		try {
			buffer = Buffer.from(data, "base64");
		} catch {
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "invalid base64 data" }));
			return;
		}
		const safeName = filename.replace(/[^\w.\-\u4e00-\u9fa5]/g, "_");
		const mimeType = typeof parsed.mimeType === "string" ? parsed.mimeType : undefined;
		if (attachmentStore) {
			try {
				const stored = await attachmentStore.save(buffer, { filename: safeName, mimeType });
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(
					JSON.stringify({
						filename: stored.filename,
						path: `/api/media?path=${encodeURIComponent(stored.id)}`,
						mimeType: stored.mimeType,
						attachmentId: stored.id,
					}),
				);
			} catch (error) {
				res.writeHead(500, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
			}
			return;
		}
		if (!uploadsDir) {
			res.writeHead(500, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "uploads directory is not configured" }));
			return;
		}
		const storedName = `${Date.now()}-${safeName}`;
		try {
			mkdirSync(uploadsDir, { recursive: true });
			writeFileSync(join(uploadsDir, storedName), buffer);
		} catch (error) {
			res.writeHead(500, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
			return;
		}
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(
			JSON.stringify({
				filename: safeName,
				path: `/api/media?path=${encodeURIComponent(storedName)}`,
				mimeType,
			}),
		);
	}

	private handleMedia(url: URL, res: ServerResponse): void {
		const attachmentStore = this.channelContext.attachmentStore;
		const uploadsDir = this.options.uploadsDir;
		const mediaPath = url.searchParams.get("path") ?? "";
		const storedPath = attachmentStore?.resolve?.(mediaPath);
		if (storedPath) {
			try {
				const content = readFileSync(storedPath);
				const type = UPLOAD_TYPES[extname(storedPath).toLowerCase()] ?? "application/octet-stream";
				res.writeHead(200, { "Content-Type": type });
				res.end(content);
			} catch {
				res.writeHead(404);
				res.end("not found");
			}
			return;
		}
		if (!uploadsDir || !mediaPath) {
			res.writeHead(404);
			res.end("not found");
			return;
		}
		const name = decodeURIComponent(mediaPath).replace(/^\//, "");
		if (!name || name.includes("..") || name.includes("/") || name.includes("\\")) {
			res.writeHead(403);
			res.end("forbidden");
			return;
		}
		try {
			const content = readFileSync(join(uploadsDir, name));
			const type = UPLOAD_TYPES[extname(name).toLowerCase()] ?? "application/octet-stream";
			res.writeHead(200, { "Content-Type": type });
			res.end(content);
		} catch {
			res.writeHead(404);
			res.end("not found");
		}
	}

	private handleStatus(res: ServerResponse): void {
		const chats = [...this.chatStats.entries()].map(([chatId, counts]) => ({ chatId, ...counts }));
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(
			JSON.stringify({
				ok: true,
				uptimeMs: Date.now() - this.startedAt,
				connections: this.subscribers.size,
				messagesIn: this.stats.messagesIn,
				messagesOut: this.stats.messagesOut,
				deltasOut: this.stats.deltasOut,
				chats,
				gateway: this.management?.status(),
			}),
		);
	}

	private handleHealth(res: ServerResponse): void {
		const gatewayStatus = this.management?.status();
		if (!Array.isArray(gatewayStatus)) {
			writeJson(res, 200, { ok: true });
			return;
		}
		const channels = gatewayStatus.filter(
			(value): value is { name: string; running: boolean; ready?: boolean } =>
				value !== null &&
				typeof value === "object" &&
				typeof (value as { name?: unknown }).name === "string" &&
				typeof (value as { running?: unknown }).running === "boolean",
		);
		writeJson(res, 200, {
			ok: channels.length > 0 && channels.every((channel) => channel.running && (channel.ready ?? channel.running)),
			ready: channels.length > 0 && channels.every((channel) => channel.ready ?? channel.running),
			channels: channels.map((channel) => ({
				name: channel.name,
				running: channel.running,
				ready: channel.ready ?? channel.running,
			})),
		});
	}

	private handleMetrics(res: ServerResponse): void {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ ok: true, metrics: this.management?.metrics() ?? this.bus.snapshot() }));
	}

	private handlePrometheusMetrics(res: ServerResponse): void {
		const metrics = this.management?.metrics() ?? this.bus.snapshot();
		const lines = Object.entries(metrics).map(
			([name, value]) => `gateway_${toMetricName(name)} ${typeof value === "number" ? value : 0}`,
		);
		lines.push(`gateway_web_sse_connections ${this.subscribers.size}`);
		lines.push(`gateway_web_messages_in ${this.stats.messagesIn}`);
		lines.push(`gateway_web_messages_out ${this.stats.messagesOut}`);
		lines.push(`gateway_web_deltas_out ${this.stats.deltasOut}`);
		res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" });
		res.end(`${lines.join("\n")}\n`);
	}

	private handleOutbox(url: URL, res: ServerResponse): void {
		const status = parseOutboxStatus(url.searchParams.get("status"));
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ ok: true, items: this.management?.listOutbox(status) ?? [] }));
	}

	private handleMessages(url: URL, res: ServerResponse): void {
		const listMessages = this.management?.listMessages;
		const query = parseMessageQuery(url);
		const items = listMessages?.(query);
		if (!items) {
			writeJson(res, 501, { error: "canonical message store is not configured" });
			return;
		}
		writeJson(res, 200, { ok: true, items });
	}

	private async handleOutboxRetry(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const body = await this.readJsonBody(req, res);
		if (!body) return;
		const messageId = typeof body.messageId === "string" ? body.messageId : undefined;
		if (!messageId || !this.management) {
			writeJson(res, 400, { error: "messageId and management support are required" });
			return;
		}
		writeJson(res, 200, { ok: await this.management.retryDelivery(messageId) });
	}

	private async handleOutboxCleanup(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const body = await this.readJsonBody(req, res);
		if (!body) return;
		if (!this.management) {
			writeJson(res, 501, { error: "outbox management is not configured" });
			return;
		}
		const olderThanMs = typeof body.olderThanMs === "number" ? body.olderThanMs : undefined;
		writeJson(res, 200, { ok: true, removed: this.management.cleanupOutbox({ olderThanMs }) });
	}

	private handleInboundDeadLetters(res: ServerResponse): void {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ ok: true, items: this.management?.listInboundDeadLetters() ?? [] }));
	}

	private async handleInboundDeadLetterRetry(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const body = await this.readJsonBody(req, res);
		if (!body) return;
		const messageId = typeof body.messageId === "string" ? body.messageId : undefined;
		if (!messageId || !this.management) {
			writeJson(res, 400, { error: "messageId and management support are required" });
			return;
		}
		writeJson(res, 200, { ok: await this.management.retryInbound(messageId) });
	}

	private handlePairingList(res: ServerResponse): void {
		const store = this.channelContext.pairingStore;
		if (!store) {
			writeJson(res, 404, { error: "pairing is not configured" });
			return;
		}
		writeJson(res, 200, { items: store.list() });
	}

	private async handlePairingAction(req: IncomingMessage, res: ServerResponse, approve: boolean): Promise<void> {
		const store = this.channelContext.pairingStore;
		if (!store) {
			writeJson(res, 404, { error: "pairing is not configured" });
			return;
		}
		const body = await this.readJsonBody(req, res);
		if (!body) return;
		const channel = typeof body.channel === "string" ? body.channel.trim() : "";
		const senderId = typeof body.senderId === "string" ? body.senderId.trim() : "";
		if (!channel || !senderId) {
			writeJson(res, 400, { error: "channel and senderId are required" });
			return;
		}
		if (approve) store.approve(channel, senderId);
		else store.deny(channel, senderId);
		writeJson(res, 200, { ok: true });
	}

	/**
	 * Delivery SDK entry: other modules (proactive / drift / ...) push outbound
	 * messages through the running gateway so channel connections stay owned by
	 * a single process. Requires the channel token (management path).
	 */
	private async handleDeliver(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const body = await this.readJsonBody(req, res, 8 * 1024 * 1024);
		if (!body) return;
		if (!this.management?.deliver) {
			writeJson(res, 501, { error: "delivery is not configured" });
			return;
		}
		const channel = typeof body.channel === "string" ? body.channel.trim() : "";
		const chatId = typeof body.chatId === "string" ? body.chatId.trim() : "";
		const content = typeof body.content === "string" ? body.content : "";
		if (!channel || !chatId) {
			writeJson(res, 400, { error: "channel and chatId are required" });
			return;
		}
		const media = Array.isArray(body.media)
			? body.media.filter((value): value is string => typeof value === "string")
			: undefined;
		const attachments = parseAttachments(body.attachments);
		const replyTo = typeof body.replyTo === "string" && body.replyTo ? body.replyTo : undefined;
		const messageId = typeof body.messageId === "string" && body.messageId ? body.messageId : undefined;
		try {
			const receipt = await this.management.deliver({
				...(messageId ? { messageId } : {}),
				channel,
				chatId,
				content,
				...(media && media.length > 0 ? { media } : {}),
				...(attachments ? { attachments } : {}),
				...(replyTo ? { replyTo } : {}),
			});
			writeJson(res, 200, { receipt });
		} catch (error) {
			writeJson(res, 502, {
				error: `delivery failed: ${error instanceof Error ? error.message : String(error)}`,
			});
		}
	}

	private async readJsonBody(
		req: IncomingMessage,
		res: ServerResponse,
		limitBytes = 64 * 1024,
	): Promise<Record<string, unknown> | undefined> {
		let body: string;
		try {
			body = await WebChannel.readBody(req, limitBytes);
		} catch {
			writeJson(res, 413, { error: "body too large" });
			return undefined;
		}
		try {
			const parsed = JSON.parse(body) as unknown;
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
				writeJson(res, 400, { error: "JSON object is required" });
				return undefined;
			}
			return parsed as Record<string, unknown>;
		} catch {
			writeJson(res, 400, { error: "invalid JSON" });
			return undefined;
		}
	}

	private handleHistory(url: URL, res: ServerResponse): void {
		const chatId = url.searchParams.get("chatId");
		const canonical = this.management?.listMessages?.(chatId ? { chatId, limit: 100 } : { limit: 100 });
		if (canonical) {
			const items = canonical.map(toHistoryItem);
			writeJson(res, 200, { ok: true, items });
			return;
		}
		const list = chatId
			? (this.history.get(chatId) ?? [])
			: [...this.history.entries()].flatMap(([id, items]) => items.map((item) => ({ chatId: id, ...item })));
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ ok: true, items: list.slice(-100) }));
	}

	/** Exact match first, then trailing "*" prefix match (e.g. "/*", "/ui/*"). */
	private matchApiRoute(method: string, pathname: string): ApiRouteHandler | undefined {
		const exact = this.apiRoutes.get(`${method} ${pathname}`);
		if (exact) return exact;
		for (const [key, handler] of this.apiRoutes) {
			const [keyMethod, keyPath] = key.split(" ");
			if (keyMethod === method && keyPath.endsWith("*") && pathname.startsWith(keyPath.slice(0, -1))) {
				return handler;
			}
		}
		return undefined;
	}

	private handleStream(url: URL, res: ServerResponse): void {
		const chatId = url.searchParams.get("chatId");
		if (!chatId) {
			res.writeHead(400);
			res.end("chatId query parameter is required");
			return;
		}

		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
			// 防止 nginx 等反向代理缓冲 SSE,导致流式块攒到回复结束才到达
			"X-Accel-Buffering": "no",
		});
		res.write(": connected\n\n");

		const client: SseClient = { res, chatId };
		this.subscribers.add(client);
		reqCleanup(res, () => {
			this.subscribers.delete(client);
		});
	}
}

function parseMessageQuery(url: URL): ChannelMessageQuery {
	return {
		direction: parseMessageDirection(url.searchParams.get("direction")),
		channel: nonEmptyQueryValue(url.searchParams.get("channel")),
		chatId: nonEmptyQueryValue(url.searchParams.get("chatId")),
		sessionKey: nonEmptyQueryValue(url.searchParams.get("sessionKey")),
		status: parseMessageStatus(url.searchParams.get("status")),
		after: parseQueryTimestamp(url.searchParams.get("after")),
		before: parseQueryTimestamp(url.searchParams.get("before")),
		limit: parseQueryLimit(url.searchParams.get("limit")),
	};
}

function toHistoryItem(record: ChannelMessageRecord): {
	role: "user" | "assistant";
	content: string;
	timestamp: number;
	messageId: string;
	direction: ChannelMessageRecord["direction"];
	status: ChannelMessageRecord["status"];
	channel: string;
	chatId: string;
} {
	return {
		role: record.direction === "inbound" ? "user" : "assistant",
		content: record.message.content,
		timestamp: record.direction === "inbound" ? record.message.timestamp : record.createdAt,
		messageId: record.message.messageId ?? record.recordId,
		direction: record.direction,
		status: record.status,
		channel: record.message.channel,
		chatId: record.message.chatId,
	};
}

function parseMessageDirection(value: string | null): ChannelMessageQuery["direction"] {
	return value === "inbound" || value === "outbound" ? value : undefined;
}

function parseMessageStatus(value: string | null): ChannelMessageStatus | undefined {
	if (!value) return undefined;
	const statuses: ChannelMessageStatus[] = [
		"received",
		"processing",
		"retrying",
		"completed",
		"dead-letter",
		"accepted",
		"delivering",
		"success",
		"partial",
		"failed",
		"cancelled",
	];
	return statuses.includes(value as ChannelMessageStatus) ? (value as ChannelMessageStatus) : undefined;
}

function nonEmptyQueryValue(value: string | null): string | undefined {
	const normalized = value?.trim();
	return normalized ? normalized : undefined;
}

function parseQueryTimestamp(value: string | null): number | undefined {
	if (!value) return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function parseQueryLimit(value: string | null): number | undefined {
	if (!value) return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : undefined;
}

function reqCleanup(res: ServerResponse, onClose: () => void): void {
	res.on("close", onClose);
	res.on("error", onClose);
}

const UPLOAD_TYPES: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".svg": "image/svg+xml",
	".pdf": "application/pdf",
	".txt": "text/plain; charset=utf-8",
	".md": "text/markdown; charset=utf-8",
	".json": "application/json",
	".js": "application/javascript",
	".ts": "text/plain; charset=utf-8",
};

function parseAttachments(value: unknown): ChannelAttachment[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const attachments: ChannelAttachment[] = [];
	for (const candidate of value) {
		if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
		const record = candidate as Record<string, unknown>;
		const kind = record.kind;
		const source = record.source;
		if (
			(kind !== "file" && kind !== "image" && kind !== "audio" && kind !== "video") ||
			typeof source !== "string" ||
			!source
		) {
			continue;
		}
		attachments.push({
			kind,
			source,
			filename: typeof record.filename === "string" ? record.filename : undefined,
			mimeType: typeof record.mimeType === "string" ? record.mimeType : undefined,
			sizeBytes: typeof record.sizeBytes === "number" ? record.sizeBytes : undefined,
			metadata:
				record.metadata && typeof record.metadata === "object" && !Array.isArray(record.metadata)
					? (record.metadata as Record<string, unknown>)
					: undefined,
		});
	}
	return attachments.length > 0 ? attachments : undefined;
}

function parseReplyReference(value: unknown): ReplyReference | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (typeof record.messageId !== "string" || !record.messageId) return undefined;
	return {
		messageId: record.messageId,
		content: typeof record.content === "string" ? record.content : undefined,
		senderId: typeof record.senderId === "string" ? record.senderId : undefined,
		senderLabel: typeof record.senderLabel === "string" ? record.senderLabel : undefined,
	};
}

function parseOutboxStatus(value: string | null): OutboxStatus | undefined {
	return value === "pending" ||
		value === "delivering" ||
		value === "delivered" ||
		value === "failed" ||
		value === "cancelled"
		? value
		: undefined;
}

function writeJson(res: ServerResponse, status: number, value: unknown): void {
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(JSON.stringify(value));
}

function toMetricName(name: string): string {
	return name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

/** Built-in management endpoints; these require the channel token when configured. */
function isManagementPath(_method: string, pathname: string): boolean {
	if (
		pathname === "/api/status" ||
		pathname === "/api/metrics" ||
		pathname === "/metrics" ||
		pathname === "/api/history" ||
		pathname === "/api/deliver" ||
		pathname === "/api/pairing"
	) {
		return true;
	}
	if (
		pathname.startsWith("/api/outbox") ||
		pathname.startsWith("/api/inbound-dlq") ||
		pathname.startsWith("/api/pairing/")
	) {
		return true;
	}
	return false;
}
