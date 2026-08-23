import { describe, expect, it, vi } from "vitest";
import { HistoryRouteGate, type HistoryRouteLlm, parseRouteResult } from "../src/memory/history-route.ts";

function makeLlm(respond: (system: string, user: string) => string | Promise<string>): HistoryRouteLlm {
	return {
		chat: vi.fn(async (system: string, user: string) => respond(system, user)),
	};
}

describe("parseRouteResult", () => {
	it("parses valid decisions and rewritten queries", () => {
		expect(parseRouteResult('{"decision": "retrieve", "query": "用户 咖啡"}', "原查询")).toEqual({
			decision: "retrieve",
			query: "用户 咖啡",
		});
		expect(parseRouteResult('{"decision": "skip", "query": ""}', "原查询")).toEqual({
			decision: "skip",
			query: "原查询",
		});
		expect(parseRouteResult('```json\n{"decision": "retrieve", "query": "x"}\n```', "原查询")).toEqual({
			decision: "retrieve",
			query: "x",
		});
	});

	it("throws on structural errors", () => {
		expect(() => parseRouteResult("not json", "q")).toThrow();
		expect(() => parseRouteResult('{"decision": "maybe"}', "q")).toThrow();
	});
});

describe("HistoryRouteGate", () => {
	it("returns retrieve with the rewritten query", async () => {
		const llm = makeLlm(async () => '{"decision": "retrieve", "query": "用户 喜欢 手冲咖啡"}');
		const gate = new HistoryRouteGate({ llm });
		const result = await gate.decide("k", "我是不是说过我喜欢手冲咖啡");
		expect(result).toEqual({ decision: "retrieve", query: "用户 喜欢 手冲咖啡" });
	});

	it("returns skip for small talk", async () => {
		const llm = makeLlm(async () => '{"decision": "skip", "query": ""}');
		const gate = new HistoryRouteGate({ llm });
		const result = await gate.decide("k", "早上好");
		expect(result).toEqual({ decision: "skip", query: "早上好" });
	});

	it("fails open to retrieve with the original query on LLM failure or bad JSON", async () => {
		const throwing = makeLlm(async () => {
			throw new Error("llm down");
		});
		const gate = new HistoryRouteGate({ llm: throwing, log: () => undefined });
		expect(await gate.decide("k", "问题")).toEqual({ decision: "retrieve", query: "问题" });

		const badJson = makeLlm(async () => "??");
		const gate2 = new HistoryRouteGate({ llm: badJson, log: () => undefined });
		expect(await gate2.decide("k", "问题")).toEqual({ decision: "retrieve", query: "问题" });
	});

	it("caches decisions per sessionKey+query", async () => {
		const llm = makeLlm(async () => '{"decision": "retrieve", "query": "q2"}');
		const gate = new HistoryRouteGate({ llm });
		await gate.decide("s1", "同一个问题");
		await gate.decide("s1", "同一个问题");
		await gate.decide("s2", "同一个问题");
		expect(llm.chat).toHaveBeenCalledTimes(2);
	});

	it("can be disabled", async () => {
		const llm = makeLlm(async () => '{"decision": "skip", "query": ""}');
		const gate = new HistoryRouteGate({ llm, enabled: false });
		expect(await gate.decide("k", "早上好")).toEqual({ decision: "retrieve", query: "早上好" });
	});
});
