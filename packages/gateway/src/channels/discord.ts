/**
 * DiscordChannel — Gateway WebSocket + REST API, zero-dependency.
 *
 * Connects to the Discord gateway (v10), sends IDENTIFY with the bot token,
 * heartbeats on the server-provided interval, listens for MESSAGE_CREATE /
 * INTERACTION_CREATE / THREAD_* events, and replies via
 * POST /channels/{id}/messages. Supports slash commands (registered on the
 * application, answered ephemeral), message component callbacks, read-receipt
 * + working emoji reactions, typing indicators, thread sessions scoped to
 * their parent channel, and channel/category/guild allowlists.
 *
 * chatId convention: Discord channel id.
 */

import type { MessageBus } from "../bus.ts";
import { type ChannelMediaCapabilities, resolveOutboundMedia, withMediaFailureNote } from "../media.ts";
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

export interface DiscordConfig extends ChannelConfig {
	token?: string;
	/** API base. Default https://discord.com/api/v10. */
	apiBase?: string;
	/** Reconnect delay in ms. Default 5000. */
	reconnectDelayMs?: number;
	/** Channel ids that may trigger the bot (channel, parent category, or guild id). Empty = all. */
	allowChannels?: string[];
	/** Guild group policy (nanobot parity): "mention" (default) or "open". */
	groupPolicy?: "open" | "mention";
	/** Read-receipt emoji added on inbound. Empty disables. Default "👀". */
	readReceiptEmoji?: string;
	/** Delayed working emoji. Empty disables. Default "🔧". */
	workingEmoji?: string;
	/** Delay before the working emoji, ms. Default 2000. */
	workingEmojiDelayMs?: number;
	/** Send the typing indicator while a turn is active. Default true. */
	showTyping?: boolean;
	/** Maximum inbound attachment size in bytes. Default 20MiB. */
	maxAttachmentBytes?: number;
}

/** Slash command definition resolved through the registry. */
export interface DiscordCommandDefinition {
	description: string;
	/** Produce the command text forwarded to the agent (e.g. "/model default"). */
	handle: (context: DiscordCommandContext) => string | Promise<string>;
}

export interface DiscordCommandContext {
	chatId: string;
	args: string[];
	isDm: boolean;
	guildId?: string;
}

export interface DiscordCommandRegistry {
	get(name: string): DiscordCommandDefinition | undefined;
	list(): Array<[string, DiscordCommandDefinition]>;
}

/** GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT */
const INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15);

const MAX_CHANNEL_CACHE = 1024;

interface DiscordChannelMeta {
	guildId?: string;
	parentId?: string;
}

interface DiscordAttachment {
	id?: string;
	url?: string;
	filename?: string;
	size?: number;
	content_type?: string;
}

interface DiscordGatewayData {
	heartbeat_interval?: number;
	session_id?: string;
	resume_gateway_url?: string;
	channel_id?: string;
	guild_id?: string;
	author?: { id?: string; bot?: boolean };
	content?: string;
	id?: string;
	mentions?: Array<{ id?: string }>;
	attachments?: DiscordAttachment[];
	type?: number;
	message_reference?: { message_id?: string };
	user?: { id?: string };
	parent_id?: string;
	/** INTERACTION_CREATE payload fields (the event data IS the interaction). */
	interaction_type?: number;
	token?: string;
	member?: { user?: { id?: string } };
	data?: { name?: string; custom_id?: string; options?: Array<{ value?: unknown }> };
}

interface DiscordInteractionData {
	id?: string;
	token?: string;
	type?: number;
	channel_id?: string;
	guild_id?: string;
	user?: { id?: string };
	member?: { user?: { id?: string } };
	data?: { name?: string; custom_id?: string; options?: Array<{ value?: unknown }> };
}

interface GatewayEnvelope {
	op?: number;
	t?: string;
	d?: DiscordGatewayData | boolean;
	s?: number;
}

interface DiscordReactionTarget {
	messageId: string;
	emojis: string[];
}

export class DiscordChannel extends BaseChannel {
	name = "discord";
	displayName = "Discord";

