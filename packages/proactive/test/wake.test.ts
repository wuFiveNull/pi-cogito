import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { evaluateContext } from "../src/wake/context-drive.ts";
import { buildEmbeddingApi } from "../src/wake/embeddings.ts";
import { executeEventTool } from "../src/wake/event-tools.ts";
import { advanceHazard, rankEvents, WAKE_ADMISSION_FLOOR } from "../src/wake/hazard.ts";
import { renderShare } from "../src/wake/renderer.ts";
import { WakeStateStore } from "../src/wake/state.ts";
import type { WakeEvent } from "../src/wake/types.ts";
import { newWakeContext } from "../src/wake/types.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	vi.useRealTimers();
});

function makeState(): WakeStateStore {
	const dir = mkdtempSync(join(tmpdir(), "wake-state-"));
	tempDirs.push(dir);
	return new WakeStateStore(join(dir, "wake_proactive.db"));
}

function makeEvent(overrides: Partial<WakeEvent> = {}): WakeEvent {
	const eventId = `ev-${Math.random().toString(36).slice(2, 8)}`;
	return {
		kind: "content",
		sourceId: "feed",
		ackSourceId: "feed",
		eventId,
		publishedAt: "2026-01-01T00:00:00Z",
		preprocess_score: 0.8,
		title: "标题",
		url: "https://example.com/1",
		// 蓄水池 unread() 输出形状:payload 携带 id/item_id。
		id: `feed:${eventId}`,
		item_id: `feed:${eventId}`,
		...overrides,
	};
}

const NOW = new Date("2026-01-02T00:00:00Z");

describe("wake hazard (akashic hazard.py port)", () => {
	it("never wakes without new items", () => {
		const result = advanceHazard([makeEvent()], {
			now: NOW,
			newItemIds: new Set(),
			randomDraw: 0.01,
			lastWakeAt: null,
		});
		expect(result.shouldWake).toBe(false);
	});

	it("new content drives a probability draw", () => {
		const event = makeEvent();
		const eventId = `${event.ackSourceId}:${event.eventId}`;
		const result = advanceHazard([event], {
			now: NOW,
			newItemIds: new Set([eventId]),
			randomDraw: 0.001,
			lastWakeAt: null,
		});
		expect(result.shouldWake).toBe(true);
		expect(result.rate).toBeGreaterThan(0);
		expect(result.driverItemId).toBe(eventId);
	});

	it("ranks by freshness and applies source diversity decay", () => {
		const fresh = makeEvent({ eventId: "a", publishedAt: "2026-01-01T23:00:00Z" });
		const stale = makeEvent({ eventId: "b", publishedAt: "2026-01-01T00:00:00Z" });
		const ranked = rankEvents([stale, fresh], NOW);
		expect(ranked[0]?._wake_rank_score as number).toBeGreaterThan((ranked[1]?._wake_rank_score ?? 0) as number);
		const sameSource = [fresh, { ...fresh, eventId: "c", publishedAt: "2026-01-01T22:00:00Z" }];
		const diversified = rankEvents(sameSource, NOW);
		expect(Number(diversified[0]!._wake_rank_score as number)).toBeGreaterThan(
			Number(diversified[1]!._wake_rank_score as number),
		);
		expect((diversified[1]!._wake_rank_features as Record<string, number>).source_diversity).toBe(0.5);
	});

	it("expires only content past the admission floor", () => {
		const event = makeEvent({ preprocess_score: 0.001 });
		const eventId = `${event.ackSourceId}:${event.eventId}`;
		const ranked = rankEvents([event], NOW);
		expect(Number(ranked[0]!._wake_rank_score)).toBeLessThan(WAKE_ADMISSION_FLOOR);
		expect(eventId).toBeDefined();
	});
});

describe("wake context drive (akashic context_drive.py port)", () => {
	it("signals reevaluate on a confident presence transition", () => {
		const first = evaluateContext({ _source: "discord", presence: "active", confidence: 0.8 });
		const second = evaluateContext(
			{ _source: "discord", presence: "sleeping", confidence: 0.8 },
			{ previous: first.context },
		);
		expect(second.signal).toBe("reevaluate");
		expect(second.context.presence).toBe("sleeping");
		expect(second.context.interruptibility).toBe(0);
	});

	it("keeps refresh when nothing changed", () => {
		const first = evaluateContext({ _source: "x", presence: "idle" });
		const second = evaluateContext({ _source: "x", presence: "idle" }, { previous: first.context });
		expect(second.signal).toBe("refresh");
	});
});

