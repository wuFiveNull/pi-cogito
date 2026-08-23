import type { AgentMessage } from "@cogito/agent-core";
import { describe, expect, it } from "vitest";
import { extractToolChain } from "../src/turn.ts";

describe("extractToolChain", () => {
	it("maps memorize tool calls to their results", () => {
		const messages: AgentMessage[] = [
			{
				role: "assistant",
				content: [
					{ type: "text", text: "好的" },
					{ type: "toolCall", id: "call-1", name: "memorize", arguments: {} },
					{ type: "toolCall", id: "call-2", name: "read_file", arguments: {} },
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
				stopReason: "toolUse",
				timestamp: 1,
			},
			{
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "memorize",
				content: [{ type: "text", text: "已记住 (id=abc123)。" }],
				isError: false,
				timestamp: 2,
			},
			{
				role: "toolResult",
				toolCallId: "call-2",
				toolName: "read_file",
				content: [{ type: "text", text: "文件内容" }],
				isError: false,
				timestamp: 3,
			},
		];
		const chain = extractToolChain(messages);
		expect(chain).toEqual([
			{ name: "memorize", result: "已记住 (id=abc123)。" },
			{ name: "read_file", result: "文件内容" },
		]);
	});

	it("returns an empty chain for text-only turns", () => {
		const messages: AgentMessage[] = [
			{ role: "user", content: "你好", timestamp: 1 },
			{
				role: "assistant",
				content: [{ type: "text", text: "你好" }],
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
				timestamp: 2,
			},
		];
		expect(extractToolChain(messages)).toEqual([]);
	});
});
