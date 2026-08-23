import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionMessageLike } from "../src/memory/extract.ts";
import { consolidateSession, FileCursorStore } from "../src/memory/extract.ts";
import { MarkdownMemoryStore } from "../src/memory/markdown-store.ts";
import type { MemoryLlm } from "../src/memory/optimizer.ts";
import {
	buildRecentContextPrompt,
	emptyCompression,
	extractCompressionFromText,
	formatRecentContextTurns,
	normalizeRecentContextCompression,
	recentTurnCount,
	refreshRecentContext,
	renderRecentContext,
} from "../src/memory/recent-context.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeStore(): MarkdownMemoryStore {
	const dir = mkdtempSync(join(tmpdir(), "recent-context-"));
	tempDirs.push(dir);
	return new MarkdownMemoryStore(dir);
}

function makeLlm(reply: string): MemoryLlm {
	return { chat: vi.fn(async () => reply) };
}

const VALID_PAYLOAD = JSON.stringify({
	active_topics: ["用户最近在讨论流式预取方案"],
	user_preferences: ["用户偏好零打扰的推送"],
	follow_ups: ["下周继续聊记忆系统"],
	avoidances: ["不要推荐深夜内容"],
	ongoing_threads: ["用户最近几天反复因面试受挫而情绪低落"],
});

describe("recent context normalization (akashic _normalize_recent_context_compression)", () => {
	it("parses all five fields and caps each at 3 items", () => {
		const compression = normalizeRecentContextCompression(JSON.parse(VALID_PAYLOAD) as unknown);
		expect(compression.activeTopics).toEqual(["用户最近在讨论流式预取方案"]);
		expect(compression.userPreferences).toEqual(["用户偏好零打扰的推送"]);
		expect(compression.followUps).toEqual(["下周继续聊记忆系统"]);
		expect(compression.avoidances).toEqual(["不要推荐深夜内容"]);
		expect(compression.ongoingThreads).toEqual(["用户最近几天反复因面试受挫而情绪低落"]);
	});

	it("trims to 3 items and strips empty strings", () => {
		const compression = normalizeRecentContextCompression({
			active_topics: ["a", "b", "c", "d", "", "e"],
		} as unknown);
		expect(compression.activeTopics).toEqual(["a", "b", "c"]);
		expect(compression.avoidances).toEqual([]);
	});

	it("rejects non-array fields", () => {
		expect(() => normalizeRecentContextCompression({ active_topics: "x" } as unknown)).toThrow("must be an array");
	});

	it("rejects non-string entries", () => {
		expect(() => normalizeRecentContextCompression({ active_topics: [1] } as unknown)).toThrow(
			"entries must be strings",
		);
	});

	it("rejects non-object payload", () => {
		expect(() => normalizeRecentContextCompression("nope")).toThrow("must be an object");
	});
});

describe("recent context rendering (akashic _render_recent_context)", () => {
	it("renders compression, ongoing threads and recent turns sections", () => {
		const text = renderRecentContext({
			compression: {
				activeTopics: ["主题A", "主题B"],
				userPreferences: ["偏好X"],
				followUps: [],
				avoidances: [],
				ongoingThreads: ["线索1"],
			},
			compressionUntil: "2026-01-02T10:00:00Z",
			recentTurns: "[user] 你好\n[a-preview] 你好，有什么可以帮你",
		});
		expect(text).toContain("# Recent Context");
		expect(text).toContain("## Compression");
		expect(text).toContain("until: 2026-01-02T10:00:00Z");
		expect(text).toContain("- 最近持续关注：主题A；主题B");
		expect(text).toContain("- 最近明确偏好：偏好X");
		expect(text).toContain("## Ongoing Threads");
		expect(text).toContain("- 线索1");
		expect(text).toContain("## Recent Turns");
		expect(text).toContain("[a-preview]");
	});

	it("renders - none when compression is empty", () => {
		const text = renderRecentContext({
			compression: emptyCompression(),
			compressionUntil: "",
			recentTurns: "",
		});
		expect(text).toContain("until: none");
		expect(text).toContain("- none");
	});

	it("round-trips through extractCompressionFromText", () => {
		const compression = {
			activeTopics: ["话题一"],
			userPreferences: ["偏好二", "偏好三"],
			followUps: [],
			avoidances: ["避免事项"],
			ongoingThreads: ["线索四"],
		};
		const text = renderRecentContext({
			compression,
			compressionUntil: "2026-01-02T10:00:00Z",
			recentTurns: "[user] 嗨",
		});
		const extracted = extractCompressionFromText(text);
		expect(extracted).not.toBeNull();
		expect(extracted?.activeTopics).toEqual(["话题一"]);
		expect(extracted?.userPreferences).toEqual(["偏好二", "偏好三"]);
		expect(extracted?.avoidances).toEqual(["避免事项"]);
		expect(extracted?.ongoingThreads).toEqual(["线索四"]);
	});

	it("returns null for empty text", () => {
		expect(extractCompressionFromText("")).toBeNull();
	});
});

