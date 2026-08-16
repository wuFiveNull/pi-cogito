import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatPreferenceBlock, recallPreferences } from "../src/memory.ts";
import { hashMessage, hashOutboundMessage } from "../src/outbound.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("recallPreferences(共享记忆召回)", () => {
	it("recalls active preferences and excludes superseded ones", () => {
		const dir = mkdtempSync(join(tmpdir(), "gate-memory-"));
		tempDirs.push(dir);
		const memoryDb = join(dir, "memory.sqlite");
		const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
		const db = new DatabaseSync(memoryDb);
		db.exec(`
CREATE TABLE memory_items (
  id TEXT PRIMARY KEY, memory_type TEXT NOT NULL, summary TEXT NOT NULL,
  content_hash TEXT NOT NULL, reinforcement INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active', updated_at TEXT NOT NULL
);`);
		db.prepare(
			"INSERT INTO memory_items (id, memory_type, summary, content_hash, status, updated_at) VALUES ('m1', 'preference', '用户不喜欢明星八卦', 'c1', 'active', '2026-01-01')",
		).run();
		db.prepare(
			"INSERT INTO memory_items (id, memory_type, summary, content_hash, status, updated_at) VALUES ('m2', 'preference', '用户关注 AI 与开源', 'c2', 'active', '2026-01-01')",
		).run();
		db.prepare(
			"INSERT INTO memory_items (id, memory_type, summary, content_hash, status, updated_at) VALUES ('m3', 'procedure', '查余额先调工具', 'c3', 'superseded', '2026-01-01')",
		).run();
		db.close();

		const all = recallPreferences(memoryDb);
		expect(all.length).toBe(2); // superseded excluded

		const matched = recallPreferences(memoryDb, "AI 开源");
		expect(matched.map((m) => m.id)).toEqual(["m2"]);

		expect(formatPreferenceBlock(matched)).toContain("用户关注 AI 与开源");
		expect(formatPreferenceBlock([])).toBe("");
	});

	it("degrades gracefully on a missing database", () => {
		expect(recallPreferences(join(tmpdir(), "no-such-memory.sqlite"))).toEqual([]);
	});
});

describe("hashOutboundMessage(共享投递哈希)", () => {
	it("hashes plain text without media or targets", () => {
		expect(hashOutboundMessage("hello", [], [], "", "")).toBe(hashMessage("hello"));
	});

	it("includes media, attachments and target in the hash", () => {
		const plain = hashOutboundMessage("hello", [], [], "", "");
		const withMedia = hashOutboundMessage("hello", ["data:image/png;base64,x"], [], "", "");
		expect(withMedia).not.toBe(plain);
		expect(withMedia).toHaveLength(64);
	});
});
