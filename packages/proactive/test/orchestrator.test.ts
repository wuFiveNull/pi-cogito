import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProactiveTurnOrchestrator } from "../src/runtime/orchestrator.ts";
import { SourceAckCoordinator } from "../src/runtime/source-ack.ts";
import { SqliteDeliverStrategy } from "../src/stages/deliver.ts";
import { ProactiveStore } from "../src/store.ts";
import type { ProactiveSource } from "../src/types.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("ProactiveTurnOrchestrator", () => {
	it("sends through the host and records success side effects", async () => {
		const appendAssistantMessage = vi.fn();
		const recordProactiveSent = vi.fn();
		const recordEvent = vi.fn();
		const acknowledge = vi.fn(async () => {});
		const orchestrator = new ProactiveTurnOrchestrator({
			outbound: {
				send: vi.fn(async () => ({ status: "success" as const, providerMessageId: "provider-1" })),
			},
			session: { appendAssistantMessage },
			presence: { recordProactiveSent },
			memory: { recordEvent },
			sourceAck: { acknowledge },
		});
		const request = {
			sessionKey: "local",
			message: "消息",
			sourceRefs: [],
			deliveryKey: "delivery:1",
			timestamp: 100,
			acknowledgements: { feed: ["event-1"] },
		};

		const receipt = await orchestrator.send(request, async () => ({ status: "failed" }));
		const sideEffects = await orchestrator.afterSuccessfulDelivery(request);

		expect(receipt).toMatchObject({ status: "success", providerMessageId: "provider-1" });
		expect(appendAssistantMessage).toHaveBeenCalledWith({
			sessionKey: "local",
			content: "消息",
			timestamp: 100,
			proactive: true,
		});
		expect(recordProactiveSent).toHaveBeenCalledWith({ sessionKey: "local", timestamp: 100 });
		expect(recordEvent).toHaveBeenCalledWith({
			sessionKey: "local",
			now: 100,
			event: {
				type: "proactive_delivery",
				deliveryKey: "delivery:1",
				message: "消息",
				sourceRefs: [],
			},
		});
		expect(acknowledge).toHaveBeenCalledWith("feed", ["event-1"]);
		expect(sideEffects).toMatchObject({
			sessionRecorded: true,
			presenceRecorded: true,
			memoryRecorded: true,
			acknowledged: true,
		});
	});

	it("keeps transport success when a host side effect fails", async () => {
		const orchestrator = new ProactiveTurnOrchestrator({
			session: {
				appendAssistantMessage: async () => {
					throw new Error("session unavailable");
				},
			},
		});
		const report = await orchestrator.afterSuccessfulDelivery({
			sessionKey: "local",
			message: "已发送",
			sourceRefs: [],
			deliveryKey: "delivery:2",
			timestamp: 200,
		});

		expect(report.sessionRecorded).toBe(false);
		expect(report.errors.join(" ")).toContain("session append failed");
	});
});

describe("SqliteDeliverStrategy host transport", () => {
	it("uses host outbound and appends the assistant message after success", async () => {
		const dir = mkdtempSync(join(tmpdir(), "proactive-orchestrator-"));
		tempDirs.push(dir);
		const store = new ProactiveStore(join(dir, "proactive.sqlite"));
		const appendAssistantMessage = vi.fn();
		const send = vi.fn(async () => ({ status: "success" as const, providerMessageId: "host-1" }));
		const strategy = new SqliteDeliverStrategy(store, {
			deliveryDedupeHours: 24,
			messageDedupeRecentN: 5,
			runtimePorts: { outbound: { send }, session: { appendAssistantMessage } },
		});

		const result = await strategy.deliver(
			{
				message: "值得一看",
				evidence: [{ id: "e1", itemId: 1, source: "feed", title: "标题", snippet: "摘要", url: "" }],
				itemIds: [],
			},
			{
				sessionKey: "local",
				now: new Date(100),
				rulesPanel: "",
				preferenceBlock: "",
				contextAsFallbackOpen: false,
				store,
			},
		);

		expect(result).toEqual({ delivered: true });
		expect(send).toHaveBeenCalledWith(
			expect.objectContaining({ sessionKey: "local", message: "值得一看", deliveryKey: expect.any(String) }),
		);
		expect(appendAssistantMessage).toHaveBeenCalledTimes(1);
		expect(store.listDeliveredDeliveries(10)[0]).toMatchObject({
			delivery_status: "success",
			provider_message_id: "host-1",
		});
		store.close();
	});

	it("queues default source ACK failures and retries them", async () => {
		const dir = mkdtempSync(join(tmpdir(), "proactive-orchestrator-"));
		tempDirs.push(dir);
		const store = new ProactiveStore(join(dir, "proactive.sqlite"));
		let fail = true;
		const ack = vi.fn(async () => {
			if (fail) throw new Error("ack unavailable");
		});
		const source: ProactiveSource = { id: "feed", label: "Feed", fetch: async () => [], ack };
		const sourceAck = new SourceAckCoordinator({
			store,
			sources: new Map([[source.id, source]]),
		});
		store.insertItem({
			scope: "",
			source: "feed",
			sub_source: "feed",
			source_event_id: "event-1",
			ack_source_id: "feed",
			title: "标题",
			url: null,
			summary: "摘要",
			title_hash: "hash-1",
			interest_score: null,
			recommendation: null,
			verdict: null,
			verdict_reason: null,
			fetched_at: 100,
		});
		const strategy = new SqliteDeliverStrategy(store, {
			deliveryDedupeHours: 24,
			messageDedupeRecentN: 5,
			runtimePorts: { sourceAck },
		});

		const result = await strategy.deliver(
			{
				message: "消息",
				evidence: [{ id: "e1", itemId: 1, source: "feed", title: "标题", snippet: "摘要", url: "" }],
				itemIds: [1],
			},
			{
				sessionKey: "local",
				now: new Date(100),
				rulesPanel: "",
				preferenceBlock: "",
				contextAsFallbackOpen: false,
				store,
			},
		);

		expect(result).toEqual({ delivered: true });
		expect(store.listPendingSourceAcknowledgements()).toHaveLength(1);
		fail = false;
		await sourceAck.flush(1000, { force: true });
		expect(ack).toHaveBeenCalledWith({}, ["event-1"]);
		expect(store.listPendingSourceAcknowledgements()).toHaveLength(0);
		store.close();
	});
});