	private readonly cfg: DiscordConfig;
	private readonly socket: WsLike;
	private readonly fetchFn: typeof fetch;
	private readonly commands: DiscordCommandRegistry | undefined;
	private heartbeatTimer: NodeJS.Timeout | undefined;
	private sequence: number | undefined;
	private sessionId: string | undefined;
	private resumeGatewayUrl: string | undefined;
	private botUserId: string | undefined;
	private appId: string | undefined;
	private readonly channelMeta = new Map<string, DiscordChannelMeta>();
	private readonly typingLoops = new Map<string, NodeJS.Timeout>();
	private readonly reactionTargets = new Map<string, DiscordReactionTarget>();
	private readonly workingTimers = new Map<string, NodeJS.Timeout>();

	constructor(
		config: ChannelConfig | undefined,
		bus: MessageBus,
		options: {
			socket?: WsLike;
			fetchFn?: typeof fetch;
			commands?: DiscordCommandRegistry;
		} = {},
	) {
		super(config, bus);
		this.cfg = (config ?? {}) as DiscordConfig;
		this.socket = options.socket ?? new GenericWsClient();
		this.fetchFn = options.fetchFn ?? fetch;
		this.commands = options.commands ?? defaultDiscordCommands();
		// Discord group messages require a mention unless the policy is open
		// (nanobot default group_policy="mention").
		if (this.config.group?.mode === undefined) {
			const policy = this.cfg.groupPolicy ?? "mention";
			this.config.group = { ...this.config.group, mode: policy };
		}
	}

	async start(context?: ChannelContext): Promise<void> {
		if (this.running) return;
		if (context) this.bindContext(context);
		this.restoreResumeState();
		this.running = true;
		void this.resolveIdentity();
		void this.syncCommands();
		void this.loop();
	}

	async stop(): Promise<void> {
		this.running = false;
		if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
		this.heartbeatTimer = undefined;
		this.socket.close();
		for (const timer of this.typingLoops.values()) clearInterval(timer);
		this.typingLoops.clear();
		this.reactionTargets.clear();
		for (const timer of this.workingTimers.values()) clearTimeout(timer);
		this.workingTimers.clear();
	}

	// ------------------------------------------------------------------
	// Gateway connection
	// ------------------------------------------------------------------

	private async gatewayUrl(): Promise<string> {
		const response = await this.api("/gateway");
		const body = (await response.json()) as { url?: string };
		const url = body.url ?? "wss://gateway.discord.gg";
		return withGatewayQuery(url);
	}

	private async api(path: string, init: RequestInit = {}): Promise<Response> {
		const base = this.cfg.apiBase ?? "https://discord.com/api/v10";
		return this.fetchFn(`${base}${path}`, {
			...init,
			headers: {
				Authorization: `Bot ${this.cfg.token ?? ""}`,
				...(init.headers ?? {}),
			},
		});
	}

	/** Resolve the bot user and application ids (best effort). */
	private async resolveIdentity(): Promise<void> {
		try {
			const userResponse = await this.api("/users/@me");
			if (userResponse.ok) {
				const body = (await userResponse.json()) as { id?: string };
				if (body.id) this.botUserId = body.id;
			}
			const appResponse = await this.api("/oauth2/applications/@me");
			if (appResponse.ok) {
				const body = (await appResponse.json()) as { id?: string };
				if (body.id) this.appId = body.id;
			}
		} catch (error) {
			this.channelContext.logger?.warn(`[discord] identity resolution failed: ${formatError(error)}`);
		}
	}

