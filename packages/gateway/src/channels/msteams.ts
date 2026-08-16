/**
 * MSTeamsChannel — Microsoft Teams Bot Framework channel, zero-dependency.
 *
 * 接收:HTTP endpoint(Bot Framework Activities),Authorization Bearer JWT
 * 由 Bot Framework OpenID 配置 + JWKS 做 RS256 校验。
 * 发送:client_credentials 换取 botframework token,POST 到
 * {serviceUrl}/v3/conversations/{id}/activities(回复走 replyTo)。
 * serviceUrl 在入站 activity 时记录(按 conversation id 缓存)。
 */

import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { MessageBus } from "../bus.ts";
import { type ChannelMediaCapabilities, withMediaFailureNote } from "../media.ts";
import type { ChannelSendResult, OutboundMessage } from "../types.ts";
import { BaseChannel, type ChannelConfig } from "./base.ts";
import type { ChannelContext } from "./context.ts";

export interface MSTeamsConfig extends ChannelConfig {
	/** Azure AD app id (bot). */
	appId?: string;
	/** Azure AD app password (client secret). */
	appPassword?: string;
	/** Azure AD tenant id. */
	tenantId?: string;
	/** Callback path. Default "/api/messages". */
	path?: string;
	/** Callback listen host. Default "0.0.0.0". */
	callbackHost?: string;
	/** Callback listen port. Default 3978. */
	callbackPort?: number;
}

interface TeamsActivity {
	type?: string;
	id?: string;
	timestamp?: string;
	from?: { id?: string; name?: string };
	conversation?: { id?: string };
	text?: string;
	serviceUrl?: string;
	channelId?: string;
}

export class MSTeamsChannel extends BaseChannel {
	name = "msteams";
	displayName = "Microsoft Teams";

	private readonly cfg: MSTeamsConfig;
	private readonly fetchFn: typeof fetch;
	private server: Server | undefined;
	private readonly addresses: Array<{ host: string; port: number }> = [];
	/** conversation id -> serviceUrl(入站时学习,回复复用)。 */
	private readonly serviceUrls = new Map<string, string>();

	constructor(config: ChannelConfig | undefined, bus: MessageBus, options: { fetchFn?: typeof fetch } = {}) {
		super(config, bus);
		this.cfg = (config ?? {}) as MSTeamsConfig;
		this.fetchFn = options.fetchFn ?? fetch;
	}

	get port(): number | undefined {
		return this.addresses[0]?.port;
	}

	async start(context?: ChannelContext): Promise<void> {
		if (this.running) return;
		if (context) this.bindContext(context);
		const handler = (req: IncomingMessage, res: ServerResponse): void => {
			void this.handleActivity(req, res).catch((error: unknown) => {
				this.channelContext.logger?.error(`[msteams] activity handling failed: ${formatError(error)}`);
				res.writeHead(500);
				res.end();
			});
		};
		this.server = createHttpServer(handler);
		await new Promise<void>((resolve) => {
			this.server!.listen(this.cfg.callbackPort ?? 3978, this.cfg.callbackHost ?? "0.0.0.0", resolve);
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
		this.serviceUrls.clear();
	}

	// ------------------------------------------------------------------
	// 入站:activity + JWT 校验
	// ------------------------------------------------------------------

	private async handleActivity(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = new URL(req.url ?? "/", "http://localhost");
		if (url.pathname !== (this.cfg.path ?? "/api/messages")) {
			res.writeHead(404);
			res.end();
			return;
		}
		if (req.method !== "POST") {
			res.writeHead(405);
			res.end();
			return;
		}
		const auth = req.headers.authorization ?? "";
		const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
		const verified = await verifyBotJwt(token, this.fetchFn).catch(() => undefined);
		if (!verified) {
			this.channelContext.logger?.warn("[msteams] activity JWT verification failed");
			res.writeHead(401);
			res.end();
			return;
		}
		const raw = await readBody(req);
		let activity: TeamsActivity;
		try {
			activity = JSON.parse(raw) as TeamsActivity;
		} catch {
			res.writeHead(400);
			res.end();
			return;
		}
		res.writeHead(200);
		res.end();
		if (activity.type !== "message" || !activity.text || !activity.from?.id || !activity.conversation?.id) return;
		if (activity.serviceUrl) this.serviceUrls.set(activity.conversation.id, activity.serviceUrl);
		await this.handleMessage({
			messageId: activity.id,
			senderId: activity.from.id,
			chatId: activity.conversation.id,
			content: activity.text,
			metadata: {
				channelId: activity.channelId,
				serviceUrl: activity.serviceUrl,
				conversationId: activity.conversation.id,
			},
		});
	}

	// ------------------------------------------------------------------
	// 发送
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
		const serviceUrl = this.serviceUrls.get(message.chatId);
		if (!serviceUrl) throw new Error(`msteams: unknown conversation ${message.chatId}`);
		const token = await this.botAccessToken();
		const activity = {
			type: "message",
			text: content,
			channelData: undefined,
		};
		const url = message.replyTo
			? `${serviceUrl}/v3/conversations/${encodeURIComponent(message.chatId)}/activities/${encodeURIComponent(message.replyTo)}/replyTo`
			: `${serviceUrl}/v3/conversations/${encodeURIComponent(message.chatId)}/activities`;
		const response = await this.fetchFn(url, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
			body: JSON.stringify(activity),
		});
		if (!response.ok) {
			throw new Error(`msteams activity send failed: ${response.status} ${await response.text()}`);
		}
		const body = (await response.json()) as { id?: string };
		return {
			status: "success",
			providerMessageId: body.id,
			...(failedMedia.length > 0 ? { detail: `media not supported: ${failedMedia.join(", ")}` } : {}),
		};
	}