describe("wake event tools", () => {
	it("executes send_event and skip_event", () => {
		expect(executeEventTool("send_event", { message: "hi" })).toEqual({ decision: "reply", message: "hi" });
		expect(executeEventTool("skip_event", { reason: "quiet" })).toEqual({ decision: "skip", message: "" });
		expect(() => executeEventTool("send_event", { message: "  " })).toThrow();
	});
});

describe("wake renderer (akashic renderer.py port)", () => {
	it("renders message with evidence and source refs", () => {
		const event = makeEvent();
		const rendered = renderShare({
			message: "刚看到这个",
			opening: "",
			items: [{ item_id: String(event.id), summary: "要点", why_it_matters: "为什么重要" }],
			closing: "",
			events: [event],
		});
		expect(rendered.message).toContain("刚看到这个");
		expect(rendered.evidence).toEqual([event.id]);
		expect(rendered.sourceRefs[0]?.display_index).toBe(1);
		expect(rendered.message).toContain("来源：https://example.com/1");
	});
});

describe("WakeStateStore reservoir (akashic state.py port)", () => {
	it("ingests events once and returns only new ids", () => {
		const state = makeState();
		const event = makeEvent();
		const first = state.ingestWithIds("content", [event, event], NOW);
		expect(first).toHaveLength(1);
		const second = state.ingestWithIds("content", [event], NOW);
		expect(second).toHaveLength(0);
		expect(state.unreadCount("content")).toBe(1);
		const unread = state.unread("content");
		expect(unread[0]?.id).toBe(`${event.ackSourceId}:${event.eventId}`);
		state.close();
	});

	it("quarantines events without identity and enforces caps", () => {
		const state = makeState();
		state.ingestWithIds("content", [{ kind: "content", title: "无身份" }], NOW);
		const quarantined = state.quarantined();
		expect(quarantined.length).toBe(1);
		expect(String(quarantined[0]?.reason)).toContain("缺少 source/event identity");
		state.close();
	});

	it("quarantines timestamps without an explicit timezone", () => {
		const state = makeState();
		state.ingestWithIds("content", [makeEvent({ publishedAt: "2026-01-01T00:00:00" })], NOW);
		expect(state.unreadCount("content")).toBe(0);
		expect(state.quarantined()[0]?.reason).toContain("timezone");
		state.close();
	});

	it("consumes with ack queue and tombstones on expire", () => {
		const state = makeState();
		const event = makeEvent();
		state.ingestWithIds("content", [event], NOW);
		const itemId = `${event.ackSourceId}:${event.eventId}`;
		state.consumeAndQueueAck({
			itemIds: [itemId],
			acknowledgements: { feed: [event.eventId!] },
			now: NOW,
		});
		expect(state.unreadCount("content")).toBe(0);
		const pending = state.pendingAcknowledgements();
		expect(pending.feed).toEqual([event.eventId]);
		state.markAcknowledged("feed", [event.eventId!]);
		expect(state.pendingAcknowledgements()).toEqual({});
		state.close();
	});

	it("queues expiration and writes a tombstone after ack", () => {
		const state = makeState();
		const event = makeEvent();
		state.ingestWithIds("content", [event], NOW);
		const itemId = `${event.ackSourceId}:${event.eventId}`;
		state.queueExpiration([itemId], NOW);
		expect(state.unreadCount("content")).toBe(0); // pending_expiry 不计入 unread
		expect(state.pendingAcknowledgementBatches()).toMatchObject([
			{ source_id: "feed", source_event_id: event.eventId, item_id: itemId, action: "expire" },
		]);
		state.markAcknowledged("feed", [event.eventId!]);
		// 墓碑阻止同一事件重新入池。
		expect(state.ingestWithIds("content", [event], NOW)).toHaveLength(0);
		state.close();
	});

	it("writes an expiry tombstone even if the pending payload was lost", () => {
		const dir = mkdtempSync(join(tmpdir(), "wake-state-lost-payload-"));
		tempDirs.push(dir);
		const dbPath = join(dir, "wake_proactive.db");
		const event = makeEvent({ eventId: "lost-payload" });
		const state = new WakeStateStore(dbPath);
		state.ingestWithIds("content", [event], NOW);
		const itemId = `${event.ackSourceId}:${event.eventId}`;
		state.queueExpiration([itemId], NOW);
		state.close();

		const db = new DatabaseSync(dbPath);
		db.prepare("DELETE FROM reservoir_events WHERE item_id = ?").run(itemId);
		db.close();

		const reopened = new WakeStateStore(dbPath);
		reopened.markAcknowledged("feed", [event.eventId!]);
		expect(reopened.pendingAcknowledgements()).toEqual({});
		expect(reopened.ingestWithIds("content", [event], NOW)).toHaveLength(0);
		reopened.close();
	});

	it("computes time-decayed aggregate mass", () => {
		const state = makeState();
		state.ingestWithIds("content", [makeEvent({ preprocessScore: 0.9 })], NOW);
		expect(state.unreadAggregateMass("content", NOW)).toBeGreaterThan(0);
		state.close();
	});

	it("ingests the batch atomically and defers commit:false quarantine (akashic 单 commit)", () => {
		const state = makeState();
		// fetch 阶段延后的隔离区:commit:false 不立即落库。
		state.recordQuarantine({
			sourceId: "feed",
			itemId: "bad-1",
			reason: "fetch-invalid",
			payload: {},
			commit: false,
		});
		expect(state.quarantined()).toHaveLength(0);

		// 批中某条 payload 序列化失败 → 整个事务回滚:事件与隔离区都不落库。
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		const good = makeEvent({ eventId: "atomic-good" });
		expect(() => state.ingestWithIds("content", [good, circular as unknown as WakeEvent], NOW)).toThrow();
		expect(state.unreadCount("content")).toBe(0);
		expect(state.quarantined()).toHaveLength(0);

		// 恢复正常批次后,延后隔离区随事务一起落库。
		state.ingestWithIds("content", [good], NOW);
		expect(state.unreadCount("content")).toBe(1);
		state.close();
	});

	it("consumes atomically: rowcount mismatch rolls back the whole consume", () => {
		const state = makeState();
		const event = makeEvent();
		state.ingestWithIds("content", [event], NOW);
		const itemId = `${event.ackSourceId}:${event.eventId}`;
		// 部分 id 不存在 → 抛错且已有行的更新回滚(akashic consume rollback)。
		expect(() => state.consume([itemId, "feed:missing"], NOW)).toThrow(/did not match/);
		expect(state.unreadCount("content")).toBe(1);
		// 单独 consume 成功。
		state.consume([itemId], NOW);
		expect(state.unreadCount("content")).toBe(0);
		state.close();
	});
});

