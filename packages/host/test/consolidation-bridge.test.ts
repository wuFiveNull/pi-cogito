import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConsolidatedPayload } from "@cogito/agent-core/node";
import { createSqliteDatabase } from "@cogito/agent-core/sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConsolidationBridge, createMemoryEngine } from "../src/core/memory/index.ts";
import type { TextEmbedder } from "../src/core/memory/types.ts";

const tempDirs: string[] = [];

function tempAgentDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "bridge-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

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

function makePayload(overrides: Partial<ConsolidatedPayload> = {}): ConsolidatedPayload {
	return {
		sourceRef: JSON.stringify(["m1", "m2", "m3"]),
		historyEntries: [
			{ summary: "[2026-01-01 10:00] 用户完成了咖啡豆囤货,买了耶加雪菲 500g", emotionalWeight: 2 },
			{ summary: "[2026-01-02 09:00] 用户开始练习钢琴,每天一小时", emotionalWeight: 1 },
		],
		conversation:
			"[2026-01-01 10:00] USER: 我买了耶加雪菲 500g 咖啡豆\n" +
			"[2026-01-01 10:01] ASSISTANT: 这款豆子风味不错\n" +
			"[2026-01-02 09:00] USER: 以后推荐咖啡豆先看烘焙日期,别只看品牌\n",
		scope: { channel: "telegram", chatId: "42" },
		...overrides,
	};
}

function makeLlm(reply: string) {
	return { chat: vi.fn(async () => reply) };
}

const IMPLICIT_REPLY = JSON.stringify({
	profile: [
		{ summary: "用户喜欢手冲咖啡", category: "personal_fact", happened_at: null, emotional_weight: 0 },
		{ summary: "用户开始练习钢琴", category: "status", happened_at: "2026-01-02", emotional_weight: 1 },
	],
	preference: [{ summary: "推荐咖啡豆时先看烘焙日期", emotional_weight: 0 }],
	procedure: [
		{
			summary: "推荐咖啡豆前必须核对烘焙日期",
			emotional_weight: 0,
			tool_requirement: "web_search",
			steps: ["先查烘焙日期"],
			rule_schema: { required_tools: ["web_search"], forbidden_tools: [], mentioned_tools: [] },
		},
	],
});

interface MemoryItemRow {
	id: string;
	memory_type: string;
	source_ref: string | null;
	scope_channel: string;
	scope_chat_id: string;
}

function queryMemoryItems(agentDir: string): MemoryItemRow[] {
	const db = createSqliteDatabase(join(agentDir, "memory", "memory.sqlite"));
	try {
		return db
			.prepare(
				`SELECT id, memory_type, source_ref, scope_channel, scope_chat_id
				 FROM memory_items
				 WHERE source_ref LIKE 'consolidation:%'
				 ORDER BY id`,
			)
			.all() as MemoryItemRow[];
	} finally {
		db.close();
	}
}

