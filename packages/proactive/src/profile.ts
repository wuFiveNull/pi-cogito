/**
 * Interest profile — distill the user's interests from pi session history.
 *
 * Ported from akashic-agent's memory-driven personalization: periodically
 * read recent user messages from the session store, ask an LLM to distill an
 * interest profile, and save it to a JSON file that the proactive tick uses
 * instead of the static proactive.json "interests" string.
 *
 * Config (from proactive.json profile section):
 * {
 *   "enabled": true,
 *   "path": "proactive-pusher/interests.json",
 *   "sessionsDir": "/home/wu/.cogito/agent/sessions",
 *   "refreshHours": 24,
 *   "maxMessages": 50,
 *   "model": "deepseek-v4-flash"
 * }
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type ChatCompletionClient, OpenAICompatibleChatClient } from "@cogito/ai/chat";
import { type Clock, SystemClock } from "./clock.ts";
import { resolveApiKey } from "./llm.ts";

export interface ProfileConfig {
	enabled?: boolean;
	/** Output profile JSON path. */
	path?: string;
	/** Directory containing session .jsonl files. */
	sessionsDir?: string;
	/** Refresh when the profile is older than this many hours. */
	refreshHours?: number;
	/** Max user messages distilled per refresh. */
	maxMessages?: number;
	/** Max chars kept per user message. */
	maxCharsPerMessage?: number;
	/** Max session files scanned (newest first). */
	maxSessionFiles?: number;
	model?: string;
	apiBaseUrl?: string;
	apiKey?: string;
	/** 宿主注入的 ChatCompletionClient(pi-host ModelRuntime);缺省走配置式客户端。 */
	client?: ChatCompletionClient;
	/** 可注入时钟(测试/回放用)。 */
	clock?: Clock;
}

export interface InterestProfile {
	interests: string;
	exclusions: string;
	generatedAt: number;
	messageCount: number;
}

const DEFAULT_SESSIONS_DIR = join(homedir(), ".cogito", "agent", "sessions");
const PROFILE_PROMPT = `你是一个用户兴趣分析师。下面是用户与 AI 助手的对话中用户发出的消息(可能夹杂技术讨论与日常闲聊)。

请提炼用户的兴趣画像,只输出 JSON(不要输出其他内容):
{"interests": "3-5 句中文,描述用户关注什么,具体到技术栈/领域/主题", "exclusions": "用户明确不感兴趣或很少涉及的内容"}

规则:
- 只依据用户实际说过的话,不要臆测。
- 技术话题要具体(例如:Python 后端、LLM 应用、飞书机器人、开源项目)。
- 如果信息太少,interests 写"信息不足,按通用开发者兴趣判断"。`;

export function defaultProfilePath(): string {
	return join(process.cwd(), "proactive-pusher", "interests.json");
}

export function loadProfile(path: string): InterestProfile | undefined {
	try {
		if (!existsSync(path)) return undefined;
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<InterestProfile>;
		if (typeof parsed.interests !== "string") return undefined;
		return {
			interests: parsed.interests,
			exclusions: typeof parsed.exclusions === "string" ? parsed.exclusions : "",
			generatedAt: typeof parsed.generatedAt === "number" ? parsed.generatedAt : 0,
			messageCount: typeof parsed.messageCount === "number" ? parsed.messageCount : 0,
		};
	} catch {
		return undefined;
	}
}

export function saveProfile(path: string, profile: InterestProfile): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, JSON.stringify(profile, null, 2), "utf-8");
}

/**
 * Extract recent user messages from session files (newest sessions first).
 * Deduplicates identical messages; returns at most maxMessages.
 */
export function extractUserMessages(
	sessionsDir: string,
	maxMessages = 50,
	maxCharsPerMessage = 300,
	maxSessionFiles = 5,
): string[] {
	let files: string[] = [];
	try {
		// 会话目录可能直接放 .jsonl(单会话),也可能按项目分一层子目录。
		const candidates: string[] = [];
		for (const name of readdirSync(sessionsDir)) {
			const full = join(sessionsDir, name);
			if (name.endsWith(".jsonl")) {
				candidates.push(full);
			} else if (statSync(full).isDirectory()) {
				for (const inner of readdirSync(full)) {
					if (inner.endsWith(".jsonl")) candidates.push(join(full, inner));
				}
			}
		}
		files = candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs).slice(0, maxSessionFiles);
	} catch {
		return [];
	}

	const messages: string[] = [];
	const seen = new Set<string>();
	for (const file of files) {
		let lines: string[];
		try {
			lines = readFileSync(file, "utf-8").split("\n");
		} catch {
			continue;
		}
		// 每文件只取最近的 user 消息,避免长会话占满配额
		const userTexts: string[] = [];
		for (const line of lines) {
			let entry: { type?: string; message?: { role?: string; content?: Array<{ type?: string; text?: string }> } };
			try {
				entry = JSON.parse(line) as typeof entry;
			} catch {
				continue;
			}
			if (entry.type !== "message" || entry.message?.role !== "user") continue;
			const text = (entry.message.content ?? [])
				.filter((block) => block.type === "text")
				.map((block) => block.text ?? "")
				.join("")
				.trim();
			if (text.length >= 2) userTexts.push(text);
		}
		for (const text of userTexts.slice(-20)) {
			if (seen.has(text)) continue;
			seen.add(text);
			messages.push(text.length > maxCharsPerMessage ? `${text.slice(0, maxCharsPerMessage)}…` : text);
			if (messages.length >= maxMessages) return messages;
		}
	}
	return messages;
}

