import { describe, expect, it, vi } from "vitest";
import {
	buildCompactionSummaryMessage,
	buildCompactionUserPrompt,
	defaultEstimateTokens,
	QUERY_COMPACTION_PREFIX,
	QueryCompactor,
} from "../src/query-compaction.ts";
import type { AgentMessage } from "../src/types.ts";

function assistant(text: string): AgentMessage {
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
		stopReason: "toolUse",
		timestamp: 1,
	};
}

function toolResult(text: string): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: "c1",
		toolName: "read_file",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 2,
	};
}

function user(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: 0 };
}

function messages(): AgentMessage[] {
	return [
		user("任务开始"),
		assistant("先读文件"),
		toolResult("文件内容一"),
		assistant("再查资料"),
		toolResult("资料结果二"),
		assistant("最后执行"),
		toolResult("执行结果三"),
	];
}

describe("QueryCompactor (akashic QueryCompactor)", () => {
	it("returns a plan when the estimate exceeds the trigger threshold", async () => {
		const summarize = vi.fn(async (segment: AgentMessage[]) => `摘要(${segment.length} 条)`);
		const compactor = new QueryCompactor({
			contextWindow: 1000,
			triggerPercent: 0.5, // 阈值 500 token
			summarize,
			estimate: () => 900,
		});
		const plan = await compactor.maybeCompact(messages());
		expect(plan).not.toBeNull();
		expect(plan?.summary).toContain("条");
		// 从消息 0 起压缩(user 消息在摘要 prompt 中会被忽略)。
		expect(plan?.startIndex).toBe(0);
		// 保留尾部 1 对 assistant+toolResult。
		expect(plan?.endIndex).toBe(messages().length - 2);
	});

	it("returns null below the threshold", async () => {
		const compactor = new QueryCompactor({
			contextWindow: 1000,
			triggerPercent: 0.5,
			summarize: vi.fn(),
			estimate: () => 100,
		});
		expect(await compactor.maybeCompact(messages())).toBeNull();
	});

	it("skips segments without assistant/tool messages", async () => {
		const compactor = new QueryCompactor({
			contextWindow: 1000,
			triggerPercent: 0.5,
			summarize: vi.fn(),
			estimate: () => 900,
		});
		const onlyUsers = [user("a"), user("b"), user("c")];
		expect(await compactor.maybeCompact(onlyUsers)).toBeNull();
	});

	it("only compacts messages after the last compaction point", async () => {
		const summarize = vi.fn(async () => "第二轮摘要");
		const compactor = new QueryCompactor({
			contextWindow: 1000,
			triggerPercent: 0.5,
			summarize,
			estimate: () => 900,
		});
		const msgs = messages();
		const first = await compactor.maybeCompact(msgs);
		expect(first).not.toBeNull();
		if (!first) return;
		msgs.splice(first.startIndex, first.endIndex - first.startIndex, buildCompactionSummaryMessage(first.summary));
		compactor.recordCompacted(first);

		// 追加两对新批次后再次压缩:只压新内容,保留尾部一对。
		msgs.push(assistant("继续读"), toolResult("结果四"), assistant("继续查"), toolResult("结果五"));
		const second = await compactor.maybeCompact(msgs);
		expect(second).not.toBeNull();
		if (!second) return;
		expect(second.startIndex).toBe(first.startIndex + 1);
		const secondSegment = (summarize.mock.calls as unknown[][])[1]?.[0] as AgentMessage[] | undefined;
		expect(secondSegment?.some((m) => m.role === "toolResult" && JSON.stringify(m.content).includes("结果四"))).toBe(
			true,
		);
	});

	it("falls back to estimate when summarize returns empty", async () => {
		const compactor = new QueryCompactor({
			contextWindow: 1000,
			triggerPercent: 0.5,
			summarize: async () => "   ",
			estimate: () => 900,
		});
		expect(await compactor.maybeCompact(messages())).toBeNull();
	});
});

describe("compaction message helpers", () => {
	it("builds a marked summary user message", () => {
		const message = buildCompactionSummaryMessage("关键决策:用 sqlite", 123);
		expect(message.role).toBe("user");
		expect(message.timestamp).toBe(123);
		expect(typeof (message as { content: unknown }).content).toBe("string");
		const text = (message as { content: unknown }).content as string;
		expect(text.startsWith(QUERY_COMPACTION_PREFIX)).toBe(true);
		expect(text).toContain("关键决策:用 sqlite");
	});

	it("formats the segment prompt with tool calls and results", () => {
		const prompt = buildCompactionUserPrompt([assistant("读文件"), toolResult("文件内容")]);
		expect(prompt).toContain("[assistant] 读文件");
		expect(prompt).toContain("[result] 文件内容");
	});

	it("estimates tokens from character counts", () => {
		const msgs = messages();
		const estimated = defaultEstimateTokens(msgs);
		expect(estimated).toBeGreaterThan(0);
	});
});
