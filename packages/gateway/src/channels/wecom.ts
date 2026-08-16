/**
 * WecomChannel — 企业微信自建应用消息通道,零依赖。
 *
 * 接收:自建应用「接收消息」回调(HTTP server,GET 验证 + POST 消息,
 * 签名校验 + AES 解密),用户消息归一化为 InboundMessage(chatId/senderId
 * 均为用户 UserID)。
 * 发送:gettoken(corpid + corpSecret)→ /cgi-bin/message/send 主动文本消息。
 *
 * 说明:nanobot 的 wecom 通道基于闭源的 wecom-aibot-sdk(WS 长连协议),
 * 零依赖无法复刻;本实现采用标准企业微信自建应用回调模型,是功能等价的
 * 可验证替代。回调需要公网可达地址(与 telegram webhook 同理)。
 */

import { createDecipheriv, createHash } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { MessageBus } from "../bus.ts";
import { type ChannelMediaCapabilities, withMediaFailureNote } from "../media.ts";
import type { ChannelSendResult, OutboundMessage } from "../types.ts";
import { BaseChannel, type ChannelConfig } from "./base.ts";
import type { ChannelContext } from "./context.ts";

export interface WecomConfig extends ChannelConfig {
	/** 企业 CorpID。 */
	corpId?: string;
	/** 自建应用 Secret。 */
	corpSecret?: string;
	/** 自建应用 AgentId。 */
	agentId?: string;
	/** 回调 token(应用管理页配置)。 */
	token?: string;
	/** 回调 EncodingAESKey(43 位)。 */
	encodingAESKey?: string;
	/** 回调监听地址。默认 "0.0.0.0"。 */
	callbackHost?: string;
	/** 回调监听端口。默认 8788。 */
	callbackPort?: number;
	/** 回调路径。默认 "/wecom"。 */
	callbackPath?: string;
}

interface WecomCallbackBody {
	toUserName: string;
	fromUserName: string;
	msgType: string;
	content: string;
	msgId: string;
}

export class WecomChannel extends BaseChannel {
	name = "wecom";
	displayName = "WeCom";

	private readonly cfg: WecomConfig;
	private readonly fetchFn: typeof fetch;
	private server: Server | undefined;
	private readonly addresses: Array<{ host: string; port: number }> = [];

	constructor(config: ChannelConfig | undefined, bus: MessageBus, options: { fetchFn?: typeof fetch } = {}) {
		super(config, bus);
		this.cfg = (config ?? {}) as WecomConfig;
		this.fetchFn = options.fetchFn ?? fetch;
	}

	get port(): number | undefined {
		return this.addresses[0]?.port;
	}

	async start(context?: ChannelContext): Promise<void> {
		if (this.running) return;
		if (context) this.bindContext(context);
		const handler = (req: IncomingMessage, res: ServerResponse): void => {
			void this.handleCallback(req, res).catch((error: unknown) => {
				this.channelContext.logger?.error(`[wecom] callback failed: ${formatError(error)}`);
				res.writeHead(500);
				res.end();
			});
		};
		this.server = createHttpServer(handler);
		await new Promise<void>((resolve) => {
			this.server!.listen(this.cfg.callbackPort ?? 8788, this.cfg.callbackHost ?? "0.0.0.0", resolve);
		});
		const address = this.server.address();
		if (address && typeof address === "object") this.addresses.push({ host: address.address, port: address.port });
		this.running = true;
	}

	async stop(): Promise<void> {
		this.running = false;
		if (this.server) {
			await new Promise<void>((resolve) => this.server!.close(() => resolve()));
			this.server = undefined;
		}
		this.addresses.length = 0;
	}

	// ------------------------------------------------------------------
	// 回调:GET 验证 + POST 消息
	// ------------------------------------------------------------------

