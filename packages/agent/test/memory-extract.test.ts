import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryBeforeTurnListener } from "../src/memory/before-turn.ts";
import {
	consolidateSession,
	FileCursorStore,
	formatConversation,
	formatPendingItems,
	limitWindowByChars,
	parseJsonLoose,
	readSessionJsonl,
	selectConsolidationWindow,
} from "../src/memory/extract.ts";
import { MarkdownMemoryStore } from "../src/memory/markdown-store.ts";
import type { MemoryLlm } from "../src/memory/optimizer.ts";
import type { AgentMessage } from "../src/types.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeStore(): MarkdownMemoryStore {
	const dir = mkdtempSync(join(tmpdir(), "extract-"));
	tempDirs.push(dir);
	return new MarkdownMemoryStore(dir);
}

function makeLlm(reply: string): MemoryLlm {
	return { chat: vi.fn(async () => reply) };
}

function writeSession(dir: string, count: number): string {
	const file = join(dir, "session.jsonl");
	const lines: string[] = [];
	for (let i = 0; i < count; i++) {
		lines.push(
			JSON.stringify({
				type: "message",
				id: `m${i}`,
				message: {
					role: i % 2 === 0 ? "user" : "assistant",
					content: `消息 ${i}`,
					timestamp: `2026-01-01T00:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}Z`,
				},
			}),
		);
	}
	writeFileSync(file, `${lines.join("\n")}\n`, "utf-8");
	return file;
}

describe("window selection (akashic _select_consolidation_window)", () => {
	const messages = Array.from({ length: 100 }, (_, i) => ({
		id: `m${i}`,
		role: i % 2 === 0 ? "user" : "assistant",
		content: `c${i}`,
	}));

	it("keeps the last keep_count messages and respects the cursor", () => {
		const window = selectConsolidationWindow({ messages, lastConsolidated: 0, keepCount: 50, minNewMessages: 25 });
		expect(window).not.toBeNull();
		expect(window!.oldMessages.length).toBe(50);
		expect(window!.consolidateUpTo).toBe(50);
	});

	it("returns null when not enough new messages", () => {
		const window = selectConsolidationWindow({ messages, lastConsolidated: 40, keepCount: 50, minNewMessages: 25 });
		// 40..50 = 10 条 < 25。
		expect(window).toBeNull();
	});

	it("returns null when nothing is new", () => {
		const window = selectConsolidationWindow({ messages, lastConsolidated: 100, keepCount: 50, minNewMessages: 25 });
		expect(window).toBeNull();
	});
});

describe("conversation formatting", () => {
	it("formats role/timestamp lines and skips tools", () => {
		const text = formatConversation([
			{ role: "user", content: "你好", timestamp: "2026-01-01T00:00:00Z" },
			{ role: "assistant", content: "你好！", timestamp: "2026-01-01T00:00:01Z" },
			{ role: "tool", content: "x" },
		]);
		expect(text).toBe("[2026-01-01T00:00] USER: 你好\n[2026-01-01T00:00] ASSISTANT: 你好！");
	});

	it("limitWindowByChars keeps semantic turn groups intact", () => {
		const messages = Array.from({ length: 20 }, (_, i) => ({
			id: `m${i}`,
			role: i % 2 === 0 ? "user" : "assistant",
			content: "x".repeat(100),
		}));
		const window = { oldMessages: messages, consolidateUpTo: 20 };
		const limited = limitWindowByChars(window, 500);
		// 每回合 2 条 × 100 字符:500 字符装 2 个完整回合。
		expect(limited.selected.length).toBe(4);
		expect(limited.consolidateUpTo).toBe(4);
	});
});

describe("pending_items validation (akashic _format_pending_items)", () => {
	it("formats and dedupes valid items, drops unknown tags", () => {
		const text = formatPendingItems([
			{ tag: "identity", content: "用户是工程师" },
			{ tag: "identity", content: "用户是工程师" },
			{ tag: "bogus", content: "x" },
			{ tag: "preference", content: " 偏好简洁 " },
		]);
		expect(text).toBe("- [identity] 用户是工程师\n- [preference] 偏好简洁");
	});

	it("rejects non-array or malformed entries", () => {
		expect(() => formatPendingItems({})).toThrow();
		expect(() => formatPendingItems([{ tag: 1, content: "x" }])).toThrow();
	});
});

describe("parseJsonLoose", () => {
	it("parses fenced and embedded JSON", () => {
		expect(parseJsonLoose('{"pending_items": []}')).toEqual({ pending_items: [] });
		expect(parseJsonLoose('```json\n{"a": 1}\n```')).toEqual({ a: 1 });
		expect(parseJsonLoose('说明文字 {"a": 1} 结尾')).toEqual({ a: 1 });
		expect(parseJsonLoose("不是 JSON")).toBeUndefined();
	});
});

