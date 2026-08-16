/**
 * WeixinChannel — 微信智能机器人(ilink bot),零依赖。
 *
 * 协议对齐 nanobot weixin 通道(ilinkai.weixin.qq.com):
 * - 认证:QR 扫码登录(get_bot_qrcode → get_qrcode_status → Bearer token),
 *   token 持久化到 offsetStore;也可配置手动 token。
 * - 接收:POST /ilink/bot/getupdates(长轮询,get_updates_buf 游标持久化)。
 * - 发送:POST /ilink/bot/sendmessage(消息类型 2=BOT,状态 2=FINISH,
 *   item_list 文本项,context_token 会话续接)。
 * 协议头:X-WECHAT-UIN(随机)、AuthorizationType、iLink-App-Id、
 * iLink-App-ClientVersion、Authorization: Bearer。
 */

import type { MessageBus } from "../bus.ts";
import { type ChannelMediaCapabilities, withMediaFailureNote } from "../media.ts";
import type { ChannelSendResult, OutboundMessage } from "../types.ts";
import { BaseChannel, type ChannelConfig } from "./base.ts";
import type { ChannelContext } from "./context.ts";

export interface WeixinConfig extends ChannelConfig {
	/** 手动配置的 bot token(经 QR 登录获取;配置后跳过扫码)。 */
	token?: string;
	/** API 域名。默认 https://ilinkai.weixin.qq.com。 */
	baseUrl?: string;
	/** 轮询间隔 ms。默认 30000(服务端可下发长轮询超时)。 */
	pollIntervalMs?: number;
	/** QR 登录等待超时 ms。默认 120000。 */
	loginTimeoutMs?: number;
	/** 路由标签(可选)。 */
	routeTag?: string;
}

interface WeixinItem {
	type?: number;
	text_item?: { text?: string };
}

interface WeixinMessage {
	message_type?: number;
	from_user_id?: string;
	to_user_id?: string;
	client_id?: string;
	item_list?: WeixinItem[];
	context_token?: string;
	msg_id?: string;
}

interface WeixinUpdates {
	ret?: number;
	errcode?: number;
	errmsg?: string;
	get_updates_buf?: string;
	longpolling_timeout_ms?: number;
	msgs?: WeixinMessage[];
}

const ITEM_TEXT = 1;
const MESSAGE_TYPE_BOT = 2;
const CHANNEL_VERSION = "2.1.1";
const ILINK_APP_ID = "ilink_bot";
const ERRCODE_SESSION_EXPIRED = 1401107;

export class WeixinChannel extends BaseChannel {
	name = "weixin";
	displayName = "WeChat";

	private readonly cfg: WeixinConfig;
	private readonly fetchFn: typeof fetch;
	private timer: NodeJS.Timeout | undefined;
	private token: string | undefined;
	private updatesBuf = "";
	private readonly contextTokens = new Map<string, string>();
	private readonly processedIds = new Set<string>();
	private sessionPausedUntil = 0;

	constructor(config: ChannelConfig | undefined, bus: MessageBus, options: { fetchFn?: typeof fetch } = {}) {
		super(config, bus);
		this.cfg = (config ?? {}) as WeixinConfig;
		this.fetchFn = options.fetchFn ?? fetch;
	}

	async start(context?: ChannelContext): Promise<void> {
		if (this.running) return;
		if (context) this.bindContext(context);
		this.token = this.cfg.token || this.channelContext.offsetStore?.get(this.name, "token");
		this.updatesBuf = this.channelContext.offsetStore?.get(this.name, "updatesBuf") ?? "";
		if (!this.token) {
			this.channelContext.logger?.warn("[weixin] no token configured; run login() to scan the QR code");
			return;
		}
		this.running = true;
		void this.pollOnce();
		this.timer = setInterval(() => void this.pollOnce(), this.cfg.pollIntervalMs ?? 30_000);
		this.timer.unref?.();
	}

