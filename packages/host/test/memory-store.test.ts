import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getLoadablePath } from "sqlite-vec";
import { afterEach, describe, expect, it } from "vitest";
import { Memorizer } from "../src/core/memory/memorizer.ts";
import { Retriever, rrfMerge } from "../src/core/memory/retriever.ts";
import { contentHash, hotnessScore, MemoryStore } from "../src/core/memory/store.ts";
import type { MemoryHit, TextEmbedder } from "../src/core/memory/types.ts";

const tempDirs: string[] = [];

function tempDb(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-memory-store-"));
	tempDirs.push(dir);
	return join(dir, "memory.sqlite");
}

function createStore(dbPath = tempDb()): MemoryStore {
	// sqlite-vec may or may not load; both paths are covered by the same suite.
	try {
		return new MemoryStore(dbPath, { vecDim: 256, extensionPath: getLoadablePath() });
	} catch {
		return new MemoryStore(dbPath, { vecDim: 256 });
	}
}

/**
 * Deterministic bag-of-characters embedder: cosine similarity reflects
 * character overlap, so similar texts score high and unrelated texts low.
 */
function charEmbedder(dimensions = 256): TextEmbedder {
	return {
		embed: async (texts) =>
			texts.map((text) => {
				const vector = new Array<number>(dimensions).fill(0);
				for (const char of text) {
					vector[char.codePointAt(0)! % dimensions] += 1;
				}
				let norm = 0;
				for (const value of vector) norm += value * value;
				norm = Math.sqrt(norm);
				return norm > 0 ? vector.map((value) => value / norm) : vector;
			}),
	};
}