describe("recent turns formatting (akashic _format_recent_context_messages)", () => {
	it("keeps full user text and 60-char assistant previews, skips tools and proactive", () => {
		const messages: SessionMessageLike[] = [
			{ role: "user", content: "今天聊一下记忆系统", timestamp: "t1" },
			{
				role: "assistant",
				content: "好的，记忆系统包括两层：markdown 档案层和向量层，我们慢慢展开讨论。",
				timestamp: "t2",
			},
			{ role: "tool", content: "unused", timestamp: "t3" },
			{ role: "assistant", content: "被跳过的主动推送", timestamp: "t4", proactive: true },
		];
		const text = formatRecentContextTurns(messages);
		expect(text).toContain("[user] 今天聊一下记忆系统");
		expect(text).toContain("[a-preview] 好的，记忆系统包括两层：markdown 档案层和向量层，我们慢");
		expect(text).not.toContain("unused");
		expect(text).not.toContain("被跳过的主动推送");
	});
});

describe("recent context prompt", () => {
	it("embeds old context, conversation and recent turns", () => {
		const prompt = buildRecentContextPrompt({
			oldRecentContext: "旧压缩",
			conversation: "[2026-01-01] USER: 你好",
			recentTurns: "[user] 你好",
		});
		expect(prompt).toContain("旧压缩");
		expect(prompt).toContain("[2026-01-01] USER: 你好");
		expect(prompt).toContain("[user] 你好");
		expect(prompt).toContain("active_topics");
	});
});

describe("recentTurnCount", () => {
	it("keeps half the keep count, at least 1", () => {
		expect(recentTurnCount(50)).toBe(25);
		expect(recentTurnCount(2)).toBe(1);
	});
});

describe("refreshRecentContext integration", () => {
	it("writes rendered RECENT_CONTEXT.md on success", async () => {
		const store = makeStore();
		const llm = makeLlm(VALID_PAYLOAD);
		await refreshRecentContext({
			store,
			llm,
			messages: [{ role: "user", content: "你好", timestamp: "t1" }],
			conversation: "[t1] USER: 你好",
			compressionUntil: "t1",
		});
		const text = store.readRecentContext();
		expect(text).toContain("# Recent Context");
		expect(text).toContain("until: t1");
		expect(text).toContain("用户最近在讨论流式预取方案");
		expect(text).toContain("[user] 你好");
	});

	it("swallows failures and keeps the old file", async () => {
		const store = makeStore();
		store.writeRecentContext("旧内容\n");
		const llm = makeLlm("not json at all");
		await refreshRecentContext({ store, llm, messages: [], conversation: "x", compressionUntil: "" });
		expect(store.readRecentContext()).toBe("旧内容\n");
	});
});

describe("consolidateSession with writeRecentContext", () => {
	it("writes RECENT_CONTEXT.md after extraction when enabled", async () => {
		const dir = mkdtempSync(join(tmpdir(), "recent-context-session-"));
		tempDirs.push(dir);
		const sessionFile = join(dir, "channel:chat.jsonl");
		const lines = [
			JSON.stringify({
				type: "message",
				id: "m0",
				message: { role: "user", content: "你好", timestamp: "2026-01-01T00:00:00Z" },
			}),
			JSON.stringify({
				type: "message",
				id: "m1",
				message: {
					role: "assistant",
					content: "你好，有什么可以帮你",
					timestamp: "2026-01-01T00:00:05Z",
				},
			}),
		];
		writeFileSync(sessionFile, `${lines.join("\n")}\n`, "utf-8");
		const store = makeStore();
		const extractionReply = JSON.stringify({
			history_entries: [{ summary: "[2026-01-01 00:00] 用户问候", emotional_weight: 0 }],
			pending_items: [],
		});
		const llm = {
			chat: vi.fn(async (_system: string, user: string) =>
				user.includes("近期语境压缩代理") ? VALID_PAYLOAD : extractionReply,
			),
		} satisfies MemoryLlm;
		const cursorStore = new FileCursorStore(store.memoryDir);

		const result = await consolidateSession({
			store,
			llm,
			sessionFile,
			cursorStore,
			config: { force: true, minNewMessages: 1 },
			writeRecentContext: true,
		});
		expect(result.consolidated).toBe(2);
		expect(store.readRecentContext()).toContain("## Recent Turns");
		expect(store.readRecentContext()).toContain("[user] 你好");
		expect(store.readRecentContext()).toContain("用户最近在讨论流式预取方案");
	});

	it("skips recent context when disabled", async () => {
		const dir = mkdtempSync(join(tmpdir(), "recent-context-disabled-"));
		tempDirs.push(dir);
		const sessionFile = join(dir, "channel:chat.jsonl");
		writeFileSync(
			sessionFile,
			`${JSON.stringify({
				type: "message",
				id: "m0",
				message: { role: "user", content: "你好", timestamp: "2026-01-01T00:00:00Z" },
			})}\n`,
			"utf-8",
		);
		const store = makeStore();
		const llm = makeLlm(JSON.stringify({ history_entries: [], pending_items: [] }));
		const cursorStore = new FileCursorStore(store.memoryDir);
		await consolidateSession({
			store,
			llm,
			sessionFile,
			cursorStore,
			config: { force: true, minNewMessages: 1 },
			writeRecentContext: false,
		});
		expect(store.readRecentContext()).toBe("");
	});
});
