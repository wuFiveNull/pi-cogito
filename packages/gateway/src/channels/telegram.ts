/**
 * TelegramChannel — long-polling Telegram bot channel (zero-dependency).
 *
 * Polls getUpdates, normalizes messages (user id -> senderId, chat id ->
 * chatId, optional reply message id in metadata), and sends replies via
 * sendMessage. Streaming edits the original message (nanobot-style), inbound
 * media is downloaded (images become multimodal input, voice/audio go through
 * the host transcriber), group mentions are parsed, and buttons render as
 * inline keyboards whose callbacks feed back as ordinary messages.
 * The HTTP client is injectable for tests.
 */

import type { MessageBus } from "../bus.ts";
import { type ChannelMediaCapabilities, isHttpUrl, resolveOutboundMedia, withMediaFailureNote } from "../media.ts";
import type {
	ChannelAttachment,
	ChannelSendResult,
	ImageAttachment,
	OutboundDelta,
	OutboundMessage,
} from "../types.ts";
import { BaseChannel, type ChannelConfig } from "./base.ts";
import type { ChannelContext } from "./context.ts";

export interface TelegramConfig extends ChannelConfig {
	token?: string;
	/** Polling interval in ms. Default 1000. */
	pollIntervalMs?: number;
	/** Reply to the triggering message. Default true. */
	replyToMessage?: boolean;
	/** Throttle between streaming edits, ms. Default 600. */
	streamEditIntervalMs?: number;
	/** Streaming messages longer than this are split mid-flight. Default 4000. */
	maxStreamLength?: number;
	/** Render OutboundMessage.buttons as inline keyboards. Default true. */
	inlineKeyboards?: boolean;
	/** Send the typing indicator while a turn is active. Default true. */
	showTyping?: boolean;
	/** Interval between typing action refreshes, ms. Default 4000. */
	typingIntervalMs?: number;
	/** Emoji reacted to the triggering message while a turn is active. Empty disables. Default "👀". */
	reactEmoji?: string;
}

/** Built-in and host-provided slash command handlers (nanobot /start /help). */
export interface TelegramCommandContext {
	chatId: number;
	args: string;
	isDm: boolean;
}

export type TelegramCommandHandler = (context: TelegramCommandContext) => string | Promise<string>;

export interface TelegramCommandRegistry {
	get(command: string): TelegramCommandHandler | undefined;
}

interface TelegramUser {
	id: number;
	first_name?: string;
	username?: string;
}

interface TelegramChat {
	id: number;
	type?: string;
}

interface TelegramEntity {
	type: string;
	offset: number;
	length: number;
	user?: TelegramUser;
}

interface TelegramMessage {
	message_id: number;
	from?: TelegramUser;
	chat: TelegramChat;
	text?: string;
	caption?: string;
	entities?: TelegramEntity[];
	caption_entities?: TelegramEntity[];
	photo?: Array<{ file_id: string; file_unique_id?: string; width?: number; height?: number }>;
	voice?: { file_id: string; duration?: number; mime_type?: string };
	audio?: { file_id: string; mime_type?: string; file_name?: string };
	document?: { file_id: string; mime_type?: string; file_name?: string };
	video?: { file_id: string; mime_type?: string; file_name?: string };
	reply_to_message?: TelegramMessage;
	media_group_id?: string;
	/** Forum topic thread id; threads get their own session. */
	message_thread_id?: number;
}

interface TelegramUpdate {
	update_id: number;
	message?: TelegramMessage;
	callback_query?: {
		id: string;
		from: TelegramUser;
		message?: { message_id: number; chat: TelegramChat };
		data?: string;
	};
}

interface TelegramStreamBuf {
	messageId?: number;
	text: string;
	streamId?: string;
	lastEditAt: number;
}

interface MediaGroupBuffer {
	senderId: string;
	chatId: string;
	contents: string[];
	attachments: ChannelAttachment[];
	images: ImageAttachment[];
	metadata: Record<string, unknown>;
	sessionKey?: string;
	from?: TelegramUser;
}

export interface HttpResult {
	ok: boolean;
	status: number;
	json(): Promise<unknown>;
}
export type HttpGet = (url: string) => Promise<HttpResult>;
export type HttpPost = (url: string, body: Record<string, unknown>) => Promise<HttpResult>;

