import { describe, expect, it, vi } from "vitest";
import type { Memorizer } from "../src/core/memory/memorizer.ts";
import {
	collectProtectedMemoryIds,
	type PostResponseLlm,
	PostResponseMemoryWorker,
	parseStringArray,
} from "../src/core/memory/post-response-worker.ts";
import type { Retriever } from "../src/core/memory/retriever.ts";
import type { MemoryHit } from "../src/core/memory/types.ts";

function makeLlm(stepReplies: string[]): PostResponseLlm {
	let step = 0;
	return {
		chat: vi.fn(async () => {
			const reply = stepReplies[Math.min(step, stepReplies.length - 1)];
			step++;
			return reply ?? "[]";
		}),
	};
}

function hit(id: string, summary: string, score: number): MemoryHit {
	return {
		id,
		memoryType: "procedure",
		summary,
		sourceRef: "test",
		happenedAt: null,
		score,
	};
}

function makeWorker(llm: PostResponseLlm, retrieve: (query: string) => Promise<MemoryHit[]>) {
	const markSupersededBatch = vi.fn(() => 1);
	const memorizer = { supersedeBatch: markSupersededBatch } as unknown as Memorizer;
	const retriever = { retrieve: vi.fn(retrieve) } as unknown as Retriever;
	const worker = new PostResponseMemoryWorker({ memorizer, retriever, llm });
	return { worker, markSupersededBatch, retriever };
}

describe("collectProtectedMemoryIds", () => {
	it("parses memorize result ids and ignores other calls", () => {
		const ids = collectProtectedMemoryIds([
			{ name: "memorize", result: "已记住 (id=abc123)。" },
			{ name: "memorize", result: "reinforced:xyz789" },
			{ name: "memorize", result: "item_id=item_42" },
			{ name: "read_file", result: "whatever" },
			{ name: "memorize", result: "失败: 网络错误" },
		]);
		expect(ids.has("abc123")).toBe(true);
		expect(ids.has("xyz789")).toBe(true);
		expect(ids.has("item_42")).toBe(true);
		expect(ids.size).toBe(3);
	});

	it("returns an empty set for no memorize calls", () => {
		expect(collectProtectedMemoryIds([]).size).toBe(0);
	});
});

describe("parseStringArray", () => {
	it("parses fenced and bare JSON arrays", () => {
		expect(parseStringArray('```json\n["a", "b"]\n```', "test")).toEqual(["a", "b"]);
		expect(parseStringArray('["a"]', "test")).toEqual(["a"]);
	});

	it("rejects non-arrays and non-string entries", () => {
		expect(() => parseStringArray('{"a": 1}', "test")).toThrow("必须返回 JSON 数组");
		expect(() => parseStringArray('["a", 1]', "test")).toThrow("只能包含非空字符串");
		expect(() => parseStringArray('["a", ""]', "test")).toThrow("只能包含非空字符串");
		expect(() => parseStringArray("garbage", "test")).toThrow("无法解析");
	});
});

describe("PostResponseMemoryWorker", () => {
	it("supersedes matching old rules when the user explicitly rejects them", async () => {
		const llm = makeLlm(['["steam查询流程"]', '["proc-1", "proc-2"]']);
		const { worker, markSupersededBatch, retriever } = makeWorker(llm, async (query) => {
			expect(query).toBe("steam查询流程");
			return [hit("proc-1", "steam 查询流程:调 feed 接口", 0.95), hit("proc-2", "steam 查询流程:读本地缓存", 0.9)];
		});
		const result = await worker.run({
			userMessage: "以后不要再按这个流程查 steam 了，错了",
			toolChain: [],
			sourceRef: "chat:test@post_response",
		});
		expect(result.topics).toEqual(["steam查询流程"]);
		expect(result.supersededIds).toEqual(["proc-1", "proc-2"]);
		expect(markSupersededBatch).toHaveBeenCalledWith(["proc-1", "proc-2"]);
		expect(retriever.retrieve).toHaveBeenCalledTimes(1);
	});

	it("does not supersede below the similarity threshold or protected ids", async () => {
		const llm = makeLlm(['["旧流程"]', '["proc-1"]']);
		const { worker, markSupersededBatch, retriever } = makeWorker(llm, async () => [
			hit("proc-1", "旧流程", 0.95),
			hit("proc-2", "低相似旧流程", 0.5),
			hit("proc-3", "刚写入的旧流程", 0.96),
		]);
		const result = await worker.run({
			userMessage: "这个旧流程错了，不要再用了",
			toolChain: [{ name: "memorize", result: "已记住 (id=proc-3)。" }],
			sourceRef: "chat:test@post_response",
		});
		expect(result.supersededIds).toEqual(["proc-1"]);
		expect(markSupersededBatch).toHaveBeenCalledWith(["proc-1"]);
		expect(retriever.retrieve).toHaveBeenCalledTimes(1);
	});

	it("does nothing when the user message is not an invalidation", async () => {
		const llm = makeLlm(["[]"]);
		const { worker, markSupersededBatch, retriever } = makeWorker(llm, async () => []);
		const result = await worker.run({
			userMessage: "你的流程是什么？",
			toolChain: [],
			sourceRef: "chat:test@post_response",
		});
		expect(result.topics).toEqual([]);
		expect(result.supersededIds).toEqual([]);
		expect(retriever.retrieve).not.toHaveBeenCalled();
		expect(markSupersededBatch).not.toHaveBeenCalled();
	});

	it("swallows failures and returns empty results", async () => {
		const llm = makeLlm(["garbage"]);
		const { worker } = makeWorker(llm, async () => {
			throw new Error("retrieve failed");
		});
		const result = await worker.run({
			userMessage: "不要再用了",
			toolChain: [],
			sourceRef: "chat:test@post_response",
		});
		expect(result.supersededIds).toEqual([]);
	});

	it("rejects unknown ids returned by the model without superseding", async () => {
		const llm = makeLlm(['["主题"]', '["proc-1", "fake-id"]']);
		const { worker, markSupersededBatch } = makeWorker(llm, async () => [hit("proc-1", "主题相关", 0.9)]);
		const result = await worker.run({
			userMessage: "这个流程错了",
			toolChain: [],
			sourceRef: "chat:test@post_response",
		});
		expect(result.supersededIds).toEqual([]);
		expect(markSupersededBatch).not.toHaveBeenCalled();
	});
});