	async stop(): Promise<void> {
		this.running = false;
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}

	/**
	 * QR 扫码登录:获取二维码(打印扫描 URL),轮询扫码状态直至成功。
	 * 成功后将 token 持久化到 offsetStore。
	 */
	override async login(force = false): Promise<boolean> {
		if (!force && this.token) return true;
		try {
			const qr = await this.fetchQrCode();
			this.channelContext.logger?.info(
				`[weixin] scan the QR code to log in (open this URL in WeChat): ${qr.scanUrl}`,
			);
			const deadline = Date.now() + (this.cfg.loginTimeoutMs ?? 120_000);
			while (Date.now() < deadline) {
				const status = await this.fetchQrStatus(qr.qrcodeId);
				if (status.token) {
					this.token = status.token;
					this.channelContext.offsetStore?.set(this.name, "token", status.token);
					this.channelContext.logger?.info("[weixin] QR login succeeded");
					return true;
				}
				if (status.expired) {
					this.channelContext.logger?.warn("[weixin] QR code expired; try again");
					return false;
				}
				await sleep(1500);
			}
			this.channelContext.logger?.warn("[weixin] QR login timed out");
			return false;
		} catch (error) {
			this.channelContext.logger?.error(`[weixin] QR login failed: ${formatError(error)}`);
			return false;
		}
	}

	// ------------------------------------------------------------------
	// iLink API
	// ------------------------------------------------------------------

	private headers(auth: boolean): Record<string, string> {
		const headers: Record<string, string> = {
			"X-WECHAT-UIN": randomUin(),
			"Content-Type": "application/json",
			AuthorizationType: "ilink_bot_token",
			"iLink-App-Id": ILINK_APP_ID,
			"iLink-App-ClientVersion": CHANNEL_VERSION,
		};
		if (this.cfg.routeTag) headers.SKRouteTag = this.cfg.routeTag;
		if (auth && this.token) headers.Authorization = `Bearer ${this.token}`;
		return headers;
	}

	private async apiPost<T>(endpoint: string, body: Record<string, unknown>, auth = true): Promise<T> {
		const response = await this.fetchFn(`${this.cfg.baseUrl ?? "https://ilinkai.weixin.qq.com"}/${endpoint}`, {
			method: "POST",
			headers: this.headers(auth),
			body: JSON.stringify(body),
		});
		if (!response.ok) throw new Error(`weixin ${endpoint} failed: ${response.status}`);
		return (await response.json()) as T;
	}

	private async fetchQrCode(): Promise<{ qrcodeId: string; scanUrl: string }> {
		const data = await this.apiPost<{
			ret?: number;
			errcode?: number;
			data?: { qrcode?: string; qrcode_img_content?: string };
		}>("ilink/bot/get_bot_qrcode", { bot_type: 3, base_info: { channel_version: CHANNEL_VERSION } }, false);
		if ((data.ret ?? 0) !== 0 || !data.data?.qrcode) {
			throw new Error(`weixin get_bot_qrcode failed: ret=${data.ret} errcode=${data.errcode}`);
		}
		return { qrcodeId: data.data.qrcode, scanUrl: data.data.qrcode_img_content || data.data.qrcode };
	}

	private async fetchQrStatus(qrcodeId: string): Promise<{ token?: string; expired?: boolean }> {
		const data = await this.apiPost<{
			ret?: number;
			errcode?: number;
			data?: { token?: string; qrcode_status?: number };
		}>("ilink/bot/get_qrcode_status", { qrcode: qrcodeId, base_info: { channel_version: CHANNEL_VERSION } }, false);
		if ((data.ret ?? 0) !== 0) {
			if (data.errcode === ERRCODE_SESSION_EXPIRED) return { expired: true };
			return {};
		}
		return { token: data.data?.token };
	}

	// ------------------------------------------------------------------
	// 接收:getupdates 长轮询
	// ------------------------------------------------------------------

