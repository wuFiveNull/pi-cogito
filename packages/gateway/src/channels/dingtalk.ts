/**
 * DingtalkChannel — 钉钉 stream 模式机器人,零依赖。
 *
 * 接收:POST https://api.dingtalk.com/v1.0/gateway/connections/open 换取
 * WS URL;注册 topic "chatbot" 帧;ping/pong 心跳;data 帧 body 为
 * base64(JSON),解析 ChatbotMessage。
 * 发送:gettoken(appKey/appSecret)→ robot 消息 API
 * (单聊 /v1.0/robot/oToMessages/batchSend,群聊 /v1.0/robot/groupMessages/send)。
 * 协议遵循钉钉 stream SDK v1 规范;需真实钉钉应用做线上验证。
 */

import { createHash } from "node:crypto";
import type { MessageBus } from "../bus.ts";
import { type ChannelMediaCapabilities, withMediaFailureNote } from "../media.ts";
import type { ChannelSendResult, OutboundMessage } from "../types.ts";
import { BaseChannel, type ChannelConfig } from "./base.ts";
import type { ChannelContext } from "./context.ts";
import { GenericWsClient, type WsLike } from "./ws-common.ts";

export interface DingtalkConfig extends ChannelConfig {
	/** 应用 AppKey(机器人 clientId)。 */
	clientId?: string;
	/** 应用 AppSecret(机器人 clientSecret)。 */
	clientSecret?: string;
	/** 机器人 robotCode,默认取 clientId。 */
	robotCode?: string;
	/** API 域名。默认 https://api.dingtalk.com。 */
	apiBase?: string;
	/** 重连延迟 ms。默认 5000。 */
	reconnectDelayMs?: number;
}

interface DingFrame {
	type?: string;
	headers?: Record<string, string>;
	body?: string;
}

interface ChatbotMessage {
	msgtype?: string;
	text?: { content?: string };
	senderStaffId?: string;
	senderId?: string;
	senderNick?: string;
	conversationId?: string;
	conversationType?: string;
	msgId?: string;
	isInAtList?: boolean;
	chatbotUserId?: string;
}

const TOPIC_CHATBOT = "chatbot";

export class DingtalkChannel extends BaseChannel {
	name = "dingtalk";
	displayName = "DingTalk";

	private readonly cfg: DingtalkConfig;
	private readonly socket: WsLike;
	private readonly fetchFn: typeof fetch;
	private heartbeatTimer: NodeJS.Timeout | undefined;
	private readonly pingTimeout = 30_000;
	private readonly processedIds = new Set<string>();

	constructor(
		config: ChannelConfig | undefined,
		bus: MessageBus,
		options: { socket?: WsLike; fetchFn?: typeof fetch } = {},
	) {
		super(config, bus);
		this.cfg = (config ?? {}) as DingtalkConfig;
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
	}

