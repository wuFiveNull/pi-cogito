import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Presence } from "../src/stages/sense.ts";
import { ProactiveStore } from "../src/store.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempSessionsDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "presence-scan-"));
	tempDirs.push(dir);
	return dir;
}

function makeStore(): ProactiveStore {
	const dir = mkdtempSync(join(tmpdir(), "presence-store-"));
	tempDirs.push(dir);
	return new ProactiveStore(join(dir, "proactive.sqlite"));
}

function writeSession(sessionsDir: string, name: string, rows: Array<Record<string, unknown>>): void {
	writeFileSync(join(sessionsDir, name), rows.map((row) => JSON.stringify(row)).join("\n"), "utf-8");
}

describe("Presence jsonl scan", () => {
	it("picks up user-message timestamps stored as epoch-ms numbers", () => {
		const sessionsDir = tempSessionsDir();
		const store = makeStore();
		writeSession(sessionsDir, "a.jsonl", [
			{ type: "session", version: 3, timestamp: "2026-01-01T00:00:00Z" },
			{
				type: "message",
				timestamp: "2026-01-01T00:00:01Z",
				message: { role: "user", content: "hi", timestamp: 1_760_000_000_000 },
			},
			{
				type: "message",
				timestamp: "2026-01-01T00:00:02Z",
				message: { role: "assistant", content: "yo", timestamp: 1_760_000_001_000 },
			},
		]);
		const presence = new Presence(store, { sessionsDir, sessionKey: "local" });
		const lastUserAt = presence.refresh();
		expect(lastUserAt).toBe(1_760_000_000_000);
		store.close();
	});

	it("also accepts ISO-string timestamps", () => {
		const sessionsDir = tempSessionsDir();
		const store = makeStore();
		writeSession(sessionsDir, "a.jsonl", [
			{
				type: "message",
				timestamp: "2026-01-01T00:00:01Z",
				message: { role: "user", content: "hi", timestamp: "2026-01-01T00:00:01Z" },
			},
		]);
		const presence = new Presence(store, { sessionsDir, sessionKey: "local" });
		expect(presence.refresh()).toBe(Date.parse("2026-01-01T00:00:01Z"));
		store.close();
	});

	it("returns null without user messages", () => {
		const sessionsDir = tempSessionsDir();
		const store = makeStore();
		writeSession(sessionsDir, "a.jsonl", [
			{
				type: "message",
				timestamp: "2026-01-01T00:00:01Z",
				message: { role: "assistant", content: "yo", timestamp: 1_760_000_001_000 },
			},
		]);
		const presence = new Presence(store, { sessionsDir, sessionKey: "local" });
		expect(presence.refresh()).toBeNull();
		store.close();
	});
});
