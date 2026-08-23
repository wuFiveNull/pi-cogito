/**
 * gateway-config — 统一网关配置文件加载器。
 *
 * 所有 channel 的配置都来自同一个 JSON 文件(config.json,路径可用
 * GATEWAY_CONFIG 环境变量覆盖)。密钥等敏感字段建议用环境变量覆盖,
 * 避免写进文件:
 *
 *   GATEWAY_FEISHU_APP_ID=cli_xxx GATEWAY_FEISHU_APP_SECRET=xxx \
 *     node node_modules/.bin/tsx agent-gateway/examples/pi-integration.ts
 *
 * 覆盖规则:GATEWAY_<CHANNEL>_<FIELD>,字段名按下划线转驼峰,例如
 * GATEWAY_FEISHU_APP_ID -> channels.feishu.appId
 * GATEWAY_FEISHU_ENCRYPT_KEY -> channels.feishu.encryptKey
 * GATEWAY_WEB_PORT -> web.port(web 的 host/port/staticDir 属于 web 段)
 */

import { type FSWatcher, readFileSync, watch } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import type { ChannelTlsOptions } from "./tls.ts";

export interface GatewayConfigFile {
	channels?: Record<string, Record<string, unknown>>;
	web?: { host?: string; port?: number; staticDir?: string; uploadsDir?: string; tls?: ChannelTlsOptions };
	/** agent 会话设置(缺省走 ~/.cogito/agent/settings.json)。 */
	agent?: { thinkingLevel?: string; model?: string; provider?: string };
	/** 主动推送:候选交给 agent 决策(akashic 风格),agent 用工具推送。 */
	proactive?: {
		dbPath?: string;
		targets?: Array<{ channel?: string; chatId?: string }>;
		/** 兴趣画像文件(interests.json),注入 agent 决策 prompt。 */
		profilePath?: string;
		/** 每轮交给 agent 决策的候选条数,默认 10。 */
		maxItemsPerRound?: number;
		/** Gate 硬闸(照 akashic gate.py):冷却/每日上限/最小间隔/概率门。 */
		gate?: {
			deliveryDedupeHours?: number;
			dailyMax?: number;
			minIntervalSeconds?: number;
			probability?: { enabled?: boolean; pMin?: number; pMax?: number; idleScaleMinutes?: number };
		};
		/** 动态调度(照 akashic energy.py):活跃拉长间隔,离线缩短。 */
		schedule?: {
			enabled?: boolean;
			idleIntervalMs?: number;
			activeIntervalMs?: number;
			threshold?: number;
			jitter?: number;
		};
		/** 画像反馈:not_interesting 理由提炼进画像排除项。 */
		profileRefine?: {
			enabled?: boolean;
			minNew?: number;
			minIntervalMs?: number;
			maxReasons?: number;
		};
		/** Drift 闲时自主行动(照 akashic drift_flow)。 */
		drift?: {
			enabled?: boolean;
			minIntervalHours?: number;
			skillsDir?: string;
			maxRecentRuns?: number;
		};
	};
	/** 静默时段:非回复类主动推送(proactive/drift/定时/message_push)
	 *  在 [start, end) 小时内积压,到 end 点后补发。start/end 为本地时区小时(0-23)。 */
	quietHours?: {
		enabled?: boolean;
		start?: number;
		end?: number;
	};
}

const ENV_PREFIX = "GATEWAY_";