	private async handleCallback(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = new URL(req.url ?? "/", "http://localhost");
		if (url.pathname !== (this.cfg.callbackPath ?? "/wecom")) {
			res.writeHead(404);
			res.end();
			return;
		}
		const timestamp = url.searchParams.get("timestamp") ?? "";
		const nonce = url.searchParams.get("nonce") ?? "";
		const signature = url.searchParams.get("msg_signature") ?? "";
		if (!this.verifySignature(timestamp, nonce, signature)) {
			this.channelContext.logger?.warn("[wecom] callback signature mismatch");
			res.writeHead(403);
			res.end();
			return;
		}
		if (req.method === "GET") {
			// 验证模式:解密 echostr 并原样返回。
			const echostr = url.searchParams.get("echostr") ?? "";
			const plain = this.decrypt(echostr);
			if (plain === undefined) {
				res.writeHead(403);
				res.end();
				return;
			}
			res.writeHead(200);
			res.end(plain);
			return;
		}
		if (req.method !== "POST") {
			res.writeHead(405);
			res.end();
			return;
		}
		const raw = await readBody(req);
		let body: WecomCallbackBody;
		try {
			const decrypt = this.decrypt(raw);
			if (decrypt === undefined) throw new Error("decrypt failed");
			body = parseCallbackXml(decrypt);
		} catch (error) {
			this.channelContext.logger?.warn(`[wecom] callback parse failed: ${formatError(error)}`);
			res.writeHead(400);
			res.end();
			return;
		}
		res.writeHead(200);
		res.end("");
		if (body.msgType !== "text" || !body.content) return;
		const result = await this.handleMessage({
			messageId: body.msgId,
			senderId: body.fromUserName,
			chatId: body.fromUserName,
			content: body.content,
			metadata: { msgType: body.msgType, toUserName: body.toUserName },
			isDm: true,
		});
		if (result.status === "rejected") {
			this.channelContext.logger?.warn(`[wecom] message rejected: ${result.detail ?? "unauthorized"}`);
		}
	}

	/** 企业微信回调签名:sha1(sort(token, timestamp, nonce, encrypt)). */
	private verifySignature(timestamp: string, nonce: string, signature: string): boolean {
		if (!this.cfg.token) return false;
		const content = [this.cfg.token, timestamp, nonce].sort().join("");
		const expected = createHash("sha1").update(content, "utf8").digest("hex");
		return signature === expected;
	}

	/**
	 * AES-256-CBC 解密(PKCS7):key = base64(EncodingAESKey + "=");
	 * 明文 = random(16) + msgLen(4 字节网络序) + msg + receiveId。
	 */
	private decrypt(encrypted: string): string | undefined {
		if (!this.cfg.encodingAESKey || !encrypted) return undefined;
		try {
			const key = Buffer.from(`${this.cfg.encodingAESKey}=`, "base64");
			const decipher = createDecipheriv("aes-256-cbc", key, key.subarray(0, 16));
			const plain = Buffer.concat([decipher.update(Buffer.from(encrypted, "base64")), decipher.final()]);
			const msgLen = plain.readUInt32BE(16);
			return plain.subarray(20, 20 + msgLen).toString("utf-8");
		} catch {
			return undefined;
		}
	}

	// ------------------------------------------------------------------
	// 发送:gettoken + message/send
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
		const response = await this.fetchFn(
			`https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${encodeURIComponent(token)}`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					touser: message.chatId,
					msgtype: "text",
					agentid: Number(this.cfg.agentId ?? 0),
					text: { content },
					safe: 0,
				}),
			},
		);
		const body = (await response.json()) as { errcode?: number; errmsg?: string };
		if (!response.ok || body.errcode !== 0) {
			throw new Error(`wecom message/send failed: ${body.errcode ?? response.status} ${body.errmsg ?? ""}`);
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
			`https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${encodeURIComponent(this.cfg.corpId ?? "")}&corpsecret=${encodeURIComponent(this.cfg.corpSecret ?? "")}`,
		);
		const body = (await response.json()) as { errcode?: number; access_token?: string; expires_in?: number };
		if (!response.ok || body.errcode !== 0 || !body.access_token) {
			throw new Error(`wecom gettoken failed: ${body.errcode ?? response.status}`);
		}
		this.tokenCache = { token: body.access_token, expiresAt: now + (body.expires_in ?? 7200) * 1000 };
		return body.access_token;
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
		req.on("error", reject);
	});
}

/** 解析企业微信回调 XML(结构固定,正则足够)。 */
function parseCallbackXml(xml: string): WecomCallbackBody {
	const field = (name: string): string => {
		const match = new RegExp(
			`<${name}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${name}>|<${name}>([\\s\\S]*?)</${name}>`,
		).exec(xml);
		return match?.[1] ?? match?.[2] ?? "";
	};
	return {
		toUserName: field("ToUserName"),
		fromUserName: field("FromUserName"),
		msgType: field("MsgType"),
		content: field("Content"),
		msgId: field("MsgId"),
	};
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
