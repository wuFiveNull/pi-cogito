import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeSqliteFactory } from "@cogito/storage-sqlite-node";
import { afterEach, describe, expect, it } from "vitest";
import { ExtensionSqlite } from "../src/core/extensions/sqlite.ts";
import { JsonlSessionIndexer } from "../src/core/session-index/jsonl-indexer.ts";

const tempDirs: string[] = [];

function createAgentDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-ext-sqlite-"));
	tempDirs.push(dir);
	mkdirSync(join(dir, "sessions"), { recursive: true });
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

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

describe("ExtensionSqlite", () => {
	it("exec/run/query/get work and every write is audit-logged", () => {
		const agentDir = createAgentDir();
		const sqlite = ExtensionSqlite.create(agentDir, () => "ext-a");
		try {
			sqlite.db.exec("CREATE TABLE IF NOT EXISTS hits (entry_id TEXT PRIMARY KEY, value REAL)");
			sqlite.db.run("INSERT INTO hits (entry_id, value) VALUES (?, ?)", "m1", 1);
			sqlite.db.run("UPDATE hits SET value = value + 1 WHERE entry_id = ?", "m1");
			expect(sqlite.db.get("SELECT value FROM hits WHERE entry_id = ?", "m1")).toEqual({ value: 2 });

			const log = sqlite.db.query("SELECT op, sql, extension_id FROM _oplog ORDER BY seq");
			expect(log.length).toBe(3);
			expect(log[0]).toMatchObject({ op: "exec", extension_id: "ext-a" });
			expect(log[1]).toMatchObject({ op: "run", sql: "INSERT INTO hits (entry_id, value) VALUES (?, ?)" });
			expect(log[2]).toMatchObject({ op: "run" });
		} finally {
			sqlite.close();
		}
	});

	it("refuses to modify the audit log", () => {
		const agentDir = createAgentDir();
		const sqlite = ExtensionSqlite.create(agentDir);
		try {
			sqlite.db.exec("CREATE TABLE t (x TEXT)");
			expect(() => sqlite.db.run("UPDATE _oplog SET extension_id = 'x'")).toThrow(/audit table/);
			expect(() => sqlite.db.exec("DROP TABLE _oplog")).toThrow(/audit table/);
		} finally {
			sqlite.close();
		}
	});

	it("logs and rolls back failed writes (log stays consistent)", () => {
		const agentDir = createAgentDir();
		const sqlite = ExtensionSqlite.create(agentDir);
		try {
			sqlite.db.exec("CREATE TABLE t (x TEXT)");
			expect(() => sqlite.db.run("INSERT INTO t (x) VALUES (1, 2)")).toThrow();
			// Failed write is recorded with an error; the failed row is absent.
			const log = sqlite.db.query(
				"SELECT error FROM _oplog WHERE sql LIKE 'INSERT INTO t%' ORDER BY seq DESC LIMIT 1",
			);
			expect(log.length).toBe(1);
			expect(log[0]!.error).toBeTruthy();
			expect(sqlite.db.query("SELECT * FROM t").length).toBe(0);
		} finally {
			sqlite.close();
		}
	});

	it("transaction groups statements under one tx_id and rolls back atomically", () => {
		const agentDir = createAgentDir();
		const sqlite = ExtensionSqlite.create(agentDir);
		try {
			sqlite.db.exec("CREATE TABLE t (x TEXT)");
			sqlite.db.transaction(() => {
				sqlite.db.run("INSERT INTO t (x) VALUES ('a')");
				sqlite.db.run("INSERT INTO t (x) VALUES ('b')");
			});
			expect(sqlite.db.query("SELECT * FROM t").length).toBe(2);
			const txIds = sqlite.db.query("SELECT DISTINCT tx_id FROM _oplog WHERE op = 'run'");
			expect(txIds.length).toBe(1);

			expect(() =>
				sqlite.db.transaction(() => {
					sqlite.db.run("INSERT INTO t (x) VALUES ('c')");
					throw new Error("boom");
				}),
			).toThrow("boom");
			expect(sqlite.db.query("SELECT * FROM t").length).toBe(2);
		} finally {
			sqlite.close();
		}
	});

	it("two extensions writing the same row with atomic SQL never lose updates", () => {
		const agentDir = createAgentDir();
		const sqlite = ExtensionSqlite.create(agentDir);
		try {
			sqlite.db.exec("CREATE TABLE IF NOT EXISTS hits (entry_id TEXT PRIMARY KEY, value REAL)");
			// Interleaved increments from two "extensions": each single-statement
			// upsert is atomic, so no increment is lost regardless of order.
			const extA = () =>
				sqlite.db.run(
					"INSERT INTO hits (entry_id, value) VALUES (?, 1) ON CONFLICT(entry_id) DO UPDATE SET value = value + 1",
					"m1",
				);
			const extB = () =>
				sqlite.db.run(
					"INSERT INTO hits (entry_id, value) VALUES (?, 1) ON CONFLICT(entry_id) DO UPDATE SET value = value + 1",
					"m1",
				);
			for (let i = 0; i < 50; i++) {
				extA();
				extB();
			}
			expect(sqlite.db.get("SELECT value FROM hits WHERE entry_id = 'm1'")).toEqual({ value: 100 });
		} finally {
			sqlite.close();
		}
	});

	it("indexDb is read-only and reflects indexed entries", async () => {
		const agentDir = createAgentDir();
		writeFileSync(
			join(agentDir, "sessions", "a.jsonl"),
			sessionJsonl("s1", agentDir, [{ id: "m1", text: "indexable content for extensions" }]),
			"utf-8",
		);
		const indexer = new JsonlSessionIndexer({
			sqlite: createNodeSqliteFactory(),
			databasePath: join(agentDir, "sessions-index", "sessions.sqlite"),
			sessionsDir: join(agentDir, "sessions"),
			fs: {
				absolutePath: async (path) => path,
				createDir: async (path) => {
					mkdirSync(path, { recursive: true });
				},
				listDir: async (path) => readdirSync(path),
				readTextFile: async (path) => readFileSync(path, "utf-8"),
				stat: async (path) => {
					const stat = statSync(path);
					return { mtimeMs: stat.mtimeMs, size: stat.size };
				},
			},
		});
		await using _ = indexer;
		await indexer.ensureIndexed();

		const sqlite = ExtensionSqlite.create(agentDir);
		try {
			const rows = sqlite.indexDbView.query("SELECT entry_id, type FROM entries");
			expect(rows.length).toBe(1);
			expect(rows[0]).toMatchObject({ entry_id: "m1", type: "message" });
			// The index view has no write surface.
			expect((sqlite.indexDbView as unknown as Record<string, unknown>).run).toBeUndefined();
		} finally {
			sqlite.close();
		}
	});

	it("ensureIndexed cleans up stale entries when the sessions dir is removed", async () => {
		const agentDir = createAgentDir();
		writeFileSync(
			join(agentDir, "sessions", "a.jsonl"),
			sessionJsonl("s1", agentDir, [{ id: "m1", text: "to be removed with the dir" }]),
			"utf-8",
		);
		const indexer = new JsonlSessionIndexer({
			sqlite: createNodeSqliteFactory(),
			databasePath: join(agentDir, "sessions-index", "sessions.sqlite"),
			sessionsDir: join(agentDir, "sessions"),
			fs: {
				absolutePath: async (path) => path,
				createDir: async (path) => {
					mkdirSync(path, { recursive: true });
				},
				listDir: async (path) => readdirSync(path),
				readTextFile: async (path) => readFileSync(path, "utf-8"),
				stat: async (path) => {
					const stat = statSync(path);
					return { mtimeMs: stat.mtimeMs, size: stat.size };
				},
			},
		});
		await using _ = indexer;
		await indexer.ensureIndexed();
		expect((await indexer.search({ text: "to be removed" })).length).toBe(1);

		// Remove the entire sessions directory: ensureIndexed must not throw and
		// must clean up the stale index rows.
		rmSync(join(agentDir, "sessions"), { recursive: true, force: true });
		await indexer.ensureIndexed();
		expect((await indexer.search({ text: "to be removed" })).length).toBe(0);
	});
});
