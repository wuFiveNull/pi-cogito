import type { MemoryScope, ToolDefinition } from "@cogito/host";
import { describe, expect, it, vi } from "vitest";
import { createProcedureInterceptorExtension } from "../src/extensions.ts";
import { ProcedureTagger, type ProcedureTaggerLlm, parseProcedureOutput } from "../src/memory/procedure-tagger.ts";
import type { ChatMemory } from "../src/memory.ts";

const SCOPE: MemoryScope = { channel: "c", chatId: "1" };

function makeLlm(respond: () => string | Promise<string>): ProcedureTaggerLlm {
	return { chat: vi.fn(async () => respond()) };
}

function makeMemory(overrides: Record<string, unknown> = {}): ChatMemory {
	return {
		engine: {},
		remember: vi.fn(async () => "new:proc1"),
		forget: vi.fn(() => ({ affected: [], missing: [] })),
		matchProcedure: vi.fn(async () => undefined),
		onMemoryWritten: vi.fn(() => () => {}),
		close: vi.fn(),
		...overrides,
	} as unknown as ChatMemory;
}

describe("parseProcedureOutput", () => {
	it("parses procedures with tools and keywords", () => {
		const result = parseProcedureOutput(
			'[{"summary": "查库存前先调用 steam_query", "tools": ["steam_query"], "keywords": ["库存", "steam"]}]',
		);
		expect(result).toEqual([
			{ summary: "查库存前先调用 steam_query", tools: ["steam_query"], keywords: ["库存", "steam"] },
		]);
	});

	it("returns [] for an empty array and tolerates fences", () => {
		expect(parseProcedureOutput("[]")).toEqual([]);
		expect(parseProcedureOutput("```json\n[]\n```")).toEqual([]);
	});

	it("throws on structural errors", () => {
		expect(() => parseProcedureOutput("nope")).toThrow();
		expect(() => parseProcedureOutput('{"summary": "x"}')).toThrow();
	});
});

describe("ProcedureTagger", () => {
	it("writes procedures with trigger tags and respects per-scope rate limiting", async () => {
		const memory = makeMemory();
		const llm = makeLlm(
			() => '[{"summary": "查库存前先调用 steam_query", "tools": ["steam_query"], "keywords": ["库存"]}]',
		);
		const tagger = new ProcedureTagger({ llm, memory, minIntervalMs: 60_000 });
		expect(await tagger.run("以后查库存前先调用 steam_query", "assistant 回复", SCOPE)).toBe(true);
		expect(memory.remember).toHaveBeenCalledWith(
			expect.objectContaining({
				summary: "查库存前先调用 steam_query",
				memoryType: "procedure",
				extra: { trigger_tags: ["steam_query", "库存"], tagged_tools: ["steam_query"] },
			}),
		);
		// 同 scope 限流:不重复调用 LLM。
		expect(await tagger.run("以后查库存前先调用 steam_query", "again", SCOPE)).toBe(false);
		expect(llm.chat).toHaveBeenCalledTimes(1);
	});

	it("fails open and swallows LLM errors", async () => {
		const memory = makeMemory();
		const llm = makeLlm(() => {
			throw new Error("down");
		});
		const tagger = new ProcedureTagger({ llm, memory, log: () => undefined });
		expect(await tagger.run("消息", "回合", SCOPE)).toBe(false);
		expect(memory.remember).not.toHaveBeenCalled();
	});

	it("can be disabled", async () => {
		const memory = makeMemory();
		const llm = makeLlm(() => "[]");
		const tagger = new ProcedureTagger({ llm, memory, enabled: false });
		expect(await tagger.run("消息", "回合", SCOPE)).toBe(false);
		expect(llm.chat).not.toHaveBeenCalled();
	});
});

describe("createProcedureInterceptorExtension", () => {
	interface ExecArgs {
		toolCallId: string;
		params: Record<string, unknown>;
	}

	function makeTool(name: string): ToolDefinition & { execute: ReturnType<typeof vi.fn> } {
		const tool = {
			name,
			label: name,
			description: "tool",
			parameters: { type: "object" as const, properties: {} },
			execute: vi.fn(async () => ({ content: [{ type: "text" as const, text: "原结果" }], details: undefined })),
		};
		return tool as unknown as ToolDefinition & { execute: ReturnType<typeof vi.fn> };
	}

	function makePi() {
		const handlers: Record<string, (event: never) => void> = {};
		return {
			on: (event: string, handler: (event: never) => void) => {
				handlers[event] = handler;
			},
			handlers,
		};
	}

	it("blocks execution for negative rules and hints for positive ones", async () => {
		const negative = makeMemory({
			matchProcedure: vi.fn(async () => ({
				id: "p1",
				memoryType: "procedure",
				summary: "不要直接使用 web_fetch 抓取,先搜",
				sourceRef: "s",
				happenedAt: null,
				score: 0.9,
			})),
		});
		const tool = makeTool("web_fetch");
		const originalExecute = tool.execute;
		const pi = makePi();
		createProcedureInterceptorExtension(
			negative,
			{ sessionKey: "k", channel: "c", chatId: "1" },
			{ tools: [tool] },
		)(pi as never);
		const args: ExecArgs = { toolCallId: "t1", params: { url: "https://x" } };
		const result = await tool.execute(args.toolCallId, args.params, undefined, undefined, undefined as never);
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("过程记忆拦截");
		expect(text).toContain("不要直接使用 web_fetch");
		// 负向拦截:原 execute 未被调用。
		expect(originalExecute).not.toHaveBeenCalled();
	});

	it("passes through when no procedure matches", async () => {
		const memory = makeMemory();
		const tool = makeTool("web_fetch");
		const pi = makePi();
		createProcedureInterceptorExtension(
			memory,
			{ sessionKey: "k", channel: "c", chatId: "1" },
			{ tools: [tool] },
		)(pi as never);
		const args: ExecArgs = { toolCallId: "t1", params: { url: "https://x" } };
		const result = await tool.execute(args.toolCallId, args.params, undefined, undefined, undefined as never);
		expect(result.content[0]).toEqual({ type: "text", text: "原结果" });
	});
});