	private async openConnection(): Promise<string> {
		const response = await this.fetchFn(
			`${this.cfg.apiBase ?? "https://api.dingtalk.com"}/v1.0/gateway/connections/open`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-acs-dingtalk-access-token": this.cfg.clientSecret ?? "",
				},
				body: JSON.stringify({ clientId: this.cfg.clientId ?? "" }),
			},
		);
		if (!response.ok) throw new Error(`dingtalk connections/open failed: ${response.status}`);
		const body = (await response.json()) as { url?: string };
		if (!body.url) throw new Error("dingtalk connections/open returned no url");
		return body.url;
	}

	private async loop(): Promise<void> {
		let delay = this.cfg.reconnectDelayMs ?? 5000;
		while (this.running) {
			try {
				const url = await this.openConnection();
				await this.socket.connect(url);
				this.socket.onMessage(
					(text) =>
						void this.handleFrame(text).catch((error: unknown) => {
							this.channelContext.logger?.error(`[dingtalk] frame processing failed: ${formatError(error)}`);
						}),
				);
				// Register for chatbot messages once connected.
				this.socket.send(
					JSON.stringify({
						type: "register",
						headers: {
							topic: TOPIC_CHATBOT,
							messageId: createHash("sha256").update(String(Date.now())).digest("hex").slice(0, 16),
						},
						body: "",
					}),
				);
				this.heartbeatTimer = setInterval(() => {
					this.socket.send(JSON.stringify({ type: "ping" }));
				}, this.pingTimeout);
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

	private async handleFrame(text: string): Promise<void> {
		let frame: DingFrame;
		try {
			frame = JSON.parse(text) as DingFrame;
		} catch {
			return;
		}
		if (frame.type === "ping") {
			this.socket.send(JSON.stringify({ type: "pong" }));
			return;
		}
		if (frame.type === "pong" || frame.type === "register") return;
		if (frame.type !== "data" || !frame.body) return;
		const topic = frame.headers?.topic;
		if (topic !== TOPIC_CHATBOT) return;
		let payload: ChatbotMessage;
		try {
			payload = JSON.parse(Buffer.from(frame.body, "base64").toString("utf-8")) as ChatbotMessage;
		} catch {
			return;
		}
		await this.handleChatbotMessage(payload);
	}

	private async handleChatbotMessage(message: ChatbotMessage): Promise<void> {
		if (!message.msgId) return;
		if (this.processedIds.has(message.msgId)) return;
		this.processedIds.add(message.msgId);
		if (this.processedIds.size > 4096) {
			const oldest = this.processedIds.keys().next().value;
			if (oldest !== undefined) this.processedIds.delete(oldest);
		}
		let content = "";
		if (message.msgtype === "text") content = message.text?.content ?? "";
		else if (message.msgtype === "picture") content = "[图片]";
		else if (message.msgtype === "file") content = "[文件]";
		else if (message.msgtype === "richText") content = "[富文本]";
		content = content.replace(/@[\w\u4e00-\u9fa5]+\s?/g, "").trim();
		if (!content) return;
		const isGroup = message.conversationType === "2";
		const senderId = message.senderStaffId ?? message.senderId ?? "unknown";
		const result = await this.handleMessage({
			messageId: message.msgId,
			senderId,
			chatId: message.conversationId ?? senderId,
			content,
			metadata: {
				msgType: message.msgtype,
				senderNick: message.senderNick,
				conversationType: message.conversationType,
			},
			isDm: !isGroup,
		});
		if (result.status === "rejected") {
			this.channelContext.logger?.warn(`[dingtalk] message rejected: ${result.detail ?? "unauthorized"}`);
		}
	}

	// ------------------------------------------------------------------
	// 发送:gettoken + robot 消息 API
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
		const token = await this.accessToken();
		const apiBase = this.cfg.apiBase ?? "https://api.dingtalk.com";
		const robotCode = this.cfg.robotCode ?? this.cfg.clientId ?? "";
		const isGroup = message.chatId.startsWith("group:");
		const url = isGroup ? `${apiBase}/v1.0/robot/groupMessages/send` : `${apiBase}/v1.0/robot/oToMessages/batchSend`;
		const payload = isGroup
			? {
					robotCode,
					openConversationId: message.chatId.slice("group:".length),
					msgKey: "sampleText",
					msgParam: JSON.stringify({ content }),
				}
			: {
					robotCode,
					userIds: [message.chatId],
					msgKey: "sampleText",
					msgParam: JSON.stringify({ content }),
				};
		const response = await this.fetchFn(url, {
			method: "POST",
			headers: { "Content-Type": "application/json", "x-acs-dingtalk-access-token": token },
			body: JSON.stringify(payload),
		});
		if (!response.ok) {
			throw new Error(`dingtalk robot send failed: ${response.status} ${await response.text()}`);
		}
		return failedMedia.length > 0
			? { status: "partial", detail: `media not supported: ${failedMedia.join(", ")}` }
			: { status: "success" };
	}

	private tokenCache: { token: string; expiresAt: number } | undefined;

	private async accessToken(): Promise<string> {
		const now = Date.now();
		if (this.tokenCache && this.tokenCache.expiresAt > now + 60_000) return this.tokenCache.token;
		const response = await this.fetchFn(
			`https://oapi.dingtalk.com/gettoken?appkey=${encodeURIComponent(this.cfg.clientId ?? "")}&appsecret=${encodeURIComponent(this.cfg.clientSecret ?? "")}`,
		);
		const body = (await response.json()) as { errcode?: number; access_token?: string; expires_in?: number };
		if (!response.ok || body.errcode !== 0 || !body.access_token) {
			throw new Error(`dingtalk gettoken failed: ${body.errcode ?? response.status}`);
		}
		this.tokenCache = { token: body.access_token, expiresAt: now + (body.expires_in ?? 7200) * 1000 };
		return body.access_token;
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
