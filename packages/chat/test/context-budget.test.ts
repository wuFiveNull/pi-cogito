import type { AgentMessage } from "@cogito/agent-core";
import type { BeforeProviderRequestEvent, ContextEvent, ExtensionAPI } from "@cogito/host";
import { describe, expect, it, vi } from "vitest";
import { createContextBudgetExtension, estimatePayloadTokens, trimMessages, trimTools } from "../src/context/budget.ts";

function user(text: string, timestamp = 1): AgentMessage {
	return { role: "user", content: text, timestamp };
}

function assistant(text: string, timestamp = 2): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
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
		timestamp,
	};
}

function assistantWithTools(names: string[], timestamp = 2): AgentMessage {
	return {
		role: "assistant",
		content: [
			{ type: "text", text: "调用" },
			...names.map((name) => ({ type: "toolCall" as const, id: `c_${name}`, name, arguments: {} })),
		],
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
		timestamp,
	};
}

function toolResult(toolCallId: string, timestamp = 3): AgentMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "x",
		content: [{ type: "text", text: "ok" }],
		isError: false,
		timestamp,
	};
}

interface PiLike {
	on: (event: string, handler: unknown) => void;
	contextHandler?: (event: ContextEvent, ctx: { getContextUsage?: () => unknown }) => Promise<unknown> | unknown;
	payloadHandler?: (
		event: BeforeProviderRequestEvent,
		ctx: { getContextUsage?: () => unknown },
	) => Promise<unknown> | unknown;
}

function makePi(): PiLike {
	const pi: PiLike = {
		on: (event, handler) => {
			if (event === "context") pi.contextHandler = handler as PiLike["contextHandler"];
			if (event === "before_provider_request") pi.payloadHandler = handler as PiLike["payloadHandler"];
		},
	};
	return pi;
}

describe("trimMessages", () => {
	it("removes oldest whole turns and never touches the last message", () => {
		const messages = [
			user("u1", 1),
			assistant("a1", 2),
			user("u2", 3),
			assistantWithTools(["t1"], 4),
			toolResult("c_t1", 5),
			user("u3", 6),
		];
		const trimmed = trimMessages(messages, 4);
		// 移除第一轮(u1+a1),保留 u2 轮与 u3。
		expect(trimmed).toHaveLength(4);
		expect(trimmed[0]).toMatchObject({ role: "user", content: "u2" });
		expect(trimmed[trimmed.length - 1]).toMatchObject({ role: "user", content: "u3" });
	});

	it("removes assistant batches together with their tool results (no dangling)", () => {
		const messages = [
			assistantWithTools(["t1"], 1),
			toolResult("c_t1", 2),
			user("u2", 3),
			assistant("a2", 4),
			user("u3", 5),
		];
		const trimmed = trimMessages(messages, 3);
		// 移除前两条(assistant 批次),保留 u2/a2/u3。
		expect(trimmed.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
		expect(trimmed.some((m) => m.role === "toolResult")).toBe(false);
	});

	it("keeps everything when already under the target", () => {
		const messages = [user("u1", 1), user("u2", 2)];
		expect(trimMessages(messages, 40)).toBe(messages);
	});
});

describe("estimatePayloadTokens and trimTools", () => {
	it("estimates system prompt, messages, and tool schemas", () => {
		const payload = {
			model: "m",
			systemPrompt: "x".repeat(400),
			messages: [{ role: "user", content: "y".repeat(400) }],
			tools: [{ name: "web_fetch", description: "z".repeat(200), parameters: {} }],
		};
		// (400 + 400 + 200 + 1) / 4 ≈ 250
		expect(estimatePayloadTokens(payload)).toBeGreaterThan(200);
	});

	it("keeps only essential tools and supports both tool shapes", () => {
		const tools = [
			{ name: "memorize", parameters: {} },
			{ type: "function", function: { name: "web_search" } },
			{ name: "bash", parameters: {} },
		];
		const kept = trimTools(tools, new Set(["memorize", "web_search"]));
		expect(kept.map((t) => t.name ?? (t.function as { name: string }).name)).toEqual(["memorize", "web_search"]);
	});
});

describe("createContextBudgetExtension", () => {
	it("trims messages when context usage crosses the hard percent", async () => {
		const pi = makePi();
		createContextBudgetExtension({ config: { hardPercent: 0.95, keepRecentMessages: 2 } })(
			pi as unknown as ExtensionAPI,
		);
		const messages: AgentMessage[] = [
			user("u1", 1),
			assistant("a1", 2),
			user("u2", 3),
			assistant("a2", 4),
			user("u3", 5),
		];
		const result = await pi.contextHandler?.(
			{ type: "context", messages },
			{ getContextUsage: () => ({ tokens: 1000, contextWindow: 1000, percent: 0.98 }) },
		);
		expect(result).toBeDefined();
		const out = (result as { messages: AgentMessage[] }).messages;
		expect(out.length).toBeLessThan(messages.length);
		expect(out[out.length - 1]).toMatchObject({ role: "user", content: "u3" });
	});

	it("does not touch messages below the threshold", async () => {
		const pi = makePi();
		createContextBudgetExtension({ config: {} })(pi as unknown as ExtensionAPI);
		const messages: AgentMessage[] = [user("u1", 1), user("u2", 2)];
		const result = await pi.contextHandler?.(
			{ type: "context", messages },
			{ getContextUsage: () => ({ tokens: 500, contextWindow: 1000, percent: 0.5 }) },
		);
		expect(result).toBeUndefined();
	});

	it("trims tools in before_provider_request when the payload is over budget", async () => {
		const pi = makePi();
		createContextBudgetExtension({
			config: { hardPercent: 0.9, essentialTools: ["memorize"] },
		})(pi as unknown as ExtensionAPI);
		const payload = {
			model: "m",
			contextWindow: 1000,
			systemPrompt: "x".repeat(9000),
			messages: [{ role: "user", content: "hi" }],
			tools: [
				{ name: "memorize", parameters: {} },
				{ name: "bash", parameters: {} },
			],
		};
		const result = await pi.payloadHandler?.(
			{ type: "before_provider_request", payload },
			{ getContextUsage: () => ({ tokens: 1000, contextWindow: 1000, percent: 1 }) },
		);
		expect(result).toBeDefined();
		const out = result as typeof payload;
		expect(out.tools).toHaveLength(1);
		expect(out.tools[0].name).toBe("memorize");
	});

	it("ignores non-OpenAI-compatible payloads and passes exceptions through", async () => {
		const pi = makePi();
		createContextBudgetExtension({ config: { hardPercent: 0.9 } })(pi as unknown as ExtensionAPI);
		const weird = { foo: "bar" };
		const result = await pi.payloadHandler?.(
			{ type: "before_provider_request", payload: weird },
			{ getContextUsage: () => ({ tokens: 1000, contextWindow: 1000, percent: 1 }) },
		);
		expect(result).toBeUndefined();
	});

	it("is disabled when enabled=false", () => {
		const pi = makePi();
		createContextBudgetExtension({ config: { enabled: false } })(pi as unknown as ExtensionAPI);
		expect(pi.contextHandler).toBeUndefined();
		expect(pi.payloadHandler).toBeUndefined();
	});

	it("never throws from handler internals (logs instead)", async () => {
		const pi = makePi();
		const log = vi.fn();
		createContextBudgetExtension({ config: {}, log })(pi as unknown as ExtensionAPI);
		await pi.contextHandler?.(
			{ type: "context", messages: [] },
			{
				getContextUsage: () => {
					throw new Error("boom");
				},
			},
		);
		expect(log).toHaveBeenCalledWith(expect.stringContaining("failed"));
	});
});
