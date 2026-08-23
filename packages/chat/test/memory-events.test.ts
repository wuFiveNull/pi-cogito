import type { MemoryHit } from "@cogito/host";
import { describe, expect, it, vi } from "vitest";
import { ChatMemory } from "../src/memory.ts";

function makeMemory(overrides: Record<string, unknown> = {}): ChatMemory {
	const engine = {
		memorizer: {
			saveItemWithSupersede: vi.fn(async (_options: Record<string, unknown>) => "new:abc123"),
		},
		retriever: {
			retrieve: vi.fn(async () => [] as MemoryHit[]),
			buildInjectionBlock: vi.fn(() => ({ text: "", injectedIds: [] })),
		},
		store: {
			deleteItems: vi.fn(() => ({ affected: ["gone"], missing: [] })),
		},
		close: vi.fn(),
	};
	return new (ChatMemory as unknown as new (engine: unknown) => ChatMemory)({ ...engine, ...overrides });
}

describe("ChatMemory events", () => {
	it("emits memory_written on remember and forget with ids", async () => {
		const memory = makeMemory();
		const events: Array<{ scope: unknown; ids: string[]; action: string }> = [];
		const unsubscribe = memory.onMemoryWritten((event) => {
			events.push(event);
		});

		const id = await memory.remember({ summary: "用户喜欢手冲咖啡", memoryType: "preference" });
		expect(id).toBe("abc123");
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ ids: ["abc123"], action: "remember" });

		memory.forget(["abc123"]);
		expect(events).toHaveLength(2);
		expect(events[1]).toMatchObject({ ids: ["gone"], action: "forget" });

		unsubscribe();
		await memory.remember({ summary: "不再触发" });
		expect(events).toHaveLength(2);
		memory.close();
	});

	it("passes extra and happenedAt through to the memorizer", async () => {
		const memory = makeMemory();
		await memory.remember({
			summary: "查库存前先调用 steam_query",
			memoryType: "procedure",
			extra: { trigger_tags: ["steam", "库存"] },
			happenedAt: "2026-08-16T00:00:00Z",
			sourceRef: "chat:c:1@test",
		});
		expect(memory.engine.memorizer.saveItemWithSupersede).toHaveBeenCalledWith(
			expect.objectContaining({
				extra: { trigger_tags: ["steam", "库存"] },
				happenedAt: "2026-08-16T00:00:00Z",
				sourceRef: "chat:c:1@test",
			}),
		);
		memory.close();
	});
});

describe("ChatMemory.matchProcedure", () => {
	it("matches a procedure whose trigger tags appear in the tool call", async () => {
		const hit: MemoryHit = {
			id: "p1",
			memoryType: "procedure",
			summary: "查库存前先调用 steam_query",
			sourceRef: "s",
			happenedAt: null,
			score: 0.8,
			extra: { trigger_tags: ["steam", "库存"] },
		};
		const memory = makeMemory({
			retriever: {
				retrieve: vi.fn(async () => [hit]),
				buildInjectionBlock: vi.fn(() => ({ text: "", injectedIds: [] })),
			},
		});
		const matched = await memory.matchProcedure({ channel: "c", chatId: "1" }, "steam_query", {
			game: "CS2",
			query: "库存",
		});
		expect(matched).toBe(hit);
		expect(memory.engine.retriever.retrieve).toHaveBeenCalledWith(
			expect.stringContaining("steam_query"),
			expect.objectContaining({ intent: "procedure", requireScopeMatch: true }),
		);
		memory.close();
	});

	it("returns undefined when no trigger tag matches", async () => {
		const hit: MemoryHit = {
			id: "p1",
			memoryType: "procedure",
			summary: "规则",
			sourceRef: "s",
			happenedAt: null,
			score: 0.8,
			extra: { trigger_tags: ["股票"] },
		};
		const memory = makeMemory({
			retriever: {
				retrieve: vi.fn(async () => [hit]),
				buildInjectionBlock: vi.fn(() => ({ text: "", injectedIds: [] })),
			},
		});
		const matched = await memory.matchProcedure({ channel: "c", chatId: "1" }, "web_fetch", { url: "https://x" });
		expect(matched).toBeUndefined();
		memory.close();
	});
});