/** Ask the LLM to distill an interest profile from user messages. Throws on failure. */
export async function generateProfile(messages: string[], config: ProfileConfig): Promise<InterestProfile> {
	const clock = config.clock ?? SystemClock;
	const apiKey = resolveApiKey(config);
	if (!config.client && !apiKey) throw new Error("profile: no API key");
	const model = config.model ?? "deepseek-v4-flash";
	const baseUrl = config.apiBaseUrl ?? "https://opencode.ai/zen/go/v1";
	const userContent = `【用户消息】\n${messages.map((text, index) => `${index + 1}. ${text}`).join("\n")}\n\n请提炼兴趣画像并输出 JSON。`;
	const client =
		config.client ??
		new OpenAICompatibleChatClient({ model, baseUrl, apiKey: apiKey ?? "", requestTimeoutMs: 120_000 });
	const response = await client.complete({
		messages: [
			{ role: "system", content: PROFILE_PROMPT },
			{ role: "user", content: userContent },
		],
		maxTokens: 1024,
		temperature: 0,
	});
	if (!response.content) throw new Error("profile: empty completion");

	let text = response.content.trim();
	const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
	if (fence) text = fence[1].trim();
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start === -1 || end === -1) throw new Error("profile: no JSON object in output");
	const parsed = JSON.parse(text.slice(start, end + 1)) as { interests?: unknown; exclusions?: unknown };
	if (typeof parsed.interests !== "string") throw new Error("profile: missing interests field");
	return {
		interests: parsed.interests,
		exclusions: typeof parsed.exclusions === "string" ? parsed.exclusions : "",
		generatedAt: clock.nowMs(),
		messageCount: messages.length,
	};
}

// 60s 内存缓存:多个 source 并发 fetch 时避免重复提炼。
let cachedProfile: { profile: InterestProfile; at: number } | undefined;

/**
 * Refresh the profile if stale (or missing) and any session file changed
 * since generation. Returns the current profile (old one on refresh failure).
 */
export async function maybeRefreshProfile(config: ProfileConfig): Promise<InterestProfile | undefined> {
	if (!config.enabled) return undefined;
	const clock = config.clock ?? SystemClock;
	const now = clock.nowMs();
	if (cachedProfile && now - cachedProfile.at < 60_000) return cachedProfile.profile;
	const path = config.path ?? defaultProfilePath();
	const existing = loadProfile(path);
	const refreshMs = (config.refreshHours ?? 24) * 3600 * 1000;
	if (existing && now - existing.generatedAt < refreshMs) return existing;

	// 画像过期:若没有任何 session 比画像新,不重提炼(避免无谓调用)。
	if (existing) {
		let sessionNewer = false;
		try {
			const dir = config.sessionsDir ?? DEFAULT_SESSIONS_DIR;
			for (const name of readdirSync(dir)) {
				const full = join(dir, name);
				if (name.endsWith(".jsonl")) {
					if (statSync(full).mtimeMs > existing.generatedAt) {
						sessionNewer = true;
						break;
					}
				} else if (statSync(full).isDirectory()) {
					for (const inner of readdirSync(full)) {
						if (inner.endsWith(".jsonl") && statSync(join(full, inner)).mtimeMs > existing.generatedAt) {
							sessionNewer = true;
							break;
						}
					}
				}
			}
		} catch {
			sessionNewer = true;
		}
		if (!sessionNewer) return existing;
	}

	const messages = extractUserMessages(
		config.sessionsDir ?? DEFAULT_SESSIONS_DIR,
		config.maxMessages,
		config.maxCharsPerMessage,
	);
	if (messages.length === 0) return existing;

	try {
		const profile = await generateProfile(messages, config);
		saveProfile(path, profile);
		cachedProfile = { profile, at: clock.nowMs() };
		console.log(`[profile] refreshed: ${profile.messageCount} messages -> ${path}`);
		return profile;
	} catch (error) {
		console.error(`[profile] refresh failed: ${error instanceof Error ? error.message : String(error)}`);
		return existing;
	}
}
