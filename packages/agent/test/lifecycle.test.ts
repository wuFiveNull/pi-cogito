import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@cogito/ai";
import { describe, expect, it } from "vitest";
import { runAgentLoop } from "../src/agent-loop.ts";
import { AgentLifecycle } from "../src/lifecycle.ts";
import { createMemoryBeforeTurnModule } from "../src/memory/before-turn.ts";
import { MarkdownMemoryStore } from "../src/memory/markdown-store.ts";
import type { MemoryLlm } from "../src/memory/optimizer.ts";
import type {
	AgentContext,
	AgentEvent,
	AgentLifecycleContext,
	AgentLoopConfig,
	AgentMessage,
	StreamFn,
} from "../src/types.ts";

const model = {
	id: "test-model",
	name: "Test model",
	api: "openai-completions",
	provider: "openai",
	baseUrl: "https://example.invalid/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 4_096,
} satisfies Model<"openai-completions">;

function createLifecycleContext(
	phase: AgentLifecycleContext["phase"],
	turnIndex: number,
	messages: AgentMessage[] = [],
): AgentLifecycleContext {
	return {
		phase,
		agentContext: { systemPrompt: "", messages, tools: [] },
		newMessages: [],
		turnIndex,
		hints: [],
		metadata: {},
	};
}

describe("AgentLifecycle", () => {
	it("runs modules in dependency order within a phase", async () => {
		const order: string[] = [];
		const lifecycle = new AgentLifecycle([
			{
				phase: "before_turn",
				slot: "consumer",
				requires: ["prepared"],
				run(frame) {
					order.push(String(frame.get("prepared")));
				},
			},
			{
				phase: "before_turn",
				slot: "producer",
				produces: ["prepared"],
				run(frame) {
					order.push("producer");
					frame.set("prepared", "consumer");
				},
			},
		]);

		await lifecycle.run(createLifecycleContext("before_turn", 0));

		expect(order).toEqual(["producer", "consumer"]);
	});

	it("rejects unknown dependencies and cycles at construction", () => {
		expect(
			() => new AgentLifecycle([{ phase: "before_turn", slot: "consumer", requires: ["missing"], run() {} }]),
		).toThrow('requires unknown slot "missing"');
		expect(
			() =>
				new AgentLifecycle([
					{ phase: "before_turn", slot: "first", requires: ["second"], run() {} },
					{ phase: "before_turn", slot: "second", requires: ["first"], run() {} },
				]),
		).toThrow("lifecycle dependency cycle");
	});

	it("blocks a provider call when a before_turn module aborts", async () => {
		const lifecycle = new AgentLifecycle([
			{
				phase: "before_turn",
				slot: "block",
				run(frame) {
					frame.context.abort = { reason: "memory backlog" };
				},
			},
		]);
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [] };
		const prompt: AgentMessage = { role: "user", content: "hello", timestamp: 0 };
		const config: AgentLoopConfig = {
			model,
			convertToLlm: () => [],
			lifecycle,
		};
		const events: AgentEvent[] = [];
		let providerCalls = 0;
		const streamFn: StreamFn = () => {
			providerCalls++;
			throw new Error("provider must not be called");
		};

		const messages = await runAgentLoop(
			[prompt],
			context,
			config,
			async (event) => {
				events.push(event);
			},
			undefined,
			streamFn,
		);

		expect(providerCalls).toBe(0);
		expect(events.map((event) => event.type)).toEqual([
			"agent_start",
			"before_turn",
			"turn_start",
			"message_start",
			"message_end",
			"message_start",
			"message_end",
			"turn_end",
			"agent_end",
		]);
		expect(messages.at(-1)).toMatchObject({ role: "assistant", errorMessage: "memory backlog" });
	});
});

describe("createMemoryBeforeTurnModule", () => {
	it("consolidates a backlog before a later turn", async () => {
		const store = new MarkdownMemoryStore(mkdtempSync(join(tmpdir(), "agent-lifecycle-memory-")));
		const llm: MemoryLlm = {
			chat: async () => JSON.stringify({ pending_items: [{ tag: "preference", content: "喜欢简洁回答" }] }),
		};
		const lifecycle = new AgentLifecycle([
			createMemoryBeforeTurnModule({
				store,
				llm,
				sessionId: "session-1",
				config: { keepCount: 1, minNewMessages: 1 },
			}),
		]);
		const messages: AgentMessage[] = [
			{ role: "user", content: "请记住我喜欢简洁回答", timestamp: 0 },
			{
				role: "assistant",
				content: [{ type: "text", text: "好的" }],
				api: "openai-completions",
				provider: "openai",
				model: "test-model",
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
		const context = createLifecycleContext("before_turn", 1, messages);

		await lifecycle.run(context);

		expect(context.abort).toBeUndefined();
		expect(store.readPending()).toContain("[preference] 喜欢简洁回答");
		store.close();
	});

	it("aborts an overloaded turn when consolidation fails", async () => {
		const store = new MarkdownMemoryStore(mkdtempSync(join(tmpdir(), "agent-lifecycle-memory-error-")));
		const errors: unknown[] = [];
		const llm: MemoryLlm = { chat: async () => Promise.reject(new Error("unavailable")) };
		const lifecycle = new AgentLifecycle([
			createMemoryBeforeTurnModule({
				store,
				llm,
				sessionId: "session-2",
				config: { keepCount: 1, minNewMessages: 1 },
				onError: (error) => errors.push(error),
			}),
		]);
		const context = createLifecycleContext("before_turn", 1, [
			{ role: "user", content: "remember this", timestamp: 0 },
			{ role: "user", content: "next turn", timestamp: 1 },
		]);

		await lifecycle.run(context);

		expect(errors).toHaveLength(1);
		expect(context.abort?.reason).toContain("Memory consolidation failed");
		store.close();
	});

	it("propagates a shared consolidation failure to concurrent turns", async () => {
		const store = new MarkdownMemoryStore(mkdtempSync(join(tmpdir(), "agent-lifecycle-memory-concurrent-")));
		let rejectChat: ((error: Error) => void) | undefined;
		const chat = new Promise<string>((_resolve, reject) => {
			rejectChat = reject;
		});
		const lifecycle = new AgentLifecycle([
			createMemoryBeforeTurnModule({
				store,
				llm: { chat: async () => await chat },
				sessionId: "session-3",
				config: { keepCount: 1, minNewMessages: 1 },
			}),
		]);
		const messages: AgentMessage[] = [
			{ role: "user", content: "remember this", timestamp: 0 },
			{ role: "user", content: "next turn", timestamp: 1 },
		];
		const first = createLifecycleContext("before_turn", 1, messages);
		const second = createLifecycleContext("before_turn", 1, messages);

		const firstRun = lifecycle.run(first);
		await Promise.resolve();
		const secondRun = lifecycle.run(second);
		rejectChat?.(new Error("unavailable"));
		await Promise.all([firstRun, secondRun]);

		expect(first.abort?.reason).toContain("Memory consolidation failed");
		expect(second.abort?.reason).toContain("Memory consolidation failed");
		store.close();
	});
});
