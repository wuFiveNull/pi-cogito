import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { ProactiveStore } from "../src/store.ts";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

async function runWorker(mode: "delivery" | "drift", target: string, value: string): Promise<Record<string, unknown>> {
	const worker = join(import.meta.dirname, "fixtures", "sqlite-concurrency-worker.mjs");
	const result = await execFileAsync(
		process.execPath,
		["--experimental-strip-types", "--no-warnings", worker, mode, target, value],
		{
			cwd: join(import.meta.dirname, "..", "..", ".."),
			maxBuffer: 1_000_000,
		},
	);
	return JSON.parse(result.stdout.trim()) as Record<string, unknown>;
}

describe("SQLite migration matrix", () => {
	it("migrates duplicate legacy delivery keys without violating the new unique index", () => {
		const root = makeTempDir("proactive-migration-matrix-");
		const dbPath = join(root, "proactive.sqlite");
		const legacy = new DatabaseSync(dbPath);
		legacy.exec(`
			CREATE TABLE items (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				scope TEXT NOT NULL DEFAULT '', recommendation TEXT, source TEXT NOT NULL,
				sub_source TEXT NOT NULL, title TEXT NOT NULL, url TEXT, summary TEXT,
				title_hash TEXT NOT NULL UNIQUE, interest_score REAL, status TEXT NOT NULL DEFAULT 'new',
				fetched_at INTEGER NOT NULL, pushed_at INTEGER
			);
			CREATE TABLE deliveries (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				session_key TEXT NOT NULL DEFAULT 'local', message TEXT NOT NULL,
				message_hash TEXT NOT NULL, source_refs TEXT NOT NULL DEFAULT '[]', evidence TEXT NOT NULL DEFAULT '[]',
				action TEXT NOT NULL DEFAULT 'send', state_summary_tag TEXT NOT NULL DEFAULT 'none',
				delivered_at INTEGER NOT NULL, acked INTEGER NOT NULL DEFAULT 0,
				idempotency_key TEXT NOT NULL DEFAULT ''
			);
			CREATE TABLE tick_log (
				id INTEGER PRIMARY KEY AUTOINCREMENT, session_key TEXT NOT NULL DEFAULT 'local', started_at INTEGER NOT NULL,
				finished_at INTEGER, base_score REAL, candidates INTEGER NOT NULL DEFAULT 0, steps INTEGER NOT NULL DEFAULT 0,
				action TEXT NOT NULL DEFAULT 'none', skip_reason TEXT NOT NULL DEFAULT '', error TEXT
			);
			INSERT INTO deliveries (message, message_hash, delivered_at, idempotency_key)
			VALUES ('one', 'hash-one', 1, 'same-key'), ('two', 'hash-two', 2, 'same-key');
		`);
		legacy.close();

		const store = new ProactiveStore(dbPath);
		try {
			const rows = store.listDeliveries(10);
			expect(rows).toHaveLength(2);
			expect(rows.map((row) => row.idempotency_key).sort()).toEqual(["delivery:1", "delivery:2"]);
		} finally {
			store.close();
		}
	});
});

describe("SQLite multi-process concurrency", () => {
	it("serializes concurrent delivery inserts on one idempotency key", async () => {
		const root = makeTempDir("proactive-concurrent-delivery-");
		const dbPath = join(root, "proactive.sqlite");
		const results = await Promise.all(
			Array.from({ length: 8 }, () => runWorker("delivery", dbPath, "concurrent:key")),
		);
		expect(results.every((result) => result.ok === true)).toBe(true);
		expect(new Set(results.map((result) => result.id))).toEqual(new Set([1]));
		const store = new ProactiveStore(dbPath);
		try {
			expect(store.listDeliveries()).toHaveLength(1);
		} finally {
			store.close();
		}
	});
});
