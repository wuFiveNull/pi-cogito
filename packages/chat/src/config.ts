/**
 * Chat module configuration (config.json "chat" section).
 *
 * The gateway config file may carry a top-level "chat" object; this module
 * reads it directly from the file (GatewayConfigFile does not model it) and
 * falls back to defaults that reproduce the legacy cogito-gateway behavior.
 */

import { readFileSync } from "node:fs";

export interface ChatToolConfig {
	/** Only these tool names are exposed to the agent. */
	allowed?: string[];
	/** These tool names are removed (applies after `allowed`). */
	excluded?: string[];
}

export interface ChatWebFetchConfig {
	/** Max characters returned from web_fetch. Default 8000. */
	maxChars?: number;
	/** Max redirect hops (0 = no redirects). Default 0. */
	maxRedirectHops?: number;
	/** Request timeout in ms. Default 60000. */
	timeoutMs?: number;
}

export interface ChatWebSearchConfig {
	/** Search endpoint URL (Bing-style: q/count params). Unset disables web_search. */
	url?: string;
	/** Optional bearer token for the search endpoint. */
	apiKey?: string;
}

export interface ChatWebConfig {
	enabled?: boolean;
	fetch?: ChatWebFetchConfig;
	search?: ChatWebSearchConfig;
	/** Permit private/loopback web destinations (e.g. a local SearXNG). Default false. */
	allowPrivateNetwork?: boolean;
}

export interface ChatMemoryConfig {
	/** Enable long-term memory (tools + per-turn injection). Default true. */
	enabled?: boolean;
	/** Memory database path. Default agentDir/memory/memory.sqlite. */
	dbPath?: string;
	/** Inject the stable memory files (SELF/MEMORY/RECENT_CONTEXT) each turn. Default true. */
	injectProfile?: boolean;
	/** 历史路由门控(RETRIEVE/NO_RETRIEVE,轻模型判断是否检索)。默认 true。 */
	historyRoute?: boolean;
}

export interface ChatSessionsConfig {
	/** Dispose a session after it stays idle for this many minutes. Default 30. */
	maxIdleMinutes?: number;
	/** Max resident sessions; idle ones are evicted LRU. Default 50. */
	maxSessions?: number;
}

export interface ChatScheduleConfig {
	/**
	 * Register the schedule/list_schedules/cancel_schedule tools. Default false.
	 * Also enabled implicitly when chat.tools.allowed lists any of them.
	 */
	enabled?: boolean;
}

export interface ChatContextBudgetConfig {
	/** 预算闸门总开关。默认 true。 */
	enabled?: boolean;
	/** 超限阈值(占上下文窗口比例)。默认 0.95。 */
	hardPercent?: number;
	/** 消息裁剪后保留的最近条数。默认 40。 */
	keepRecentMessages?: number;
	/** 工具裁剪的保留集(工具名)。默认 CHAT_DEFAULT_TOOLS。 */
	essentialTools?: string[];
}

export interface ChatContextConfig {
	/** 上下文预算闸门:超限时裁消息/裁工具(akashic ContextTrimPlan 等价)。 */
	budget?: ChatContextBudgetConfig;
}

export interface ChatConfig {
	/** Model reference (provider/id pattern) for chat sessions. */
	model?: string;
	/** Default provider (used with model). */
	provider?: string;
	/** Thinking level: off|minimal|low|medium|high. */
	thinkingLevel?: string;
	/** Forward assistant deltas to streaming-capable channels. Default true. */
	streaming?: boolean;
	tools?: ChatToolConfig;
	memory?: ChatMemoryConfig;
	web?: ChatWebConfig;
	sessions?: ChatSessionsConfig;
	schedule?: ChatScheduleConfig;
	/** Merge backlog: when > 0, messages arriving while a turn is in flight are
	 *  merged into one reply after the current turn finishes. 0 disables merging. */
	mergeWindowMs?: number;
	context?: ChatContextConfig;
	/** Chat extension directory (absolute, or relative to the agent dir). */
	extensionsDir?: string;
	/** Persona text appended to the system prompt (akashic VEDA equivalent). */
	persona?: string;
}