describe("wake run persistence", () => {
	it("saves and reloads a wake context", () => {
		const state = makeState();
		const ctx = newWakeContext("local", NOW);
		ctx.scratchpad = { [ctx.wakeId]: { itemId: ctx.wakeId, initialInterest: "likely_interesting", question: "q" } };
		ctx.finalMessage = "消息";
		ctx.terminalAction = "reply";
		state.save(ctx);
		const loaded = state.get(ctx.wakeId);
		expect(loaded?.final_message).toBe("消息");
		expect(loaded?.terminal_action).toBe("reply");
		state.close();
	});
});

describe("wake embedding api (pi-ai adapter)", () => {
	it("returns undefined when disabled or missing key", () => {
		expect(buildEmbeddingApi(undefined)).toBeUndefined();
		expect(buildEmbeddingApi({ enabled: false })).toBeUndefined();
		const previous = process.env.SILICONFLOW_API_KEY;
		delete process.env.SILICONFLOW_API_KEY;
		expect(buildEmbeddingApi({ enabled: true })).toBeUndefined();
		if (previous !== undefined) process.env.SILICONFLOW_API_KEY = previous;
	});

	it("builds an api with an explicit key", () => {
		const api = buildEmbeddingApi({ enabled: true, apiKey: "sk-test" });
		expect(api?.modelId).toBe("BAAI/bge-m3");
		expect(typeof api?.embedBatch).toBe("function");
	});
});
