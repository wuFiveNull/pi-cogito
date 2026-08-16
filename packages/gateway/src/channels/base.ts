/**
 * BaseChannel — abstract channel interface (nanobot-style).
 *
 * Subclasses connect to a chat platform, normalize incoming messages via
 * handleMessage() (permission check + InboundMessage + bus publish), and
 * implement send()/sendDelta() to deliver agent replies back to the platform.
 */

import type { ChannelAuthConfig } from "../auth.ts";
import type { MessageBus } from "../bus.ts";
import { ProgressEvent } from "../events.ts";
import { type ChannelMediaCapabilities, collectOutboundMedia } from "../media.ts";
import { formatPairingReply } from "../pairing.ts";
import { type ChannelRateLimitConfig, SlidingWindowRateLimiter } from "../rate-limit.ts";
import {
	buildSessionKey,
	type ChannelAttachment,
	type ChannelSendResult,
	createMessageId,
	type ImageAttachment,
	type InboundMessage,
	type OutboundDelta,
	type OutboundMessage,
	type ReplyReference,
} from "../types.ts";
import { type ChannelContext, ChannelContextScope } from "./context.ts";

export type ChannelPublishStatus = "accepted" | "duplicate" | "filtered" | "rejected";

export interface ChannelPublishResult {
	status: ChannelPublishStatus;
	messageId: string;
	detail?: string;
}

/** Group access policy (nanobot DIRECT_GROUP_POLICIES + allowlist). */
export type GroupPolicyMode = "open" | "mention" | "allowlist";

export interface GroupPolicy {
	/** Empty means all senders are allowed in the group. */
	allowFrom?: string[];
	/** Require a channel parser to mark the message as mentioning the bot. */
	requireAt?: boolean;
	/**
	 * Declarative group policy (nanobot-style): "open" allows everyone,
	 * "mention" requires an @-mention, "allowlist" restricts to allowFrom.
	 * Takes precedence over the legacy allowFrom/requireAt flags.
	 */
	mode?: GroupPolicyMode;
}

/** Rich rendering capabilities declared by a channel implementation. */
export interface ChannelCapabilities {
	/** Can stream text via sendDelta. */
	streaming: boolean;
	/** Has a native low-emphasis reasoning rendering primitive. */
	reasoning: boolean;
	/** Renders structured file-edit events. */
	fileEdits: boolean;
	/** Can emit progress/tool-hint messages (text degradation always available). */
	progress: boolean;
	/** Renders interactive buttons and handles their callbacks. */
	buttons: boolean;
}

export interface ChannelConfig {
	/** Senders allowed to talk to the agent. "*" allows everyone. */
	allowFrom?: string[];
	/** Optional common policy for group messages. */
	group?: GroupPolicy;
	/** Enable streaming (sendDelta) if the channel supports it. */
	streaming?: boolean;
	/** Optional shared-secret protection for HTTP/WebSocket channel endpoints. */
	auth?: ChannelAuthConfig;
	/** Optional per-sender/chat inbound sliding-window limit. */
	rateLimit?: ChannelRateLimitConfig;
	/** Send progress messages (default true). */
	sendProgress?: boolean;
	/** Send tool-call hints (default true). */
	sendToolHints?: boolean;
	/** Deliver reasoning/thinking content (default true). */
	showReasoning?: boolean;
	/**
	 * Pairing mode: when true (and no allowFrom), unapproved DM senders
	 * receive a pairing code instead of being silently dropped. Default
	 * false (current behavior: everyone allowed when allowFrom is empty).
	 */
	pairing?: boolean;
	[key: string]: unknown;
}

export abstract class BaseChannel {
	/**
	 * Unique runtime channel id, e.g. "web" or a multi-instance
	 * "telegram.work". The registry may rename instances at construction time.
	 */
	abstract name: string;
	abstract readonly displayName: string;

	protected readonly config: ChannelConfig;
	protected readonly bus: MessageBus;
	protected channelContext: ChannelContext;
	protected running = false;
	private readonly inboundRateLimiter: SlidingWindowRateLimiter;

	constructor(config: ChannelConfig | undefined, bus: MessageBus) {
		this.config = config ?? {};
		this.bus = bus;
		this.channelContext = new ChannelContextScope(bus);
		this.inboundRateLimiter = new SlidingWindowRateLimiter(this.config.rateLimit);
	}

