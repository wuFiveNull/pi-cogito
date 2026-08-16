import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProactiveRules } from "../src/rules.ts";
import { ProactiveStore } from "../src/store.ts";
import type { ProactiveSource } from "../src/types.ts";
import { buildWakeRuntimeDeps } from "../src/wake/index.ts";

const tempDirs: string[] = [];
const fixedClock = {
	now: () => new Date("2026-08-13T00:00:00.000Z"),
	nowMs: () => Date.parse("2026-08-13T00:00:00.000Z"),
};

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("proactive completion regressions", () => {
	it("migrates an old deliveries table before querying pending outbox rows", () => {
		const dir = mkdtempSync(join(tmpdir(), "proactive-migration-"));
		tempDirs.push(dir);
		const dbPath = join(dir, "proactive.sqlite");
		const legacy = new DatabaseSync(dbPath);
		legacy.exec(`
CREATE TABLE deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_key TEXT NOT NULL DEFAULT 'local',
  message TEXT NOT NULL,
  message_hash TEXT NOT NULL,
  source_refs TEXT NOT NULL DEFAULT '[]',
  evidence TEXT NOT NULL DEFAULT '[]',
  action TEXT NOT NULL DEFAULT 'send',
  state_summary_tag TEXT NOT NULL DEFAULT 'none',
  delivered_at INTEGER NOT NULL
);
INSERT INTO deliveries (message, message_hash, delivered_at) VALUES ('legacy', 'legacy-hash', 1);
`);
		legacy.close();

		const store = new ProactiveStore(dbPath, fixedClock);
		expect(store.listPendingDeliveries()).toHaveLength(1);
		expect(store.getDelivery(1)?.acked).toBe(0);
		store.ackDeliveries([1]);
		expect(store.listPendingDeliveries()).toHaveLength(0);
		store.close();
	});

	it("migrates a source ACK queue created before retry scheduling", () => {
		const dir = mkdtempSync(join(tmpdir(), "proactive-ack-migration-"));
		tempDirs.push(dir);
		const dbPath = join(dir, "proactive.sqlite");
		const legacy = new DatabaseSync(dbPath);
		legacy.exec(`
CREATE TABLE source_ack_queue (
  source_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  queued_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  last_attempt_at INTEGER,
  PRIMARY KEY (source_id, event_id)
);
INSERT INTO source_ack_queue(source_id, event_id, queued_at) VALUES ('feed', 'event-1', 1);
`);
		legacy.close();

		const store = new ProactiveStore(dbPath, fixedClock);
		expect(store.listPendingSourceAcknowledgements()).toMatchObject([
			{ source_id: "feed", event_id: "event-1", next_attempt_at: null },
		]);
		store.close();
	});

	it("routes an ackSourceId alias to the configured source module", async () => {
		const dir = mkdtempSync(join(tmpdir(), "proactive-ack-route-"));
		tempDirs.push(dir);
		const store = new ProactiveStore(join(dir, "proactive.sqlite"), fixedClock);
		const ack = vi.fn(async (_config: unknown, _eventIds: string[]) => {});
		const source: ProactiveSource = {
			id: "mcp",
			label: "MCP",
			fetch: async () => [],
			ack,
		};
		const deps = buildWakeRuntimeDeps({
			sources: new Map([[source.id, source]]),
			sourceConfigs: { mcp: { ack: { sourceIds: ["feed"] }, token: "test" } },
			dbPath: join(dir, "proactive.sqlite"),
			sessionsDir: dir,
			rules: new ProactiveRules(join(dir, "PROACTIVE_CONTEXT.md")),
			store,
			llm: { model: "test", apiBaseUrl: "http://localhost", apiKey: "test" },
			clock: fixedClock,
		});

		await deps.acknowledge?.("feed", ["event-1"]);
		expect(ack).toHaveBeenCalledWith({ ack: { sourceIds: ["feed"] }, token: "test" }, ["event-1"]);
		deps.stateStore.close();
		store.close();
	});
});
