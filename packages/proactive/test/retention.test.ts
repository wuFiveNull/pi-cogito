import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { ProactiveStore } from "../src/store.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeStore(): { store: ProactiveStore; dbPath: string } {
	const dir = mkdtempSync(join(tmpdir(), "proactive-retention-"));
	tempDirs.push(dir);
	const dbPath = join(dir, "proactive.sqlite");
	return { store: new ProactiveStore(dbPath), dbPath };
}

function insertItem(store: ProactiveStore, title: string, fetchedAt: number): number {
	store.insertItem({
		scope: "local",
		recommendation: null,
		verdict: "interesting",
		verdict_reason: null,
		source: "test",
		sub_source: "retention",
		source_event_id: null,
		ack_source_id: null,
		title,
		url: null,
		summary: title,
		title_hash: title,
		interest_score: 0.5,
		fetched_at: fetchedAt,
	});
	const item = store.listNew(20, "local").find((candidate) => candidate.title === title);
	if (!item) throw new Error(`failed to insert item ${title}`);
	return item.id;
}

function insertDelivery(store: ProactiveStore, key: string, deliveredAt: number): number {
	return store.insertDelivery({
		session_key: "local",
		message: key,
		message_hash: key,
		source_refs: "[]",
		evidence: "[]",
		action: "send",
		state_summary_tag: "none",
		delivered_at: deliveredAt,
		idempotency_key: key,
	});
}

describe("Proactive history retention", () => {
	it("removes old terminal history while preserving pending work and new items", () => {
		const { store, dbPath } = makeStore();
		const old = Date.parse("2026-05-01T00:00:00.000Z");
		const now = Date.parse("2026-05-11T00:00:00.000Z");
		try {
			const oldItemId = insertItem(store, "old item", old);
			store.markPushed(oldItemId, old);
			const oldDismissedItemId = insertItem(store, "old dismissed item", old);
			store.markDismissed(oldDismissedItemId);
			insertItem(store, "new item", old);

			const oldDeliveryId = insertDelivery(store, "old delivery", old);
			store.ackDeliveries([oldDeliveryId], old, { notify: false });
			const pendingDeliveryId = insertDelivery(store, "pending delivery", old);

			const oldTickId = store.recordTickLog({
				session_key: "local",
				started_at: old,
				finished_at: old,
				base_score: 0.1,
				candidates: 1,
				steps: 1,
				action: "send",
				skip_reason: "",
				error: null,
			});
			store.recordTickStep({
				tick_id: oldTickId,
				step_index: 0,
				phase: "sense",
				detail: "old",
				action_after: "send",
				skip_reason_after: "",
				duration_ms: 1,
			});
			const activeTickId = store.recordTickLog({
				session_key: "local",
				started_at: old,
				finished_at: null,
				base_score: null,
				candidates: 0,
				steps: 1,
				action: "running",
				skip_reason: "",
				error: null,
			});
			store.recordTickStep({
				tick_id: activeTickId,
				step_index: 0,
				phase: "sense",
				detail: "active",
				action_after: "",
				skip_reason_after: "",
				duration_ms: 1,
			});

			store.recordSourceFailure({ sourceId: "test", error: "old failure", now: old });
			store.recordSourceQuarantine({
				sourceId: "test",
				itemId: "old-event",
				reason: "old quarantine",
				payload: { old: true },
				now: old,
			});
			store.markContextOnlySend("local", old);
			store.incrementDailyCount("send", old);

			const result = store.pruneHistory({
				maxItemAgeDays: 5,
				maxDeliveryAgeDays: 5,
				maxTickLogAgeDays: 5,
				maxSourceFailureAgeDays: 5,
				maxQuarantineAgeDays: 5,
				maxContextOnlyAgeDays: 5,
				maxDailyCountAgeDays: 5,
				now,
			});
			expect(result).toEqual({
				itemsDeleted: 2,
				deliveriesDeleted: 1,
				tickLogsDeleted: 1,
				tickStepsDeleted: 1,
				sourceFailuresDeleted: 1,
				quarantineDeleted: 1,
				contextOnlyDeleted: 1,
				dailyCountsDeleted: 1,
			});

			const pending = store.getDelivery(pendingDeliveryId);
			expect(pending).toMatchObject({ acked: 0, delivery_status: "pending" });
			const db = new DatabaseSync(dbPath, { readOnly: true });
			try {
				const count = (table: string): number =>
					Number((db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count);
				expect(count("items")).toBe(1);
				expect(count("deliveries")).toBe(1);
				expect(count("tick_log")).toBe(1);
				expect(count("tick_steps")).toBe(1);
				expect(count("source_failures")).toBe(0);
				expect(count("source_quarantine")).toBe(0);
				expect(count("context_only_timestamps")).toBe(0);
				expect(count("daily_counts")).toBe(0);
			} finally {
				db.close();
			}
		} finally {
			store.close();
		}
	});
});
