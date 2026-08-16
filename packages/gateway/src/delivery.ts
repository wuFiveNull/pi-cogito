/**
 * 通用投递 SDK —— 供 proactive/drift 及其他模块直接 import 使用。
 *
 * 两种用法:
 *
 * 1. createDeliveryClient(推荐):HTTP 客户端,把消息 POST 到 gateway 的
 *    /api/deliver,复用 gateway 进程持有的通道连接,不重复建连接。
 *
 *   import { createDeliveryClient } from "@cogito/gateway";
 *   const client = createDeliveryClient({ configPath: "./config.json" });
 *   await client.send({ channel: "qq", chatId: "user:123", content: "hi", media: ["/tmp/a.png"] });
 *
 * 2. createDeliverySdk:send-only 直连模式,本进程自持通道连接。按
 *    `proactive.targets` 里出现的通道(feishu/qq/onebot/napcat)启用。
 *
 *   import { createDeliverySdk } from "@cogito/gateway";
 *   const sdk = createDeliverySdk({ configPath: "./config.json" });
 *   await sdk.start();
 *   await sdk.send({ channel: "qq", chatId: "user:123", content: "hi" });
 *   await sdk.stop();
 */

import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { guessMimeType } from "./media.ts";
import { type ChannelSdk, createChannelSdk } from "./sdk.ts";
import type { DeliveryReceipt, OutboundMessage } from "./types.ts";

/** 投递支持的通道(可发送的 IM 通道)。 */
export const DELIVERY_CHANNELS = [
	"feishu",
	"qq",
	"onebot",
	"napcat",
	"telegram",
	"discord",
	"slack",
	"mattermost",
	"matrix",
	"email",
	"web",
	"websocket",
] as const;

export type DeliveryChannelName = (typeof DELIVERY_CHANNELS)[number];

export interface DeliveryTarget {
	/** 通道名(feishu / qq / onebot / napcat)。 */
	channel: string;
	/** 目标会话 ID(feishu: oc_xxx;qq: user:<QQ号> / group:<群号>)。 */
	chatId: string;
}

export interface DeliverySdkOptions {
	/** 根配置路径(默认 GATEWAY_CONFIG 或 cwd/config.json)。 */
	configPath?: string;
	/** 直接传入根配置对象(测试用),优先于 configPath。 */
	config?: unknown;
	/** 传输层 fetch 覆盖(测试用)。 */
	fetchFn?: typeof fetch;
}

export interface GatewayRootConfig {
	channels?: Record<string, Record<string, unknown> | undefined>;
	proactive?: { targets?: unknown };
	web?: { host?: string; port?: number };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function nonEmptyString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed || undefined;
}

