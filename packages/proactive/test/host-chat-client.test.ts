import type { AssistantMessage, Model } from "@cogito/ai";
import type { ChatCompletionClient } from "@cogito/ai/chat";
import type { ModelRuntime } from "@cogito/host";
import { describe, expect, it, vi } from "vitest";
import { createHostChatClient } from "../src/host.ts";
import { generateProfile, type ProfileConfig } from "../src/profile.ts";
import { isMessageDuplicate } from "../src/stages/dedupe.ts";
import { resolveMessage } from "../src/stages/resolve-evidence.ts";

function fakeModel(): Model<any> {
	return {
		id: "deepseek-v4-flash",
		name: "DeepSeek V4 Flash",
		api: "openai-completions",
		provider: "opencode-go",
		input: ["text"],
		contextWindow: 1000000,
		maxTokens: 384000,
		cost: { input: 0.07, output: 0.14, cacheRead: 0, cacheWrite: 0 },
	} as Model<any>;
}

function assistantMessage(
	text: string,
	toolCalls: Array<{ name: string; arguments: Record<string, unknown> }> = [],
): AssistantMessage {
	const content: AssistantMessage["content"] = [];
	if (text) content.push({ type: "text", text });
	for (const call of toolCalls) {
		content.push({ type: "toolCall", id: `tc-${call.name}`, name: call.name, arguments: call.arguments });
	}
	return {
		role: "assistant",
		content,
		api: "openai-completions",
		provider: "opencode-go",
		model: "deepseek-v4-flash",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function fakeModelRuntime(respond: (messages: unknown) => AssistantMessage) {
	const streamSimple = vi.fn(async (_messages: unknown, _options?: unknown) => ({
		result: async () => respond(streamSimple.mock.calls[streamSimple.mock.calls.length - 1]),
	}));
	return {
		modelRuntime: { streamSimple } as unknown as ModelRuntime,
		model: fakeModel(),
		streamSimple,
	};
}

describe("createHostChatClient(pi-host ModelRuntime → ChatCompletionClient)", () => {
	it("routes system/user messages through streamSimple and maps the reply back", async () => {
		const { modelRuntime, model, streamSimple } = fakeModelRuntime(() => assistantMessage("ok"));
		const client = createHostChatClient({ modelRuntime, model });
		const response = await client.complete({
			messages: [
				{ role: "system", content: "sys" },
				{ role: "user", content: "hi" },
			],
			maxTokens: 128,
		});
		expect(response.content).toBe("ok");
		expect(response.toolCalls).toEqual([]);
		expect(modelRuntime.streamSimple).toHaveBeenCalledTimes(1);
		const context = streamSimple.mock.calls[0]?.[1] as { systemPrompt?: string; messages?: unknown[] };
		expect(context?.systemPrompt).toBe("sys");
	});

	it("maps tool messages and returns tool calls", async () => {
		const { modelRuntime, model } = fakeModelRuntime(() =>
			assistantMessage("", [{ name: "finish_judgment", arguments: { action: "send" } }]),
		);
		const client = createHostChatClient({ modelRuntime, model });
		const response = await client.complete({
			messages: [
				{ role: "user", content: "go" },
				{
					role: "assistant",
					content: "",
					toolCalls: [{ id: "c1", name: "fetch_evidence", arguments: { item_id: 1 } }],
				},
				{ role: "tool", toolCallId: "c1", toolName: "fetch_evidence", content: "body" },
			],
			maxTokens: 128,
		});
		expect(response.content).toBe("");
		expect(response.toolCalls).toEqual([
			{ id: "tc-finish_judgment", name: "finish_judgment", arguments: { action: "send" } },
		]);
	});
});

describe("default-lifecycle stages use the injected client", () => {
	it("dedupe calls the injected client instead of the config endpoint", async () => {
		const complete = vi.fn(async () => ({
			content: '{"is_duplicate": true, "reason": "same event"}',
			toolCalls: [],
			message: assistantMessage(""),
		}));
		const client = { complete } as ChatCompletionClient;
		const result = await isMessageDuplicate("新消息", [{ message: "旧消息", delivered_at: 1700000000000 }], {
			model: "unused",
			baseUrl: "unused",
			apiKey: undefined,
			client,
		});
		expect(result).toEqual({ duplicate: true, reason: "same event" });
		expect(complete).toHaveBeenCalledTimes(1);
	});

	it("resolve writes the message through the injected client", async () => {
		const complete = vi.fn(async () => ({
			content: "写好的消息",
			toolCalls: [],
			message: assistantMessage("写好的消息"),
		}));
		const client = { complete } as ChatCompletionClient;
		const message = await resolveMessage({
			evidence: [{ id: "e1", itemId: 1, source: "s", title: "t", snippet: "snippet", url: "u" }],
			preferenceBlock: "",
			rulesPanel: "",
			model: "unused",
			baseUrl: "unused",
			apiKey: undefined,
			nowStr: "2026-01-01T00:00:00Z",
			client,
		});
		expect(message).toBe("写好的消息");
		expect(complete).toHaveBeenCalledTimes(1);
	});

	it("profile distills through the injected client without an apiKey", async () => {
		const complete = vi.fn(async () => ({
			content: '{"interests": "drift, rust", "exclusions": ""}',
			toolCalls: [],
			message: assistantMessage(""),
		}));
		const client = { complete } as ChatCompletionClient;
		const config: ProfileConfig = {
			enabled: true,
			client,
			clock: { now: () => new Date("2026-01-01T00:00:00Z"), nowMs: () => 1700000000000 },
		};
		const profile = await generateProfile(["我喜欢写 rust"], config);
		expect(profile.interests).toBe("drift, rust");
		expect(complete).toHaveBeenCalledTimes(1);
	});
});
