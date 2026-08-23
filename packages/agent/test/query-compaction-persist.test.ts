import { describe, expect, it } from "vitest";
import {
	buildQueryCompactionMarker,
	collectQueryCompactionMarkers,
	QUERY_COMPACTION_CUSTOM_TYPE,
	QUERY_COMPACTION_PREFIX,
	replayQueryCompactions,
} from "../src/query-compaction.ts";
import type { AgentMessage } from "../src/types.ts";

function user(text: string, timestamp = 0): AgentMessage {
	return { role: "user", content: text, timestamp };
}

function assistant(text: string, timestamp = 1): AgentMessage {
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
		timestamp,
	};
}

function toolResult(text: string, timestamp = 2): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: "c1",
		toolName: "read_file",
		content: [{ type: "text", text }],
		isError: false,
		timestamp,
	};
}

function marker(startIndex: number, coveredCount: number, summary = "摘要文本"): AgentMessage {
	return {
		role: "custom",
		customType: QUERY_COMPACTION_CUSTOM_TYPE,
		content: `${QUERY_COMPACTION_PREFIX}${summary}`,
		display: false,
		details: { startIndex, coveredCount, contextWindow: 1000 },
		timestamp: 9,
	};
}

describe("buildQueryCompactionMarker", () => {
	it("produces a hidden custom message carrying coordinates and the summary projection", () => {
		const plan = { startIndex: 0, endIndex: 10, summary: "完成第一阶段", contextWindow: 128000 };
		const message = buildQueryCompactionMarker(plan) as {
			role: "custom";
			customType: string;
			content: string;
			display: boolean;
			details: { startIndex: number; coveredCount: number; contextWindow: number };
		};
		expect(message.role).toBe("custom");
		expect(message.customType).toBe(QUERY_COMPACTION_CUSTOM_TYPE);
		expect(message.display).toBe(false);
		expect(message.content).toBe(`${QUERY_COMPACTION_PREFIX}完成第一阶段`);
		expect(message.details).toEqual({ startIndex: 0, coveredCount: 10, contextWindow: 128000 });
	});
});

describe("collectQueryCompactionMarkers", () => {
	it("skips non-marker messages and malformed markers", () => {
		const messages = [
			user("u"),
			marker(0, 2),
			{ role: "custom", customType: "other", content: "x", display: true, timestamp: 1 } as AgentMessage,
			{
				role: "custom",
				customType: QUERY_COMPACTION_CUSTOM_TYPE,
				content: "bad",
				display: false,
				timestamp: 2,
			} as AgentMessage,
		];
		const markers = collectQueryCompactionMarkers(messages);
		expect(markers).toHaveLength(1);
		expect(markers[0]).toMatchObject({ index: 1, startIndex: 0, coveredCount: 2 });
	});
});

describe("replayQueryCompactions", () => {
	it("replaces the covered range with the summary at the original position", () => {
		// 上一轮:10 条历史被压缩(覆盖 0..10),尾部保留 a1/r1,marker 持久化在流尾。
		const stream = [
			...Array.from({ length: 10 }, (_, i) => user(`m${i}`, i)),
			assistant("a1"),
			toolResult("r1"),
			marker(0, 10, "阶段摘要"),
		];
		const replayed = replayQueryCompactions(stream);
		expect(replayed).toHaveLength(3);
		expect(replayed[0]).toMatchObject({ role: "user", content: `${QUERY_COMPACTION_PREFIX}阶段摘要` });
		expect(replayed[1]).toMatchObject({ role: "assistant" });
		expect(replayed[2]).toMatchObject({ role: "toolResult" });
		expect(replayed.some((m) => m.role === "custom")).toBe(false);
	});

	it("reconstructs two sequential compactions (A2 = A1 + c1)", () => {
		// 压缩 1 覆盖 0..10;压缩 2(本轮坐标 startIndex=1)覆盖其保留尾批 a1/r1。
		const stream = [
			...Array.from({ length: 10 }, (_, i) => user(`m${i}`, i)),
			assistant("a1"),
			toolResult("r1"),
			marker(0, 10, "摘要一"),
			assistant("a2"),
			toolResult("r2"),
			marker(1, 2, "摘要二"),
		];
		const replayed = replayQueryCompactions(stream);
		expect(replayed).toHaveLength(4);
		expect(replayed[0]).toMatchObject({ role: "user", content: `${QUERY_COMPACTION_PREFIX}摘要一` });
		expect(replayed[1]).toMatchObject({ role: "user", content: `${QUERY_COMPACTION_PREFIX}摘要二` });
		expect(replayed[2]).toMatchObject({ role: "assistant" });
		expect(replayed[3]).toMatchObject({ role: "toolResult" });
		expect(replayed.some((m) => m.role === "custom")).toBe(false);
	});

	it("keeps everything when coordinates are out of bounds (host compaction intervened)", () => {
		const stream = [user("m0"), user("m1"), marker(0, 10, "摘要")];
		expect(replayQueryCompactions(stream)).toBe(stream);
	});

	it("keeps non-marker custom messages untouched", () => {
		const custom = { role: "custom", customType: "other", content: "x", display: true, timestamp: 1 } as AgentMessage;
		const stream = [user("m0"), user("m1"), custom];
		expect(replayQueryCompactions(stream)).toBe(stream);
	});

	it("returns the same array when there are no markers", () => {
		const stream = [user("u1"), user("u2")];
		expect(replayQueryCompactions(stream)).toBe(stream);
	});
});
