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
}

export interface ChatMemoryConfig {
	/** Enable long-term memory (tools + per-turn injection). Default true. */
	enabled?: boolean;
	/** Memory database path. Default agentDir/memory/memory.sqlite. */
	dbPath?: string;
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
			? { enabled: optionalBoolean(chat.memory.enabled, true), dbPath: optionalString(chat.memory.dbPath) }
			: { enabled: true },
		web: isRecord(chat.web)
			? {
					enabled: optionalBoolean(chat.web.enabled, true),
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
			: { enabled: true },
		sessions: isRecord(chat.sessions)
			? {
					maxIdleMinutes: optionalNumber(chat.sessions.maxIdleMinutes, CHAT_DEFAULT_MAX_IDLE_MINUTES),
					maxSessions: optionalNumber(chat.sessions.maxSessions, CHAT_DEFAULT_MAX_SESSIONS),
				}
			: { maxIdleMinutes: CHAT_DEFAULT_MAX_IDLE_MINUTES, maxSessions: CHAT_DEFAULT_MAX_SESSIONS },
		schedule: isRecord(chat.schedule)
			? { enabled: optionalBoolean(chat.schedule.enabled, false) }
			: { enabled: false },
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

function optionalStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const items = value.filter((item): item is string => typeof item === "string" && item.length > 0);
	return items.length > 0 ? items : undefined;
}
