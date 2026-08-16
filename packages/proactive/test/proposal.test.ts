import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProactiveProposal, proposalAcknowledgements } from "../src/proposal.ts";
import { deliverProactiveProposal } from "../src/stages/deliver.ts";
import { ProactiveStore } from "../src/store.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("shared proactive proposal contract", () => {
	it("groups only explicit source acknowledgement references", () => {
		expect(
			proposalAcknowledgements([
				{ id: "feed:event-1", ack_source_id: "feed", event_id: "event-1" },
				{ id: "feed:event-2", ack_source_id: "feed", source_event_id: "event-2" },
				{ id: 3, source: "local" },
			]),
		).toEqual({ feed: ["event-1", "event-2"] });
	});

	it("uses one idempotent delivery transaction for wake-style proposals", async () => {
		const dir = mkdtempSync(join(tmpdir(), "proactive-proposal-"));
		tempDirs.push(dir);
		const store = new ProactiveStore(join(dir, "proactive.sqlite"));
		const proposal = createProactiveProposal({
			action: "send",
			message: "一条经过证据确认的消息",
			itemIds: ["feed:event-1"],
			sourceRefs: [{ id: "feed:event-1", ack_source_id: "feed", event_id: "event-1" }],
			reason: "wake_content",
		});

		const first = await deliverProactiveProposal(
			proposal,
			{ sessionKey: "local", now: new Date(1000) },
			{ store, deliveryDedupeHours: 24, messageDedupeRecentN: 5, acknowledgeSources: false },
		);
		const second = await deliverProactiveProposal(
			proposal,
			{ sessionKey: "local", now: new Date(2000) },
			{ store, deliveryDedupeHours: 24, messageDedupeRecentN: 5, acknowledgeSources: false },
		);

		expect(first).toEqual({ delivered: true });
		expect(second).toEqual({ delivered: false, reason: "duplicate" });
		const delivery = store.listDeliveredDeliveries(1)[0];
		expect(delivery).toBeDefined();
		expect(store.getDeliveryByIdempotencyKey(delivery!.idempotency_key)).toMatchObject({
			id: delivery!.id,
			delivery_status: "success",
		});
		expect(store.listDeliveredDeliveries(10)).toHaveLength(1);
		store.close();
	});
});