/** "FEISHU_APP_ID" -> "feishuAppId"。 */
function toCamel(name: string): string {
	return name.toLowerCase().replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

function parseEnvValue(value: string): unknown {
	if (value === "true") return true;
	if (value === "false") return false;
	if (/^-?\d+$/.test(value)) return Number(value);
	return value;
}

/** 用 GATEWAY_<CHANNEL>_<FIELD> 环境变量覆盖文件配置。 */
export function applyEnvOverrides(config: GatewayConfigFile): GatewayConfigFile {
	const channels = config.channels ?? {};
	const webSection = config.web ?? {};
	for (const [key, value] of Object.entries(process.env)) {
		if (!key.startsWith(ENV_PREFIX) || value === undefined) continue;
		const rest = key.slice(ENV_PREFIX.length);
		const sep = rest.indexOf("_");
		if (sep === -1) continue;
		const channel = toCamel(rest.slice(0, sep));
		const field = toCamel(rest.slice(sep + 1));
		if (!channel || !field) continue;
		// web 的 host/port/staticDir 属于顶层 web 段,不是 channels.web
		if (
			channel === "web" &&
			(field === "host" || field === "port" || field === "staticDir" || field === "uploadsDir")
		) {
			webSection[field] = parseEnvValue(value) as never;
			continue;
		}
		if (channel === "web" && (field === "tlsKeyFile" || field === "tlsCertFile" || field === "tlsCaFile")) {
			const tls = isRecord(webSection.tls) ? webSection.tls : {};
			const tlsKey = field === "tlsKeyFile" ? "keyFile" : field === "tlsCertFile" ? "certFile" : "caFile";
			webSection.tls = { ...tls, [tlsKey]: value } as ChannelTlsOptions;
			continue;
		}
		if (channels[channel] === undefined) {
			channels[channel] = {};
		}
		const section = channels[channel]!;
		if (field === "tlsKeyFile" || field === "tlsCertFile" || field === "tlsCaFile") {
			const tls = isRecord(section.tls) ? section.tls : {};
			const tlsKey = field === "tlsKeyFile" ? "keyFile" : field === "tlsCertFile" ? "certFile" : "caFile";
			section.tls = { ...tls, [tlsKey]: value };
		} else if (field === "authToken") {
			const auth = isRecord(section.auth) ? section.auth : {};
			section.auth = { ...auth, token: parseEnvValue(value) };
		} else if (field === "rateLimitMaxRequests" || field === "rateLimitWindowMs") {
			const rateLimit = isRecord(section.rateLimit) ? section.rateLimit : {};
			const rateKey = field === "rateLimitMaxRequests" ? "maxRequests" : "windowMs";
			section.rateLimit = { ...rateLimit, [rateKey]: parseEnvValue(value) };
		} else {
			section[field] = parseEnvValue(value);
		}
	}
	return { ...config, channels, web: webSection };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 读取网关配置文件(JSON)并应用环境变量覆盖。
 * @param path 配置文件路径;缺省用 GATEWAY_CONFIG 环境变量,再缺省用 cwd/config.json
 */
export function loadGatewayConfig(path?: string): GatewayConfigFile {
	const configPath = path ?? process.env.GATEWAY_CONFIG ?? resolve(process.cwd(), "config.json");
	let raw: string;
	try {
		raw = readFileSync(configPath, "utf-8");
	} catch (error) {
		throw new Error(`无法读取网关配置文件 ${configPath}: ${(error as Error).message}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new Error(`网关配置文件 ${configPath} 不是合法 JSON: ${(error as Error).message}`);
	}
	return applyEnvOverrides((parsed ?? {}) as GatewayConfigFile);
}

export interface GatewayConfigWatchOptions {
	/** Debounce bursts caused by atomic editor saves. Defaults to 150 ms. */
	debounceMs?: number;
	onError?: (error: Error) => void;
}

/** Watch a JSON config file and publish only successfully parsed snapshots. */
export class GatewayConfigWatcher {
	private readonly path: string;
	private readonly onConfig: (config: GatewayConfigFile) => void | Promise<void>;
	private readonly debounceMs: number;
	private readonly onError: ((error: Error) => void) | undefined;
	private watcher: FSWatcher | undefined;
	private timer: NodeJS.Timeout | undefined;
	private processing = false;
	private pending = false;
	private closed = false;

	constructor(
		path: string,
		onConfig: (config: GatewayConfigFile) => void | Promise<void>,
		options: GatewayConfigWatchOptions = {},
	) {
		this.path = resolve(path);
		this.onConfig = onConfig;
		this.debounceMs = positiveDuration(options.debounceMs, 150);
		this.onError = options.onError;
	}

	start(): void {
		if (this.watcher || this.closed) return;
		const directory = dirname(this.path);
		const filename = basename(this.path);
		this.watcher = watch(directory, { persistent: false }, (_eventType, changed) => {
			if (changed && changed.toString() !== filename) return;
			this.schedule();
		});
	}

	close(): void {
		this.closed = true;
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		this.watcher?.close();
		this.watcher = undefined;
	}

	private schedule(): void {
		if (this.closed) return;
		this.pending = true;
		if (this.processing || this.timer) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			void this.reload();
		}, this.debounceMs);
		this.timer.unref?.();
	}

	private async reload(): Promise<void> {
		if (this.closed || this.processing || !this.pending) return;
		this.pending = false;
		this.processing = true;
		try {
			await this.onConfig(loadGatewayConfig(this.path));
		} catch (error) {
			const normalized = error instanceof Error ? error : new Error(String(error));
			this.onError?.(normalized);
		} finally {
			this.processing = false;
			if (this.pending) this.schedule();
		}
	}
}

export function watchGatewayConfig(
	path: string,
	onConfig: (config: GatewayConfigFile) => void | Promise<void>,
	options: GatewayConfigWatchOptions = {},
): GatewayConfigWatcher {
	const watcher = new GatewayConfigWatcher(path, onConfig, options);
	watcher.start();
	return watcher;
}

function positiveDuration(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}
