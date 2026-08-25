import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { DriftStateStore } from "../../drift/src/state.ts";
import { createWebApi, type WebApiOptions } from "../src/web-api.ts";

const tempDirs: string[] = [];

function makeEnv(): { dir: string; opts: WebApiOptions } {
	const dir = mkdtempSync(join(tmpdir(), "web-api-"));
	tempDirs.push(dir);
	const sessionsDir = join(dir, "sessions");
	const workDir = join(sessionsDir, "--work--");
	mkdirSync(workDir, { recursive: true });
	writeFileSync(
		join(workDir, "a.jsonl"),
		`${[
			JSON.stringify({ type: "session", id: "a" }),
			JSON.stringify({
				type: "message",
				id: "m1",
				timestamp: "2026-01-01T00:00:00Z",
				message: { role: "user", content: "你好" },
			}),
			JSON.stringify({
				type: "message",
				id: "m2",
				timestamp: "2026-01-01T00:00:01Z",
				message: { role: "assistant", content: "你好!有什么可以帮你?" },
			}),
		].join("\n")}\n`,
	);
	const dbPath = join(dir, "proactive.sqlite");
	const db = new DatabaseSync(dbPath);
	db.exec(`
		CREATE TABLE tick_log (id INTEGER PRIMARY KEY AUTOINCREMENT, session_key TEXT, started_at INTEGER, finished_at INTEGER, base_score REAL, candidates INTEGER, steps INTEGER, action TEXT, skip_reason TEXT, error TEXT);
		CREATE TABLE deliveries (id INTEGER PRIMARY KEY AUTOINCREMENT, session_key TEXT, message TEXT, message_hash TEXT, source_refs TEXT, evidence TEXT, action TEXT, state_summary_tag TEXT, delivered_at INTEGER, acked INTEGER);
		CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT, recommendation TEXT, source TEXT, sub_source TEXT, title TEXT, url TEXT, summary TEXT, title_hash TEXT UNIQUE, interest_score REAL, verdict TEXT, verdict_reason TEXT, status TEXT, fetched_at INTEGER, pushed_at INTEGER, evidence TEXT);
		CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT);
		INSERT INTO tick_log (session_key, started_at, finished_at, base_score, candidates, steps, action, skip_reason) VALUES ('local', 1000, 1001, 0.5, 3, 2, 'send', '');
		INSERT INTO tick_log (session_key, started_at, finished_at, base_score, candidates, steps, action, skip_reason) VALUES ('local', 2000, 2001, 0.1, 0, 0, 'none', 'no_candidates');
		INSERT INTO deliveries (session_key, message, message_hash, source_refs, evidence, action, state_summary_tag, delivered_at, acked) VALUES ('local', '测试消息', 'h1', '[]', '[]', 'send', 'none', 1000, 1);
	`);
	db.close();
	const memoryDb = join(dir, "memory.sqlite");
	const mdb = new DatabaseSync(memoryDb);
	mdb.exec(`CREATE TABLE memory_items (id TEXT PRIMARY KEY, memory_type TEXT, summary TEXT, content_hash TEXT, embedding TEXT, reinforcement INTEGER, emotional_weight INTEGER, extra_json TEXT, source_ref TEXT, happened_at TEXT, status TEXT, scope_channel TEXT, scope_chat_id TEXT, created_at TEXT, updated_at TEXT);
	INSERT INTO memory_items VALUES ('mem1', 'fact', '用户喜欢 Rust', 'h', NULL, 3, 0, NULL, NULL, NULL, 'active', '', '', '2026-01-01', '2026-01-02');`);
	mdb.close();
	return {
		dir,
		opts: {
			sessionsDir,
			proactiveDbPath: dbPath,
			memoryDbPath: memoryDb,
			driftSkillsDir: join(dir, "skills"),
			mcpConfigPath: join(dir, "mcp.json"),
			settingsPath: join(dir, "web-settings.json"),
		},
	};
}

function fakeRes(): { res: import("node:http").ServerResponse; status: () => number; body: () => unknown } {
	let status = 200;
	let body: unknown = null;
	const res = {
		writeHead(code: number) {
			status = code;
			return res;
		},
		end(data?: unknown) {
			if (typeof data === "string") {
				try {
					body = JSON.parse(data);
				} catch {
					body = data;
				}
			}
			return res;
		},
	} as unknown as import("node:http").ServerResponse;
	return { res, status: () => status, body: () => body };
}