export class TelegramChannel extends BaseChannel {
	name = "telegram";
	displayName = "Telegram";

	private polling = false;
	private pollTimer: NodeJS.Timeout | undefined;
	private lastUpdateId = 0;
	private botUsername: string | undefined;
	private readonly streamBufs = new Map<string, TelegramStreamBuf>();
	private readonly get: HttpGet;
	private readonly post: HttpPost;
	private readonly fetchFn: typeof fetch;
	private readonly config2: TelegramConfig;
	private readonly commands: TelegramCommandRegistry | undefined;
	private readonly typingLoops = new Map<string, NodeJS.Timeout>();
	private readonly reactionTargets = new Map<string, number>();
	private readonly mediaGroups = new Map<string, MediaGroupBuffer>();
	private readonly mediaGroupTimers = new Map<string, NodeJS.Timeout>();

	constructor(
		config: TelegramConfig | undefined,
		bus: MessageBus,
		options: {
			get?: HttpGet;
			post?: HttpPost;
			apiBaseUrl?: string;
			fetchFn?: typeof fetch;
			commands?: TelegramCommandRegistry;
		} = {},
	) {
		super(config, bus);
		this.config2 = config ?? {};
		this.fetchFn = options.fetchFn ?? fetch;
		this.commands = options.commands ?? defaultTelegramCommands();
		this.get =
			options.get ??
			(async (url) => {
				const response = await fetch(url);
				return { ok: response.ok, status: response.status, json: () => response.json() };
			});
		this.post =
			options.post ??
			(async (url, body) => {
				const response = await fetch(url, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(body),
				});
				return { ok: response.ok, status: response.status, json: () => response.json() };
			});
		this.apiBaseUrl = options.apiBaseUrl ?? "https://api.telegram.org";
	}

	private readonly apiBaseUrl: string;

	private get apiUrl(): string {
		return `${this.apiBaseUrl}/bot${this.config2.token ?? ""}`;
	}

	async start(context?: ChannelContext): Promise<void> {
		if (this.running) return;
		if (!this.config2.token) throw new Error("telegram token not configured");
		if (context) this.bindContext(context);
		const savedOffset = this.channelContext.offsetStore?.get(this.name, "updateId");
		const parsedOffset = savedOffset === undefined ? undefined : Number(savedOffset);
		if (parsedOffset !== undefined && Number.isSafeInteger(parsedOffset) && parsedOffset >= 0) {
			this.lastUpdateId = parsedOffset;
		}
		this.running = true;
		// Resolve the bot username once for @-mention detection (best effort).
		void this.refreshBotUsername();
		this.pollTimer = setInterval(() => void this.pollOnce(), this.config2.pollIntervalMs ?? 1000);
		this.pollTimer.unref?.();
	}

	async stop(): Promise<void> {
		if (!this.running) return;
		this.running = false;
		if (this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = undefined;
		}
		this.streamBufs.clear();
		for (const timer of this.typingLoops.values()) clearInterval(timer);
		this.typingLoops.clear();
		this.reactionTargets.clear();
		for (const timer of this.mediaGroupTimers.values()) clearTimeout(timer);
		this.mediaGroupTimers.clear();
		this.mediaGroups.clear();
	}

	private async refreshBotUsername(): Promise<void> {
		try {
			const response = await this.get(`${this.apiUrl}/getMe`);
			if (!response.ok) return;
			const data = (await response.json()) as { ok?: boolean; result?: { username?: string } };
			this.botUsername = data.result?.username;
		} catch {
			// Username resolution is best effort; mention detection falls back to false.
		}
	}

	private async pollOnce(): Promise<void> {
		if (this.polling) return;
		this.polling = true;
		try {
			const params = new URLSearchParams({ timeout: "25", offset: String(this.lastUpdateId + 1) });
			const response = await this.get(`${this.apiUrl}/getUpdates?${params}`);
			if (!response.ok) return;
			const data = (await response.json()) as { ok?: boolean; result?: TelegramUpdate[] };
			for (const update of data.result ?? []) {
				await this.processUpdate(update);
				this.lastUpdateId = Math.max(this.lastUpdateId, update.update_id);
				this.channelContext.offsetStore?.set(this.name, "updateId", String(this.lastUpdateId));
			}
		} catch {
			// Transient network errors are normal in polling; retry next tick.
		} finally {
			this.polling = false;
		}
	}

	private async processUpdate(update: TelegramUpdate): Promise<void> {
		if (update.callback_query) {
			await this.processCallbackQuery(update.callback_query);
			return;
		}
		const message = update.message;
		if (!message?.from) return;
		const chatId = String(message.chat.id);
		const isDm = message.chat.type === "private" || message.chat.type === undefined;
		const content = message.text ?? message.caption ?? "";
		const metadata: Record<string, unknown> = {
			messageId: String(message.message_id),
			chatType: message.chat.type ?? "private",
		};
		if (message.reply_to_message) {
			metadata.replyMessageId = String(message.reply_to_message.message_id);
			metadata.replySenderId = String(message.reply_to_message.from?.id ?? "");
		}
		if (message.media_group_id) metadata.mediaGroupId = message.media_group_id;
		if (this.isMentioned(message)) metadata.mentionedBot = true;

		const sessionKey = message.message_thread_id ? `${this.name}:${chatId}:${message.message_thread_id}` : undefined;

		// Slash commands are answered directly and never reach the agent.
		if (message.text) {
			const handled = await this.tryHandleCommand(message.text, Number(chatId), isDm);
			if (handled) return;
		}

		const attachments: ChannelAttachment[] = [];
		const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
		const contentParts: string[] = [];
		if (content) contentParts.push(content);

		if (message.photo && message.photo.length > 0) {
			const largest = message.photo.reduce((a, b) =>
				(a.width ?? 0) * (a.height ?? 0) > (b.width ?? 0) * (b.height ?? 0) ? a : b,
			);
			const image = await this.downloadImage(largest.file_id);
			if (image) images.push(image);
		}
		if (message.voice) {
			const text = await this.transcribeMessageMedia(message.voice.file_id, message.voice.mime_type ?? "audio/ogg");
			if (text) contentParts.push(text);
		}
		if (message.audio) {
			const text = await this.transcribeMessageMedia(message.audio.file_id, message.audio.mime_type ?? "audio/mpeg");
			if (text) contentParts.push(text);
			else if (message.audio.file_name) {
				attachments.push({
					kind: "audio",
					source: await this.downloadMediaSource(message.audio.file_id),
					filename: message.audio.file_name,
				});
			}
		}
		if (message.document) {
			attachments.push({
				kind: "file",
				source: await this.downloadMediaSource(message.document.file_id),
				filename: message.document.file_name,
				mimeType: message.document.mime_type,
			});
		}
		if (message.video) {
			attachments.push({
				kind: "video",
				source: await this.downloadMediaSource(message.video.file_id),
				filename: message.video.file_name,
				mimeType: message.video.mime_type,
			});
		}

		// Media groups (albums) are buffered briefly and flushed as one turn
		// so the agent sees a single request instead of N near-identical ones.
		if (message.media_group_id) {
			const key = `${message.media_group_id}:${message.from.id}`;
			const existing = this.mediaGroups.get(key);
			const buffer: MediaGroupBuffer = existing ?? {
				senderId: String(message.from.id),
				chatId,
				contents: [],
				attachments: [],
				images: [],
				metadata,
				sessionKey,
			};
			buffer.contents.push(...contentParts);
			buffer.attachments.push(...attachments);
			buffer.images.push(...images);
			this.mediaGroups.set(key, buffer);
			if (!this.mediaGroupTimers.has(key)) {
				const timer = setTimeout(() => void this.flushMediaGroup(key), 600);
				timer.unref?.();
				this.mediaGroupTimers.set(key, timer);
			}
			return;
		}

		const result = await this.handleMessage({
			messageId: String(message.message_id),
			senderId: String(message.from.id),
			chatId,
			content: contentParts.join("\n"),
			attachments: attachments.length > 0 ? attachments : undefined,
			images: images.length > 0 ? images : undefined,
			metadata,
			sessionKeyOverride: sessionKey,
			isDm,
		});
		if (result.status === "accepted") {
			this.markTurnActive(chatId, message.message_id);
		}
	}

	/** Buffer a media group for a brief window, then forward it as one turn. */
	private async flushMediaGroup(key: string): Promise<void> {
		this.mediaGroupTimers.delete(key);
		const buffer = this.mediaGroups.get(key);
		this.mediaGroups.delete(key);
		if (!buffer) return;
		const result = await this.handleMessage({
			senderId: buffer.senderId,
			chatId: buffer.chatId,
			content: buffer.contents.join("\n"),
			attachments: buffer.attachments.length > 0 ? buffer.attachments : undefined,
			images: buffer.images.length > 0 ? buffer.images : undefined,
			metadata: buffer.metadata,
			sessionKeyOverride: buffer.sessionKey,
		});
		if (result.status === "accepted" && buffer.metadata.messageId) {
			this.markTurnActive(buffer.chatId, Number(buffer.metadata.messageId));
		}
	}

	/** Reply to a registered slash command; returns true when handled. */
	private async tryHandleCommand(text: string, chatId: number, isDm: boolean): Promise<boolean> {
		const match = /^\/([A-Za-z0-9_]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
		if (!match) return false;
		const command = match[1]!.toLowerCase();
		const handler = this.commands?.get(command);
		if (!handler) return false;
		try {
			const reply = await handler({ chatId, args: match[2]?.trim() ?? "", isDm });
			if (reply) await this.sendText(chatId, reply);
		} catch (error) {
			this.channelContext.logger?.error(`[telegram] command /${command} failed: ${formatError(error)}`);
		}
		return true;
	}

	/** Turn-activity markers: typing indicator + emoji reaction on the trigger. */
	private markTurnActive(chatId: string, messageId: number): void {
		this.startTyping(chatId);
		const emoji = this.config2.reactEmoji ?? "👀";
		if (emoji) {
			this.reactionTargets.set(chatId, messageId);
			void this.setReaction(chatId, messageId, emoji);
		}
	}

	/** Clear typing/reaction markers after a reply completes. */
	private clearTurnActive(chatId: string): void {
		this.stopTyping(chatId);
		const target = this.reactionTargets.get(chatId);
		this.reactionTargets.delete(chatId);
		if (target !== undefined) {
			void this.setReaction(chatId, target, "");
		}
	}

	private startTyping(chatId: string): void {
		if (this.config2.showTyping === false) return;
		if (this.typingLoops.has(chatId)) return;
		const intervalMs = this.config2.typingIntervalMs ?? 4000;
		const send = (): void => {
			try {
				const result = this.post(`${this.apiUrl}/sendChatAction`, {
					chat_id: Number(chatId),
					action: "typing",
				});
				void Promise.resolve(result).catch(() => undefined);
			} catch {
				// Best-effort typing indicator; failures are never fatal.
			}
		};
		send();
		const timer = setInterval(send, intervalMs);
		timer.unref?.();
		this.typingLoops.set(chatId, timer);
	}

	private stopTyping(chatId: string): void {
		const timer = this.typingLoops.get(chatId);
		if (timer) {
			clearInterval(timer);
			this.typingLoops.delete(chatId);
		}
	}

	/** Best-effort message reaction; empty emoji clears it. */
	private async setReaction(chatId: string, messageId: number, emoji: string): Promise<void> {
		try {
			await this.post(`${this.apiUrl}/setMessageReaction`, {
				chat_id: Number(chatId),
				message_id: messageId,
				reaction: emoji ? [{ type: "emoji", emoji }] : [],
			});
		} catch (error) {
			this.channelContext.logger?.debug(`[telegram] reaction failed: ${formatError(error)}`);
		}
	}

	private async processCallbackQuery(query: NonNullable<TelegramUpdate["callback_query"]>): Promise<void> {
		const label = query.data ?? "";
		const message = query.message;
		if (!message) return;
		await this.handleMessage({
			messageId: `cb_${query.id}`,
			senderId: String(query.from.id),
			chatId: String(message.chat.id),
			content: label,
			metadata: {
				chatType: message.chat.type ?? "private",
				button: true,
				callbackQueryId: query.id,
			},
		});
	}

	/** Whether the message entity mentions the bot (@username or direct reply). */
	private isMentioned(message: TelegramMessage): boolean {
		for (const entity of message.entities ?? []) {
			if (entity.type === "mention" && this.botUsername) {
				const offset = message.text?.slice(entity.offset, entity.offset + entity.length) ?? "";
				if (offset.toLowerCase() === `@${this.botUsername.toLowerCase()}`) return true;
			}
			if (entity.type === "text_mention" && entity.user && this.botUsername === undefined) {
				// text_mention carries a user id; without a resolved username we
				// cannot match the bot — treated as unmentioned.
				void entity.user;
			}
		}
		if (message.reply_to_message && this.botUsername) {
			const replied = message.reply_to_message.from;
			if (replied && replied.username?.toLowerCase() === this.botUsername.toLowerCase()) return true;
		}
		return false;
	}

	private async downloadImage(fileId: string): Promise<{ type: "image"; data: string; mimeType: string } | undefined> {
		try {
			const bytes = await this.downloadFile(fileId);
			if (!bytes) return undefined;
			const mimeType = sniffImageMime(bytes);
			return { type: "image", data: Buffer.from(bytes).toString("base64"), mimeType };
		} catch (error) {
			this.channelContext.logger?.error(`[telegram] image download failed: ${formatError(error)}`);
			return undefined;
		}
	}

	private async transcribeMessageMedia(fileId: string, mimeType: string): Promise<string> {
		if (!this.channelContext.transcriber) return "";
		try {
			const bytes = await this.downloadFile(fileId);
			if (!bytes) return "";
			const text = await this.transcribeAudio(bytes, mimeType);
			return text ? `[transcription]\n${text}` : "";
		} catch (error) {
			this.channelContext.logger?.error(`[telegram] transcription failed: ${formatError(error)}`);
			return "";
		}
	}

	private async downloadMediaSource(fileId: string): Promise<string> {
		const bytes = await this.downloadFile(fileId);
		if (!bytes) return fileId;
		return `data:application/octet-stream;base64,${Buffer.from(bytes).toString("base64")}`;
	}

	private async downloadFile(fileId: string): Promise<Uint8Array | undefined> {
		const response = await this.get(`${this.apiUrl}/getFile?file_id=${encodeURIComponent(fileId)}`);
		if (!response.ok) return undefined;
		const data = (await response.json()) as { ok?: boolean; result?: { file_path?: string } };
		const filePath = data.result?.file_path;
		if (!filePath) return undefined;
		const fileResponse = await this.fetchFn(`${this.apiBaseUrl}/file/bot${this.config2.token ?? ""}/${filePath}`);
		if (!fileResponse.ok) return undefined;
		return new Uint8Array(await fileResponse.arrayBuffer());
	}

	override get mediaCapabilities(): ChannelMediaCapabilities {
		return { kinds: ["image", "video", "audio", "file"], urlDirect: true, maxBytes: 50 * 1024 * 1024 };
	}

	async send(message: OutboundMessage): Promise<ChannelSendResult> {
		const chatId = Number(message.chatId);
		const replyTo = this.config2.replyToMessage !== false && message.replyTo ? Number(message.replyTo) : undefined;
		const failedMedia: string[] = [];
		let providerMessageId: string | undefined;
		for (const item of this.collectOutboundMedia(message)) {
			try {
				providerMessageId = await this.sendMediaItem(item, chatId, replyTo);
			} catch (error) {
				this.channelContext.logger?.error(
					`[telegram] media send failed source=${item.source}: ${formatError(error)}`,
				);
				failedMedia.push(item.filename ?? item.source);
			}
		}
		let content = withMediaFailureNote(message.content, failedMedia);
		if (message.buttons && message.buttons.length > 0) {
			content = this.renderButtons(message.buttons, content);
		}
		if (content) {
			providerMessageId = await this.sendContent(chatId, content, replyTo, message.buttons);
		}
		this.clearTurnActive(String(chatId));
		return failedMedia.length > 0
			? { status: "partial", providerMessageId, detail: `media failed: ${failedMedia.join(", ")}` }
			: { status: "success", providerMessageId };
	}

	/**
	 * Send text with markdown→HTML rendering (tables, code fences, inline
	 * formatting). HTML is best-effort: on any parse failure the plain text
	 * is sent instead so nothing user-visible is lost.
	 */
	private async sendContent(
		chatId: number,
		content: string,
		replyTo?: number,
		buttons?: string[][],
	): Promise<string | undefined> {
		const rendered = renderTelegramHtml(content);
		if (rendered.changed) {
			try {
				return await this.sendText(chatId, rendered.html, replyTo, buttons, "HTML");
			} catch (error) {
				this.channelContext.logger?.debug(
					`[telegram] HTML send failed, falling back to plain: ${formatError(error)}`,
				);
			}
		}
		return this.sendText(chatId, content, replyTo, buttons);
	}

	/** Buttons degrade to bracketed labels when keyboards are disabled. */
	private renderButtons(buttons: string[][], content: string): string {
		if (this.config2.inlineKeyboards !== false) return content;
		const rows = buttons.map((row) => row.map((label) => `[${label}]`).join(" ")).join("\n");
		return content ? `${content}\n\n${rows}` : rows;
	}

	private async sendText(
		chatId: number,
		text: string,
		replyTo?: number,
		buttons?: string[][],
		parseMode?: string,
	): Promise<string | undefined> {
		const body: Record<string, unknown> = {
			chat_id: chatId,
			text,
		};
		if (replyTo !== undefined) body.reply_to_message_id = replyTo;
		if (parseMode !== undefined) body.parse_mode = parseMode;
		if (buttons && buttons.length > 0 && this.config2.inlineKeyboards !== false) {
			body.reply_markup = { inline_keyboard: toInlineKeyboard(buttons) };
		}
		const response = await this.post(`${this.apiUrl}/sendMessage`, body);
		if (!response.ok) {
			throw new Error(`telegram sendMessage failed: ${response.status}`);
		}
		const result = (await response.json()) as { result?: { message_id?: number } };
		return result.result?.message_id === undefined ? undefined : String(result.result.message_id);
	}

	private async sendMediaItem(item: ChannelAttachment, chatId: number, replyTo?: number): Promise<string | undefined> {
		const method = TELEGRAM_MEDIA_METHOD[item.kind] ?? "sendDocument";
		const param = TELEGRAM_MEDIA_PARAM[item.kind] ?? "document";
		// Telegram Bot API accepts HTTP(S) URLs directly for media parameters.
		if (isHttpUrl(item.source)) {
			const body: Record<string, unknown> = { chat_id: chatId, [param]: item.source };
			if (replyTo !== undefined) body.reply_to_message_id = replyTo;
			const response = await this.post(`${this.apiUrl}/${method}`, body);
			if (!response.ok) {
				throw new Error(`telegram ${method} failed: ${response.status}`);
			}
			const result = (await response.json()) as { result?: { message_id?: number } };
			return result.result?.message_id === undefined ? undefined : String(result.result.message_id);
		}
		const media = await resolveOutboundMedia(item, {
			fetchFn: this.fetchFn,
			maxBytes: this.mediaCapabilities.maxBytes,
		});
		const form = new FormData();
		form.append("chat_id", String(chatId));
		if (replyTo !== undefined) form.append("reply_to_message_id", String(replyTo));
		form.append(param, new Blob([media.data], { type: media.mimeType }), media.filename);
		const response = await this.fetchFn(`${this.apiUrl}/${method}`, { method: "POST", body: form });
		if (!response.ok) {
			throw new Error(`telegram ${method} failed: ${response.status}`);
		}
		const result = (await response.json()) as { result?: { message_id?: number } };
		return result.result?.message_id === undefined ? undefined : String(result.result.message_id);
	}

	// ------------------------------------------------------------------
	// Streaming (progressive message editing, nanobot-style)
	// ------------------------------------------------------------------

	async sendDelta(delta: OutboundDelta): Promise<void> {
		const chatId = Number(delta.chatId);
		if (!Number.isSafeInteger(chatId)) return;
		const streamId = delta.streamId;
		const isEnd = delta.event?.kind === "stream_end" || delta.streamEnd === true;
		const resuming = delta.event?.kind === "stream_end" && (delta.event as { resuming?: boolean }).resuming === true;
		const mergeNext =
			delta.event?.kind === "stream_end" && (delta.event as { mergeNext?: boolean }).mergeNext === true;

		if (isEnd && mergeNext) {
			if (!delta.delta) return;
		}
		if (isEnd && !mergeNext) {
			const buf = this.streamBufs.get(delta.chatId);
			if (!buf || buf.messageId === undefined || !buf.text) return;
			if (streamId !== undefined && buf.streamId !== undefined && buf.streamId !== streamId) return;
			this.streamBufs.delete(delta.chatId);
			this.clearTurnActive(delta.chatId);
			await this.finalizeStream(chatId, buf.messageId, buf.text);
			return;
		}
		if (resuming) {
			// A resuming segment belongs to a previous stream; without the
			// original buffer there is nothing to append to — send fresh.
			if (!this.streamBufs.has(delta.chatId)) {
				await this.sendStreamFirst(chatId, delta.delta, streamId);
			}
			return;
		}

		let buf = this.streamBufs.get(delta.chatId);
		if (buf === undefined || (streamId !== undefined && buf.streamId !== undefined && buf.streamId !== streamId)) {
			buf = { text: "", streamId, lastEditAt: 0 };
			this.streamBufs.set(delta.chatId, buf);
		} else if (buf.streamId === undefined && streamId !== undefined) {
			buf.streamId = streamId;
		}
		buf.text += delta.delta;
		if (!buf.text.trim()) return;

		const now = Date.now();
		const editInterval = this.config2.streamEditIntervalMs ?? 600;
		const maxLength = this.config2.maxStreamLength ?? 4000;
		if (buf.messageId === undefined) {
			await this.sendStreamFirst(chatId, buf.text, streamId);
			buf.lastEditAt = now;
			return;
		}
		if (now - buf.lastEditAt < editInterval) return;
		if (buf.text.length > maxLength) {
			await this.flushStreamOverflow(chatId, buf);
			buf.lastEditAt = now;
			return;
		}
		await this.editStreamMessage(chatId, buf.messageId, buf.text);
		buf.lastEditAt = now;
	}

	private async sendStreamFirst(chatId: number, text: string, streamId?: string): Promise<void> {
		const sent = await this.sendText(chatId, text);
		const buf = this.streamBufs.get(String(chatId));
		if (sent) {
			this.streamBufs.set(String(chatId), {
				messageId: Number(sent),
				text,
				streamId,
				lastEditAt: Date.now(),
			});
		} else if (buf) {
			buf.text = text;
			buf.streamId = streamId;
		}
	}

	/** Edit the streaming message; "message is not modified" is a silent no-op. */
	private async editStreamMessage(chatId: number, messageId: number, text: string, parseMode?: string): Promise<void> {
		const body: Record<string, unknown> = { chat_id: chatId, message_id: messageId, text };
		if (parseMode !== undefined) body.parse_mode = parseMode;
		const response = await this.post(`${this.apiUrl}/editMessageText`, body);
		if (response.ok) return;
		if (response.status === 400) {
			try {
				const data = (await response.json()) as { description?: string };
				if (data.description?.toLowerCase().includes("message is not modified")) return;
			} catch {
				// Fall through to the error path below.
			}
		}
		throw new Error(`telegram editMessageText failed: ${response.status}`);
	}

	/** Split an oversized stream mid-flight: edit the head, send the tail. */
	private async flushStreamOverflow(chatId: number, buf: TelegramStreamBuf): Promise<void> {
		const maxLength = this.config2.maxStreamLength ?? 4000;
		const text = buf.text;
		if (text.length <= maxLength || buf.messageId === undefined) return;
		const head = text.slice(0, maxLength);
		const tail = text.slice(maxLength);
		try {
			await this.editStreamMessage(chatId, buf.messageId, head);
		} catch {
			// Head edit failure is tolerated; the tail still gets delivered.
		}
		const sent = await this.sendText(chatId, tail);
		buf.text = tail;
		buf.messageId = sent === undefined ? buf.messageId : Number(sent);
	}

	private async finalizeStream(chatId: number, messageId: number, text: string): Promise<void> {
		// The final edit renders markdown→HTML (safe on the complete text);
		// a parse failure falls back to plain, then to a fresh message.
		const rendered = renderTelegramHtml(text);
		try {
			await this.editStreamMessage(
				chatId,
				messageId,
				rendered.changed ? rendered.html : text,
				rendered.changed ? "HTML" : undefined,
			);
		} catch (error) {
			try {
				await this.editStreamMessage(chatId, messageId, text);
			} catch {
				// Final edit failed: send the complete text as a new message so the
				// user still receives the answer.
				this.channelContext.logger?.warn(`[telegram] final stream edit failed, resending: ${formatError(error)}`);
				await this.sendText(chatId, text);
			}
		}
	}

	// ------------------------------------------------------------------
	// Reasoning: accumulated and rendered as an expandable blockquote
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
			// Telegram expandable blockquote keeps reasoning subordinate.
			await this.sendText(
				Number(chatId),
				`<blockquote expandable>${escapeHtml(text.trim())}</blockquote>`,
				undefined,
				undefined,
				"HTML",
			);
		}
	}
}

