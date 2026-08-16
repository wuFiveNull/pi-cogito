import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { DriftStateStore } from "@cogito/drift";
import { afterEach, describe, expect, it } from "vitest";

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
	it("migrates a legacy Drift database and preserves the old rows", () => {
		const root = makeTempDir("drift-migration-matrix-");
		const dbPath = join(root, "drift.db");
		const legacy = new DatabaseSync(dbPath);
		legacy.exec(`
			CREATE TABLE runs (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				run_at TEXT NOT NULL,
				skill_name TEXT NOT NULL,
				status TEXT NOT NULL,
				briefing TEXT NOT NULL,
				message_result TEXT NOT NULL
			);
			CREATE TABLE skill_continuum (
				skill_name TEXT PRIMARY KEY,
				run_count INTEGER NOT NULL DEFAULT 0,
				last_run_at TEXT,
				last_status TEXT NOT NULL DEFAULT 'idle',
				last_briefing TEXT NOT NULL DEFAULT '',
				scratchpad TEXT NOT NULL DEFAULT ''
			);
			CREATE TABLE run_steps (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				run_id INTEGER,
				step_index INTEGER NOT NULL,
				tool_name TEXT NOT NULL,
				input_preview TEXT NOT NULL DEFAULT '',
				output_preview TEXT NOT NULL DEFAULT '',
				created_at TEXT NOT NULL
			);
			INSERT INTO runs (run_at, skill_name, status, briefing, message_result)
			VALUES ('2025-01-01T00:00:00.000Z', 'legacy', 'completed', 'old', 'silent');
		`);
		legacy.close();

		const store = new DriftStateStore({ driftDir: root });
		try {
			const migrated = new DatabaseSync(dbPath, { readOnly: true });
			try {
				const runColumns = new Set(
					(migrated.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>).map((row) => row.name),
				);
				const continuumColumns = new Set(
					(migrated.prepare("PRAGMA table_info(skill_continuum)").all() as Array<{ name: string }>).map(
						(row) => row.name,
					),
				);
				const stepColumns = new Set(
					(migrated.prepare("PRAGMA table_info(run_steps)").all() as Array<{ name: string }>).map(
						(row) => row.name,
					),
				);
				expect([...runColumns]).toEqual(
					expect.arrayContaining([
						"run_id",
						"session_key",
						"started_at",
						"finished_at",
						"message_hash",
						"message",
					]),
				);
				expect([...continuumColumns]).toEqual(expect.arrayContaining(["cursor_json", "skill_hash", "updated_at"]));
				expect(stepColumns).toContain("run_key");
				expect((migrated.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n).toBe(1);
			} finally {
				migrated.close();
			}

			store.saveFinish({
				runId: "new-run",
				sessionKey: "local",
				skillUsed: "legacy",
				status: "completed",
				briefing: "migrated",
				messageResult: "silent",
				nowUtc: new Date("2026-05-01T00:00:00.000Z"),
			});
			expect(store.getRunDiagnostics("new-run")).toMatchObject({ run: { run_id: "new-run" } });
		} finally {
			store.close();
		}
	});
});

describe("SQLite multi-process concurrency", () => {
	it("allows only one process to claim a Drift session lease", async () => {
		const root = makeTempDir("drift-concurrent-lease-");
		const results = await Promise.all(
			Array.from({ length: 8 }, (_, index) => runWorker("drift", root, `run-${index}`)),
		);
		expect(results.filter((result) => result.ok === true)).toHaveLength(1);
		expect(results.filter((result) => result.name === "DriftRunAlreadyActiveError")).toHaveLength(7);
		const store = new DriftStateStore({ driftDir: root });
		try {
			expect(store.listActiveRuns()).toHaveLength(1);
		} finally {
			store.close();
		}
	});
});