describe("ConsolidationBridge", () => {
	it("writes event entries with consolidation: source refs and the session scope", async () => {
		const agentDir = tempAgentDir();
		const engine = await createMemoryEngine({ agentDir, embedder: charEmbedder() });
		const bridge = new ConsolidationBridge({ engine, llm: makeLlm(IMPLICIT_REPLY) });

		const result = await bridge.handleConsolidated(makePayload());

		expect(result.mode).toBe("synced");
		expect(result.eventStatuses).toHaveLength(2);
		for (const status of result.eventStatuses) expect(status).toMatch(/^(new|reinforced):/);

		const rows = queryMemoryItems(agentDir);
		expect(rows.length).toBeGreaterThanOrEqual(2);
		for (const row of rows) {
			if (row.source_ref?.includes("#h:")) {
				expect(row.memory_type).toBe("event");
				expect(row.source_ref).toMatch(/^consolidation:\["m1","m2","m3"\]#h:/);
				expect(row.scope_channel).toBe("telegram");
				expect(row.scope_chat_id).toBe("42");
			}
		}
		engine.close();
	});

	it("is idempotent per entry source ref: the same batch never duplicates", async () => {
		const agentDir = tempAgentDir();
		const engine = await createMemoryEngine({ agentDir, embedder: charEmbedder() });
		const bridge = new ConsolidationBridge({ engine, llm: makeLlm(IMPLICIT_REPLY) });
		const payload = makePayload();

		const first = await bridge.handleConsolidated(payload);
		const second = await bridge.handleConsolidated(payload);

		expect(second.eventStatuses.every((status) => status.startsWith("skipped:"))).toBe(true);
		expect(first.eventStatuses.length).toBe(2);
		const events = queryMemoryItems(agentDir).filter((row) => row.source_ref?.includes("#h:"));
		expect(events).toHaveLength(2);
		engine.close();
	});

	it("writes implicit profile/preference/procedure items with the session scope", async () => {
		const agentDir = tempAgentDir();
		const engine = await createMemoryEngine({ agentDir, embedder: charEmbedder() });
		const bridge = new ConsolidationBridge({ engine, llm: makeLlm(IMPLICIT_REPLY) });

		const result = await bridge.handleConsolidated(makePayload());

		expect(result.saved).toEqual({ profile: 2, preference: 1, procedure: 1 });
		const rows = queryMemoryItems(agentDir);
		const profile = rows.filter((row) => row.source_ref?.endsWith("#profile"));
		const implicit = rows.filter((row) => row.source_ref?.endsWith("#implicit"));
		expect(profile).toHaveLength(2);
		expect(profile.every((row) => row.memory_type === "profile")).toBe(true);
		expect(implicit).toHaveLength(2);
		expect(implicit.every((row) => row.memory_type === "preference" || row.memory_type === "procedure")).toBe(true);
		for (const row of [...profile, ...implicit]) {
			expect(row.scope_channel).toBe("telegram");
			expect(row.scope_chat_id).toBe("42");
		}
		engine.close();
	});

	it("skips everything when no embedder is configured (degraded to markdown-only)", async () => {
		const agentDir = tempAgentDir();
		const engine = await createMemoryEngine({ agentDir, embedder: charEmbedder() });
		const bridge = new ConsolidationBridge({
			engine: { store: engine.store, memorizer: engine.memorizer, embedder: undefined },
			llm: makeLlm(IMPLICIT_REPLY),
		});

		const result = await bridge.handleConsolidated(makePayload());

		expect(result.mode).toBe("no_embedder");
		expect(result.eventStatuses).toEqual([]);
		expect(result.saved).toEqual({ profile: 0, preference: 0, procedure: 0 });
		expect(queryMemoryItems(agentDir)).toHaveLength(0);
		engine.close();
	});

	it("survives garbage implicit LLM output without failing the event write", async () => {
		const agentDir = tempAgentDir();
		const engine = await createMemoryEngine({ agentDir, embedder: charEmbedder() });
		const bridge = new ConsolidationBridge({ engine, llm: makeLlm("不是 JSON") });

		const result = await bridge.handleConsolidated(makePayload());

		expect(result.mode).toBe("synced");
		expect(result.eventStatuses).toHaveLength(2);
		expect(result.saved).toEqual({ profile: 0, preference: 0, procedure: 0 });
		engine.close();
	});

	it("supports turning implicit extraction off", async () => {
		const agentDir = tempAgentDir();
		const engine = await createMemoryEngine({ agentDir, embedder: charEmbedder() });
		const llm = makeLlm(IMPLICIT_REPLY);
		const bridge = new ConsolidationBridge({ engine, llm, implicitExtraction: false });

		const result = await bridge.handleConsolidated(makePayload());

		expect(result.eventStatuses).toHaveLength(2);
		expect(result.saved).toEqual({ profile: 0, preference: 0, procedure: 0 });
		expect(llm.chat).not.toHaveBeenCalled();
		engine.close();
	});

	it("makes consolidation events retrievable by the fusion retriever", async () => {
		const agentDir = tempAgentDir();
		const engine = await createMemoryEngine({ agentDir, embedder: charEmbedder() });
		const bridge = new ConsolidationBridge({ engine, llm: makeLlm(IMPLICIT_REPLY) });
		const payload = makePayload();

		await bridge.handleConsolidated(payload);

		// 同 scope 检索能召回跨会话 consolidation 写入的 event。
		const hits = await engine.retriever.retrieve("耶加雪菲咖啡豆", {
			scope: { channel: "telegram", chatId: "42" },
			requireScopeMatch: true,
		});
		expect(hits.length).toBeGreaterThan(0);
		expect(hits[0]?.memoryType).toBe("event");

		// 全局 scope 条目可被无 scope 检索召回。
		await bridge.handleConsolidated(
			makePayload({ scope: { channel: "", chatId: "" }, sourceRef: JSON.stringify(["g1"]) }),
		);
		const globalHits = await engine.retriever.retrieve("练习钢琴");
		expect(globalHits.length).toBeGreaterThan(0);
		engine.close();
	});
});
