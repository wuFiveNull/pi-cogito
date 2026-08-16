import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { ProactiveStore } from "../src/store.ts";

let tempDir = "";

afterEach(() => {
	if (tempDir) rmSync(tempDir, { recursive: true, force: true });
	tempDir = "";
});

describe("ProactiveStore delivery media, attachments and route", () => {
	it("reuses a delivery row for the same idempotency key", () => {
		tempDir = mkdtempSync(join(tmpdir(), "proactive-delivery-idempotency-"));
		const store = new ProactiveStore(join(tempDir, "proactive.sqlite"));
		const record = {
			session_key: "drift",
			message: "同一条消息",
			message_hash: "same-hash",
			source_refs: "[]",
			evidence: "[]",
			action: "send",
			state_summary_tag: "drift",
			delivered_at: 1,
			idempotency_key: "drift:same-hash",
		};
		const first = store.insertDelivery(record);
		const second = store.insertDelivery({ ...record, delivered_at: 2 });

		expect(second).toBe(first);
		expect(store.listDeliveries()).toHaveLength(1);
		store.close();
	});

	it("migrates an old deliveries table and round-trips media and route", () => {
		tempDir = mkdtempSync(join(tmpdir(), "proactive-delivery-media-"));
		const dbPath = join(tempDir, "proactive.sqlite");
		const legacyDb = new DatabaseSync(dbPath);
		legacyDb.exec(`
			CREATE TABLE deliveries (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				session_key TEXT NOT NULL DEFAULT 'local',
				message TEXT NOT NULL,
				message_hash TEXT NOT NULL,
				source_refs TEXT NOT NULL DEFAULT '[]',
				evidence TEXT NOT NULL DEFAULT '[]',
				action TEXT NOT NULL DEFAULT 'send',
				state_summary_tag TEXT NOT NULL DEFAULT 'none',
				delivered_at INTEGER NOT NULL,
				acked INTEGER NOT NULL DEFAULT 0
			);
		`);
		legacyDb
			.prepare(
				`INSERT INTO deliveries (session_key, message, message_hash, source_refs, evidence, action, state_summary_tag, delivered_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run("legacy", "旧消息", "legacy-hash", "[]", "[]", "send", "none", 1);
		legacyDb.close();

		const store = new ProactiveStore(dbPath);
		expect(store.getDelivery(1)).toMatchObject({
			media: [],
			attachments: [],
			target_channel: "",
			target_chat_id: "",
		});

		const id = store.insertDelivery({
			session_key: "drift",
			message: "图片消息",
			message_hash: "media-hash",
			media: [" /tmp/one.png ", "", "https://example.test/two.png"],
			attachments: [
				{ kind: "file", source: " /tmp/report.pdf ", filename: " report.pdf ", mimeType: " application/pdf " },
			],
			target_channel: " feishu ",
			target_chat_id: " oc_target ",
			source_refs: "[]",
			evidence: "[]",
			action: "send",
			state_summary_tag: "drift",
			delivered_at: 2,
		});
		expect(store.getDelivery(id)).toMatchObject({
			media: ["/tmp/one.png", "https://example.test/two.png"],
			attachments: [
				{ kind: "file", source: "/tmp/report.pdf", filename: "report.pdf", mimeType: "application/pdf" },
			],
			target_channel: "feishu",
			target_chat_id: "oc_target",
		});
		store.close();
	});
});