function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Render a markdown-ish message as Telegram HTML (nanobot-style): fenced code
 * blocks, inline code, bold/italic/strikethrough, links, and boxed tables.
 * Returns whether any markup was produced so callers can fall back to plain.
 */
function renderTelegramHtml(text: string): { html: string; changed: boolean } {
	if (!text) return { html: "", changed: false };
	const fences: string[] = [];
	const tables: string[] = [];
	// Fenced code blocks are extracted first so inline rules never touch them.
	let working = text.replace(/```([A-Za-z0-9_+-]*)\n?([\s\S]*?)```/g, (_match, lang: string, code: string) => {
		const langAttr = lang ? ` class="language-${lang}"` : "";
		fences.push(`<pre><code${langAttr}>${escapeHtml(code.replace(/\n$/, ""))}</code></pre>`);
		return `\u0000F${fences.length - 1}\u0000`;
	});
	// Consecutive table lines render as a monospace box (content preserved).
	working = working.replace(/^((?:\|.*(?:\n|$))+)/gm, (match) => {
		tables.push(`<pre>${escapeHtml(match.replace(/\n$/, ""))}</pre>`);
		return `\u0000T${tables.length - 1}\u0000`;
	});
	working = escapeHtml(working)
		.replace(/`([^`\n]+)`/g, "<code>$1</code>")
		.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>')
		.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
		.replace(/~~([^~\n]+)~~/g, "<s>$1</s>")
		.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<i>$2</i>");
	working = working
		.replace(/\u0000F(\d+)\u0000/g, (_match, index: string) => fences[Number(index)] ?? "")
		.replace(/\u0000T(\d+)\u0000/g, (_match, index: string) => tables[Number(index)] ?? "");
	return { html: working, changed: working !== escapeHtml(text) };
}

/** Built-in slash commands; hosts can supply their own registry. */
function defaultTelegramCommands(): TelegramCommandRegistry {
	const handlers: Record<string, TelegramCommandHandler> = {
		start: (_context) =>
			"Hello! I'm a bot running on the cogito gateway. Send me a message and I'll answer, or use /help for commands.",
		help: (_context) => "Available commands:\n/start — say hello\n/help — this list",
	};
	return { get: (command) => handlers[command] };
}

function toInlineKeyboard(buttons: string[][]): Array<Array<{ text: string; callback_data: string }>> {
	return buttons.map((row) =>
		row.map((label) => {
			const value = label.slice(0, 64);
			return { text: value, callback_data: value };
		}),
	);
}

const TELEGRAM_MEDIA_METHOD: Record<string, string> = {
	image: "sendPhoto",
	video: "sendVideo",
	audio: "sendAudio",
	file: "sendDocument",
};

const TELEGRAM_MEDIA_PARAM: Record<string, string> = {
	image: "photo",
	video: "video",
	audio: "audio",
	file: "document",
};

function sniffImageMime(bytes: Uint8Array): string {
	if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
	if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
		return "image/png";
	}
	if (bytes.length > 3 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif";
	if (bytes.length > 11 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) {
		return "image/webp";
	}
	return "image/jpeg";
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