/** Chat tools enabled by default (schedule tools stay opt-in). */
export const CHAT_DEFAULT_TOOLS = [
	"message_push",
	"web_fetch",
	"web_search",
	"memorize",
	"recall_memory",
	"forget_memory",
	"fetch_messages",
	"search_messages",
	"load_skill",
] as const;

/** Schedule tools: opt-in via chat.tools.allowed. */
export const CHAT_SCHEDULE_TOOLS = ["schedule", "list_schedules", "cancel_schedule"] as const;

export const CHAT_DEFAULT_MAX_IDLE_MINUTES = 30;
export const CHAT_DEFAULT_MAX_SESSIONS = 50;
export const CHAT_DEFAULT_KEEP_RECENT_MESSAGES = 40;

export function loadChatConfig(configPath: string): ChatConfig {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(configPath, "utf-8"));
	} catch {
		raw = undefined;
	}
	const chat = isRecord(raw) && isRecord(raw.chat) ? raw.chat : {};
	return {
		model: optionalString(chat.model),
		provider: optionalString(chat.provider),
		thinkingLevel: optionalString(chat.thinkingLevel),
		streaming: optionalBoolean(chat.streaming, true),
		tools: isRecord(chat.tools)
			? { allowed: optionalStringArray(chat.tools.allowed), excluded: optionalStringArray(chat.tools.excluded) }
			: undefined,
		memory: isRecord(chat.memory)
			? {
					enabled: optionalBoolean(chat.memory.enabled, true),
					dbPath: optionalString(chat.memory.dbPath),
					injectProfile: optionalBoolean(chat.memory.injectProfile, true),
					historyRoute: optionalBoolean(chat.memory.historyRoute, true),
				}
			: { enabled: true, injectProfile: true, historyRoute: true },
		web: isRecord(chat.web)
			? {
					enabled: optionalBoolean(chat.web.enabled, true),
					allowPrivateNetwork: optionalBoolean(chat.web.allowPrivateNetwork, false),
					fetch: isRecord(chat.web.fetch)
						? {
								maxChars: optionalNumber(chat.web.fetch.maxChars),
								maxRedirectHops: optionalNumber(chat.web.fetch.maxRedirectHops),
								timeoutMs: optionalNumber(chat.web.fetch.timeoutMs),
							}
						: undefined,
					search: isRecord(chat.web.search)
						? { url: optionalString(chat.web.search.url), apiKey: optionalString(chat.web.search.apiKey) }
						: undefined,
				}
			: { enabled: true, allowPrivateNetwork: false },
		sessions: isRecord(chat.sessions)
			? {
					maxIdleMinutes: optionalNumber(chat.sessions.maxIdleMinutes, CHAT_DEFAULT_MAX_IDLE_MINUTES),
					maxSessions: optionalNumber(chat.sessions.maxSessions, CHAT_DEFAULT_MAX_SESSIONS),
				}
			: { maxIdleMinutes: CHAT_DEFAULT_MAX_IDLE_MINUTES, maxSessions: CHAT_DEFAULT_MAX_SESSIONS },
		schedule: isRecord(chat.schedule)
			? { enabled: optionalBoolean(chat.schedule.enabled, false) }
			: { enabled: false },
		mergeWindowMs: optionalNumber(chat.mergeWindowMs, 0),
		context: isRecord(chat.context)
			? {
					budget: isRecord(chat.context.budget)
						? {
								enabled: optionalBoolean(chat.context.budget.enabled, true),
								hardPercent: optionalFraction(chat.context.budget.hardPercent, 0.95),
								keepRecentMessages: optionalNumber(
									chat.context.budget.keepRecentMessages,
									CHAT_DEFAULT_KEEP_RECENT_MESSAGES,
								),
								essentialTools: optionalStringArray(chat.context.budget.essentialTools),
							}
						: undefined,
				}
			: undefined,
		extensionsDir: optionalString(chat.extensionsDir),
		persona: optionalString(chat.persona),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalBoolean(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function optionalNumber(value: unknown, fallback?: number): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
	return Math.floor(value);
}

/** 小数配置(如 hardPercent=0.95):不做取整。 */
function optionalFraction(value: unknown, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value >= 1) return fallback;
	return value;
}

function optionalStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const items = value.filter((item): item is string => typeof item === "string" && item.length > 0);
	return items.length > 0 ? items : undefined;
}
