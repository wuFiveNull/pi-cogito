import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractJsonObject, formatRecentEntries, isMessageDuplicate } from "../src/stages/dedupe.ts";
import { type DeliveryOutlet, SqliteDeliverStrategy } from "../src/stages/deliver.ts";
import { type DeliveryRecord, ProactiveStore } from "../src/store.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	vi.unstubAllGlobals();
});

function makeStore(): ProactiveStore {
	const agentDir = mkdtempSync(join(tmpdir(), "proactive-dedupe-"));
	tempDirs.push(agentDir);
	return new ProactiveStore(join(agentDir, "proactive.sqlite"));
}

/** Fake chat endpoint returning a fixed LLM reply. */
function stubChat(reply: string, ok = true): ReturnType<typeof vi.fn> {
	const fetchMock = vi.fn().mockResolvedValue({
		ok,
		json: async () => ({ choices: [{ message: { content: reply } }] }),
	});
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

const LLM_OPTS = {
	model: "m",
	baseUrl: "https://api.example.com/v1",
	apiKey: "k",
	requestTimeoutMs: 1000,
};

describe("LLM dedupe (akashic deduper.py port)", () => {
	it("flags a semantic duplicate", async () => {
		stubChat('{"is_duplicate": true, "reason": "同一事件重复"}');
		const result = await isMessageDuplicate(
			"新消息",
			[{ message: "旧消息", delivered_at: 1_700_000_000_000 }],
			LLM_OPTS,
		);
		expect(result.duplicate).toBe(true);
		expect(result.reason).toBe("同一事件重复");
	});

	it("passes a genuinely new message", async () => {
		stubChat('{"is_duplicate": false, "reason": "有新进展"}');
		const result = await isMessageDuplicate("新消息", [{ message: "旧消息" }], LLM_OPTS);
		expect(result.duplicate).toBe(false);
	});

	it("skips the LLM call when there are no recent messages", async () => {
		const fetchMock = stubChat("{}");
		const result = await isMessageDuplicate("新消息", [], LLM_OPTS);
		expect(result.duplicate).toBe(false);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("fails open on LLM errors", async () => {
		stubChat("", false);
		const result = await isMessageDuplicate("新消息", [{ message: "旧" }], LLM_OPTS);
		expect(result.duplicate).toBe(false);
		expect(result.reason).toBe("dedupe_llm_unavailable");
	});

	it("fails open on invalid JSON", async () => {
		stubChat("不是 JSON");
		const result = await isMessageDuplicate("新消息", [{ message: "旧" }], LLM_OPTS);
		expect(result.duplicate).toBe(false);
		expect(result.reason).toBe("dedupe_invalid_json");
	});

	it("parses fenced JSON replies", async () => {
		stubChat('```json\n{"is_duplicate": true, "reason": "r"}\n```');
		const result = await isMessageDuplicate("新消息", [{ message: "旧" }], LLM_OPTS);
		expect(result.duplicate).toBe(true);
	});
});

describe("extractJsonObject", () => {
	it("parses plain and fenced JSON", () => {
		expect(extractJsonObject('{"a": 1}')).toEqual({ a: 1 });
		expect(extractJsonObject('```json\n{"a": 1}\n```')).toEqual({ a: 1 });
		expect(extractJsonObject("no json")).toEqual({});
	});
});

describe("formatRecentEntries", () => {
	it("renders time and state tag metadata", () => {
		const text = formatRecentEntries([
			{ message: "甲", delivered_at: 1_700_000_000_000, state_summary_tag: "focus" },
			{ message: "乙", state_summary_tag: "none" },
		]);
		expect(text).toContain("[1] (time=");
		expect(text).toContain("state_tag=focus");
		expect(text).toContain("[2] 乙");
	});
});

describe("SqliteDeliverStrategy with llmDedupeFn", () => {
	it("rejects semantically duplicate messages after rule dedupe passes", async () => {
		const store = makeStore();
		const llmDedupeFn = vi.fn().mockResolvedValue({ duplicate: true, reason: "同一事件" });
		const strategy = new SqliteDeliverStrategy(store, {
			deliveryDedupeHours: 24,
			messageDedupeRecentN: 5,
			llmDedupeFn,
		});
		const result = await strategy.deliver(
			{
				message: "deepseek 发布了 v4",
				evidence: [{ id: "ev1", itemId: 1, source: "g", title: "t", snippet: "s", url: "" }],
				itemIds: [1],
			},
			{
				sessionKey: "local",
				now: new Date(),
				rulesPanel: "",
				preferenceBlock: "",
				contextAsFallbackOpen: false,
				store,
			},
		);
		expect(result.delivered).toBe(false);
		expect(result.reason).toBe("llm_duplicate");
		expect(llmDedupeFn).toHaveBeenCalledTimes(1);
		expect(store.listDeliveries(10)).toHaveLength(0);
	});

	it("delivers when the LLM says it is a new message", async () => {
		const store = makeStore();
		const llmDedupeFn = vi.fn().mockResolvedValue({ duplicate: false, reason: "新进展" });
		const strategy = new SqliteDeliverStrategy(store, {
			deliveryDedupeHours: 24,
			messageDedupeRecentN: 5,
			llmDedupeFn,
		});
		const result = await strategy.deliver(
			{
				message: "deepseek 发布了 v4",
				evidence: [{ id: "ev1", itemId: 1, source: "g", title: "t", snippet: "s", url: "" }],
				itemIds: [1],
			},
			{
				sessionKey: "local",
				now: new Date(),
				rulesPanel: "",
				preferenceBlock: "",
				contextAsFallbackOpen: false,
				store,
			},
		);
		expect(result.delivered).toBe(true);
		expect(store.listDeliveries(10)).toHaveLength(1);
	});

	it("skips the LLM dedupe when not configured", async () => {
		const store = makeStore();
		const strategy = new SqliteDeliverStrategy(store, { deliveryDedupeHours: 24, messageDedupeRecentN: 5 });
		const result = await strategy.deliver(
			{
				message: "消息",
				evidence: [{ id: "ev1", itemId: 1, source: "g", title: "t", snippet: "s", url: "" }],
				itemIds: [1],
			},
			{
				sessionKey: "local",
				now: new Date(),
				rulesPanel: "",
				preferenceBlock: "",
				contextAsFallbackOpen: false,
				store,
			},
		);
		expect(result.delivered).toBe(true);
	});

	it("commits item state only after an external outlet accepts the message", async () => {
		const store = makeStore();
		store.insertItem({
			scope: "",
			source: "feed",
			sub_source: "feed",
			title: "候选",
			url: "https://example.com/item",
			summary: "摘要",
			title_hash: "delivery-outlet-success",
			interest_score: null,
			recommendation: null,
			verdict: null,
			verdict_reason: null,
			fetched_at: Date.now(),
		});
		const itemId = store.listNew()[0]!.id;
		const outlet: DeliveryOutlet = {
			send: vi.fn(async (_record: DeliveryRecord) => {}),
		};
		const strategy = new SqliteDeliverStrategy(store, {
			deliveryDedupeHours: 24,
			messageDedupeRecentN: 5,
			outlet,
		});

		const result = await strategy.deliver(
			{
				message: "外部出口消息",
				evidence: [{ id: "ev1", itemId, source: "feed", title: "候选", snippet: "摘要", url: "" }],
				itemIds: [itemId],
			},
			{
				sessionKey: "local",
				now: new Date(),
				rulesPanel: "",
				preferenceBlock: "",
				contextAsFallbackOpen: false,
				store,
			},
		);

		expect(result).toEqual({ delivered: true });
		expect(store.listPendingDeliveries()).toHaveLength(0);
		expect(store.getItem(itemId)?.status).toBe("pushed");
	});

	it("leaves an outbox row and the item new when an external outlet fails", async () => {
		const store = makeStore();
		store.insertItem({
			scope: "",
			source: "feed",
			sub_source: "feed",
			title: "失败候选",
			url: null,
			summary: "摘要",
			title_hash: "delivery-outlet-failure",
			interest_score: null,
			recommendation: null,
			verdict: null,
			verdict_reason: null,
			fetched_at: Date.now(),
		});
		const itemId = store.listNew()[0]!.id;
		const outlet: DeliveryOutlet = {
			send: vi.fn(async (_record: DeliveryRecord) => {
				throw new Error("channel down");
			}),
			enqueue: vi.fn(),
		};
		const strategy = new SqliteDeliverStrategy(store, {
			deliveryDedupeHours: 24,
			messageDedupeRecentN: 5,
			outlet,
		});

		const result = await strategy.deliver(
			{
				message: "失败消息",
				evidence: [{ id: "ev2", itemId, source: "feed", title: "失败候选", snippet: "摘要", url: "" }],
				itemIds: [itemId],
			},
			{
				sessionKey: "local",
				now: new Date(),
				rulesPanel: "",
				preferenceBlock: "",
				contextAsFallbackOpen: false,
				store,
			},
		);

		expect(result).toEqual({ delivered: false, reason: "outlet_failed" });
		expect(store.listPendingDeliveries()).toHaveLength(1);
		expect(store.getItem(itemId)?.status).toBe("new");
		expect(outlet.enqueue).toHaveBeenCalledTimes(1);
	});

	it("does not commit partial receipts or count them as delivered", async () => {
		const store = makeStore();
		const outlet: DeliveryOutlet = {
			send: vi.fn(async (_record: DeliveryRecord) => ({ status: "partial" as const, detail: "media failed" })),
			enqueue: vi.fn(),
		};
		const strategy = new SqliteDeliverStrategy(store, {
			deliveryDedupeHours: 24,
			messageDedupeRecentN: 5,
			outlet,
		});

		const result = await strategy.deliver(
			{
				message: "部分失败消息",
				evidence: [{ id: "ev3", itemId: 3, source: "feed", title: "候选", snippet: "摘要", url: "" }],
				itemIds: [3],
			},
			{
				sessionKey: "local",
				now: new Date(),
				rulesPanel: "",
				preferenceBlock: "",
				contextAsFallbackOpen: false,
				store,
			},
		);

		expect(result).toEqual({ delivered: false, reason: "outlet_partial" });
		expect(store.listPendingDeliveries()).toHaveLength(1);
		expect(store.listPendingDeliveries()[0]?.delivery_status).toBe("partial");
		expect(store.isMessageDelivered("does-not-match", 24)).toBe(false);
		expect(store.countDeliveriesInWindow(24)).toBe(0);
		expect(outlet.enqueue).toHaveBeenCalledTimes(1);
	});
});
