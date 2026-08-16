import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeSqliteFactory } from "@earendil-works/pi-storage-sqlite-node";
import { getLoadablePath } from "sqlite-vec";
import { afterEach, describe, expect, it } from "vitest";
import { JsonlSessionIndexer, type TextEmbedder } from "../src/core/session-index/jsonl-indexer.ts";
import { SessionManager } from "../src/core/session-manager.ts";

function sessionJsonl(sessionId: string, cwd: string, messages: { id: string; text: string }[]): string {
	const lines = [
		JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: "2024-01-01T00:00:00.000Z", cwd }),
	];
	for (const message of messages) {
		lines.push(
			JSON.stringify({
				type: "message",
				id: message.id,
				parentId: null,
				timestamp: "2024-01-01T00:00:00.000Z",
				message: { role: "user", content: message.text },
			}),
		);
	}
	return `${lines.join("\n")}\n`;
}

/** Deterministic fake embedder: vector encodes text length. */
function lengthEmbedder(dimensions = 3): TextEmbedder {
	return {
		embed: async (texts) => texts.map((text) => [text.length, ...Array(dimensions - 1).fill(0)]),
	};
}

const tempDirs: string[] = [];

function createFixture() {
	const root = mkdtempSync(join(tmpdir(), "pi-session-index-"));
	tempDirs.push(root);
	const sessionsDir = join(root, "sessions");
	mkdirSync(sessionsDir, { recursive: true });
	const fs = {
		absolutePath: async (path: string) => path,
		createDir: async (path: string) => {
			mkdirSync(path, { recursive: true });
		},
		listDir: async (path: string) => readdirSync(path),
		readTextFile: async (path: string) => readFileSync(path, "utf-8"),
		stat: async (path: string) => {
			const stat = statSync(path);
			return { mtimeMs: stat.mtimeMs, size: stat.size };
		},
	};
	return { root, sessionsDir, fs };
}