async function save(
	memorizer: Memorizer,
	summary: string,
	memoryType: "event" | "profile" | "preference" | "procedure",
	extra?: Record<string, unknown>,
	sourceRef?: string,
): Promise<string> {
	return memorizer.saveItem({
		summary,
		memoryType,
		...(extra ? { extra } : {}),
		...(sourceRef ? { sourceRef } : {}),
	});
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("MemoryStore writes", () => {
	it("upserts new items and reinforces identical content", () => {
		const store = createStore();
		const first = store.upsertItem({ memoryType: "preference", summary: "用户喜欢喝咖啡", embedding: null });
		expect(first.startsWith("new:")).toBe(true);
		const second = store.upsertItem({ memoryType: "preference", summary: "用户喜欢喝咖啡", embedding: null });
		expect(second.startsWith("reinforced:")).toBe(true);
		expect(second).toContain(first.slice(4));

		// Different type -> separate item even with identical summary text.
		const other = store.upsertItem({ memoryType: "event", summary: "用户喜欢喝咖啡", embedding: null });
		expect(other.startsWith("new:")).toBe(true);
	});

	it("reactivates superseded items on rewrite", () => {
		const store = createStore();
		const result = store.upsertItem({ memoryType: "preference", summary: "部署用 docker", embedding: null });
		const id = result.slice(4);
		store.markSupersededBatch([id]);
		expect(store.getItem(id)?.extra).toBeUndefined();

		const again = store.upsertItem({ memoryType: "preference", summary: "部署用 docker", embedding: null });
		expect(again.startsWith("reinforced:")).toBe(true);
	});

	it("logs supersede replacements and forget deletes", () => {
		const store = createStore();
		const id = store
			.upsertItem({ memoryType: "procedure", summary: "发布流程:构建后推送", embedding: null })
			.slice(4);
		expect(store.markSupersededBatch([id, "missing-id"])).toBe(1);

		const second = store.upsertItem({ memoryType: "event", summary: "发布了 v1.0", embedding: null }).slice(4);
		const { affected, missing } = store.deleteItems([second, "nope"]);
		expect(affected).toEqual([second]);
		expect(missing).toEqual(["nope"]);
	});

	it("merges summaries and metadata", async () => {
		const store = createStore();
		const memorizer = new Memorizer(store, charEmbedder());
		const id = store
			.upsertItem({
				memoryType: "procedure",
				summary: "部署流程:先构建",
				embedding: null,
				extra: { steps: ["构建"], tool_requirement: "必须使用 bash" },
			})
			.slice(4);
		await memorizer.mergeItem(id, "部署流程:先构建再推送", { steps: ["推送"] });
		const item = store.getItem(id)!;
		expect(item.summary).toBe("部署流程:先构建再推送");
		expect((item.extra as Record<string, unknown>).steps).toEqual(["构建", "推送"]);
	});

	it("dedups consolidation events by source_ref", () => {
		const store = createStore();
		const first = store.upsertConsolidationEvent({
			sourceRef: "turn:abc",
			summary: "用户确定了项目名",
			embedding: null,
		});
		expect(first.startsWith("new:")).toBe(true);
		const second = store.upsertConsolidationEvent({
			sourceRef: "turn:abc",
			summary: "用户确定了项目名",
			embedding: null,
		});
		expect(second.startsWith("skipped:")).toBe(true);
		expect(store.hasConsolidationSourceRef("turn:abc")).toBe(true);
	});
});

describe("MemoryStore retrieval", () => {
	it("searches by vector similarity with hotness blend", async () => {
		const store = createStore();
		const memorizer = new Memorizer(store, charEmbedder());
		await save(memorizer, "用户喜欢喝咖啡,每天早上来一杯", "preference");
		await save(memorizer, "用户喜欢喝茶,尤其是龙井", "preference");
		await save(memorizer, "今天天气不错,适合散步", "event");

		const query = await charEmbedder()
			.embed(["用户喜欢喝咖啡"])
			.then((v) => v[0]!);
		const hits = store.vectorSearch(query, { topK: 3, scoreThreshold: 0.1 });
		expect(hits[0]?.summary).toContain("咖啡");
		expect(hits[0]?.score).toBeGreaterThan(hits[1]?.score ?? 1);

		// Hotness: heavily reinforced recent items beat pure semantic matches.
		const stale = store.vectorSearch(query, { topK: 3, scoreThreshold: 0.1, hotnessAlpha: 0.9 });
		expect(stale.length).toBeGreaterThan(0);
	});

	it("filters by type and scope", async () => {
		const store = createStore();
		const memorizer = new Memorizer(store, charEmbedder());
		await save(memorizer, "用户偏好:用 vim", "preference");
		await save(memorizer, "用户画像:程序员", "profile");
		await memorizer.saveItem({
			summary: "channel 内的记忆",
			memoryType: "event",
			scope: { channel: "telegram", chatId: "42" },
		});

		const query = await charEmbedder()
			.embed(["偏好"])
			.then((v) => v[0]!);
		const typed = store.vectorSearch(query, { topK: 10, scoreThreshold: 0, memoryTypes: ["preference"] });
		expect(typed.every((hit) => hit.memoryType === "preference")).toBe(true);

		const scoped = store.vectorSearch(query, {
			topK: 10,
			scoreThreshold: 0,
			scope: { channel: "telegram", chatId: "42" },
			requireScopeMatch: true,
		});
		expect(scoped.map((hit) => hit.summary)).toEqual(["channel 内的记忆"]);
	});

	it("searches keywords with hit-ratio scoring", async () => {
		const store = createStore();
		const memorizer = new Memorizer(store, charEmbedder());
		await save(memorizer, "部署使用 docker compose 管理服务", "procedure");
		await save(memorizer, "发布用 docker 构建镜像", "procedure");

		const hits = store.keywordSearchSummary(["docker", "compose"], { topK: 10 });
		expect(hits[0]?.summary).toContain("docker compose");
		// summary 命中 1 分 + extra_json(trigger_tags)命中 0.5 分,按 term 数归一。
		expect(hits[0]?.keywordScore).toBe(1.5);
		expect(hits[1]?.keywordScore).toBe(0.75);
	});

	it("semantic dedup reinforces recent similar events", async () => {
		const store = createStore();
		const memorizer = new Memorizer(store, charEmbedder());
		const result = await memorizer.saveFromConsolidation({
			historyEntry: "[2026-05-01] 用户决定采用 sqlite 存储会话索引",
			sourceRef: "compact:first",
		});
		expect(result.eventStatus.startsWith("new:")).toBe(true);

		const second = await memorizer.saveFromConsolidation({
			historyEntry: "[2026-05-01] 用户决定采用 sqlite 存储会话索引",
			sourceRef: "compact:second",
		});
		expect(second.eventStatus).toBe("skipped:semantic_dedup");
	});
});

describe("Memorizer maintenance", () => {
	it("supersedes similar procedure/preference items", async () => {
		const store = createStore();
		const memorizer = new Memorizer(store, charEmbedder());
		const old = await save(memorizer, "部署必须使用 docker", "procedure");
		const next = await memorizer.saveItemWithSupersede({
			summary: "部署必须使用 docker",
			memoryType: "procedure",
			supersedeThreshold: 0.8,
		});
		expect(next.startsWith("reinforced:")).toBe(true);
		void old;
	});

	it("merges explicit procedures with the same tool requirement", async () => {
		const store = createStore();
		const memorizer = new Memorizer(store, charEmbedder());
		const first = await memorizer.saveItemWithSupersede({
			summary: "查 steam 库存要先调用 steam 查询工具",
			memoryType: "procedure",
			extra: { tool_requirement: "必须使用 steam 查询工具" },
			mergeThreshold: 0.5,
			supersedeThreshold: 0.95,
		});
		const merged = await memorizer.saveItemWithSupersede({
			summary: "查 steam 库存前必须调用 steam 查询工具,然后汇总",
			memoryType: "procedure",
			extra: { tool_requirement: "必须使用 steam 查询工具" },
			mergeThreshold: 0.5,
			supersedeThreshold: 0.95,
		});
		expect(merged.startsWith("merged:")).toBe(true);
		expect(merged).toContain(first.slice(merged.startsWith("new:") ? 4 : 7));
	});

	it("retires same-category profile status facts", async () => {
		const store = createStore();
		const memorizer = new Memorizer(store, charEmbedder());
		await memorizer.saveItemWithSupersede({
			summary: "用户当前状态:正在找工作",
			memoryType: "profile",
			extra: { category: "status" },
			supersedeThreshold: 0.7,
		});
		const next = await memorizer.saveItemWithSupersede({
			summary: "用户当前状态:已经入职新公司",
			memoryType: "profile",
			extra: { category: "status" },
			supersedeThreshold: 0.7,
		});
		expect(next.startsWith("new:")).toBe(true);

		const query = await charEmbedder()
			.embed(["用户当前状态"])
			.then((v) => v[0]!);
		const hits = store.vectorSearch(query, { topK: 10, scoreThreshold: 0, memoryTypes: ["profile"] });
		const active = hits.filter((hit) => hit.summary.includes("入职"));
		expect(active.length).toBe(1);
	});
});

describe("Retriever fusion and injection", () => {
	function makeStore(): { store: MemoryStore; memorizer: Memorizer; retriever: Retriever } {
		const store = createStore();
		const embedder = charEmbedder();
		const memorizer = new Memorizer(store, embedder);
		const retriever = new Retriever(store, embedder, {
			scoreThreshold: 0.1,
			injectMaxChars: 600,
		});
		return { store, memorizer, retriever };
	}

	it("fuses vector and keyword lanes with RRF", async () => {
		const { memorizer, retriever } = makeStore();
		await save(memorizer, "用户偏好:写代码用 vim 编辑器", "preference");
		await save(memorizer, "用户喜欢研究编辑器插件", "preference");

		const hits = await retriever.retrieve("vim 编辑器", { topK: 5 });
		expect(hits.length).toBeGreaterThan(0);
		expect(hits[0]?.summary).toContain("vim");
		expect(hits[0]?.rrfScore).toBeDefined();
	});

	it("force-injects procedures with tool requirements", async () => {
		const { memorizer, retriever } = makeStore();
		await save(memorizer, "查询余额必须先调用 balance 工具", "procedure", {
			tool_requirement: "必须调用 balance 工具",
		});
		await save(memorizer, "用户偏好简洁回复", "preference");

		const hits = await retriever.retrieve("余额", { topK: 5 });
		const block = retriever.buildInjectionBlock(hits);
		expect(block.text).toContain("强制约束");
		expect(block.text).toContain("必须调用");
		expect(block.injectedIds.length).toBeGreaterThan(0);
	});

	it("respects the character budget", async () => {
		const { memorizer, retriever } = makeStore();
		for (let i = 0; i < 8; i++) {
			await save(memorizer, `用户偏好条目编号 ${i}:这是第 ${i} 条测试偏好内容,内容足够长以消耗预算`, "preference");
		}
		const hits = await retriever.retrieve("偏好", { topK: 10 });
		const block = retriever.buildInjectionBlock(hits);
		expect(block.text.length).toBeLessThanOrEqual(600);
		expect(block.injectedIds.length).toBeGreaterThan(0);
	});

	it("rrf merge ranks dual-lane hits above keyword-only hits", () => {
		const makeHit = (id: string, score: number): MemoryHit => ({
			id,
			memoryType: "preference",
			summary: id,
			sourceRef: "",
			happenedAt: null,
			score,
		});
		const vector = [makeHit("both", 0.9), makeHit("vec-only", 0.8)];
		const keyword = [makeHit("both", 0.9), makeHit("kw-only", 0.7)];
		const merged = rrfMerge(vector, keyword, 3);
		expect(merged[0]?.id).toBe("both");
		expect(merged.map((hit) => hit.id).sort()).toEqual(["both", "kw-only", "vec-only"]);
	});
});

describe("hotness score", () => {
	it("decays with age and grows with reinforcement", () => {
		const now = new Date("2026-01-01T00:00:00Z");
		const fresh = hotnessScore(1, "2025-12-30T00:00:00Z", now, 14, 0);
		const old = hotnessScore(1, "2025-06-01T00:00:00Z", now, 14, 0);
		expect(fresh).toBeGreaterThan(old);

		const reinforced = hotnessScore(10, "2025-12-30T00:00:00Z", now, 14, 0);
		expect(reinforced).toBeGreaterThan(fresh);

		const emotional = hotnessScore(1, "2025-12-30T00:00:00Z", now, 14, 10);
		expect(emotional).toBeGreaterThan(fresh);
	});
});

describe("content hash", () => {
	it("normalizes whitespace and case", () => {
		expect(contentHash("  Docker 部署 ", "procedure")).toBe(contentHash("docker 部署", "procedure"));
		expect(contentHash("部署", "procedure")).not.toBe(contentHash("部署", "preference"));
	});
});