describe("consolidateSession", () => {
	it("extracts pending items and advances the cursor", async () => {
		const dir = mkdtempSync(join(tmpdir(), "extract-sess-"));
		tempDirs.push(dir);
		const store = makeStore();
		const file = writeSession(dir, 100);
		const llm = makeLlm(JSON.stringify({ pending_items: [{ tag: "identity", content: "用户是工程师" }] }));
		const cursorStore = new FileCursorStore(store.memoryDir);

		const result = await consolidateSession({
			store,
			llm,
			sessionFile: file,
			cursorStore,
			config: { keepCount: 50, minNewMessages: 25 },
		});

		expect(result.consolidated).toBe(50);
		expect(result.cursor).toBe(50);
		expect(cursorStore.getCursor(file)).toBe(50);
		expect(store.readPending()).toContain("- [identity] 用户是工程师");
		store.close();
	});

	it("is idempotent per window: same window never extracts twice", async () => {
		const dir = mkdtempSync(join(tmpdir(), "extract-sess2-"));
		tempDirs.push(dir);
		const store = makeStore();
		const file = writeSession(dir, 100);
		const llm = makeLlm(JSON.stringify({ pending_items: [{ tag: "preference", content: "偏好 A" }] }));
		const cursorStore = new FileCursorStore(store.memoryDir);
		const config = { keepCount: 50, minNewMessages: 25 };

		const first = await consolidateSession({ store, llm, sessionFile: file, cursorStore, config });
		expect(first.consolidated).toBe(50);
		// 游标已到 50,再次 consolidation 无新窗口。
		const second = await consolidateSession({ store, llm, sessionFile: file, cursorStore, config });
		expect(second.consolidated).toBe(0);
		expect(store.readPending()).toContain("偏好 A");
		store.close();
	});

	it("advances the cursor when nothing is extractable", async () => {
		const dir = mkdtempSync(join(tmpdir(), "extract-sess3-"));
		tempDirs.push(dir);
		const store = makeStore();
		const file = writeSession(dir, 100);
		const llm = makeLlm(JSON.stringify({ pending_items: [] }));
		const cursorStore = new FileCursorStore(store.memoryDir);

		const result = await consolidateSession({
			store,
			llm,
			sessionFile: file,
			cursorStore,
			config: { keepCount: 50, minNewMessages: 25 },
		});
		expect(result.consolidated).toBe(50);
		expect(store.readPending()).toBe("");
		store.close();
	});

	it("does not advance the cursor when extraction fails", async () => {
		const dir = mkdtempSync(join(tmpdir(), "extract-sess4-"));
		tempDirs.push(dir);
		const store = makeStore();
		const file = writeSession(dir, 100);
		const llm = makeLlm("不是 JSON");
		const cursorStore = new FileCursorStore(store.memoryDir);

		await expect(
			consolidateSession({
				store,
				llm,
				sessionFile: file,
				cursorStore,
				config: { keepCount: 50, minNewMessages: 25 },
			}),
		).rejects.toThrow();
		expect(cursorStore.getCursor(file)).toBe(0); // 游标不推进,下轮重试
		store.close();
	});

	it("reads session jsonl with array content blocks", () => {
		const dir = mkdtempSync(join(tmpdir(), "extract-read-"));
		tempDirs.push(dir);
		const file = join(dir, "s.jsonl");
		writeFileSync(
			file,
			`${JSON.stringify({
				type: "message",
				id: "a",
				message: {
					role: "user",
					content: [
						{ type: "text", text: "块1" },
						{ type: "text", text: "块2" },
					],
					timestamp: "2026-01-01T00:00:00Z",
				},
			})}\n`,
			"utf-8",
		);
		const messages = readSessionJsonl(file);
		expect(messages).toHaveLength(1);
		expect(messages[0]?.id).toBe("a");
	});
});

describe("before_turn memory listener", () => {
	it("extracts completed in-memory messages on later turns", async () => {
		const store = makeStore();
		const llm = makeLlm(JSON.stringify({ pending_items: [{ tag: "identity", content: "用户是工程师" }] }));
		const listener = createMemoryBeforeTurnListener({
			store,
			llm,
			sessionId: "session-1",
			config: { force: true, minNewMessages: 1 },
		});
		const userMessage = {
			role: "user",
			content: [{ type: "text", text: "我是工程师" }],
			timestamp: Date.now(),
		} satisfies AgentMessage;
		const event = {
			type: "before_turn" as const,
			context: { systemPrompt: "", messages: [userMessage] },
			newMessages: [userMessage],
			turnIndex: 1,
		};

		await listener({ ...event, turnIndex: 0 });
		expect(llm.chat).not.toHaveBeenCalled();
		await listener(event);
		await listener(event);

		expect(llm.chat).toHaveBeenCalledTimes(1);
		expect(store.readPending()).toContain("用户是工程师");
		store.close();
	});
});
