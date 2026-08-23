import { describe, expect, it, vi } from "vitest";
import { Retriever } from "../src/core/memory/retriever.ts";
import type { MemoryHit, MemoryStoreSearchOptions, TextEmbedder } from "../src/core/memory/types.ts";

/** 记录检索选项的 mock store(只实现 retrieve 路径用到的两个方法)。 */
function makeMockStore() {
	const keywordCalls: MemoryStoreSearchOptions[] = [];
	const vectorCalls: MemoryStoreSearchOptions[] = [];
	const store = {
		keywordSearchSummary: vi.fn((_terms: string[], searchOptions: MemoryStoreSearchOptions): MemoryHit[] => {
			keywordCalls.push(searchOptions);
			return [];
		}),
		vectorSearchBatch: vi.fn((_vectors: number[][], searchOptions: MemoryStoreSearchOptions): MemoryHit[][] => {
			vectorCalls.push(searchOptions);
			return [];
		}),
	};
	return { store, keywordCalls, vectorCalls };
}

function makeEmbedder(): TextEmbedder {
	return {
		embed: vi.fn(async (texts: readonly string[]) => texts.map(() => new Array(4).fill(0.1))),
	};
}

describe("retriever intent routing (akashic MemoryQuery.intent)", () => {
	it("defaults interest to preference+profile types", async () => {
		const { store, keywordCalls } = makeMockStore();
		const retriever = new Retriever(store as never, makeEmbedder());
		await retriever.retrieve("用户喜欢什么", { intent: "interest" });
		expect(keywordCalls[0]?.memoryTypes).toEqual(["preference", "profile"]);
	});

	it("defaults procedure to procedure type only", async () => {
		const { store, keywordCalls } = makeMockStore();
		const retriever = new Retriever(store as never, makeEmbedder());
		await retriever.retrieve("怎么部署服务", { intent: "procedure" });
		expect(keywordCalls[0]?.memoryTypes).toEqual(["procedure"]);
	});

	it("honors explicit memoryTypes over intent defaults", async () => {
		const { store, keywordCalls } = makeMockStore();
		const retriever = new Retriever(store as never, makeEmbedder());
		await retriever.retrieve("查询事件", { intent: "interest", memoryTypes: ["event"] });
		expect(keywordCalls[0]?.memoryTypes).toEqual(["event"]);
	});

	it("adds two HyDE hypotheses as aux queries for answer intent", async () => {
		const { store, vectorCalls } = makeMockStore();
		const embedder = makeEmbedder();
		const retriever = new Retriever(store as never, embedder);
		const hypothesisLlm = {
			chat: vi.fn(async (_system: string, user: string) =>
				user.includes("带具体时间") ? "[2026-03-08] 用户…" : "用户…",
			),
		};
		await retriever.retrieve("上次用户说了什么", { intent: "answer", hypothesisLlm });
		expect(hypothesisLlm.chat).toHaveBeenCalledTimes(2);
		// 向量路:query + 2 条假设,共 3 组(embedLanes 逐个文本嵌入)。
		expect(embedder.embed).toHaveBeenCalledTimes(3);
		const texts = (embedder.embed as ReturnType<typeof vi.fn>).mock.calls.flatMap((call) => call[0] as string[]);
		expect(texts).toHaveLength(3);
		expect(texts[0]).toBe("上次用户说了什么");
		expect(texts).toContain("[2026-03-08] 用户…");
		expect(texts).toContain("用户…");
		expect(vectorCalls[0]?.memoryTypes).toBeUndefined();
	});

	it("degrades to the raw query when the hypothesis llm fails", async () => {
		const { store, vectorCalls } = makeMockStore();
		const embedder = makeEmbedder();
		const retriever = new Retriever(store as never, embedder);
		const hypothesisLlm = {
			chat: vi.fn(async () => {
				throw new Error("llm down");
			}),
		};
		await retriever.retrieve("x", { intent: "answer", hypothesisLlm });
		const texts = (embedder.embed as ReturnType<typeof vi.fn>).mock.calls.flatMap((call) => call[0] as string[]);
		expect(texts).toHaveLength(1);
		expect(vectorCalls.length).toBeGreaterThan(0);
	});

	it("passes time filters through for timeline intent", async () => {
		const { store, keywordCalls } = makeMockStore();
		const retriever = new Retriever(store as never, makeEmbedder());
		const timeStart = new Date("2026-01-01T00:00:00Z");
		const timeEnd = new Date("2026-01-08T00:00:00Z");
		await retriever.retrieve("最近一周", { intent: "timeline", timeStart, timeEnd });
		expect(keywordCalls[0]?.timeStart).toEqual(timeStart);
		expect(keywordCalls[0]?.timeEnd).toEqual(timeEnd);
	});

	it("keeps context intent behavior unchanged", async () => {
		const { store, keywordCalls } = makeMockStore();
		const retriever = new Retriever(store as never, makeEmbedder());
		await retriever.retrieve("普通查询", {});
		expect(keywordCalls[0]?.memoryTypes).toBeUndefined();
	});
});