function fakeRequest(opts: WebApiOptions): {
	api: ReturnType<typeof createWebApi>;
	get: (path: string) => Promise<{ status: number; body: unknown }>;
} {
	const api = createWebApi(opts);
	const get = async (path: string) => {
		const { res, status, body } = fakeRes();
		const url = new URL(`http://localhost${path}`);
		const req = { method: "GET" } as import("node:http").IncomingMessage;
		const handled = api.handle(req, res, url);
		if (!handled) return { status: 404, body: null };
		// 异步处理器(probeModels)完成后才返回
		await new Promise((resolve) => setTimeout(resolve, 120));
		return { status: status(), body: body() };
	};
	return { api, get };
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("web-api", () => {
	it("lists sessions and reads messages from jsonl", async () => {
		const { opts } = makeEnv();
		const { get } = fakeRequest(opts);
		const sessions = await get("/api/chat/sessions");
		expect(sessions.status).toBe(200);
		const items = (sessions.body as { items: Array<{ key: string; message_count: number }> }).items;
		expect(items).toHaveLength(1);
		expect(items[0].message_count).toBe(2);

		const msgs = await get("/api/chat/sessions/a/messages");
		const rows = (msgs.body as { items: Array<{ role: string; content: string }> }).items;
		expect(rows).toHaveLength(2);
		expect(rows[0]).toEqual({ id: "m1", role: "user", content: "你好", timestamp: "2026-01-01T00:00:00Z" });
	});

	it("queries proactive tick logs, deliveries and overview", async () => {
		const { opts } = makeEnv();
		const { get } = fakeRequest(opts);

		const logs = await get("/api/dashboard/proactive/tick_logs");
		const logItems = (logs.body as { items: Array<{ id: number; action: string }>; total: number }).items;
		expect(logItems).toHaveLength(2);
		// started_at DESC:最新 tick 在前
		expect(logItems[0].action).toBe("none");
		expect(logItems.some((item) => item.action === "send")).toBe(true);

		const detail = await get("/api/dashboard/proactive/tick_logs/1");
		expect((detail.body as { id: number }).id).toBe(1);
		expect((await get("/api/dashboard/proactive/tick_logs/999")).status).toBe(404);

		const deliveries = await get("/api/dashboard/proactive/deliveries");
		expect((deliveries.body as { total: number }).total).toBe(1);

		const overview = await get("/api/dashboard/proactive/overview");
		const ov = overview.body as {
			action_counts: Record<string, number>;
			delivery_count: number;
			item_counts: { total: number };
		};
		expect(ov.action_counts.send).toBe(1);
		expect(ov.action_counts.none).toBe(1);
		expect(ov.delivery_count).toBe(1);
		expect(ov.item_counts.total).toBe(0);
	});

	it("acks deliveries and writes back drift run message_result to sent", async () => {
		const { opts, dir } = makeEnv();
		// 造一条 drift 投递(未确认)+ 一条普通投递(未确认)。
		const db = new DatabaseSync(opts.proactiveDbPath);
		db.exec(`INSERT INTO deliveries (session_key, message, message_hash, source_refs, evidence, action, state_summary_tag, delivered_at, acked)
			VALUES ('local', 'drift 消息', 'hash-drift', '[]', '[]', 'send', 'drift', 2000, 0),
			       ('local', '普通消息', 'hash-normal', '[]', '[]', 'send', 'none', 3000, 0);`);
		db.close();

		// 造 drift.db:一条 staged run 带相同 hash,一条 silent run。
		const driftDbPath = join(dir, "drift.db");
		const driftDb = new DatabaseSync(driftDbPath);
		driftDb.exec(`CREATE TABLE runs (id INTEGER PRIMARY KEY AUTOINCREMENT, run_at TEXT NOT NULL,
			skill_name TEXT NOT NULL, status TEXT NOT NULL, briefing TEXT NOT NULL,
			message_result TEXT NOT NULL, message_hash TEXT);
			INSERT INTO runs (run_at, skill_name, status, briefing, message_result, message_hash)
			VALUES ('2026-01-01T00:00:00Z', 'skill-a', 'completed', '推送', 'staged', 'hash-drift'),
			       ('2026-01-01T00:00:01Z', 'skill-a', 'completed', '静默', 'silent', NULL);`);
		driftDb.close();

		const api = createWebApi({ ...opts, driftDbPath });
		const { res, status, body } = fakeRes();
		const req = {
			method: "POST",
			[Symbol.asyncIterator]() {
				const body = JSON.stringify({ ids: [2, 3] });
				let sent = false;
				return {
					next: () => {
						if (sent) return Promise.resolve({ done: true, value: undefined });
						sent = true;
						return Promise.resolve({ done: false, value: body });
					},
				};
			},
		} as unknown as import("node:http").IncomingMessage;
		api.handle(req, res, new URL("http://localhost/api/dashboard/proactive/deliveries/ack"));
		await new Promise((resolve) => setTimeout(resolve, 80));
		expect(status()).toBe(200);
		expect(body()).toEqual({ ok: true, acked: 2, drift_runs_sent: 1 });

		// deliveries 已确认。
		const checkDb = new DatabaseSync(opts.proactiveDbPath);
		const unacked = (checkDb.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE acked = 0").get() as { n: number })
			.n;
		checkDb.close();
		expect(unacked).toBe(0);

		// drift run 已回写 sent,silent run 不受影响。
		const checkDrift = new DatabaseSync(driftDbPath);
		const rows = checkDrift.prepare("SELECT message_result FROM runs ORDER BY id").all() as Array<{
			message_result: string;
		}>;
		checkDrift.close();
		expect(rows.map((r) => r.message_result)).toEqual(["sent", "silent"]);
	});

	it("serves tick steps for a tick log", async () => {
		const { opts } = makeEnv();
		// 造 tick_steps 数据
		const db = new DatabaseSync(opts.proactiveDbPath);
		db.exec(`CREATE TABLE IF NOT EXISTS tick_steps (
			id INTEGER PRIMARY KEY AUTOINCREMENT, tick_id INTEGER NOT NULL, step_index INTEGER NOT NULL,
			phase TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', action_after TEXT NOT NULL DEFAULT '',
			skip_reason_after TEXT NOT NULL DEFAULT '', duration_ms INTEGER NOT NULL DEFAULT 0);
			INSERT INTO tick_steps (tick_id, step_index, phase, detail, action_after, duration_ms) VALUES (1, 0, 'sense', '候选 3 条', 'judge', 5);
			INSERT INTO tick_steps (tick_id, step_index, phase, detail, action_after, duration_ms) VALUES (1, 1, 'judge', '判题完成:send', 'send', 120);`);
		db.close();
		const { get } = fakeRequest(opts);
		const steps = await get("/api/dashboard/proactive/tick_logs/1/steps");
		const items = (steps.body as { items: Array<{ phase: string; step_index: number }> }).items;
		expect(items).toHaveLength(2);
		expect(items[0]).toEqual({
			id: 1,
			tick_id: 1,
			step_index: 0,
			phase: "sense",
			detail: "候选 3 条",
			action_after: "judge",
			skip_reason_after: "",
			duration_ms: 5,
		});
		expect((await get("/api/dashboard/proactive/tick_logs/999/steps")).body as { items: unknown[] }).toEqual({
			items: [],
		});
	});

	it("lists memories and handles settings roundtrip", async () => {
		const { opts, dir } = makeEnv();
		const { get } = fakeRequest(opts);

		const memories = await get("/api/dashboard/memories");
		const items = (memories.body as { items: Array<{ id: string; summary: string; memory_type: string }> }).items;
		expect(items).toHaveLength(1);
		expect(items[0].summary).toBe("用户喜欢 Rust");
		expect(items[0].memory_type).toBe("fact");

		const state = await get("/api/settings/state");
		expect((state.body as { agentTick: { model: string } }).agentTick.model).toBe("deepseek-v4-flash");

		// POST save
		const { res: serverRes, status } = fakeRes();
		const api = createWebApi(opts);
		const req = {
			method: "POST",
			[Symbol.asyncIterator]() {
				const body = JSON.stringify({ agentTick: { model: "gpt-5" } });
				let sent = false;
				return {
					next: () => {
						if (sent) return Promise.resolve({ done: true, value: undefined });
						sent = true;
						return Promise.resolve({ done: false, value: body });
					},
				};
			},
		} as unknown as import("node:http").IncomingMessage;
		api.handle(req, serverRes, new URL("http://localhost/api/settings/save"));
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(status()).toBe(200);

		const saved = JSON.parse(
			await import("node:fs/promises").then((fs) => fs.readFile(join(dir, "web-settings.json"), "utf-8")),
		) as { agentTick: { model: string } };
		expect(saved.agentTick.model).toBe("gpt-5");
	});
});

describe("web-api extensions", () => {
	it("serves runtime jobs, memory detail/delete and plugins", async () => {
		const { opts } = makeEnv();
		// 造 presence + 注册插件
		const db = new DatabaseSync(opts.proactiveDbPath);
		db.exec(`CREATE TABLE IF NOT EXISTS presence (session_key TEXT PRIMARY KEY, last_user_at INTEGER, last_proactive_at INTEGER);
			INSERT INTO presence VALUES ('local', 1000, 2000);`);
		db.close();
		const { api: api2, get } = fakeRequest({
			...opts,
			plugins: [
				{
					id: "demo",
					name: "演示面板",
					panel: (_req, res) => {
						const response = res as unknown as {
							writeHead: (code: number, headers?: Record<string, string>) => void;
							end: (body: string) => void;
						};
						response.writeHead(200, { "Content-Type": "application/json" });
						response.end(JSON.stringify({ columns: [{ key: "a", label: "A" }], rows: [{ a: 1 }] }));
						return;
					},
				},
			],
		});

		const jobs = await get("/api/runtime/jobs");
		expect((jobs.body as { items: Array<{ key: string }> }).items[0].key).toBe("local");

		const memory = await get("/api/dashboard/memories/mem1");
		expect((memory.body as { id: string }).id).toBe("mem1");
		expect((await get("/api/dashboard/memories/nope")).status).toBe(404);

		const plugins = await get("/api/plugins");
		expect((plugins.body as { items: Array<{ id: string }> }).items[0].id).toBe("demo");
		const panel = await get("/api/plugins/demo");
		expect((panel.body as { rows: Array<{ a: number }> }).rows[0].a).toBe(1);

		// DELETE memory
		const _res = {
			writeHead: (_code: number) => _res,
			end: () => _res,
		} as unknown as import("node:http").ServerResponse;
		let status = 0;
		const res2 = {
			writeHead: (code: number) => {
				status = code;
				return res2;
			},
			end: () => res2,
		} as unknown as import("node:http").ServerResponse;
		const req = { method: "DELETE" } as import("node:http").IncomingMessage;
		api2.handle(req, res2, new URL("http://localhost/api/dashboard/memories/mem1"));
		expect(status).toBe(200);
		const after = await get("/api/dashboard/memories");
		expect((after.body as { total: number }).total).toBe(0);
	});

	it("serves active Drift runs and their diagnostics to the monitoring UI", async () => {
		const { opts, dir } = makeEnv();
		const driftDir = join(dir, "drift");
		const drift = new DriftStateStore({ driftDir });
		const now = new Date("2026-05-01T00:00:00.000Z");
		drift.startRun({ runId: "ui-run", sessionKey: "local", nowUtc: now });
		drift.updateRunProgress({ runId: "ui-run", stage: "executing", skillName: "skill-a", nowUtc: now });
		drift.appendStep({
			runId: "ui-run",
			stepIndex: 1,
			toolName: "read_file",
			inputPreview: "{}",
			outputPreview: "ok",
			nowUtc: now,
		});
		drift.close();

		const { get } = fakeRequest({ ...opts, driftDbPath: join(driftDir, "drift.db") });
		const active = await get("/api/dashboard/proactive/drift/active");
		expect(active.status).toBe(200);
		expect((active.body as { items: Array<{ run_id: string; stage: string }> }).items).toEqual([
			expect.objectContaining({ run_id: "ui-run", stage: "executing" }),
		]);

		const diagnostics = await get("/api/dashboard/proactive/drift/diagnostics/ui-run");
		expect(diagnostics.status).toBe(200);
		expect(diagnostics.body).toMatchObject({
			active: { run_id: "ui-run", skill_name: "skill-a" },
			steps: [{ tool_name: "read_file", output_preview: "ok" }],
		});
	});

	it("finds similar memories by embedding and batch-deletes", async () => {
		const { opts } = makeEnv();
		// 给记忆补 embedding(3 维)
		const db = new DatabaseSync(opts.memoryDbPath!);
		db.exec(`UPDATE memory_items SET embedding = '[0.9, 0.1, 0.2]' WHERE id = 'mem1';
			INSERT INTO memory_items VALUES ('mem2', 'fact', '用户喜欢 Python', 'h2', '[0.8, 0.15, 0.1]', 1, 0, NULL, NULL, NULL, 'active', '', '', '2026-01-01', '2026-01-02');
			INSERT INTO memory_items VALUES ('mem3', 'fact', '用户不喜欢噪音', 'h3', '[-0.9, 0.1, 0.1]', 1, 0, NULL, NULL, NULL, 'active', '', '', '2026-01-01', '2026-01-02');`);
		db.close();
		const { get } = fakeRequest(opts);

		const similar = await get("/api/dashboard/memories/mem1/similar");
		const body = similar.body as { items: Array<{ id: string; score: number }>; note: string };
		expect(body.note).toBe("");
		expect(body.items[0].id).toBe("mem2");
		expect(body.items[0].score).toBeGreaterThan(0.9);
		expect(body.items.some((item) => item.id === "mem3")).toBe(false);

		// 无 embedding 的记忆 → note
		const db2 = new DatabaseSync(opts.memoryDbPath!);
		db2.exec("UPDATE memory_items SET embedding = NULL WHERE id = 'mem2'");
		db2.close();
		const noVec = await get("/api/dashboard/memories/mem2/similar");
		expect((noVec.body as { note: string }).note).toContain("embedding");

		// batch delete
		const res2 = {
			writeHead: (code: number) => {
				status = code;
				return res2;
			},
			end: () => res2,
		} as unknown as import("node:http").ServerResponse;
		let status = 0;
		const req = {
			method: "POST",
			[Symbol.asyncIterator]() {
				const body = JSON.stringify({ ids: ["mem2", "mem3"] });
				let sent = false;
				return {
					next: () => {
						if (sent) return Promise.resolve({ done: true, value: undefined });
						sent = true;
						return Promise.resolve({ done: false, value: body });
					},
				};
			},
		} as unknown as import("node:http").IncomingMessage;
		createWebApi(opts).handle(req, res2, new URL("http://localhost/api/dashboard/memories/batch-delete"));
		await new Promise((resolve) => setTimeout(resolve, 80));
		expect(status).toBe(200);
		const after = await get("/api/dashboard/memories");
		expect((after.body as { total: number }).total).toBe(1);
	});

	it("probes models endpoint and reports upstream errors", async () => {
		const { opts } = makeEnv();
		const { get } = fakeRequest(opts);
		// baseUrl 必填
		const missing = await get("/api/settings/models");
		expect(missing.status).toBe(400);
		// 不可达端点 → 502
		const bad = await get("/api/settings/models?baseUrl=http://127.0.0.1:1");
		expect(bad.status).toBe(502);
	});
	it("serves usage totals and daily buckets with cache hit rate", async () => {
		const { opts } = makeEnv();
		writeFileSync(
			join(opts.sessionsDir, "usage.jsonl"),
			`${JSON.stringify({
				type: "message",
				id: "u1",
				timestamp: "2026-01-02T00:00:00",
				message: {
					role: "assistant",
					content: "x",
					usage: {
						input: 100,
						output: 50,
						cacheRead: 100,
						cacheWrite: 0,
						totalTokens: 250,
						cost: { total: 0.001 },
					},
				},
			})}\n`,
		);
		const { get } = fakeRequest(opts);
		const usage = await get("/api/dashboard/usage");
		const body = usage.body as {
			totals: { cacheHitRate: number };
			days: Array<{ label: string; cacheHitRate: number; totalTokens: number }>;
		};
		expect(body.totals.cacheHitRate).toBeCloseTo(50);
		expect(body.days).toHaveLength(1);
		expect(body.days[0].cacheHitRate).toBeCloseTo(50);
		expect(body.days[0].totalTokens).toBe(250);
	});
});
