import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@cogito/agent-core";
import type { ContextEvent, ExtensionAPI } from "@cogito/host";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	buildContextFrameContent,
	buildStableMemoryBlock,
	CONTEXT_FRAME_MARKER,
	createMemoryInjectionExtension,
	memoryInjectionMode,
	trimRecentTurns,
} from "../src/extensions.ts";
import type { ChatMemory } from "../src/memory.ts";

const tempDirs: string[] = [];

function tempAgentDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "chat-ext-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("buildStableMemoryBlock", () => {
	it("injects SELF → MEMORY → RECENT_CONTEXT in order with full file contents", () => {
		const agentDir = tempAgentDir();
		const memoryDir = join(agentDir, "memory");
		mkdirSync(memoryDir, { recursive: true });
		writeFileSync(join(memoryDir, "SELF.md"), "# 助手自我认知\n\n## 人格与形象\n- 直接、温暖。", "utf-8");
		writeFileSync(join(memoryDir, "MEMORY.md"), "# 用户长期记忆\n\n## 用户事实\n- 用户是工程师", "utf-8");
		writeFileSync(
			join(memoryDir, "RECENT_CONTEXT.md"),
			"# Recent Context\n\n## Compression\nuntil: 2026-01-01\n- 最近持续关注：A\n\n## Ongoing Threads\n- 面试准备\n\n## Recent Turns\n- [user] 你好",
			"utf-8",
		);

		const block = buildStableMemoryBlock(agentDir);

		expect(block.indexOf("## 自我认知")).toBeLessThan(block.indexOf("## 长期记忆"));
		expect(block.indexOf("## 长期记忆")).toBeLessThan(block.indexOf("## 近期语境"));
		expect(block).toContain("- 直接、温暖。");
		expect(block).toContain("- 用户是工程师");
		// RECENT_CONTEXT 只保留 Compression/Ongoing Threads,裁掉 Recent Turns。
		expect(block).toContain("## Ongoing Threads");
		expect(block).toContain("- 面试准备");
		expect(block).not.toContain("## Recent Turns");
		expect(block).not.toContain("[user] 你好");
	});

	it("skips missing files and returns an empty block when nothing exists", () => {
		const agentDir = tempAgentDir();
		expect(buildStableMemoryBlock(agentDir)).toBe("");

		const memoryDir = join(agentDir, "memory");
		mkdirSync(memoryDir, { recursive: true });
		writeFileSync(join(memoryDir, "SELF.md"), "   ", "utf-8");
		expect(buildStableMemoryBlock(agentDir)).toBe("");
	});
});

describe("trimRecentTurns", () => {
	it("cuts the Recent Turns tail and keeps the compression sections", () => {
		const text = "## Compression\n- 最近持续关注：A\n\n## Ongoing Threads\n- B\n\n## Recent Turns\n- [user] x";
		expect(trimRecentTurns(text)).toBe("## Compression\n- 最近持续关注：A\n\n## Ongoing Threads\n- B");
	});

	it("returns an empty string for missing or recent-turns-only content", () => {
		expect(trimRecentTurns(undefined)).toBe("");
		expect(trimRecentTurns("")).toBe("");
		expect(trimRecentTurns("## Recent Turns\n- [user] x")).toBe("");
	});
});

describe("buildContextFrameContent", () => {
	it("wraps the block in system-reminder markers with a candidate-context disclaimer", () => {
		const content = buildContextFrameContent("## 长期记忆\n- 用户是工程师");
		expect(content.startsWith(CONTEXT_FRAME_MARKER)).toBe(true);
		expect(content.endsWith("</system-reminder>")).toBe(true);
		expect(content).toContain("不是用户陈述");
		expect(content).toContain("## 长期记忆");
	});
});

describe("memoryInjectionMode", () => {
	it("degrades stepwise as context usage rises", () => {
		expect(memoryInjectionMode(undefined)).toBe("full");
		expect(memoryInjectionMode({ percent: null })).toBe("full");
		expect(memoryInjectionMode({ percent: 0.5 })).toBe("full");
		expect(memoryInjectionMode({ percent: 0.75 })).toBe("stable-only");
		expect(memoryInjectionMode({ percent: 0.9 })).toBe("self-only");
		expect(memoryInjectionMode({ percent: 0.98 })).toBe("none");
	});
});