	private async pollOnce(): Promise<void> {
		if (!this.running || !this.token) return;
		if (Date.now() < this.sessionPausedUntil) return;
		try {
			const data = await this.apiPost<WeixinUpdates>("ilink/bot/getupdates", {
				get_updates_buf: this.updatesBuf,
				base_info: { channel_version: CHANNEL_VERSION },
			});
			if ((data.ret ?? 0) !== 0) {
				if (data.errcode === ERRCODE_SESSION_EXPIRED) {
					this.sessionPausedUntil = Date.now() + 5 * 60_000;
					this.channelContext.logger?.warn("[weixin] session expired; pausing 5 minutes");
				}
				return;
			}
			if (typeof data.get_updates_buf === "string" && data.get_updates_buf) {
				this.updatesBuf = data.get_updates_buf;
				this.channelContext.offsetStore?.set(this.name, "updatesBuf", this.updatesBuf);
			}
			for (const msg of data.msgs ?? []) {
				await this.processMessage(msg);
			}
		} catch (error) {
			this.channelContext.logger?.debug(`[weixin] poll failed: ${formatError(error)}`);
		}
	}

	private async processMessage(msg: WeixinMessage): Promise<void> {
		if (msg.message_type === MESSAGE_TYPE_BOT) return; // Own messages.
		const senderId = msg.from_user_id ?? "unknown";
		const content = extractMessageText(msg);
		if (!content) return;
		if (msg.msg_id) {
			if (this.processedIds.has(msg.msg_id)) return;
			this.processedIds.add(msg.msg_id);
			if (this.processedIds.size > 4096) {
				const oldest = this.processedIds.keys().next().value;
				if (oldest !== undefined) this.processedIds.delete(oldest);
			}
		}
		if (msg.context_token) {
			this.contextTokens.set(senderId, msg.context_token);
			if (this.contextTokens.size > 1024) {
				const oldest = this.contextTokens.keys().next().value;
				if (oldest !== undefined) this.contextTokens.delete(oldest);
			}
		}
		await this.handleMessage({
			messageId: msg.msg_id,
			senderId,
			chatId: senderId,
			content,
			metadata: { clientId: msg.client_id, fromUserId: msg.from_user_id },
			isDm: true,
		});
	}

	// ------------------------------------------------------------------
	// 发送:sendmessage
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
		if (!this.token) throw new Error("weixin: not logged in");
		const contextToken = this.contextTokens.get(message.chatId);
		const weixinMsg: Record<string, unknown> = {
			from_user_id: "",
			to_user_id: message.chatId,
			client_id: `cogito-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
			message_type: MESSAGE_TYPE_BOT,
			message_state: 2,
			item_list: [{ type: ITEM_TEXT, text_item: { text: content } }],
		};
		if (contextToken) weixinMsg.context_token = contextToken;
		const data = await this.apiPost<{ ret?: number; errcode?: number; errmsg?: string }>("ilink/bot/sendmessage", {
			msg: weixinMsg,
			base_info: { channel_version: CHANNEL_VERSION },
		});
		if ((data.ret ?? 0) !== 0) {
			throw new Error(`weixin sendmessage failed: ret=${data.ret} errcode=${data.errcode} ${data.errmsg ?? ""}`);
		}
		return failedMedia.length > 0
			? { status: "partial", detail: `media not supported: ${failedMedia.join(", ")}` }
			: { status: "success" };
	}
}

function extractMessageText(msg: WeixinMessage): string {
	const parts: string[] = [];
	for (const item of msg.item_list ?? []) {
		if (item.type === ITEM_TEXT && item.text_item?.text) {
			parts.push(item.text_item.text);
		} else if (item.type && item.type !== ITEM_TEXT) {
			parts.push("[非文本消息]");
		}
	}
	return parts.join("\n").trim();
}

function randomUin(): string {
	return `${Math.floor(Math.random() * 1_000_000_000)}${Date.now() % 1000}`;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
