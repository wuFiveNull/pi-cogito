import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { ProactiveStore } from "../src/store.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeDbPath(): string {
	const agentDir = mkdtempSync(join(tmpdir(), "proactive-migration-"));
	tempDirs.push(agentDir);
	return join(agentDir, "proactive.sqlite");
}

/** 模拟旧库:只有最初的 items 表(无 kind)与 tick_log(无审计列)。 */
function createLegacyDb(dbPath: string): void {
	const db = new DatabaseSync(dbPath);
	db.exec(`
		CREATE TABLE items (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			scope TEXT NOT NULL DEFAULT '',
			recommendation TEXT,
			source TEXT NOT NULL,
			sub_source TEXT NOT NULL,
			source_event_id TEXT,
			ack_source_id TEXT,
			title TEXT NOT NULL,
			url TEXT,
			summary TEXT,
			title_hash TEXT NOT NULL UNIQUE,
			interest_score REAL,
			verdict TEXT,
			verdict_reason TEXT,
			status TEXT NOT NULL DEFAULT 'new',
			fetched_at INTEGER NOT NULL,
			pushed_at INTEGER,
			evidence TEXT
		);
		CREATE TABLE tick_log (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			session_key TEXT NOT NULL DEFAULT 'local',
			started_at INTEGER NOT NULL,
			finished_at INTEGER,
			base_score REAL,
			candidates INTEGER NOT NULL DEFAULT 0,
			steps INTEGER NOT NULL DEFAULT 0,
			action TEXT NOT NULL DEFAULT 'none',
			skip_reason TEXT NOT NULL DEFAULT '',
			error TEXT
		);
		CREATE TABLE tick_steps (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			tick_id INTEGER NOT NULL,
			step_index INTEGER NOT NULL,
			phase TEXT NOT NULL,
			detail TEXT NOT NULL DEFAULT '',
			action_after TEXT NOT NULL DEFAULT '',
			skip_reason_after TEXT NOT NULL DEFAULT '',
			duration_ms INTEGER NOT NULL DEFAULT 0
		);
		INSERT INTO items (scope, source, sub_source, title, title_hash, fetched_at)
		VALUES ('', 'old-src', 'old-sub', '旧条目', 'old-hash', 1);
	`);
	db.close();
}

describe("store migrations (items.kind + tick audit columns)", () => {
	it("migrates a legacy items table and defaults kind to content", () => {
		const dbPath = makeDbPath();
		createLegacyDb(dbPath);
		const store = new ProactiveStore(dbPath);
		// 旧行默认 content。
		expect(store.listNew()[0]?.kind).toBe("content");
		expect(store.listNew()[0]?.title).toBe("旧条目");
		// 新行按 kind 落库。
		store.insertItem({
			scope: "",
			source: "mcp",
			sub_source: "feed",
			title: "新告警",
			url: null,
			summary: null,
			title_hash: "alert-hash",
			interest_score: null,
			recommendation: null,
			verdict: null,
			verdict_reason: null,
			kind: "alert",
			fetched_at: Date.now(),
		});
		const rows = store.listNew();
		expect(rows.some((row) => row.kind === "alert" && row.title === "新告警")).toBe(true);
		store.close();
	});

	it("migrates tick_log/tick_steps audit columns and writes them", () => {
		const dbPath = makeDbPath();
		createLegacyDb(dbPath);
		const store = new ProactiveStore(dbPath);
		const tickId = store.recordTickLog({
			session_key: "local",
			started_at: 1,
			finished_at: null,
			base_score: null,
			candidates: 0,
			steps: 0,
			action: "none",
			skip_reason: "",
			error: null,
			tick_id: "uuid-1",
			gate_exit: "open",
		});
		store.updateTickLogCounts(tickId, { alertCount: 1, contentCount: 2, contextCount: 3 });
		store.updateTickLogGateExit(tickId, "cooldown");
		store.finishTickLog(tickId, {
			finished_at: 2,
			base_score: 0.5,
			steps: 3,
			action: "send",
			skip_reason: "",
			error: null,
			llm_cache_read_tokens: 40,
			llm_cache_write_tokens: 60,
		});
		store.recordTickStep({
			tick_id: tickId,
			step_index: 0,
			phase: "judge.tool",
			detail: "detail",
			action_after: "continue",
			skip_reason_after: "",
			duration_ms: 5,
			tool_name: "web_fetch",
			tool_call_id: "call-1",
			tool_args_json: '{"url":"x"}',
			tool_result_text: "正文",
			interesting_ids_after: "[1]",
			discarded_ids_after: "[]",
			cited_ids_after: "[]",
			final_message_after: "msg",
		});
		const db = new DatabaseSync(dbPath, { readOnly: true });
		const log = db.prepare("SELECT * FROM tick_log WHERE id = ?").get(tickId) as Record<string, unknown>;
		expect(String(log.tick_id)).toBe("uuid-1");
		expect(String(log.gate_exit)).toBe("cooldown");
		expect(Number(log.alert_count)).toBe(1);
		expect(Number(log.content_count)).toBe(2);
		expect(Number(log.context_count)).toBe(3);
		expect(Number(log.llm_cache_read_tokens)).toBe(40);
		expect(Number(log.llm_cache_write_tokens)).toBe(60);
		const step = db.prepare("SELECT * FROM tick_steps WHERE tick_id = ?").get(tickId) as Record<string, unknown>;
		expect(String(step.tool_name)).toBe("web_fetch");
		expect(String(step.tool_call_id)).toBe("call-1");
		expect(String(step.interesting_ids_after)).toBe("[1]");
		expect(String(step.final_message_after)).toBe("msg");
		db.close();
		store.close();
	});

	it("tick_id defaults to a UUID when not provided", () => {
		const dbPath = makeDbPath();
		const store = new ProactiveStore(dbPath);
		const tickId = store.recordTickLog({
			session_key: "local",
			started_at: 1,
			finished_at: null,
			base_score: null,
			candidates: 0,
			steps: 0,
			action: "none",
			skip_reason: "",
			error: null,
		});
		const db = new DatabaseSync(dbPath, { readOnly: true });
		const log = db.prepare("SELECT tick_id FROM tick_log WHERE id = ?").get(tickId) as { tick_id: string };
		expect(log.tick_id).toMatch(/^[0-9a-f-]{36}$/);
		db.close();
		store.close();
	});
});