describe("buildStableMemoryBlock levels", () => {
	it("injects only SELF.md at the self level", () => {
		const agentDir = tempAgentDir();
		const memoryDir = join(agentDir, "memory");
		mkdirSync(memoryDir, { recursive: true });
		writeFileSync(join(memoryDir, "SELF.md"), "# 助手自我认知\n\n## 人格与形象\n- 直接、温暖。", "utf-8");
		writeFileSync(join(memoryDir, "MEMORY.md"), "# 用户长期记忆\n\n## 用户事实\n- 用户是工程师", "utf-8");

		const full = buildStableMemoryBlock(agentDir);
		expect(full).toContain("## 长期记忆");

		const self = buildStableMemoryBlock(agentDir, "self");
		expect(self).toContain("## 自我认知");
		expect(self).not.toContain("## 长期记忆");
	});
});

describe("createMemoryInjectionExtension", () => {
	interface ContextEventResultLocal {
		messages?: AgentMessage[];
	}

	type ContextHandler = (
		event: ContextEvent,
	) => Promise<ContextEventResultLocal | undefined> | ContextEventResultLocal | undefined;

	function makePi(onContext: (handler: ContextHandler) => void) {
		return {
			on: (event: string, handler: unknown) => {
				if (event === "context") onContext(handler as ContextHandler);
			},
		} as unknown as ExtensionAPI;
	}

	it("inserts a context frame right before the last user message", async () => {
		const memory = {
			recall: vi.fn(async () => [
				{
					id: "mem1",
					memoryType: "event",
					summary: "用户完成了迁移",
					sourceRef: "s",
					happenedAt: null,
					score: 0.9,
				},
			]),
			onMemoryWritten: vi.fn(() => () => {}),
			engine: undefined,
			remember: vi.fn(),
			forget: vi.fn(() => ({ affected: [], missing: [] })),
			close: vi.fn(),
		} as unknown as ChatMemory;
		let handler: ContextHandler | undefined;
		const pi = makePi((h) => {
			handler = h;
		});
		createMemoryInjectionExtension(
			memory,
			{ sessionKey: "k", channel: "c", chatId: "1" },
			{
				agentDir: "/nonexistent",
				injectProfile: false,
			},
		)(pi);

		const messages: AgentMessage[] = [
			{ role: "user", content: "第一条", timestamp: 1 },
			{ role: "user", content: "第二条", timestamp: 3 },
		];
		const result = (await handler?.({ type: "context", messages })) as ContextEventResultLocal | undefined;
		expect(result).toBeDefined();
		if (!result) throw new Error("expected a context event result");
		const outMessages = result.messages;
		expect(outMessages).toHaveLength(3);
		// frame 位于最后一条 user 消息之前,原消息内容不被篡改。
		expect(outMessages?.[2]).toMatchObject({ role: "user", content: "第二条" });
		const frame = outMessages?.[1] as { role: "user"; content: string } | undefined;
		expect(frame).toBeDefined();
		if (!frame) throw new Error("expected a frame message");
		expect(frame.role).toBe("user");
		expect(frame.content).toContain(CONTEXT_FRAME_MARKER);
		// 富注入块:类型标签 + 摘要,而非旧 recallBlock 原始文本。
		expect(frame.content).toContain("## 记忆检索");
		expect(frame.content).toContain("- [mem1] (事件) 用户完成了迁移");
		expect(frame.content).not.toContain("第一条");
	});

	it("invalidates the recall cache when memory is written in the same scope", async () => {
		const listeners: Array<(event: { scope?: { channel: string; chatId: string } }) => void> = [];
		const memory = {
			recall: vi.fn(async () => [
				{
					id: "mem1",
					memoryType: "event",
					summary: "旧结果",
					sourceRef: "",
					happenedAt: null,
					score: 0.9,
				},
			]),
			onMemoryWritten: vi.fn((listener: (event: { scope?: { channel: string; chatId: string } }) => void) => {
				listeners.push(listener);
				return () => {};
			}),
			engine: undefined,
			remember: vi.fn(),
			forget: vi.fn(() => ({ affected: [], missing: [] })),
			close: vi.fn(),
		} as unknown as ChatMemory;
		let handler: ContextHandler | undefined;
		const pi = makePi((h) => {
			handler = h;
		});
		createMemoryInjectionExtension(
			memory,
			{ sessionKey: "k", channel: "c", chatId: "1" },
			{
				agentDir: "/nonexistent",
				injectProfile: false,
			},
		)(pi);

		const messages: AgentMessage[] = [{ role: "user", content: "查询", timestamp: 1 }];
		const first = (await handler?.({ type: "context", messages })) as ContextEventResultLocal | undefined;
		expect(first?.messages).toBeDefined();
		// 同一 query 第二次命中缓存(不再调用 recall)。
		await handler?.({ type: "context", messages });
		expect(memory.recall).toHaveBeenCalledTimes(1);
		// 同 scope 记忆写入 → 缓存失效 → 下一次重新检索。
		listeners[0]?.({ scope: { channel: "c", chatId: "1" } });
		await handler?.({ type: "context", messages });
		expect(memory.recall).toHaveBeenCalledTimes(2);
		// 不同 scope 写入不影响本会话缓存。
		listeners[0]?.({ scope: { channel: "other", chatId: "9" } });
		await handler?.({ type: "context", messages });
		expect(memory.recall).toHaveBeenCalledTimes(2);
	});

	it("skips the vector recall on history-route skip but still injects the stable profile", async () => {
		const agentDir = tempAgentDir();
		const memoryDir = join(agentDir, "memory");
		mkdirSync(memoryDir, { recursive: true });
		writeFileSync(join(memoryDir, "MEMORY.md"), "# 用户长期记忆\n\n## 用户事实\n- 用户是工程师", "utf-8");
		const memory = {
			recall: vi.fn(async () => []),
			onMemoryWritten: vi.fn(() => () => {}),
			engine: undefined,
			remember: vi.fn(),
			forget: vi.fn(() => ({ affected: [], missing: [] })),
			close: vi.fn(),
		} as unknown as ChatMemory;
		let handler: ContextHandler | undefined;
		const pi = makePi((h) => {
			handler = h;
		});
		createMemoryInjectionExtension(
			memory,
			{ sessionKey: "k", channel: "c", chatId: "1" },
			{
				agentDir,
				injectProfile: true,
				historyRoute: {
					decide: async () => ({ decision: "skip", query: "" }),
				} as never,
			},
		)(pi);

		const messages: AgentMessage[] = [{ role: "user", content: "早上好", timestamp: 1 }];
		const result = (await handler?.({ type: "context", messages })) as ContextEventResultLocal | undefined;
		// skip:不发起向量检索。
		expect(memory.recall).not.toHaveBeenCalled();
		// 稳定档案仍注入。
		expect(result).toBeDefined();
		const frame = result?.messages?.[0] as { content: string } | undefined;
		expect(frame?.content).toContain("## 长期记忆");
		expect(frame?.content).toContain("- 用户是工程师");
	});

	it("does not inject a second frame when one is already present", async () => {
		const memory = {
			recall: vi.fn(async () => []),
			onMemoryWritten: vi.fn(() => () => {}),
			engine: undefined,
			remember: vi.fn(),
			forget: vi.fn(() => ({ affected: [], missing: [] })),
			close: vi.fn(),
		} as unknown as ChatMemory;
		let handler: ContextHandler | undefined;
		const pi = makePi((h) => {
			handler = h;
		});
		createMemoryInjectionExtension(
			memory,
			{ sessionKey: "k", channel: "c", chatId: "1" },
			{
				agentDir: "/nonexistent",
				injectProfile: false,
			},
		)(pi);

		const messages: AgentMessage[] = [
			{ role: "user", content: `${CONTEXT_FRAME_MARKER}\n候选上下文\n</system-reminder>`, timestamp: 1 },
			{ role: "user", content: "用户消息", timestamp: 2 },
		];
		const result = (await handler?.({ type: "context", messages })) as ContextEventResultLocal | undefined;
		expect(result).toBeUndefined();
	});

	it("skips injection when there is no user message", async () => {
		const memory = {
			recall: vi.fn(async () => []),
			onMemoryWritten: vi.fn(() => () => {}),
			engine: undefined,
			remember: vi.fn(),
			forget: vi.fn(() => ({ affected: [], missing: [] })),
			close: vi.fn(),
		} as unknown as ChatMemory;
		let handler: ContextHandler | undefined;
		const pi = makePi((h) => {
			handler = h;
		});
		createMemoryInjectionExtension(
			memory,
			{ sessionKey: "k", channel: "c", chatId: "1" },
			{
				agentDir: "/nonexistent",
				injectProfile: false,
			},
		)(pi);

		const messages: AgentMessage[] = [
			{
				role: "assistant",
				content: [{ type: "text", text: "只有助手消息" }],
				api: "openai",
				provider: "openai",
				model: "m",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 1,
			},
		];
		const result = await handler?.({ type: "context", messages });
		expect(result).toBeUndefined();
	});
});
