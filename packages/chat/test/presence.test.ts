import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteDatabase } from "@cogito/agent-core/sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { ChatPresenceWriter } from "../src/presence.ts";

const tempDirs: string[] = [];

function tempDb(): string {
	const dir = mkdtempSync(join(tmpdir(), "chat-presence-"));
	tempDirs.push(dir);
	return join(dir, "proactive.sqlite");
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("ChatPresenceWriter", () => {
	it("records a user message into the presence table", () => {
		const path = tempDb();
		const writer = new ChatPresenceWriter(path);
		writer.recordUserMessage(1_700_000_000_000, "local");
		writer.close();

		const db = createSqliteDatabase(path);
		const row = db.prepare("SELECT session_key, last_user_at FROM presence").get() as
			| { session_key: string; last_user_at: number }
			| undefined;
		expect(row).toEqual({ session_key: "local", last_user_at: 1_700_000_000_000 });
		db.close();
	});

	it("keeps the newest timestamp on repeated writes", () => {
		const path = tempDb();
		const writer = new ChatPresenceWriter(path);
		writer.recordUserMessage(1_700_000_000_000, "local");
		writer.recordUserMessage(1_700_000_060_000, "local");
		writer.recordUserMessage(1_700_000_030_000, "local");
		writer.close();

		const db = createSqliteDatabase(path);
		const row = db.prepare("SELECT last_user_at FROM presence").get() as { last_user_at: number };
		expect(row.last_user_at).toBe(1_700_000_060_000);
		db.close();
	});

	it("never throws when the database is unavailable", () => {
		const writer = new ChatPresenceWriter("/nonexistent-dir/nope/proactive.sqlite");
		expect(() => writer.recordUserMessage(1_700_000_000_000, "local")).not.toThrow();
		writer.close();
	});
});