function writeSession(dir: string, name: string, content: string): void {
	writeFileSync(join(dir, name), content, "utf-8");
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("JsonlSessionIndexer keyword search", () => {
	it("indexes jsonl sessions and finds entries by keyword", async () => {
		const { root, sessionsDir, fs } = createFixture();
		writeSession(
			sessionsDir,
			"a.jsonl",
			sessionJsonl("s1", root, [
				{ id: "m1", text: "the auth defect lives in the login handler" },
				{ id: "m2", text: "unrelated note about css" },
			]),
		);
		const indexer = new JsonlSessionIndexer({
			sqlite: createNodeSqliteFactory(),
			databasePath: join(root, "index.sqlite"),
			sessionsDir,
			fs,
		});
		await using _ = indexer;

		const hits = await indexer.search({ text: "auth defect", limit: 10 });
		expect(hits.length).toBe(1);
		expect(hits[0]).toMatchObject({ sessionId: "s1", entryId: "m1", type: "message" });
		expect(hits[0]!.text).toContain("auth defect");
	});

	it("filters by cwd and is incremental", async () => {
		const { root, sessionsDir, fs } = createFixture();
		writeSession(
			sessionsDir,
			"a.jsonl",
			sessionJsonl("s1", `${root}/proj-a`, [{ id: "m1", text: "needle in proj-a" }]),
		);
		writeSession(
			sessionsDir,
			"b.jsonl",
			sessionJsonl("s2", `${root}/proj-b`, [{ id: "m1", text: "needle in proj-b" }]),
		);
		const indexer = new JsonlSessionIndexer({
			sqlite: createNodeSqliteFactory(),
			databasePath: join(root, "index.sqlite"),
			sessionsDir,
			fs,
		});
		await using _ = indexer;

		expect((await indexer.search({ text: "needle", cwd: `${root}/proj-a` })).map((h) => h.sessionId)).toEqual(["s1"]);
		expect((await indexer.search({ text: "needle" })).length).toBe(2);

		// Append to file b: mtime+size change, so it is re-indexed.
		writeSession(
			sessionsDir,
			"b.jsonl",
			sessionJsonl("s2", `${root}/proj-b`, [
				{ id: "m1", text: "needle in proj-b" },
				{ id: "m2", text: "brand new content" },
			]),
		);
		expect((await indexer.search({ text: "brand new" })).length).toBe(1);
	});

	it("indexes jsonl files nested under per-cwd subdirectories", async () => {
		const { root, sessionsDir, fs } = createFixture();
		const sub = join(sessionsDir, "--proj--");
		mkdirSync(sub, { recursive: true });
		writeSession(sub, "a.jsonl", sessionJsonl("s1", root, [{ id: "m1", text: "nested session content" }]));
		const indexer = new JsonlSessionIndexer({
			sqlite: createNodeSqliteFactory(),
			databasePath: join(root, "index.sqlite"),
			sessionsDir,
			fs,
		});
		await using _ = indexer;

		const hits = await indexer.search({ text: "nested session", limit: 10 });
		expect(hits.length).toBe(1);
		expect(hits[0]).toMatchObject({ sessionId: "s1", entryId: "m1" });
	});

	it("removes entries for deleted session files", async () => {
		const { root, sessionsDir, fs } = createFixture();
		writeSession(sessionsDir, "a.jsonl", sessionJsonl("s1", root, [{ id: "m1", text: "will be deleted" }]));
		const indexer = new JsonlSessionIndexer({
			sqlite: createNodeSqliteFactory(),
			databasePath: join(root, "index.sqlite"),
			sessionsDir,
			fs,
		});
		await using _ = indexer;
		expect((await indexer.search({ text: "will be deleted" })).length).toBe(1);

		rmSync(join(sessionsDir, "a.jsonl"));
		expect((await indexer.search({ text: "will be deleted" })).length).toBe(0);
	});
});

describe("JsonlSessionIndexer vector search", () => {
	it("indexes embeddings and finds nearest neighbors", async () => {
		const { root, sessionsDir, fs } = createFixture();
		writeSession(
			sessionsDir,
			"a.jsonl",
			sessionJsonl("s1", root, [
				{ id: "m1", text: "short" },
				{ id: "m2", text: "a much longer message body" },
			]),
		);
		const indexer = new JsonlSessionIndexer({
			sqlite: createNodeSqliteFactory(),
			databasePath: join(root, "index.sqlite"),
			sessionsDir,
			fs,
			vector: { embedder: lengthEmbedder(), dimensions: 3, extensionPath: getLoadablePath() },
		});
		await using _ = indexer;

		const hits = await indexer.search({ vector: [5, 0, 0], limit: 1 });
		expect(hits.length).toBe(1);
		expect(hits[0]!.entryId).toBe("m1");
		expect(hits[0]!.text).toBe("short");
	});

	it("rebuilds the vec table when dimensions change", async () => {
		const { root, sessionsDir, fs } = createFixture();
		writeSession(sessionsDir, "a.jsonl", sessionJsonl("s1", root, [{ id: "m1", text: "hello" }]));
		const indexer = new JsonlSessionIndexer({
			sqlite: createNodeSqliteFactory(),
			databasePath: join(root, "index.sqlite"),
			sessionsDir,
			fs,
			vector: { embedder: lengthEmbedder(), dimensions: 3, extensionPath: getLoadablePath() },
		});
		await using _ = indexer;
		await indexer.search({ vector: [5, 0, 0] });

		// Same db path, new dimensions: vec table is dropped and recreated.
		const indexer2 = new JsonlSessionIndexer({
			sqlite: createNodeSqliteFactory(),
			databasePath: join(root, "index.sqlite"),
			sessionsDir,
			fs,
			vector: { embedder: lengthEmbedder(4), dimensions: 4, extensionPath: getLoadablePath() },
		});
		await using __ = indexer2;
		// mtime unchanged, so entries are not re-indexed; the vec table exists with 4 dims.
		const hits = await indexer2.search({ vector: [5, 0, 0, 0], limit: 1 });
		expect(hits.length).toBe(1);
		expect(hits[0]!.entryId).toBe("m1");
	});
});

describe("dual-write: appendEntry + SessionManager hook", () => {
	it("mirrors appended entries into the index in real time", async () => {
		const { root, sessionsDir, fs } = createFixture();
		const indexer = new JsonlSessionIndexer({
			sqlite: createNodeSqliteFactory(),
			databasePath: join(root, "index.sqlite"),
			sessionsDir,
			fs,
			vector: { embedder: lengthEmbedder(), dimensions: 3, extensionPath: getLoadablePath() },
		});
		await using _ = indexer;

		indexer.appendEntry("s1", root, {
			type: "message",
			id: "m1",
			parentId: null,
			timestamp: "2024-01-01T00:00:00.000Z",
			message: { role: "user", content: "live appended message", timestamp: Date.now() },
		});
		indexer.appendEntry("s1", root, {
			type: "model_change",
			id: "m2",
			parentId: "m1",
			timestamp: "2024-01-01T00:00:00.000Z",
			provider: "p",
			modelId: "m",
		});
		// Wait for the fire-and-forget queue to drain.
		await indexer.ensureIndexed();

		const hits = await indexer.search({ text: "live appended", limit: 10 });
		expect(hits.length).toBe(1);
		expect(hits[0]).toMatchObject({ sessionId: "s1", entryId: "m1" });
	});

	it("reconciles from jsonl when the session file changes (jsonl authoritative)", async () => {
		const { root, sessionsDir, fs } = createFixture();
		const indexer = new JsonlSessionIndexer({
			sqlite: createNodeSqliteFactory(),
			databasePath: join(root, "index.sqlite"),
			sessionsDir,
			fs,
			vector: { embedder: lengthEmbedder(), dimensions: 3, extensionPath: getLoadablePath() },
		});
		await using _ = indexer;

		// Dual-written entry not present in any jsonl file yet.
		indexer.appendEntry("s1", root, {
			type: "message",
			id: "m1",
			parentId: null,
			timestamp: "2024-01-01T00:00:00.000Z",
			message: { role: "user", content: "stale index content", timestamp: Date.now() },
		});
		await indexer.ensureIndexed();
		expect((await indexer.search({ text: "stale index" })).length).toBe(1);

		// The jsonl file appears with different content: ensureIndexed rebuilds from it.
		writeSession(sessionsDir, "a.jsonl", sessionJsonl("s1", root, [{ id: "m1", text: "authoritative content" }]));
		await indexer.ensureIndexed();
		expect((await indexer.search({ text: "authoritative" })).length).toBe(1);
		expect((await indexer.search({ text: "stale index" })).length).toBe(0);
	});

	it("SessionManager invokes onEntryAppended for every appended entry", () => {
		const { root, sessionsDir } = createFixture();
		const manager = SessionManager.open(join(sessionsDir, "test.jsonl"), sessionsDir, root);
		manager.newSession();
		const seen: string[] = [];
		manager.onEntryAppended = (entry) => seen.push(entry.type);
		manager.appendModelChange("provider", "model");
		manager.appendCustomEntry("custom-type", { x: 1 });
		expect(seen).toEqual(["model_change", "custom"]);
	});
});
