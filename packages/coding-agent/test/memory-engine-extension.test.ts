import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testAgentDirs: string[] = [];
let agentDir = "";
const { createMemoryEngineMock } = vi.hoisted(() => ({ createMemoryEngineMock: vi.fn() }));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
	const original = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
	return {
		...original,
		getAgentDir: () => agentDir,
		createMemoryEngine: createMemoryEngineMock,
	};
});

import memoryEngineExtension from "../examples/extensions/memory-engine.ts";

type ToolRegistration = {
	name: string;
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal?: unknown,
		onUpdate?: unknown,
		ctx?: unknown,
	) => Promise<{ content: Array<{ type: string; text: string }>; details?: unknown }>;
};

interface FakeEngine {
	store: {
		deleteItems: ReturnType<typeof vi.fn>;
	};
	retriever: {
		retrieve: ReturnType<typeof vi.fn>;
		buildInjectionBlock: ReturnType<typeof vi.fn>;
	};
	memorizer: {
		saveItemWithSupersede: ReturnType<typeof vi.fn>;
		saveFromConsolidation: ReturnType<typeof vi.fn>;
		supersedeBatch: ReturnType<typeof vi.fn>;
	};
	embedder: undefined;
	close: ReturnType<typeof vi.fn>;
}

function makeFakeEngine(): FakeEngine {
	return {
		store: { deleteItems: vi.fn().mockReturnValue({ affected: ["m1"], missing: [] }) },
		retriever: {
			retrieve: vi.fn().mockResolvedValue([]),
			buildInjectionBlock: vi.fn().mockReturnValue({ text: "", injectedIds: [] }),
		},
		memorizer: {
			saveItemWithSupersede: vi.fn().mockResolvedValue("new:m1"),
			saveFromConsolidation: vi.fn().mockResolvedValue({ eventStatus: "new:e1", updates: [] }),
			supersedeBatch: vi.fn().mockReturnValue(1),
		},
		embedder: undefined,
		close: vi.fn(),
	};
}

interface LoadedExtension {
	tools: Map<string, ToolRegistration>;
	commands: Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>;
	handlers: Map<string, (event: unknown, ctx?: unknown) => Promise<unknown> | unknown>;
}

function loadExtension(): LoadedExtension {
	const loaded: LoadedExtension = { tools: new Map(), commands: new Map(), handlers: new Map() };
	memoryEngineExtension({
		registerTool: (tool: ToolRegistration) => {
			loaded.tools.set(tool.name, tool);
		},
		registerCommand: (name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
			loaded.commands.set(name, options);
		},
		on: (event: string, handler: (event: unknown, ctx?: unknown) => Promise<unknown> | unknown) => {
			loaded.handlers.set(event, handler);
		},
	} as never);
	return loaded;
}

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "pi-memory-engine-"));
	testAgentDirs.push(agentDir);
	mkdirSync(join(agentDir, "memory"), { recursive: true });
	createMemoryEngineMock.mockReset();
	createMemoryEngineMock.mockResolvedValue(makeFakeEngine());
});

afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of testAgentDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("memory-engine extension tools", () => {
	it("registers recall_memory, memorize and forget_memory", () => {
		const { tools } = loadExtension();
		expect(tools.has("recall_memory")).toBe(true);
		expect(tools.has("memorize")).toBe(true);
		expect(tools.has("forget_memory")).toBe(true);
	});

	it("recall_memory returns typed hits from the fusion retriever", async () => {
		const { tools } = loadExtension();
		const engine = makeFakeEngine();
		engine.retriever.retrieve.mockResolvedValue([
			{ id: "m1", memoryType: "preference", summary: "用户偏好 vim", sourceRef: "", happenedAt: null, score: 0.91 },
		]);
		createMemoryEngineMock.mockResolvedValue(engine);

		const result = await tools.get("recall_memory")!.execute("call-1", { query: "vim", limit: 5 });
		expect(engine.retriever.retrieve).toHaveBeenCalledWith(
			"vim",
			expect.objectContaining({ topK: 5, timeStart: undefined }),
		);
		const parsed = JSON.parse(result.content[0]!.text) as {
			count: number;
			items: Array<{ id: string; memory_type: string }>;
		};
		expect(parsed.count).toBe(1);
		expect(parsed.items[0]?.memory_type).toBe("preference");
	});

	it("memorize writes with supersede maintenance and reports item_id", async () => {
		const { tools } = loadExtension();
		const engine = makeFakeEngine();
		engine.memorizer.saveItemWithSupersede.mockResolvedValue("merged:m1");
		createMemoryEngineMock.mockResolvedValue(engine);

		const result = await tools.get("memorize")!.execute("call-2", {
			summary: "部署必须使用 docker",
			memory_kind: "procedure",
			tool_requirement: "必须使用 docker",
		});
		expect(engine.memorizer.saveItemWithSupersede).toHaveBeenCalledWith(
			expect.objectContaining({
				summary: "部署必须使用 docker",
				memoryType: "procedure",
				extra: { tool_requirement: "必须使用 docker" },
			}),
		);
		expect(result.content[0]!.text).toContain("item_id=m1");
		expect(result.content[0]!.text).toContain("status=merged");
	});

	it("forget_memory soft-deletes the requested ids", async () => {
		const { tools } = loadExtension();
		const engine = makeFakeEngine();
		createMemoryEngineMock.mockResolvedValue(engine);

		const result = await tools.get("forget_memory")!.execute("call-3", { ids: ["m1", "m1"] });
		expect(engine.store.deleteItems).toHaveBeenCalledWith(["m1"]);
		const parsed = JSON.parse(result.content[0]!.text) as { superseded_ids: string[]; missing_ids: string[] };
		expect(parsed.superseded_ids).toEqual(["m1"]);
	});

	it("/remember command memorizes preferences and corrections", async () => {
		const { commands } = loadExtension();
		const engine = makeFakeEngine();
		createMemoryEngineMock.mockResolvedValue(engine);
		const notify = vi.fn();

		await commands.get("remember")!.handler("用户喜欢喝咖啡", { ui: { notify } });
		expect(engine.memorizer.saveItemWithSupersede).toHaveBeenCalledWith(
			expect.objectContaining({ memoryType: "preference" }),
		);

		await commands.get("remember")!.handler("更正:用户不喝咖啡了", { ui: { notify } });
		expect(engine.memorizer.saveItemWithSupersede).toHaveBeenCalledWith(
			expect.objectContaining({ memoryType: "profile", extra: { category: "correction" } }),
		);
		expect(notify).toHaveBeenCalledTimes(2);
	});
});