	/** Default configuration used by onboarding to scaffold a channel section. */
	static defaultConfig(): ChannelConfig {
		return { enabled: false };
	}

	/**
	 * Perform channel-specific interactive login (e.g. QR code scan).
	 * Returns true when already authenticated or login succeeds. Override in
	 * channels that support interactive login; hosts call this before start().
	 */
	async login(_force = false): Promise<boolean> {
		return true;
	}

	/**
	 * Transcribe audio bytes via the host-provided transcriber
	 * (e.g. Whisper through the agent). Returns "" when no transcriber is
	 * configured or transcription fails.
	 */
	protected async transcribeAudio(data: Uint8Array, mimeType: string): Promise<string> {
		const transcriber = this.channelContext.transcriber;
		if (!transcriber) return "";
		try {
			return await transcriber(data, mimeType);
		} catch (error) {
			this.channelContext.logger?.error(
				`[${this.name}] transcription failed: ${error instanceof Error ? error.message : String(error)}`,
			);
			return "";
		}
	}

	/** Bind the per-channel host context before startup. */
	bindContext(context: ChannelContext): void {
		this.channelContext = context;
	}

	/** Start listening for messages. Long-running. */
	abstract start(context?: ChannelContext): Promise<void>;

	/** Stop and clean up. */
	abstract stop(): Promise<void>;

	/** Deliver a complete reply through this channel. Must throw on failure. */
	// biome-ignore lint/suspicious/noConfusingVoidType: channels may intentionally return no structured receipt
	abstract send(message: OutboundMessage): Promise<void | ChannelSendResult>;

	/** Deliver a streaming chunk. Default: no streaming. */
	async sendDelta(_delta: OutboundDelta): Promise<void> {
		throw new Error(`${this.name} channel does not support streaming`);
	}

	get supportsStreaming(): boolean {
		return this.config.streaming === true && this.sendDelta !== BaseChannel.prototype.sendDelta;
	}

	/**
	 * Declared rich capabilities. Channels override the underlying primitives
	 * and this getter reflects them; `progress` is always available because
	 * sendProgress degrades to a plain text send.
	 */
	get capabilities(): ChannelCapabilities {
		return {
			streaming: this.supportsStreaming,
			reasoning: this.sendReasoningDelta !== BaseChannel.prototype.sendReasoningDelta,
			fileEdits: this.sendFileEditEvents !== BaseChannel.prototype.sendFileEditEvents,
			progress: true,
			buttons: this.sendButtons !== BaseChannel.prototype.sendButtons,
		};
	}

	/** Whether progress messages may be delivered (config gate). */
	get sendProgressEnabled(): boolean {
		return this.config.sendProgress !== false;
	}

	/** Whether tool-call hints may be delivered (config gate). */
	get sendToolHintsEnabled(): boolean {
		return this.config.sendToolHints !== false;
	}

	/** Whether reasoning content may be delivered (config gate). */
	get showReasoningEnabled(): boolean {
		return this.config.showReasoning !== false;
	}

	/**
	 * Deliver a process message (progress text or tool hint). Default sends it
	 * as a complete plain-text message so nothing user-visible is lost.
	 */
	// biome-ignore lint/suspicious/noConfusingVoidType: channels may intentionally return no structured receipt
	async sendProgress(message: OutboundMessage): Promise<void | ChannelSendResult> {
		return this.send(message);
	}

	/** Stream a chunk of model reasoning/thinking content. Default no-op. */
	async sendReasoningDelta(
		chatId: string,
		delta: string,
		metadata?: Record<string, unknown>,
		streamId?: string,
	): Promise<void> {
		void chatId;
		void delta;
		void metadata;
		void streamId;
	}

	/** Mark the end of a reasoning stream segment. Default no-op. */
	async sendReasoningEnd(chatId: string, metadata?: Record<string, unknown>, streamId?: string): Promise<void> {
		void chatId;
		void metadata;
		void streamId;
	}

	/**
	 * Deliver a complete reasoning block. Default reuses the streaming pair:
	 * one delta with the full content followed by an end marker, so channels
	 * only need to implement the streaming primitives.
	 */
	async sendReasoning(message: OutboundMessage): Promise<void> {
		if (!message.content) return;
		const streamId = streamIdOf(message);
		await this.sendReasoningDelta(message.chatId, message.content, message.metadata, streamId);
		await this.sendReasoningEnd(message.chatId, message.metadata, streamId);
	}

