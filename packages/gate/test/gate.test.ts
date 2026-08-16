import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DriftGateStore } from "../src/gate.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeStore(): DriftGateStore {
	const dir = mkdtempSync(join(tmpdir(), "drift-gate-"));
	tempDirs.push(dir);
	return new DriftGateStore({ driftDir: dir });
}

describe("DriftGateStore drift_gate(三进程门控)", () => {
	it("upserts and reads an allowed gate within TTL", () => {
		const store = makeStore();
		const grantedAt = new Date("2026-05-01T00:00:00Z");
		store.writeDriftGate({
			sessionKey: "local",
			verdict: "allowed",
			reason: "wake_idle",
			grantedAt,
			ttlHours: 1,
		});
		const gate = store.readDriftGate("local", new Date("2026-05-01T00:30:00Z"));
		expect(gate).toMatchObject({ verdict: "allowed", reason: "wake_idle", ttlHours: 1 });
		expect(gate?.grantedAt.toISOString()).toBe("2026-05-01T00:00:00.000Z");
	});

	it("returns null after TTL expiry", () => {
		const store = makeStore();
		store.writeDriftGate({
			sessionKey: "local",
			verdict: "allowed",
			reason: "wake_idle",
			grantedAt: new Date("2026-05-01T00:00:00Z"),
			ttlHours: 1,
		});
		expect(store.readDriftGate("local", new Date("2026-05-01T01:00:00Z"))).toBeNull();
		expect(store.readDriftGate("local", new Date("2026-05-01T02:00:00Z"))).toBeNull();
	});

	it("returns null when missing", () => {
		const store = makeStore();
		expect(store.readDriftGate("local", new Date())).toBeNull();
	});

	it("upsert overwrites the previous verdict", () => {
		const store = makeStore();
		const grantedAt = new Date("2026-05-01T00:00:00Z");
		store.writeDriftGate({
			sessionKey: "local",
			verdict: "allowed",
			reason: "wake_idle",
			grantedAt,
			ttlHours: 1,
		});
		store.writeDriftGate({
			sessionKey: "local",
			verdict: "suppressed",
			reason: "min_interval",
			grantedAt: new Date("2026-05-01T00:10:00Z"),
			ttlHours: 2,
		});
		expect(store.readDriftGate("local", new Date("2026-05-01T00:20:00Z"))).toMatchObject({
			verdict: "suppressed",
			reason: "min_interval",
			ttlHours: 2,
		});
	});

	it("keeps per-session keys independent", () => {
		const store = makeStore();
		store.writeDriftGate({
			sessionKey: "a",
			verdict: "allowed",
			reason: "wake_idle",
			grantedAt: new Date("2026-05-01T00:00:00Z"),
			ttlHours: 1,
		});
		expect(store.readDriftGate("b", new Date("2026-05-01T00:30:00Z"))).toBeNull();
		expect(store.readDriftGate("a", new Date("2026-05-01T00:30:00Z"))).not.toBeNull();
	});

	it("round-trips the prefetched context with the gate", () => {
		const store = makeStore();
		store.writeDriftGate({
			sessionKey: "local",
			verdict: "allowed",
			reason: "wake_idle",
			context: '{"kind":"wake","text":"hello"}',
			grantedAt: new Date("2026-05-01T00:00:00Z"),
			ttlHours: 1,
		});
		expect(store.readDriftGate("local", new Date("2026-05-01T00:30:00Z"))?.context).toBe(
			'{"kind":"wake","text":"hello"}',
		);
		// 无 context 写入时读回空串。
		store.writeDriftGate({
			sessionKey: "local",
			verdict: "suppressed",
			reason: "min_interval",
			grantedAt: new Date("2026-05-01T00:40:00Z"),
			ttlHours: 1,
		});
		expect(store.readDriftGate("local", new Date("2026-05-01T00:50:00Z"))).toMatchObject({
			verdict: "suppressed",
			context: "",
		});
	});

	it("migrates an existing drift_gate table without the context column", () => {
		const dir = mkdtempSync(join(tmpdir(), "drift-gate-migrate-"));
		tempDirs.push(dir);
		// 先建旧结构库:仅 verdict/reason/granted_at/ttl_hours。
		const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
		const legacy = new DatabaseSync(join(dir, "drift.db"));
		legacy.exec(
			`CREATE TABLE drift_gate (
				session_key TEXT PRIMARY KEY,
				verdict TEXT NOT NULL,
				reason TEXT NOT NULL DEFAULT '',
				granted_at TEXT NOT NULL,
				ttl_hours REAL NOT NULL
			)`,
		);
		legacy.close();
		const store = new DriftGateStore({ driftDir: dir });
		store.writeDriftGate({
			sessionKey: "local",
			verdict: "allowed",
			reason: "wake_idle",
			context: "c1",
			grantedAt: new Date("2026-05-01T00:00:00Z"),
			ttlHours: 1,
		});
		expect(store.readDriftGate("local", new Date("2026-05-01T00:30:00Z"))).toMatchObject({
			verdict: "allowed",
			context: "c1",
		});
	});
});