	private tokenCache: { token: string; expiresAt: number } | undefined;

	/** client_credentials 换取 Bot Framework token。 */
	private async botAccessToken(): Promise<string> {
		const now = Date.now();
		if (this.tokenCache && this.tokenCache.expiresAt > now + 60_000) return this.tokenCache.token;
		const tenant = this.cfg.tenantId ?? "common";
		const body = new URLSearchParams({
			client_id: this.cfg.appId ?? "",
			client_secret: this.cfg.appPassword ?? "",
			grant_type: "client_credentials",
			scope: "https://api.botframework.com/.default",
		});
		const response = await this.fetchFn(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body,
		});
		const data = (await response.json()) as { access_token?: string; expires_in?: number };
		if (!response.ok || !data.access_token) {
			throw new Error(`msteams token acquisition failed: ${response.status}`);
		}
		this.tokenCache = { token: data.access_token, expiresAt: now + (data.expires_in ?? 3600) * 1000 };
		return data.access_token;
	}
}

// ---------------------------------------------------------------------------
// Bot Framework JWT 校验(OpenID 配置 + JWKS + RS256)
// ---------------------------------------------------------------------------

interface JwksKey {
	kty?: string;
	kid?: string;
	n?: string;
	e?: string;
	x5c?: string[];
}

/** 校验 Bot Framework Bearer JWT;失败返回 undefined。 */
async function verifyBotJwt(token: string, fetchFn: typeof fetch): Promise<Record<string, unknown> | undefined> {
	if (!token) return undefined;
	const parts = token.split(".");
	if (parts.length !== 3) return undefined;
	let header: { alg?: string; kid?: string };
	let payload: Record<string, unknown>;
	try {
		header = JSON.parse(base64UrlDecode(parts[0]!)) as { alg?: string; kid?: string };
		payload = JSON.parse(base64UrlDecode(parts[1]!)) as Record<string, unknown>;
	} catch {
		return undefined;
	}
	if (header.alg !== "RS256") return undefined;
	const config = (await (
		await fetchFn("https://login.botframework.com/v1/.well-known/openidconfiguration")
	).json()) as {
		jwks_uri?: string;
		issuer?: string;
	};
	if (!config.jwks_uri) return undefined;
	const jwks = (await (await fetchFn(config.jwks_uri)).json()) as { keys?: JwksKey[] };
	const key = (jwks.keys ?? []).find((candidate) => candidate.kid === header.kid);
	if (!key?.n || !key.e) return undefined;
	try {
		const publicKey = createPublicKey({ key: { kty: key.kty ?? "RSA", n: key.n, e: key.e }, format: "jwk" });
		const valid = cryptoVerify(
			"RSA-SHA256",
			Buffer.from(`${parts[0]}.${parts[1]}`, "utf-8"),
			publicKey,
			Buffer.from(parts[2]!, "base64url"),
		);
		if (!valid) return undefined;
	} catch {
		return undefined;
	}
	if (config.issuer && typeof payload.iss === "string" && !payload.iss.startsWith(config.issuer)) return undefined;
	if (typeof payload.aud !== "string" && !Array.isArray(payload.aud)) return undefined;
	return payload;
}

function base64UrlDecode(value: string): string {
	return Buffer.from(value, "base64url").toString("utf-8");
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

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