	/** Deliver structured live file-edit events. Default no-op. */
	async sendFileEditEvents(
		chatId: string,
		edits: Array<Record<string, unknown>>,
		metadata?: Record<string, unknown>,
	): Promise<void> {
		void chatId;
		void edits;
		void metadata;
	}

	/**
	 * Deliver an interactive button layout. Default no-op: channels without an
	 * interactive surface leave the content in `message.content` (producers
	 * render buttons as text when the channel does not support them).
	 */
	async sendButtons(_message: OutboundMessage): Promise<void> {
		// No interactive surface by default.
	}

	/**
	 * Channel media capability declaration. Default supports no media;
	 * media-capable channels override and call collectOutboundMedia() in send().
	 */
	get mediaCapabilities(): ChannelMediaCapabilities {
		return { kinds: [], urlDirect: false };
	}

	/**
	 * 归一化出站媒体并校验渠道能力。`media`(裸字符串)与 `attachments`
	 * (结构化)统一为 ChannelAttachment 列表;渠道不支持的 kind 显式抛错,
	 * 绝不静默丢弃。
	 */
	protected collectOutboundMedia(message: OutboundMessage): ChannelAttachment[] {
		const items = collectOutboundMedia(message);
		const supported = new Set(this.mediaCapabilities.kinds);
		for (const item of items) {
			if (!supported.has(item.kind)) {
				throw new Error(`${this.name} channel does not support ${item.kind} media`);
			}
		}
		return items;
	}

	/**
	 * Permission check: "*" > allowlist > pairing store approval.
	 * When allowFrom is empty and pairing mode is enabled, senders must be
	 * approved through the pairing store (nanobot is_allowed semantics).
	 */
	isAllowed(senderId: string): boolean {
		const allow = this.config.allowFrom ?? [];
		if (allow.includes("*")) return true;
		if (allow.length > 0) return allow.includes(senderId);
		if (this.config.pairing === true) {
			const store = this.channelContext.pairingStore;
			return store?.isApproved(this.name, senderId) ?? false;
		}
		return true;
	}

	/**
	 * Normalize a platform message into an InboundMessage and publish it.
	 * Subclasses call this from their platform listeners.
	 */
	protected async handleMessage(input: {
		messageId?: string;
		senderId: string;
		chatId: string;
		content: string;
		media?: string[];
		attachments?: ChannelAttachment[];
		images?: ImageAttachment[];
		threadId?: string;
		clientMessageId?: string;
		replyTo?: ReplyReference;
		metadata?: Record<string, unknown>;
		sessionKeyOverride?: string;
		isDm?: boolean;
		authorizationId?: string;
	}): Promise<ChannelPublishResult> {
		const clientMessageId =
			input.clientMessageId ??
			readString(input.metadata, "clientMessageId") ??
			readString(input.metadata, "client_message_id");
		const messageId =
			input.messageId ?? readMessageId(input.metadata) ?? clientMessageId ?? createMessageId(this.name);
		// Group/room-scoped authorization: the permission check runs against the
		// authorization entity while sender identity stays untouched (nanobot
		// _handle_message authorization_id semantics).
		const permissionId = input.authorizationId ?? input.senderId;
		if (!this.isAllowed(permissionId) || !this.isAllowedGroup(input)) {
			// Drop unauthorized messages; in pairing mode send a code to DMs.
			await this.sendPairingHintIfNeeded(input);
			return { status: "filtered", messageId };
		}
		if (!this.inboundRateLimiter.allow(`${input.senderId}:${input.chatId}`)) {
			return { status: "filtered", messageId, detail: "inbound rate limit exceeded" };
		}
		const metadata: Record<string, unknown> = { ...(input.metadata ?? {}) };
		if (this.supportsStreaming) metadata._wants_stream = true;
		const message: InboundMessage = {
			messageId,
			channel: this.name,
			senderId: input.senderId,
			chatId: input.chatId,
			content: input.content,
			media: input.media,
			attachments: input.attachments,
			images: input.images,
			threadId: input.threadId,
			clientMessageId,
			replyTo: input.replyTo,
			metadata,
			timestamp: Date.now(),
			sessionKey: input.sessionKeyOverride ?? buildSessionKey(this.name, input.chatId),
			isDm: input.isDm,
			authorizationId: input.authorizationId,
		};
		try {
			const accepted = this.bus.publishInbound(message);
			return { status: accepted ? "accepted" : "duplicate", messageId };
		} catch (error) {
			this.channelContext.logger?.error(
				`[${this.name}] inbound message rejected id=${messageId}: ${formatError(error)}`,
			);
			return { status: "rejected", messageId, detail: formatError(error) };
		}
	}