	/** Register the command registry on the application (best effort). */
	private async syncCommands(): Promise<void> {
		const commands = this.commands?.list() ?? [];
		if (commands.length === 0) return;
		try {
			if (!this.appId) {
				const response = await this.api("/oauth2/applications/@me");
				if (!response.ok) return;
				const body = (await response.json()) as { id?: string };
				if (!body.id) return;
				this.appId = body.id;
			}
			const payload = commands.map(([name, definition]) => ({
				name,
				description: definition.description.slice(0, 100),
			}));
			const response = await this.api(`/applications/${this.appId}/commands`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
			});
			if (!response.ok) {
				this.channelContext.logger?.warn(
					`[discord] command sync failed: ${response.status} ${await response.text()}`,
				);
			}
		} catch (error) {
			this.channelContext.logger?.warn(`[discord] command sync failed: ${formatError(error)}`);
		}
	}

	private async loop(): Promise<void> {
		while (this.running) {
			try {
				const url = this.resumeGatewayUrl ? withGatewayQuery(this.resumeGatewayUrl) : await this.gatewayUrl();
				await this.socket.connect(url);
				this.socket.onMessage(
					(text) =>
						void this.handlePayload(text).catch((error: unknown) => {
							this.channelContext.logger?.error(`[discord] event processing failed: ${formatError(error)}`);
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
			await new Promise((resolve) => setTimeout(resolve, this.cfg.reconnectDelayMs ?? 5000));
		}
	}

	private async handlePayload(text: string): Promise<void> {
		let envelope: GatewayEnvelope;
		try {
			envelope = JSON.parse(text) as GatewayEnvelope;
		} catch {
			return;
		}
		if (envelope.op === 10) {
			const interval = (isGatewayData(envelope.d) ? envelope.d.heartbeat_interval : undefined) ?? 41_250;
			this.socket.send(JSON.stringify(this.resumePayload()));
			this.heartbeatTimer = setInterval(() => {
				this.socket.send(JSON.stringify({ op: 1, d: Date.now() }));
			}, interval);
			return;
		}
		if (envelope.op === 1) {
			this.socket.send(JSON.stringify({ op: 1, d: Date.now() }));
			return;
		}
		if (envelope.op === 7) {
			this.socket.close();
			return;
		}
		if (envelope.op === 9) {
			if (envelope.d !== true) this.clearResumeState();
			this.socket.close();
			return;
		}
		if (envelope.op === 0) {
			const data = envelope.d;
			if (envelope.t === "MESSAGE_CREATE" && isGatewayData(data)) {
				await this.handleMessageCreate(data);
			}
			if (envelope.t === "INTERACTION_CREATE" && isGatewayData(data)) {
				await this.handleInteraction(data as unknown as DiscordInteractionData);
			}
			if (envelope.t === "THREAD_CREATE" || envelope.t === "THREAD_UPDATE") {
				if (isGatewayData(data) && data.id) {
					this.rememberChannel(data.id, { guildId: data.guild_id, parentId: data.parent_id });
				}
			}
			if (envelope.t === "THREAD_DELETE") {
				if (isGatewayData(data) && data.id) this.channelMeta.delete(data.id);
			}
			if (envelope.t === "READY") {
				this.sessionId = isGatewayData(data) ? data.session_id : undefined;
				this.resumeGatewayUrl = isGatewayData(data) ? data.resume_gateway_url : undefined;
				if (isGatewayData(data) && data.user?.id) this.botUserId = data.user.id;
				this.persistResumeState();
			}
			if (envelope.s !== undefined) {
				this.sequence = envelope.s;
				this.channelContext.offsetStore?.set(this.name, "sequence", String(envelope.s));
			}
		}
	}

	// ------------------------------------------------------------------
	// Inbound: messages, interactions, threads
	// ------------------------------------------------------------------

	private async handleMessageCreate(data: DiscordGatewayData): Promise<void> {
		if (!data.channel_id || typeof data.content !== "string") return;
		// Self-loop guard only: messages from other bots are allowed through so
		// multi-agent setups work (nanobot semantics).
		if (this.botUserId !== undefined && data.author?.id === this.botUserId) return;
		const messageType = data.type ?? 0;
		if (messageType !== 0 && messageType !== 19) return; // System messages carry no prompt.

		const senderId = data.author?.id ?? "unknown";
		const chatId = data.channel_id;
		const isDm = data.guild_id === undefined || data.guild_id === null;
		const metadata: Record<string, unknown> = {
			messageId: data.id,
			chatType: isDm ? "private" : "group",
			mentionedBot:
				this.botUserId !== undefined &&
				Array.isArray(data.mentions) &&
				data.mentions.some((mention) => mention.id === this.botUserId),
		};
		if (data.guild_id) metadata.guildId = data.guild_id;
		if (data.message_reference?.message_id) metadata.replyMessageId = data.message_reference.message_id;

		let channelInfo: DiscordChannelMeta | undefined;
		if (!isDm) channelInfo = await this.resolveChannel(chatId);
		let sessionKey: string | undefined;
		if (channelInfo?.parentId) {
			metadata.parentChannelId = channelInfo.parentId;
			metadata.threadId = chatId;
			sessionKey = `discord:${channelInfo.parentId}:thread:${chatId}`;
		}
		if (!(await this.isChannelAllowed(chatId, senderId, channelInfo))) return;

		const attachments: ChannelAttachment[] = [];
		const images: ImageAttachment[] = [];
		for (const attachment of data.attachments ?? []) {
			const downloaded = await this.downloadAttachment(attachment);
			if (!downloaded) continue;
			if (downloaded.kind === "image") images.push(downloaded.image);
			else attachments.push(downloaded.attachment);
		}

		const result = await this.handleMessage({
			messageId: data.id,
			senderId,
			chatId,
			content: data.content,
			attachments: attachments.length > 0 ? attachments : undefined,
			images: images.length > 0 ? images : undefined,
			metadata,
			sessionKeyOverride: sessionKey,
			isDm,
		});
		if (result.status === "accepted" && data.id) {
			this.markTurnActive(chatId, data.id);
		}
	}

	private async handleInteraction(interaction: DiscordInteractionData): Promise<void> {
		const senderId = interaction.user?.id ?? interaction.member?.user?.id;
		const chatId = interaction.channel_id;
		if (!senderId || !chatId || !interaction.id || !interaction.token) return;
		const isDm = interaction.guild_id === undefined || interaction.guild_id === null;
		const channelInfo = isDm ? undefined : await this.resolveChannel(chatId);
		let sessionKey: string | undefined;
		if (channelInfo?.parentId) sessionKey = `discord:${channelInfo.parentId}:thread:${chatId}`;

		if (!this.isAllowed(senderId) || !(await this.isChannelAllowed(chatId, senderId, channelInfo))) {
			await this.ackInteraction(interaction.id, interaction.token, "You are not allowed to use this bot.");
			return;
		}

		if (interaction.type === 3) {
			// Message component (button/select): acknowledge and forward the id.
			await this.ackDeferred(interaction.id, interaction.token);
			const customId = interaction.data?.custom_id ?? "";
			await this.handleMessage({
				messageId: `interaction_${interaction.id}`,
				senderId,
				chatId,
				content: customId,
				metadata: {
					button: true,
					interactionId: interaction.id,
					chatType: isDm ? "private" : "group",
				},
				sessionKeyOverride: sessionKey,
				isDm,
			});
			return;
		}

		if (interaction.type !== 2) return; // Not an application command.
		const name = interaction.data?.name ?? "";
		const args = (interaction.data?.options ?? []).map((option) => String(option.value ?? ""));
		const definition = this.commands?.get(name);
		let text = `/${name}`;
		if (definition) {
			try {
				text = await definition.handle({ chatId, args, isDm, guildId: interaction.guild_id });
			} catch (error) {
				this.channelContext.logger?.warn(`[discord] slash command /${name} failed: ${formatError(error)}`);
				await this.ackInteraction(interaction.id, interaction.token, `Command /${name} failed.`);
				return;
			}
		}
		await this.ackInteraction(interaction.id, interaction.token, "Processing...");
		await this.handleMessage({
			messageId: `interaction_${interaction.id}`,
			senderId,
			chatId,
			content: text,
			metadata: {
				isSlashCommand: true,
				interactionId: interaction.id,
				guildId: interaction.guild_id,
				chatType: isDm ? "private" : "group",
			},
			sessionKeyOverride: sessionKey,
			isDm,
		});
	}

	/** Channel/category/guild allowlist (nanobot _channel_allow_keys). */
	private async isChannelAllowed(
		chatId: string,
		senderId: string,
		channelInfo?: DiscordChannelMeta,
	): Promise<boolean> {
		if (!this.isAllowed(senderId)) return false;
		const allow = this.cfg.allowChannels;
		if (!allow || allow.length === 0 || allow.includes("*")) return true;
		const info = channelInfo ?? (await this.resolveChannel(chatId));
		const keys = [chatId, info?.parentId, info?.guildId].filter((key): key is string => key !== undefined);
		return keys.some((key) => allow.includes(key));
	}

	/** Resolve channel metadata from cache, then REST (best effort). */
	private async resolveChannel(chatId: string): Promise<DiscordChannelMeta | undefined> {
		const cached = this.channelMeta.get(chatId);
		if (cached) return cached;
		try {
			const response = await this.api(`/channels/${encodeURIComponent(chatId)}`);
			if (!response.ok) return undefined;
			const body = (await response.json()) as { guild_id?: string; parent_id?: string };
			const info: DiscordChannelMeta = { guildId: body.guild_id, parentId: body.parent_id };
			this.rememberChannel(chatId, info);
			return info;
		} catch (error) {
			this.channelContext.logger?.debug(`[discord] channel ${chatId} lookup failed: ${formatError(error)}`);
			return undefined;
		}
	}

	private rememberChannel(chatId: string, info: DiscordChannelMeta): void {
		if (this.channelMeta.size >= MAX_CHANNEL_CACHE) {
			const oldest = this.channelMeta.keys().next().value;
			if (oldest !== undefined) this.channelMeta.delete(oldest);
		}
		this.channelMeta.set(chatId, info);
	}

	private async downloadAttachment(
		attachment: DiscordAttachment,
	): Promise<{ kind: "image"; image: ImageAttachment } | { kind: "file"; attachment: ChannelAttachment } | undefined> {
		const filename = attachment.filename ?? "attachment";
		const maxBytes = this.cfg.maxAttachmentBytes ?? 20 * 1024 * 1024;
		if (!attachment.url || (attachment.size ?? 0) > maxBytes) return undefined;
		try {
			const response = await this.fetchFn(attachment.url);
			if (!response.ok) return undefined;
			const data = new Uint8Array(await response.arrayBuffer());
			if (data.byteLength > maxBytes) return undefined;
			const mimeType = sniffImageMime(data);
			if (mimeType !== "application/octet-stream") {
				return { kind: "image", image: { type: "image", data: toBase64(data), mimeType } };
			}
			return {
				kind: "file",
				attachment: {
					kind: "file",
					source: `data:${attachment.content_type ?? "application/octet-stream"};base64,${toBase64(data)}`,
					filename,
					mimeType: attachment.content_type,
					sizeBytes: data.byteLength,
				},
			};
		} catch (error) {
			this.channelContext.logger?.debug(`[discord] attachment download failed: ${formatError(error)}`);
			return undefined;
		}
	}

	// ------------------------------------------------------------------
	// Turn activity: typing, read receipt + working emoji
	// ------------------------------------------------------------------

	private markTurnActive(chatId: string, messageId: string): void {
		this.startTyping(chatId);
		const readEmoji = this.cfg.readReceiptEmoji ?? "👀";
		const workingEmoji = this.cfg.workingEmoji ?? "🔧";
		const emojis: string[] = [];
		if (readEmoji) {
			emojis.push(readEmoji);
			void this.setReaction(chatId, messageId, readEmoji, true);
		}
		if (workingEmoji) {
			emojis.push(workingEmoji);
			const delay = this.cfg.workingEmojiDelayMs ?? 2000;
			if (delay > 0) {
				const timer = setTimeout(() => {
					this.workingTimers.delete(chatId);
					const target = this.reactionTargets.get(chatId);
					if (target && target.messageId === messageId)
						void this.setReaction(chatId, messageId, workingEmoji, true);
				}, delay);
				timer.unref?.();
				this.workingTimers.set(chatId, timer);
			}
		}
		this.reactionTargets.set(chatId, { messageId, emojis });
	}

	private clearTurnActive(chatId: string): void {
		this.stopTyping(chatId);
		const timer = this.workingTimers.get(chatId);
		if (timer) {
			clearTimeout(timer);
			this.workingTimers.delete(chatId);
		}
		const target = this.reactionTargets.get(chatId);
		this.reactionTargets.delete(chatId);
		if (target) {
			for (const emoji of target.emojis) void this.setReaction(chatId, target.messageId, emoji, false);
		}
	}

	private startTyping(chatId: string): void {
		if (this.cfg.showTyping === false) return;
		if (this.typingLoops.has(chatId)) return;
		const send = (): void => {
			try {
				const result = this.api(`/channels/${encodeURIComponent(chatId)}/typing`, { method: "POST" });
				void Promise.resolve(result).catch(() => undefined);
			} catch {
				// Best-effort typing indicator.
			}
		};
		send();
		const timer = setInterval(send, 8000);
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

	/** Add or remove an emoji reaction on a message (best effort). */
	private async setReaction(chatId: string, messageId: string, emoji: string, add: boolean): Promise<void> {
		try {
			const path = `/channels/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}/reactions/${encodeURIComponent(emoji)}/@me`;
			const response = await this.api(path, add ? { method: "PUT" } : { method: "DELETE" });
			if (!response.ok && add) {
				this.channelContext.logger?.debug(`[discord] reaction failed: ${response.status}`);
			}
		} catch (error) {
			this.channelContext.logger?.debug(`[discord] reaction failed: ${formatError(error)}`);
		}
	}

	// ------------------------------------------------------------------
	// Interaction acknowledgements (ephemeral)
	// ------------------------------------------------------------------

	/** Respond with an ephemeral channel message. */
	private async ackInteraction(id: string, token: string, content: string): Promise<void> {
		try {
			await this.api(`/interactions/${id}/${token}/callback`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ type: 4, data: { content, flags: 64 } }),
			});
		} catch (error) {
			this.channelContext.logger?.debug(`[discord] interaction ack failed: ${formatError(error)}`);
		}
	}

	/** Acknowledge a component interaction without a visible reply. */
	private async ackDeferred(id: string, token: string): Promise<void> {
		try {
			await this.api(`/interactions/${id}/${token}/callback`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ type: 6 }),
			});
		} catch (error) {
			this.channelContext.logger?.debug(`[discord] interaction ack failed: ${formatError(error)}`);
		}
	}

	// ------------------------------------------------------------------
	// Resume state
	// ------------------------------------------------------------------

	private resumePayload(): { op: number; d: Record<string, unknown> } {
		if (this.sessionId && this.sequence !== undefined) {
			return {
				op: 6,
				d: { token: this.cfg.token ?? "", session_id: this.sessionId, seq: this.sequence },
			};
		}
		return {
			op: 2,
			d: {
				token: this.cfg.token ?? "",
				intents: INTENTS,
				properties: { os: "linux", browser: "agent-gateway", device: "agent-gateway" },
			},
		};
	}

	private restoreResumeState(): void {
		const store = this.channelContext.offsetStore;
		this.sessionId = store?.get(this.name, "sessionId") || undefined;
		this.resumeGatewayUrl = store?.get(this.name, "resumeGatewayUrl") || undefined;
		const savedSequence = store?.get(this.name, "sequence");
		const sequence = savedSequence === undefined ? undefined : Number(savedSequence);
		this.sequence = sequence !== undefined && Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : undefined;
	}

	private persistResumeState(): void {
		const store = this.channelContext.offsetStore;
		if (!store) return;
		if (this.sessionId) store.set(this.name, "sessionId", this.sessionId);
		if (this.resumeGatewayUrl) store.set(this.name, "resumeGatewayUrl", this.resumeGatewayUrl);
	}

	private clearResumeState(): void {
		this.sessionId = undefined;
		this.resumeGatewayUrl = undefined;
		this.sequence = undefined;
		const store = this.channelContext.offsetStore;
		if (!store) return;
		store.delete?.(this.name, "sessionId");
		store.delete?.(this.name, "resumeGatewayUrl");
		store.delete?.(this.name, "sequence");
	}

	// ------------------------------------------------------------------
	// Outbound
	// ------------------------------------------------------------------

	override get mediaCapabilities(): ChannelMediaCapabilities {
		return { kinds: ["image", "video", "audio", "file"], urlDirect: false, maxBytes: 25 * 1024 * 1024 };
	}

	async send(message: OutboundMessage): Promise<ChannelSendResult> {
		const media = this.collectOutboundMedia(message);
		const url = `${this.apiBase()}/channels/${encodeURIComponent(message.chatId)}/messages`;
		if (media.length === 0) {
			const result = await this.sendJson(url, message);
			this.clearTurnActive(message.chatId);
			return result;
		}
		const files: Array<{ blob: Blob; filename: string }> = [];
		const failedMedia: string[] = [];
		for (const item of media) {
			try {
				const resolved = await resolveOutboundMedia(item, {
					fetchFn: this.fetchFn,
					maxBytes: this.mediaCapabilities.maxBytes,
				});
				files.push({ blob: new Blob([resolved.data], { type: resolved.mimeType }), filename: resolved.filename });
			} catch (error) {
				this.channelContext.logger?.error(
					`[discord] media resolve failed source=${item.source}: ${formatError(error)}`,
				);
				failedMedia.push(item.filename ?? item.source);
			}
		}
		const payload: Record<string, unknown> = { content: withMediaFailureNote(message.content, failedMedia) };
		if (message.replyTo) {
			payload.message_reference = { message_id: message.replyTo, fail_if_not_exists: false };
		}
		if (files.length > 0) {
			payload.attachments = files.map((file, index) => ({ id: index, filename: file.filename }));
		}
		const form = new FormData();
		form.append("payload_json", JSON.stringify(payload));
		for (const [index, file] of files.entries()) {
			form.append(`files[${index}]`, file.blob, file.filename);
		}
		const response = await this.api(`/channels/${encodeURIComponent(message.chatId)}/messages`, {
			method: "POST",
			body: form,
		});
		if (!response.ok) {
			throw new Error(`Discord send failed: ${response.status} ${await response.text()}`);
		}
		const body = (await response.json()) as { id?: string };
		this.clearTurnActive(message.chatId);
		return failedMedia.length > 0
			? { status: "partial", providerMessageId: body.id, detail: `media failed: ${failedMedia.join(", ")}` }
			: { status: "success", providerMessageId: body.id };
	}

	private apiBase(): string {
		return this.cfg.apiBase ?? "https://discord.com/api/v10";
	}

	private async sendJson(url: string, message: OutboundMessage): Promise<ChannelSendResult> {
		const response = await this.fetchFn(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bot ${this.cfg.token ?? ""}`,
			},
			body: JSON.stringify({
				content: message.content,
				...(message.replyTo
					? { message_reference: { message_id: message.replyTo, fail_if_not_exists: false } }
					: {}),
			}),
		});
		if (!response.ok) {
			throw new Error(`Discord send failed: ${response.status} ${await response.text()}`);
		}
		const body = (await response.json()) as { id?: string };
		return { providerMessageId: body.id };
	}

	// ------------------------------------------------------------------
	// Streaming: send the first delta as a message, edit it afterwards
	// ------------------------------------------------------------------

	private readonly streamIds = new Map<string, string>();

	async sendDelta(delta: OutboundDelta): Promise<void> {
		const base = this.apiBase();
		const existing = this.streamIds.get(delta.chatId);
		if (existing === undefined) {
			const result = await this.sendJson(`${base}/channels/${encodeURIComponent(delta.chatId)}/messages`, {
				channel: delta.chatId,
				chatId: delta.chatId,
				content: delta.delta,
				replyTo: delta.replyTo,
			});
			if (result.providerMessageId) this.streamIds.set(delta.chatId, result.providerMessageId);
			return;
		}
		const response = await this.fetchFn(`${base}/channels/${encodeURIComponent(delta.chatId)}/messages/${existing}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json", Authorization: `Bot ${this.cfg.token ?? ""}` },
			body: JSON.stringify({ content: delta.delta }),
		});
		if (!response.ok) {
			throw new Error(`Discord edit failed: ${response.status} ${await response.text()}`);
		}
		if (delta.streamEnd) {
			this.streamIds.delete(delta.chatId);
			this.clearTurnActive(delta.chatId);
		}
	}
}