function loadRootConfig(options: DeliverySdkOptions): GatewayRootConfig {
	if (options.config !== undefined) return options.config as GatewayRootConfig;
	const configPath = options.configPath ?? process.env.GATEWAY_CONFIG ?? resolve(process.cwd(), "config.json");
	if (!existsSync(configPath)) {
		throw new Error(`delivery sdk: config not found: ${configPath}`);
	}
	try {
		return JSON.parse(readFileSync(configPath, "utf-8")) as GatewayRootConfig;
	} catch (error) {
		throw new Error(
			`delivery sdk: failed to parse config ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/** 从根配置读取投递目标(proactive.targets),过滤非投递通道与未启用通道。 */
export function loadDeliveryTargets(options: DeliverySdkOptions = {}): DeliveryTarget[] {
	const root = loadRootConfig(options);
	const targets = Array.isArray(root.proactive?.targets) ? root.proactive.targets : [];
	const channels = root.channels ?? {};
	const result: DeliveryTarget[] = [];
	for (const value of targets) {
		const target = asRecord(value);
		const channel = nonEmptyString(target?.channel);
		const chatId = nonEmptyString(target?.chatId);
		if (!channel || !chatId) continue;
		if (!(DELIVERY_CHANNELS as readonly string[]).includes(channel)) continue;
		const channelConfig = asRecord(channels[channel]);
		if (channelConfig?.enabled === false) continue;
		result.push({ channel, chatId });
	}
	return result;
}

/**
 * 创建 send-only 投递 SDK。
 *
 * 只启用 `proactive.targets` 中出现的通道(feishu/qq/onebot/napcat),
 * receive=false,不占用 gateway 的入站连接。调用方负责 start/stop。
 */
export function createDeliverySdk(options: DeliverySdkOptions = {}): ChannelSdk {
	const root = loadRootConfig(options);
	const channels = root.channels ?? {};
	const selected: string[] = [];
	const channelConfigs: Record<string, Record<string, unknown>> = {};
	for (const target of loadDeliveryTargets(options)) {
		if (selected.includes(target.channel)) continue;
		const config = asRecord(channels[target.channel]);
		channelConfigs[target.channel] = { ...(config ?? {}), enabled: true };
		selected.push(target.channel);
	}
	return createChannelSdk({
		config: { ...root, channels: channelConfigs },
		channels: selected,
		// receive:true 让通道真正启动(连接型通道如 qq/onebot 只有 start 后
		// 才能发送;receive:false 只注册不启动,只适用于无状态通道)。入站事件
		// 没有消费者,直接丢弃;gateway 进程有自己的连接,不受影响。
		receive: true,
		retry: { maxAttempts: 1 },
		transport: options.fetchFn ? { fetchFn: options.fetchFn } : undefined,
	});
}

// ---------------------------------------------------------------------------
// HTTP 投递客户端(推荐):复用 gateway 进程持有的通道连接。
// ---------------------------------------------------------------------------

export interface DeliveryClient {
	/** 通过 gateway 投递一条消息,返回回执。失败时抛出错误。 */
	send(message: OutboundMessage): Promise<DeliveryReceipt>;
	/** 无状态客户端,start/stop 为空操作(与 ChannelSdk 接口对齐)。 */
	start(): Promise<void>;
	stop(): Promise<void>;
}

export interface DeliveryClientOptions {
	/** Gateway 地址(默认 config.web 或 http://127.0.0.1:8787)。 */
	baseUrl?: string;
	/** web channel 鉴权 token(默认 config.channels.web.auth.token 或 GATEWAY_WEB_AUTH_TOKEN)。 */
	token?: string;
	/** 根配置路径,用于解析 baseUrl/token(默认 GATEWAY_CONFIG 或 cwd/config.json)。 */
	configPath?: string;
	/** 直接传入根配置对象(测试用),优先于 configPath。 */
	config?: unknown;
	/** 传输层 fetch 覆盖(测试用)。 */
	fetchFn?: typeof fetch;
}

/**
 * 创建 HTTP 投递客户端:把 OutboundMessage POST 到 gateway 的
 * /api/deliver(管理端点,需要 token)。通道连接由 gateway 统一持有,
 * 其他模块(proactive/drift/...)import 后即可直接发送,不重复建连接。
 */
export function createDeliveryClient(options: DeliveryClientOptions = {}): DeliveryClient {
	const root = options.config !== undefined ? (options.config as GatewayRootConfig) : loadRootConfig(options);
	const web = asRecord(root.web);
	const host = typeof web?.host === "string" && web.host ? web.host : "127.0.0.1";
	const port = typeof web?.port === "number" && web.port > 0 ? web.port : 8787;
	const baseUrl = options.baseUrl ?? `http://${host}:${port}`;
	const channelAuth = asRecord(root.channels?.web) ? asRecord(asRecord(root.channels?.web)!.auth) : undefined;
	const token =
		options.token ??
		(typeof channelAuth?.token === "string" && channelAuth.token ? channelAuth.token : undefined) ??
		process.env.GATEWAY_WEB_AUTH_TOKEN;
	const fetchFn = options.fetchFn ?? fetch;
	if (!token) {
		throw new Error(
			"delivery client: no web auth token configured (channels.web.auth.token / GATEWAY_WEB_AUTH_TOKEN)",
		);
	}

	return {
		async send(message: OutboundMessage): Promise<DeliveryReceipt> {
			const outbound = await embedLocalMedia(message);
			const response = await fetchFn(`${baseUrl}/api/deliver`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${token}`,
				},
				body: JSON.stringify(outbound),
			});
			const payload = (await response.json().catch(() => undefined)) as
				| { receipt?: DeliveryReceipt; error?: string }
				| undefined;
			if (!response.ok || !payload?.receipt) {
				throw new Error(payload?.error ?? `delivery failed: HTTP ${response.status}`);
			}
			return payload.receipt;
		},
		async start() {},
		async stop() {},
	};
}

/**
 * 跨进程投递前把本地文件路径媒体转成 data URL(gateway 进程可能无法访问
 * 调用方的文件系统)。HTTP(S) URL 与 data URL 原样保留。
 */
async function embedLocalMedia(message: OutboundMessage): Promise<OutboundMessage> {
	const media = message.media;
	const attachments = message.attachments;
	if ((!media || media.length === 0) && (!attachments || attachments.length === 0)) return message;
	const outbound: OutboundMessage = { ...message };
	if (media && media.length > 0) {
		outbound.media = [];
		for (const source of media) {
			outbound.media.push(await sourceToTransport(source));
		}
	}
	if (attachments && attachments.length > 0) {
		outbound.attachments = [];
		for (const attachment of attachments) {
			outbound.attachments.push({ ...attachment, source: await sourceToTransport(attachment.source) });
		}
	}
	return outbound;
}

async function sourceToTransport(source: string): Promise<string> {
	if (/^https?:\/\//i.test(source) || source.startsWith("data:")) return source;
	let data: Buffer;
	try {
		data = await readFile(source);
	} catch (error) {
		throw new Error(
			`delivery client: cannot read local media ${source}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const mime = guessMimeType(basename(source));
	return `data:${mime};base64,${data.toString("base64")}`;
}