	protected allowInboundRate(senderId: string, chatId: string): boolean {
		return this.inboundRateLimiter.allow(`${senderId}:${chatId}`);
	}

	get isRunning(): boolean {
		return this.running;
	}

	/**
	 * Whether the channel can currently receive/send traffic. Connection-oriented
	 * channels override this while they are reconnecting.
	 */
	get isReady(): boolean {
		return this.running;
	}

	private isAllowedGroup(input: {
		senderId: string;
		chatId: string;
		metadata?: Record<string, unknown>;
		authorizationId?: string;
	}): boolean {
		const policy = this.config.group;
		if (!policy) return true;
		const metadata = input.metadata;
		const isGroup =
			input.chatId.startsWith("group:") ||
			metadata?.chatType === "group" ||
			metadata?.messageType === "group" ||
			metadata?.chat_type === "group";
		if (!isGroup) return true;
		const permissionId = input.authorizationId ?? input.senderId;
		if (policy.mode !== undefined) {
			switch (policy.mode) {
				case "open":
					return true;
				case "mention":
					return metadata?.mentionedBot === true;
				case "allowlist":
					return (
						policy.allowFrom !== undefined &&
						(policy.allowFrom.includes("*") || policy.allowFrom.includes(permissionId))
					);
			}
		}
		if (policy.allowFrom && policy.allowFrom.length > 0) {
			const allowed = policy.allowFrom.includes("*") || policy.allowFrom.includes(permissionId);
			if (!allowed) return false;
		}
		if (policy.requireAt && metadata?.mentionedBot !== true) return false;
		return true;
	}

	/**
	 * In pairing mode, DM senders rejected by the permission check receive a
	 * pairing code; group messages stay silent (nanobot _handle_message).
	 */
	private async sendPairingHintIfNeeded(input: {
		senderId: string;
		chatId: string;
		metadata?: Record<string, unknown>;
		isDm?: boolean;
	}): Promise<void> {
		if (this.config.pairing !== true) return;
		const metadata = input.metadata;
		const isGroup =
			input.isDm === false ||
			input.chatId.startsWith("group:") ||
			metadata?.chatType === "group" ||
			metadata?.messageType === "group" ||
			metadata?.chat_type === "group";
		if (isGroup) return;
		const store = this.channelContext.pairingStore;
		if (!store) return;
		let code: string;
		try {
			code = store.generateCode(this.name, input.senderId);
		} catch (error) {
			this.channelContext.logger?.warn(
				`[${this.name}] pairing store unavailable; dropping DM from ${input.senderId}: ${formatError(error)}`,
			);
			return;
		}
		this.channelContext.logger?.info(
			`[${this.name}] sent pairing code to sender ${input.senderId} in chat ${input.chatId}`,
		);
		try {
			await this.send({
				channel: this.name,
				chatId: input.chatId,
				content: formatPairingReply(code, this.name),
				metadata: { pairingCode: code },
			});
		} catch (error) {
			this.channelContext.logger?.warn(
				`[${this.name}] pairing reply failed for ${input.senderId}: ${formatError(error)}`,
			);
		}
	}
}

function readMessageId(metadata: Record<string, unknown> | undefined): string | undefined {
	for (const key of ["messageId", "eventId", "updateId", "event_id", "message_id"]) {
		const value = readString(metadata, key);
		if (value) return value;
	}
	return undefined;
}

function streamIdOf(message: OutboundMessage): string | undefined {
	const event = message.event;
	if (event instanceof ProgressEvent && event.streamId) return event.streamId;
	const value = message.metadata?._stream_id;
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readString(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
	const value = metadata?.[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
