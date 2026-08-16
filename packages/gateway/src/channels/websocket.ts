/**
 * WebSocketChannel — nanobot-style chat channel over WebSocket.
 *
 * A WebSocket server (RFC 6455) where clients:
 *   -> {"type":"subscribe","chatId":"..."}     subscribe to a chat
 *   -> {"type":"unsubscribe","chatId":"..."}   leave a chat
 *   -> {"type":"message","chatId":"...","content":"...","senderId":"..."}
 *                                              send a message
 *   <- {"type":"message","chatId":...,"content":...}         complete reply
 *   <- {"type":"delta","chatId":...,"delta":...,"streamId":...,"streamEnd":...}
 *                                              streaming chunk
 *   <- {"type":"system","chatId":...,"text":...}             info/error
 *
 * Replies fan out to all connections subscribed to the target chatId
 * (same semantics as the SSE /api/stream of the web channel).
 */

import { isAuthorizedRequest } from "../auth.ts";
import { outboundEventFromMessage, ProgressEvent } from "../events.ts";
import type { ChannelTlsOptions } from "../tls.ts";
import {
	buildSessionKey,
	type ChannelAttachment,
	type OutboundDelta,
	type OutboundMessage,
	type ReplyReference,
} from "../types.ts";
import { BaseChannel, type ChannelConfig } from "./base.ts";
import type { ChannelContext } from "./context.ts";
import { WebSocketServer, type WsServerConnection } from "./ws-common.ts";

export interface WebSocketChannelConfig extends ChannelConfig {
	/** Listen port. Default 0 (ephemeral). */
	port?: number;
	/** Listen host. Default 127.0.0.1. */
	host?: string;
	tls?: ChannelTlsOptions;
}

interface WsClient {
	connection: WsServerConnection;
	/** chatIds this connection is subscribed to. */
	chats: Set<string>;
}

interface InboundEnvelope {
	type?: string;
	messageId?: unknown;
	clientMessageId?: unknown;
	chatId?: unknown;
	content?: unknown;
	senderId?: unknown;
	threadId?: unknown;
	media?: unknown;
	attachments?: unknown;
	replyTo?: unknown;
	metadata?: unknown;
}

export class WebSocketChannel extends BaseChannel {
	name = "websocket";
	displayName = "WebSocket";

	private server: WebSocketServer | undefined;
	private readonly clients = new Set<WsClient>();
	private boundPort = 0;

	get port(): number {
		return this.boundPort;
	}

	async start(context?: ChannelContext): Promise<void> {
		if (this.running) return;
		if (context) this.bindContext(context);
		const cfg = (this.config ?? {}) as WebSocketChannelConfig;
		this.server = new WebSocketServer();
		this.server.onUpgrade = (request) =>
			isAuthorizedRequest(
				this.config.auth,
				request.headers,
				new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`),
			);
		this.server.onConnection = (connection) => this.attach(connection);
		this.boundPort = await this.server.listen(cfg.port ?? 0, cfg.host ?? "127.0.0.1", cfg.tls);
		this.running = true;
	}

	async stop(): Promise<void> {
		if (!this.running) return;
		this.running = false;
		for (const client of this.clients) client.connection.close();
		this.clients.clear();
		await this.server?.close();
		this.server = undefined;
	}

	// ------------------------------------------------------------------
	// Outbound
	// ------------------------------------------------------------------

	async send(message: OutboundMessage): Promise<void> {
		const event = outboundEventFromMessage(message);
		const payload: Record<string, unknown> = {
			type: "message",
			messageId: message.messageId,
			chatId: message.chatId,
			content: message.content,
			replyTo: message.replyTo,
			replyContext: message.replyContext,
			media: message.media,
			attachments: message.attachments,
			thinking: message.thinking,
			turnId: message.turnId,
			metadata: message.metadata,
		};
		if (event instanceof ProgressEvent) {
			if (event.reasoningDelta || event.reasoningEnd || event.reasoning) {
				payload.kind = "reasoning";
			} else if (event.fileEditEvents) {
				payload.kind = "file_edits";
				payload.fileEditEvents = event.fileEditEvents;
			} else {
				payload.kind = event.toolHint ? "tool_hint" : "progress";
			}
		} else if (event) {
			payload.kind = event.kind;
		}
		this.broadcast(message.chatId, payload);
	}

	async sendDelta(delta: OutboundDelta): Promise<void> {
		this.broadcast(delta.chatId, {
			type: "delta",
			messageId: delta.messageId,
			chatId: delta.chatId,
			delta: delta.delta,
			replyTo: delta.replyTo,
			deltaType: delta.type,
			streamId: delta.streamId,
			streamEnd: delta.streamEnd,
			turnId: delta.turnId,
		});
	}

	private broadcast(chatId: string, payload: unknown): void {
		const body = JSON.stringify(payload);
		for (const client of this.clients) {
			if (client.chats.has(chatId)) client.connection.send(body);
		}
	}

	// ------------------------------------------------------------------
	// Inbound
	// ------------------------------------------------------------------

	private attach(connection: WsServerConnection): void {
		const client: WsClient = { connection, chats: new Set() };
		this.clients.add(client);
		connection.onMessage = (text) => this.handlePayload(client, text);
		connection.onClose = () => {
			this.clients.delete(client);
		};
	}

	private handlePayload(client: WsClient, text: string): void {
		let envelope: InboundEnvelope;
		try {
			envelope = JSON.parse(text) as InboundEnvelope;
		} catch {
			this.sendSystem(client, "", "invalid JSON");
			return;
		}
		const chatId = typeof envelope.chatId === "string" ? envelope.chatId : "";
		if (envelope.type === "subscribe") {
			if (!chatId) return;
			client.chats.add(chatId);
			return;
		}
		if (envelope.type === "unsubscribe") {
			client.chats.delete(chatId);
			return;
		}
		if (envelope.type === "message") {
			if (!chatId || typeof envelope.content !== "string" || !envelope.content) {
				this.sendSystem(client, chatId, "chatId and content are required");
				return;
			}
			const senderId = typeof envelope.senderId === "string" ? envelope.senderId : "ws-user";
			void this.handleMessage({
				messageId: typeof envelope.messageId === "string" ? envelope.messageId : undefined,
				clientMessageId: typeof envelope.clientMessageId === "string" ? envelope.clientMessageId : undefined,
				senderId,
				chatId,
				content: envelope.content,
				threadId: typeof envelope.threadId === "string" ? envelope.threadId : undefined,
				media: Array.isArray(envelope.media) ? envelope.media.map(String) : undefined,
				attachments: parseAttachments(envelope.attachments),
				replyTo: parseReplyReference(envelope.replyTo),
				metadata: parseMetadata(envelope.metadata),
			});
			return;
		}
		if (envelope.type === "stop") {
			if (!chatId) {
				this.sendSystem(client, chatId, "chatId is required");
				return;
			}
			const result = this.channelContext.interruptController?.requestInterrupt({
				sessionKey: buildSessionKey(this.name, chatId),
				reason: "websocket channel requested stop",
			});
			client.connection.send(
				JSON.stringify({
					type: "turn.interrupted",
					chatId,
					status: result?.status ?? "not_found",
					message: result?.message ?? "interrupt controller is not configured",
				}),
			);
			return;
		}
		this.sendSystem(client, chatId, `unknown message type: ${envelope.type ?? "(none)"}`);
	}

	private sendSystem(client: WsClient, chatId: string, text: string): void {
		client.connection.send(JSON.stringify({ type: "system", chatId, text }));
	}
}

function parseMetadata(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

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
			metadata: parseMetadata(record.metadata),
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