describe("memory-engine extension events", () => {
	it("injects a retrieval frame before the last user message", async () => {
		const { handlers } = loadExtension();
		const engine = makeFakeEngine();
		engine.retriever.retrieve.mockResolvedValue([
			{ id: "m1", memoryType: "preference", summary: "用户偏好 vim", sourceRef: "", happenedAt: null, score: 0.9 },
		]);
		engine.retriever.buildInjectionBlock.mockReturnValue({
			text: "## 【流程规范】用户偏好与规则\n- [m1] 用户偏好 vim",
			injectedIds: ["m1"],
		});
		createMemoryEngineMock.mockResolvedValue(engine);

		const messages = [
			{ role: "system", content: "sys", timestamp: 1 },
			{ role: "user", content: "我之前的偏好是什么", timestamp: 2 },
		];
		const result = (await handlers.get("context")!({ type: "context", messages }, undefined)) as {
			messages: Array<{ role: string; content: string; timestamp: number }>;
		};
		expect(result.messages.length).toBe(3);
		expect(result.messages[1]!.content).toContain("system-reminder");
		expect(result.messages[1]!.content).toContain("用户偏好 vim");
		expect(result.messages[2]!.content).toBe("我之前的偏好是什么");
		expect(engine.retriever.retrieve).toHaveBeenCalledWith("我之前的偏好是什么");
	});

	it("skips injection when the last message is not a user message", async () => {
		const { handlers } = loadExtension();
		const messages = [
			{ role: "user", content: "hi", timestamp: 1 },
			{ role: "assistant", content: "hello", timestamp: 2 },
		];
		const result = (await handlers.get("context")!({ type: "context", messages }, undefined)) as
			| {
					messages: Array<{ role: string }>;
			  }
			| undefined;
		expect(result).toBeUndefined();
		expect(createMemoryEngineMock).not.toHaveBeenCalled();
	});

	it("consolidates into memory on session_before_compact", async () => {
		writeFileSync(
			join(agentDir, "memory-engine.json"),
			JSON.stringify({ provider: "siliconflow", model: "m", baseUrl: "https://api.example.com/v1" }),
		);
		writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ siliconflow: { key: "sk-test" } }));
		const { handlers } = loadExtension();
		const engine = makeFakeEngine();
		createMemoryEngineMock.mockResolvedValue(engine);

		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({
				choices: [
					{
						message: {
							content:
								"<history_entry>\n[2026-05-01] 用户确定了部署方案\n</history_entry>\n<behavior_updates>\n- [preference] 部署优先使用 docker\n- [procedure] 发布前先跑测试(工具要求:必须使用 bash)\n</behavior_updates>",
						},
					},
				],
			}),
		});
		vi.stubGlobal("fetch", fetchMock);

		const result = await handlers.get("session_before_compact")!(
			{
				type: "session_before_compact",
				preparation: {
					messagesToSummarize: [
						{ role: "user", content: "我们用 docker 部署吧", timestamp: 1 },
						{ role: "assistant", content: "好的", timestamp: 2 },
					],
				},
			},
			undefined,
		);
		expect(result).toBeUndefined(); // Never blocks compaction.
		expect(engine.memorizer.saveFromConsolidation).toHaveBeenCalledWith(
			expect.objectContaining({
				historyEntry: "[2026-05-01] 用户确定了部署方案",
				behaviorUpdates: expect.arrayContaining([
					expect.objectContaining({ memoryType: "preference", summary: "部署优先使用 docker" }),
					expect.objectContaining({ memoryType: "procedure" }),
				]),
			}),
		);
		vi.unstubAllGlobals();
	});

	it("retires conflicting procedures when the user rejects a behavior", async () => {
		writeFileSync(
			join(agentDir, "memory-engine.json"),
			JSON.stringify({ provider: "siliconflow", model: "m", baseUrl: "https://api.example.com/v1" }),
		);
		writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ siliconflow: { key: "sk-test" } }));
		const { handlers } = loadExtension();
		const engine = makeFakeEngine();
		engine.retriever.retrieve.mockResolvedValue([
			{
				id: "old-proc",
				memoryType: "procedure",
				summary: "查 steam 必须先调工具",
				sourceRef: "",
				happenedAt: null,
				score: 0.9,
			},
		]);
		createMemoryEngineMock.mockResolvedValue(engine);

		let call = 0;
		const fetchMock = vi.fn().mockImplementation(async () => {
			call++;
			const content = call === 1 ? '["steam查询流程"]' : call === 2 ? '["old-proc"]' : "[]";
			return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) };
		});
		vi.stubGlobal("fetch", fetchMock);

		await handlers.get("message_end")!(
			{ type: "message_end", message: { role: "user", content: "不对,不要再按那个流程查了" } },
			undefined,
		);
		await handlers.get("turn_end")!(
			{
				type: "turn_end",
				turnIndex: 1,
				message: { role: "assistant", content: "好的,以后不这样了" },
				toolResults: [],
			},
			undefined,
		);

		expect(engine.retriever.retrieve).toHaveBeenCalledWith(
			"steam查询流程",
			expect.objectContaining({ memoryTypes: ["procedure", "preference"] }),
		);
		expect(engine.memorizer.supersedeBatch).toHaveBeenCalledWith(["old-proc"]);
		vi.unstubAllGlobals();
	});
});
