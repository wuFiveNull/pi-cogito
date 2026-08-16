import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import proactivePushExtension from "../examples/extensions/proactive-push.ts";
import type { ExtensionAPI } from "../src/core/extensions/index.ts";

const tempDirs: string[] = [];
let agentDir = "";
let dbPath = "";

function makeDb(): DatabaseSync {
	dbPath = join(agentDir, "proactive.sqlite");
	const db = new DatabaseSync(dbPath);
	db.exec(`
CREATE TABLE items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL,
  sub_source TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT,
  summary TEXT,
  title_hash TEXT NOT NULL UNIQUE,
  interest_score REAL,
  status TEXT NOT NULL DEFAULT 'new',
  fetched_at INTEGER NOT NULL,
  pushed_at INTEGER
);
CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_key TEXT NOT NULL DEFAULT 'local',
  message TEXT NOT NULL,
  message_hash TEXT NOT NULL,
  source_refs TEXT NOT NULL DEFAULT '[]',
  evidence TEXT NOT NULL DEFAULT '[]',
  action TEXT NOT NULL DEFAULT 'send',
  state_summary_tag TEXT NOT NULL DEFAULT 'none',
  delivered_at INTEGER NOT NULL,
  acked INTEGER NOT NULL DEFAULT 0
);
`);
	return db;
}

describe("proactive-push extension", () => {
	let handlers: Record<string, (...args: unknown[]) => unknown>;
	let commands: Record<string, (args: string, ctx: unknown) => Promise<void> | void>;
	let db: DatabaseSync;
	let notifications: string[];
	const originalEnv = process.env.PROACTIVE_DB;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "proactive-push-"));
		tempDirs.push(agentDir);
		db = makeDb();
		process.env.PROACTIVE_DB = dbPath;
		handlers = {};
		commands = {};
		notifications = [];

		proactivePushExtension({
			on: (event: string, handler: (...args: unknown[]) => unknown) => {
				handlers[event] = handler;
			},
			registerCommand: (
				name: string,
				options: { handler: (args: string, ctx: unknown) => Promise<void> | void },
			) => {
				commands[name] = options.handler;
			},
		} as unknown as ExtensionAPI);
	});

	afterEach(() => {
		db.close();
		if (originalEnv === undefined) delete process.env.PROACTIVE_DB;
		else process.env.PROACTIVE_DB = originalEnv;
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	const ctx = {
		ui: { notify: (message: string) => notifications.push(message) },
	};

	function insertDelivery(message: string, sourceRefs = "[]"): void {
		db.prepare(
			`INSERT INTO deliveries (session_key, message, message_hash, source_refs, evidence, action, state_summary_tag, delivered_at, acked)
			 VALUES ('local', ?, ?, ?, '[]', 'send', 'none', ?, 0)`,
		).run(message, message, sourceRefs, Date.now());
	}

	function insertNew(title: string, source = "weibo", subSource = "weibo"): void {
		db.prepare(
			`INSERT INTO items (scope, source, sub_source, title, url, summary, title_hash, interest_score, fetched_at, status)
			 VALUES ('', ?, ?, ?, NULL, NULL, ?, NULL, ?, 'new')`,
		).run(source, subSource, title, title, Date.now());
	}

	it("shows delivery messages with source refs on session_start and acks them", async () => {
		insertDelivery(
			"DeepSeek 发布了新模型,支持更长的上下文。",
			JSON.stringify([{ title: "DeepSeek 发布", url: "https://example.com/1" }]),
		);
		insertDelivery("GitHub 热榜出现了一个新的 agent 框架。");

		await handlers.session_start?.({ type: "session_start" }, ctx);

		expect(notifications[0]).toContain("主动推送");
		expect(notifications[0]).toContain("DeepSeek 发布了新模型");
		expect(notifications[0]).toContain("https://example.com/1");
		expect(notifications[0]).toContain("GitHub 热榜");
		const acked = db.prepare(`SELECT acked FROM deliveries`).all() as Array<{ acked: number }>;
		expect(acked.every((row) => row.acked === 1)).toBe(true);
	});

	it("does not repeat deliveries already acked", async () => {
		insertDelivery("只推送一次的内容");
		await handlers.session_start?.({ type: "session_start" }, ctx);
		notifications.length = 0;
		await handlers.session_start?.({ type: "session_start" }, ctx);
		expect(notifications.length).toBe(0);
	});

	it("omits deliveries when the push switch is off", async () => {
		await commands.proactive!("off", ctx);
		expect(notifications[0]).toContain("已关闭");

		insertDelivery("不该推送的消息");
		notifications.length = 0;
		await handlers.session_start?.({ type: "session_start" }, ctx);
		expect(notifications.length).toBe(0);
	});

	it("/digest lists new candidate items and marks them pushed", async () => {
		insertNew("热点A", "github", "github");
		insertNew("热点B", "weibo", "weibo");
		await commands.digest!("", ctx);
		expect(notifications[0]).toContain("热点A");
		expect(notifications[0]).toContain("热点B");
		const statuses = db.prepare(`SELECT status FROM items ORDER BY id`).all() as Array<{ status: string }>;
		expect(statuses.every((row) => row.status === "pushed")).toBe(true);
	});

	it("/digest filters by source", async () => {
		insertNew("微博热点", "weibo", "weibo");
		insertNew("GitHub 热点", "github", "github");
		await commands.digest!("github", ctx);
		expect(notifications[0]).toContain("GitHub 热点");
		expect(notifications[0]).not.toContain("微博热点");
	});

	it("degrades gracefully when the database is missing", async () => {
		process.env.PROACTIVE_DB = join(agentDir, "missing.sqlite");
		await handlers.session_start?.({ type: "session_start" }, ctx);
		expect(notifications.length).toBe(0);
		await commands.digest!("", ctx);
		expect(notifications.at(-1)).toContain("没有新的候选");
	});
});
