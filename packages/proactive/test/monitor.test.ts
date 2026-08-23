import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { EventBus } from "../src/bus.ts";
import { RuntimeReplayJournal } from "../src/ext/snapshot.ts";
import { type MonitorHandle, startMonitor } from "../src/monitor.ts";
import { PassiveTurnLifecycle } from "../src/passive.ts";
import { ProactiveStore } from "../src/store.ts";
import { WakeStateStore } from "../src/wake/state.ts";

const tempDirs: string[] = [];
const monitors: MonitorHandle[] = [];

afterEach(async () => {
	for (const handle of monitors.splice(0)) await handle.stop();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function startTestMonitor(dbPath: string): Promise<{ baseUrl: string; handle: MonitorHandle }> {
	const handle = await startMonitor({ port: 0, dbPath });
	monitors.push(handle);
	return { baseUrl: `http://127.0.0.1:${handle.port}`, handle };
}

function makeStore(): { store: ProactiveStore; dbPath: string } {
	const agentDir = mkdtempSync(join(tmpdir(), "proactive-monitor-"));
	tempDirs.push(agentDir);
	return { store: new ProactiveStore(join(agentDir, "proactive.sqlite")), dbPath: join(agentDir, "proactive.sqlite") };
}

async function getJson(baseUrl: string, path: string): Promise<{ status: number; body: Record<string, unknown> }> {
	const response = await fetch(`${baseUrl}${path}`);
	const body = (await response.json()) as Record<string, unknown>;
	return { status: response.status, body };
}

describe("proactive monitor (akashic dashboard API port)", () => {
	it("serves overview counts and recent tick", async () => {
		const { store, dbPath } = makeStore();
		store.insertDelivery({
			session_key: "local",
			message: "推送消息",
			message_hash: "h",
			source_refs: "[]",
			evidence: "[]",
			action: "send",
			state_summary_tag: "none",
			delivered_at: 1_700_000_000_000,
		});
		const tickId = store.recordTickLog({
			session_key: "local",
			started_at: 1_700_000_100_000,
			finished_at: 1_700_000_101_000,
			base_score: 0.4,
			candidates: 2,
			steps: 3,
			action: "send",
			skip_reason: "",
			error: null,
		});
		store.recordTickStep({
			tick_id: tickId,
			step_index: 0,
			phase: "sense",
			detail: "候选 2 条",
			action_after: "judge",
			skip_reason_after: "",
			duration_ms: 5,
		});

		const { baseUrl } = await startTestMonitor(dbPath);
		const { status, body } = await getJson(baseUrl, "/api/dashboard/proactive/overview");

		expect(status).toBe(200);
		const counts = body.counts as Record<string, number>;
		expect(counts.deliveries).toBe(1);
		expect(counts.tick_logs).toBe(1);
		expect(counts.tick_steps).toBe(1);
		expect(body.last_send_at).toBe(1_700_000_000_000);
		expect(body.last_tick_at).toBe(1_700_000_100_000);
		const resultCounts = body.result_counts as Record<string, number>;
		expect(resultCounts.send).toBe(1);
		expect(body.last_skip_reason).toBeNull();
	});

	it("serves runtime snapshot replay events", async () => {
		const { dbPath } = makeStore();
		const journalPath = join(tempDirs[0]!, "runtime.jsonl");
		const journal = new RuntimeReplayJournal(journalPath);
		journal.append({
			type: "snapshot_installed",
			snapshotId: "snapshot-1",
			fenceToken: 1,
			leaseCount: 0,
			payload: { lifecycle: "default" },
		});
		const handle = await startMonitor({ port: 0, dbPath, runtimeJournalPath: journalPath });
		monitors.push(handle);
		const replay = await getJson(
			`http://127.0.0.1:${handle.port}`,
			"/api/dashboard/proactive/runtime/replay?limit=10",
		);
		const items = replay.body.items as Array<{ type: string; snapshotId: string }>;
		expect(replay.status).toBe(200);
		expect(items).toEqual([expect.objectContaining({ type: "snapshot_installed", snapshotId: "snapshot-1" })]);
	});

	it("streams EventBus events while retaining SQLite overview fallback", async () => {
		const { dbPath } = makeStore();
		const eventBus = new EventBus();
		const handle = await startMonitor({ port: 0, dbPath, eventBus });
		monitors.push(handle);
		const lifecycle = new PassiveTurnLifecycle(eventBus);
		await lifecycle.run({ sessionKey: "local", turnIndex: 1, startedAt: 10 }, () => "ok");

		const live = await getJson(`http://127.0.0.1:${handle.port}`, "/api/dashboard/proactive/events?limit=10");
		expect(live.status).toBe(200);
		expect(live.body.source).toBe("event_bus");
		expect((live.body.items as unknown[]).length).toBe(4);

		const overview = await getJson(`http://127.0.0.1:${handle.port}`, "/api/dashboard/proactive/overview");
		const liveOverview = overview.body.live as Record<string, unknown>;
		expect(liveOverview.source).toBe("event_bus");
		expect(liveOverview.event_count).toBe(4);
	});

	it("lists deliveries with pagination and filters", async () => {
		const { store, dbPath } = makeStore();
		for (let i = 0; i < 3; i++) {
			store.insertDelivery({
				session_key: "local",
				message: `消息 ${i}`,
				message_hash: `h${i}`,
				source_refs: "[]",
				evidence: "[]",
				action: "send",
				state_summary_tag: "none",
				delivered_at: 1_700_000_000_000 + i,
			});
		}
		const { baseUrl } = await startTestMonitor(dbPath);

		const page = await getJson(
			baseUrl,
			"/api/dashboard/proactive/deliveries?page_size=2&delivered_from=1700000000001",
		);
		expect(page.status).toBe(200);
		const items = page.body.items as unknown[];
		expect(items).toHaveLength(2);
		expect(page.body.total).toBe(2);

		const filtered = await getJson(baseUrl, "/api/dashboard/proactive/deliveries?session_key=none");
		expect((filtered.body.items as unknown[]).length).toBe(0);
	});

	it("lists tick logs with action/flow filters and sorting", async () => {
		const { store, dbPath } = makeStore();
		store.recordTickLog({
			session_key: "local",
			started_at: 100,
			finished_at: null,
			base_score: null,
			candidates: 0,
			steps: 0,
			action: "drift",
			skip_reason: "",
			error: null,
		});
		store.recordTickLog({
			session_key: "local",
			started_at: 200,
			finished_at: null,
			base_score: null,
			candidates: 0,
			steps: 0,
			action: "skip",
			skip_reason: "no_candidates",
			error: null,
		});
		const { baseUrl } = await startTestMonitor(dbPath);

		const drift = await getJson(baseUrl, "/api/dashboard/proactive/tick_logs?flow=drift");
		expect((drift.body.items as unknown[]).length).toBe(1);
		expect(drift.body.total).toBe(1);

		const skip = await getJson(baseUrl, "/api/dashboard/proactive/tick_logs?action=skip&skip_reason=no_candidates");
		expect((skip.body.items as unknown[]).length).toBe(1);

		const sorted = await getJson(baseUrl, "/api/dashboard/proactive/tick_logs?sort_by=started_at&sort_order=asc");
		const sortedItems = sorted.body.items as Array<{ started_at: number }>;
		expect(sortedItems[0]?.started_at).toBe(100);

		// 非法 sort_by 回退到 started_at。
		const safe = await getJson(baseUrl, "/api/dashboard/proactive/tick_logs?sort_by=id;drop");
		expect(safe.status).toBe(200);
	});

	it("serves a single tick log and its steps", async () => {
		const { store, dbPath } = makeStore();
		const tickId = store.recordTickLog({
			session_key: "local",
			started_at: 100,
			finished_at: 200,
			base_score: 0.5,
			candidates: 1,
			steps: 2,
			action: "send",
			skip_reason: "",
			error: null,
		});
		store.recordTickStep({
			tick_id: tickId,
			step_index: 0,
			phase: "sense",
			detail: "x",
			action_after: "judge",
			skip_reason_after: "",
			duration_ms: 1,
		});
		const { baseUrl } = await startTestMonitor(dbPath);

		const single = await getJson(baseUrl, `/api/dashboard/proactive/tick_logs/${tickId}`);
		expect(single.status).toBe(200);
		expect((single.body as { action?: string }).action).toBe("send");

		const steps = await getJson(baseUrl, `/api/dashboard/proactive/tick_logs/${tickId}/steps`);
		expect(steps.body.items ?? steps.body).toBeDefined();
		expect(Array.isArray(steps.body)).toBe(true);

		const missing = await getJson(baseUrl, "/api/dashboard/proactive/tick_logs/99999");
		expect(missing.status).toBe(404);
	});

	it("returns 404 for unknown paths and 405 for POST", async () => {
		const { dbPath } = makeStore();
		const { baseUrl } = await startTestMonitor(dbPath);
		const notFound = await fetch(`${baseUrl}/api/nope`);
		expect(notFound.status).toBe(404);
		const post = await fetch(`${baseUrl}/api/dashboard/proactive/overview`, { method: "POST" });
		expect(post.status).toBe(405);
		await post.body?.cancel();
	});

	it("exposes source failures, pending deliveries, and wake tick errors", async () => {
		const { store, dbPath } = makeStore();
		store.insertDelivery({
			session_key: "local",
			message: "pending",
			message_hash: "pending",
			source_refs: "[]",
			evidence: "[]",
			action: "send",
			state_summary_tag: "none",
			delivered_at: 1,
		});
		store.recordSourceFailure({ sourceId: "feed", error: "upstream down", diagnostics: { failed: 1 }, now: 2 });
		store.setState(
			"health.source.feed",
			JSON.stringify({
				sourceId: "feed",
				status: "circuit_open",
				circuitState: "open",
				consecutiveFailures: 3,
				fetchAttempts: 4,
				fetchSuccesses: 1,
				fetchFailures: 3,
				received: 5,
				accepted: 4,
				quarantined: 1,
				checkedAt: 2,
				lastSuccessAt: 1,
				lastFailureAt: 2,
				nextProbeAt: 100,
				lastError: "upstream down",
			}),
		);
		store.queueSourceAcknowledgements("feed", ["event-1", "event-2"], 2);
		store.recordSourceAcknowledgementFailure("feed", ["event-1"], "ack unavailable", 4);
		store.recordSourceQuarantine({
			sourceId: "feed",
			itemId: "bad-1",
			reason: "bad identity",
			payload: { title: "bad" },
			now: 3,
		});

		const wakeDir = mkdtempSync(join(tmpdir(), "monitor-wake-"));
		tempDirs.push(wakeDir);
		const wakeDbPath = join(wakeDir, "wake_proactive.db");
		const wake = new WakeStateStore(wakeDbPath);
		wake.recordTickStart({ wakeId: "wake-error", sessionKey: "local", startedAt: new Date(1) });
		wake.finishTick({ wakeId: "wake-error", finishedAt: new Date(2), status: "error", error: "tick failed" });
		wake.recordQuarantine({ sourceId: "feed", itemId: "bad-2", reason: "invalid", payload: { title: "bad" } });
		wake.close();

		const handle = await startMonitor({ port: 0, dbPath, wakeDbPath });
		monitors.push(handle);
		const baseUrl = `http://127.0.0.1:${handle.port}`;
		const failures = await getJson(baseUrl, "/api/dashboard/proactive/source_failures?source_id=feed");
		expect(failures.status).toBe(200);
		expect(failures.body.total).toBe(1);
		const acknowledgements = await getJson(baseUrl, "/api/dashboard/proactive/source_ack_queue?source_id=feed");
		expect(acknowledgements.status).toBe(200);
		expect(acknowledgements.body.total).toBe(2);
		expect((acknowledgements.body.items as Array<{ event_id: string; attempts: number }>)[0]).toEqual(
			expect.objectContaining({ event_id: "event-1", attempts: 1 }),
		);
		const metrics = await getJson(baseUrl, "/api/dashboard/proactive/metrics");
		expect(metrics.body.ack).toEqual({ pending: 2, attempts: 1 });
		expect(metrics.body.items).toEqual([
			expect.objectContaining({ source_id: "feed", circuitState: "open", consecutiveFailures: 3 }),
		]);
		const pending = await getJson(baseUrl, "/api/dashboard/proactive/deliveries/pending");
		expect(pending.body.total).toBe(1);
		const quarantine = await getJson(baseUrl, "/api/dashboard/proactive/source_quarantine");
		expect(quarantine.body.total).toBe(1);
		const errors = await getJson(baseUrl, "/api/dashboard/proactive/wake/tick_errors");
		expect(errors.body.total).toBe(1);
		const wakeQuarantine = await getJson(baseUrl, "/api/dashboard/proactive/wake/quarantine");
		expect(wakeQuarantine.body.total).toBe(1);
	});

	it("serves drift runs and steps when driftDbPath is configured", async () => {
		const { dbPath } = makeStore();
		const agentDir = mkdtempSync(join(tmpdir(), "monitor-drift-"));
		tempDirs.push(agentDir);
		const driftDbPath = join(agentDir, "drift.db");
		const db = new DatabaseSync(driftDbPath);
		db.exec(`CREATE TABLE runs (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, session_key TEXT NOT NULL DEFAULT 'local', run_at TEXT NOT NULL,
			skill_name TEXT NOT NULL, status TEXT NOT NULL, briefing TEXT NOT NULL,
			message_result TEXT NOT NULL, message_hash TEXT);
			CREATE TABLE run_steps (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER,
			step_index INTEGER NOT NULL, tool_name TEXT NOT NULL, input_preview TEXT NOT NULL DEFAULT '',
			output_preview TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
			INSERT INTO runs (run_id, session_key, run_at, skill_name, status, briefing, message_result, message_hash)
			VALUES ('run-1', 'local', '2026-05-01T00:00:00Z', 'skill-a', 'completed', '审计了一条记忆', 'sent', 'h1');
			INSERT INTO run_steps (run_id, step_index, tool_name, input_preview, output_preview, created_at)
			VALUES (1, 1, 'read_file', 'x', 'ok', '2026-05-01T00:00:00Z');`);
		db.close();

		const handle = await startMonitor({ port: 0, dbPath, driftDbPath });
		monitors.push(handle);
		const baseUrl = `http://127.0.0.1:${handle.port}`;

		const runs = await getJson(baseUrl, "/api/dashboard/proactive/drift/runs");
		expect(runs.status).toBe(200);
		const runItems = runs.body.items as Array<{ skill_name: string; message_result: string }>;
		expect(runItems).toHaveLength(1);
		expect(runItems[0]?.skill_name).toBe("skill-a");
		expect(runItems[0]?.message_result).toBe("sent");

		const filtered = await getJson(baseUrl, "/api/dashboard/proactive/drift/runs?skill_name=other");
		expect((filtered.body.items as unknown[]).length).toBe(0);

		const steps = await getJson(baseUrl, "/api/dashboard/proactive/drift/steps?run_id=1");
		const stepItems = steps.body.items as Array<{ tool_name: string }>;
		expect(stepItems).toHaveLength(1);
		expect(stepItems[0]?.tool_name).toBe("read_file");

		// 未配置 driftDbPath 时 drift 端点 404。
		const { dbPath: plainDbPath } = makeStore();
		const plain = await startTestMonitor(plainDbPath);
		const missing = await getJson(plain.baseUrl, "/api/dashboard/proactive/drift/runs");
		expect(missing.status).toBe(404);
	});

	it("merges drift runs into the tick_logs timeline with flow=drift (三进程统一审计)", async () => {
		const { store, dbPath } = makeStore();
		store.recordTickLog({
			session_key: "local",
			started_at: 1_700_000_000_000,
			finished_at: 1_700_000_001_000,
			base_score: 0.4,
			candidates: 1,
			steps: 2,
			action: "send",
			skip_reason: "",
			error: null,
		});
		store.recordTickLog({
			session_key: "local",
			started_at: 1_700_000_100_000,
			finished_at: null,
			base_score: null,
			candidates: 0,
			steps: 0,
			action: "drift",
			skip_reason: "",
			error: null,
		});
		// drift.db:一条真实 drift run(时间位于两条 tick 之间)。
		const agentDir = mkdtempSync(join(tmpdir(), "proactive-monitor-drift-"));
		tempDirs.push(agentDir);
		const driftDbPath = join(agentDir, "drift.db");
		const driftDb = new DatabaseSync(driftDbPath);
		driftDb.exec(`
			CREATE TABLE runs (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				run_id TEXT,
				session_key TEXT NOT NULL DEFAULT 'local',
				run_at TEXT NOT NULL,
				started_at TEXT,
				finished_at TEXT,
				skill_name TEXT NOT NULL,
				status TEXT NOT NULL,
				briefing TEXT NOT NULL,
				message_result TEXT NOT NULL,
				message_hash TEXT
			);
			INSERT INTO runs (run_id, session_key, run_at, skill_name, status, briefing, message_result)
			VALUES ('run-1', 'local', '2026-05-01T00:00:50Z', 'skill-a', 'completed', '整理笔记', 'sent');
		`);
		driftDb.close();

		const handle = await startMonitor({ port: 0, dbPath, driftDbPath });
		monitors.push(handle);
		const baseUrl = `http://127.0.0.1:${handle.port}`;

		// 合并时间线:3 条,drift 行带 flow=drift 标记。
		const merged = await getJson(baseUrl, "/api/dashboard/proactive/tick_logs");
		const items = merged.body.items as Array<Record<string, unknown>>;
		expect(items).toHaveLength(3);
		const driftRow = items.find((row) => row.tick_id === "run-1");
		expect(driftRow).toBeDefined();
		expect(driftRow?.flow).toBe("drift");
		expect(driftRow?.action).toBe("drift");
		expect(driftRow?.skill_name).toBe("skill-a");
		expect(driftRow?.final_message).toBe("整理笔记");

		// flow=drift:只返回 drift 行(tick_log 的 action=drift 行 + drift.db 行)。
		const driftOnly = await getJson(baseUrl, "/api/dashboard/proactive/tick_logs?flow=drift");
		const driftItems = driftOnly.body.items as Array<Record<string, unknown>>;
		expect(driftItems.every((row) => row.flow === "drift")).toBe(true);
		expect(driftItems).toHaveLength(2);

		// flow=proactive:不含任何 drift 行。
		const proactiveOnly = await getJson(baseUrl, "/api/dashboard/proactive/tick_logs?flow=proactive");
		const proactiveItems = proactiveOnly.body.items as Array<Record<string, unknown>>;
		expect(proactiveItems.every((row) => row.flow === "proactive")).toBe(true);
		expect(proactiveItems).toHaveLength(1);

		// 时间窗口过滤对 drift 行生效。
		const windowed = await getJson(
			baseUrl,
			"/api/dashboard/proactive/tick_logs?started_from=1700000050000&started_to=1700000950000",
		);
		const windowItems = windowed.body.items as Array<Record<string, unknown>>;
		expect(windowItems).toHaveLength(1);
		expect(windowItems[0]?.flow).toBe("drift");
	});
});