function withGatewayQuery(url: string): string {
	const parsed = new URL(url);
	parsed.searchParams.set("v", "10");
	parsed.searchParams.set("encoding", "json");
	return parsed.toString();
}

function isGatewayData(value: DiscordGatewayData | boolean | undefined): value is DiscordGatewayData {
	return typeof value === "object" && value !== null;
}

/** Built-in slash commands; hosts can supply their own registry. */
function defaultDiscordCommands(): DiscordCommandRegistry {
	const definitions: Record<string, DiscordCommandDefinition> = {
		model: {
			description: "Show or switch runtime model preset",
			handle: (context) => (context.args.length > 0 ? `/model ${context.args.join(" ")}` : "/model"),
		},
		trigger: {
			description: "Create a named local trigger for this chat",
			handle: (context) => (context.args.length > 0 ? `/trigger ${context.args.join(" ")}` : "/trigger"),
		},
		help: {
			description: "Show available commands",
			handle: () => "/help",
		},
	};
	return {
		get: (name) => definitions[name],
		list: () => Object.entries(definitions),
	};
}

function toBase64(data: Uint8Array): string {
	return Buffer.from(data).toString("base64");
}

function sniffImageMime(bytes: Uint8Array): string {
	if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
	if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
		return "image/png";
	}
	if (bytes.length > 3 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif";
	if (bytes.length > 11 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) {
		return "image/webp";
	}
	return "application/octet-stream";
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
