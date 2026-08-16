/**
 * Proactive monitor — 只读 HTTP 观测面(akashic dashboard API 移植)。
 *
 * node:http 零依赖;对 proactive.sqlite 只读查询。可在 pusher 进程内启动
 * (runPusher 的 monitor 配置),也可作为独立进程指向 pusher 的 db。
 * 端点形状对照 akashic /api/dashboard/proactive/*:
 *   GET /overview                         总览(计数 + 最近 tick + 结果分布)
 *   GET /deliveries                       投递列表(分页)
 *   GET /deliveries/pending                待投递列表
 *   GET /source_quarantine                source 坏 item 隔离列表
 *   GET /source_failures                  source 拉取失败历史
 *   GET /metrics                          source 状态、熔断和 ACK 指标
 *   GET /source_ack_queue                 source ACK 待重试列表
 *   GET /wake/tick_logs                   wake tick 审计
 *   GET /wake/tick_errors                 wake tick 错误审计
 *   GET /wake/quarantine                  wake reservoir 隔离列表
 *   GET /wake/pending_acknowledgements    wake 待 ACK 列表
 *   GET /tick_logs                         tick 日志列表(筛选 + 排序 + 分页)
 *   GET /tick_logs/{id}                    单条 tick 日志
 *   GET /tick_logs/{id}/steps              tick 阶段步骤回放
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { DatabaseSync } from "node:sqlite";
import type { EventBus } from "./bus.ts";
import { RuntimeReplayJournal } from "./ext/snapshot.ts";
import { readHistoricalReplayAudit } from "./replay.ts";

export interface MonitorConfig {
	port: number;
	dbPath: string;
	/** wake_proactive.db 路径;提供时开放 wake 审计端点。 */
	wakeDbPath?: string;
	/** drift/drift.db 路径;提供时开放 drift 观测端点。 */
	driftDbPath?: string;
	/** runtime snapshot/replay journal path. */
	runtimeJournalPath?: string;
	/** Historical tick replay audit JSONL path. */
	replayReportPath?: string;
	/** In-process event stream; omitted for standalone SQLite-only monitor. */
	eventBus?: EventBus;
}

export interface MonitorEventRecord {
	type: string;
	at: number;
	payload: Record<string, unknown>;
}

interface MonitorLiveState {
	events: MonitorEventRecord[];
	lastEventAt: number | null;
	lastEventType: string | null;
}

export interface MonitorHandle {
	/** 实际监听端口(port=0 时由系统分配)。 */
	port: number;
	stop(): Promise<void>;
}

const TICK_LOG_SORT_COLUMNS = new Set(["session_key", "started_at", "finished_at", "action", "steps", "base_score"]);

function clampPage(value: number): number {
	return Number.isFinite(value) ? Math.max(1, Math.trunc(value)) : 1;
}

function clampPageSize(value: number): number {
	return Number.isFinite(value) ? Math.min(200, Math.max(1, Math.trunc(value))) : 50;
}

function parseNumeric(raw: string | null): number | undefined {
	if (!raw) return undefined;
	const value = Number(raw);
	return Number.isFinite(value) ? value : undefined;
}

/** 启动只读 monitor;port=0 时由系统分配(测试用)。 */
export async function startMonitor(config: MonitorConfig): Promise<MonitorHandle> {
	const db = new DatabaseSync(config.dbPath, { readOnly: true });
	db.exec("PRAGMA busy_timeout = 5000");
	const wakeDb = config.wakeDbPath ? openReadonly(config.wakeDbPath) : null;
	const driftDb = config.driftDbPath ? openReadonly(config.driftDbPath) : null;
	const runtimeJournal = config.runtimeJournalPath ? new RuntimeReplayJournal(config.runtimeJournalPath) : null;
	const live: MonitorLiveState | undefined = config.eventBus
		? { events: [], lastEventAt: null, lastEventType: null }
		: undefined;
	const unsubscribeLive = config.eventBus?.onAny((event) => {
		if (!live) return;
		const record = monitorEventRecord(event);
		live.events.push(record);
		if (live.events.length > 200) live.events.splice(0, live.events.length - 200);
		live.lastEventAt = record.at;
		live.lastEventType = record.type;
	});
	const server = createServer((req, res) => {
		try {
			handleRequest(db, wakeDb, driftDb, runtimeJournal, config.replayReportPath, live, req, res);
		} catch (error) {
			sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
		}
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(config.port, "127.0.0.1", resolve);
	});
	const address = server.address();
	const actualPort = typeof address === "object" && address !== null ? address.port : config.port;
	return {
		stop: async () => {
			await new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			});
			db.close();
			wakeDb?.close();
			driftDb?.close();
			unsubscribeLive?.();
		},
		port: actualPort,
	};
}

function openReadonly(path: string): DatabaseSync | null {
	try {
		return new DatabaseSync(path, { readOnly: true });
	} catch {
		return null;
	}
}

// ------------------------------------------------------------------
// Routing
// ------------------------------------------------------------------

function handleRequest(
	db: DatabaseSync,
	wakeDb: DatabaseSync | null,
	driftDb: DatabaseSync | null,
	runtimeJournal: RuntimeReplayJournal | null,
	replayReportPath: string | undefined,
	live: MonitorLiveState | undefined,
	req: IncomingMessage,
	res: ServerResponse,
): void {
	const url = new URL(req.url ?? "/", "http://127.0.0.1");
	const path = url.pathname.replace(/\/+$/, "") || "/";
	const method = req.method ?? "GET";
	if (method !== "GET") {
		sendJson(res, 405, { error: "method not allowed" });
		return;
	}

	if (path === "/" || path === "/health") {
		sendText(res, 200, "proactive monitor ok");
		return;
	}
	if (path === "/api/dashboard/proactive/overview") {
		sendJson(res, 200, overview(db, live));
		return;
	}
	if (path === "/api/dashboard/proactive/events") {
		sendJson(res, 200, {
			source: live ? "event_bus" : "sqlite",
			live: live !== undefined,
			items: live?.events.slice(-clampPageSize(parseNumeric(url.searchParams.get("limit")) ?? 100)) ?? [],
			fallback: live ? undefined : overview(db),
		});
		return;
	}
	if (path === "/api/dashboard/proactive/runtime/replay") {
		sendJson(res, 200, {
			items: runtimeJournal?.list(clampPageSize(parseNumeric(url.searchParams.get("limit")) ?? 100)) ?? [],
		});
		return;
	}
	if (path === "/api/dashboard/proactive/runtime/replay/ticks") {
		sendJson(res, 200, {
			source: replayReportPath ? "replay_audit" : "sqlite",
			items: replayReportPath
				? readHistoricalReplayAudit(
						replayReportPath,
						clampPageSize(parseNumeric(url.searchParams.get("limit")) ?? 100),
					)
				: [],
		});
		return;
	}
	if (path === "/api/dashboard/proactive/deliveries") {
		sendJson(res, 200, listDeliveries(db, url.searchParams));
		return;
	}
	if (path === "/api/dashboard/proactive/deliveries/pending") {
		sendJson(res, 200, listPendingDeliveries(db, url.searchParams));
		return;
	}
	if (path === "/api/dashboard/proactive/source_quarantine") {
		sendJson(res, 200, listSourceRows(db, "source_quarantine", "last_seen_at", url.searchParams));
		return;
	}
	if (path === "/api/dashboard/proactive/source_failures") {
		sendJson(res, 200, listSourceRows(db, "source_failures", "checked_at", url.searchParams));
		return;
	}
	if (path === "/api/dashboard/proactive/metrics") {
		sendJson(res, 200, sourceMetrics(db, url.searchParams));
		return;
	}
	if (path === "/api/dashboard/proactive/source_ack_queue") {
		sendJson(res, 200, listSourceAcknowledgements(db, url.searchParams));
		return;
	}
	if (wakeDb) {
		if (path === "/api/dashboard/proactive/wake/tick_logs") {
			sendJson(res, 200, listWakeRows(wakeDb, "wake_tick_log", "started_at", url.searchParams));
			return;
		}
		if (path === "/api/dashboard/proactive/wake/tick_errors") {
			sendJson(res, 200, listWakeRows(wakeDb, "wake_tick_log", "started_at", url.searchParams, "status = 'error'"));
			return;
		}
		if (path === "/api/dashboard/proactive/wake/quarantine") {
			sendJson(res, 200, listWakeRows(wakeDb, "reservoir_quarantine", "last_seen_at", url.searchParams));
			return;
		}
		if (path === "/api/dashboard/proactive/wake/pending_acknowledgements") {
			sendJson(
				res,
				200,
				listWakeRows(wakeDb, "pending_acknowledgements", "queued_at", url.searchParams, undefined, "ASC"),
			);
			return;
		}
	}
	if (driftDb) {
		if (path === "/api/dashboard/proactive/drift/runs") {
			sendJson(res, 200, listDriftRuns(driftDb, url.searchParams));
			return;
		}
		if (path === "/api/dashboard/proactive/drift/active") {
			sendJson(res, 200, listDriftActiveRuns(driftDb, url.searchParams));
			return;
		}
		if (path === "/api/dashboard/proactive/drift/steps") {
			sendJson(res, 200, listDriftSteps(driftDb, url.searchParams));
			return;
		}
		const diagnosticsMatch = path.match(/^\/api\/dashboard\/proactive\/drift\/diagnostics\/(.+)$/);
		if (diagnosticsMatch) {
			const runId = decodeURIComponent(diagnosticsMatch[1] ?? "");
			const diagnostics = getDriftDiagnostics(driftDb, runId);
			if (!diagnostics) {
				sendJson(res, 404, { error: `drift run 不存在: ${runId}` });
				return;
			}
			sendJson(res, 200, diagnostics);
			return;
		}
	}
	if (path === "/api/dashboard/proactive/tick_logs") {
		sendJson(res, 200, listTickLogs(db, url.searchParams, driftDb));
		return;
	}
	const tickLogMatch = path.match(/^\/api\/dashboard\/proactive\/tick_logs\/(\d+)$/);
	if (tickLogMatch) {
		const id = Number(tickLogMatch[1]);
		const log = getTickLog(db, id);
		if (!log) {
			sendJson(res, 404, { error: `tick 不存在: ${id}` });
			return;
		}
		sendJson(res, 200, log);
		return;
	}
	const stepsMatch = path.match(/^\/api\/dashboard\/proactive\/tick_logs\/(\d+)\/steps$/);
	if (stepsMatch) {
		sendJson(res, 200, listTickSteps(db, Number(stepsMatch[1])));
		return;
	}
	sendJson(res, 404, { error: `unknown path: ${path}` });
}

// ------------------------------------------------------------------
// Queries
// ------------------------------------------------------------------

function countRows(db: DatabaseSync, table: string): number {
	const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
	return row.count;
}

function overview(db: DatabaseSync, live?: MonitorLiveState): Record<string, unknown> {
	const counts = {
		deliveries: countRows(db, "deliveries"),
		items: countRows(db, "items"),
		tick_logs: countRows(db, "tick_log"),
		tick_steps: countRows(db, "tick_steps"),
	};
	const resultCounts = Object.fromEntries(
		(
			db.prepare(`SELECT action AS bucket, COUNT(*) AS total FROM tick_log GROUP BY action`).all() as Array<{
				bucket: string;
				total: number;
			}>
		).map((row) => [row.bucket, row.total]),
	);
	const flowCounts = Object.fromEntries(
		(
			db
				.prepare(
					`SELECT CASE WHEN action = 'drift' THEN 'drift' ELSE 'proactive' END AS bucket, COUNT(*) AS total
					 FROM tick_log GROUP BY 1`,
				)
				.all() as Array<{ bucket: string; total: number }>
		).map((row) => [row.bucket, row.total]),
	);
	const lastTickAt = (db.prepare(`SELECT MAX(started_at) AS at FROM tick_log`).get() as { at: number | null }).at;
	const lastSendAt = (db.prepare(`SELECT MAX(delivered_at) AS at FROM deliveries`).get() as { at: number | null }).at;
	const recentTick = db.prepare(`SELECT * FROM tick_log ORDER BY started_at DESC, id DESC LIMIT 1`).get() as
		| Record<string, unknown>
		| undefined;
	return {
		counts,
		result_counts: resultCounts,
		flow_counts: flowCounts,
		last_tick_at: lastTickAt,
		last_send_at: lastSendAt,
		last_skip_reason: recentTick && recentTick.action !== "send" ? (recentTick.skip_reason ?? null) : null,
		recent_tick: recentTick ?? null,
		live: live
			? {
					source: "event_bus",
					event_count: live.events.length,
					last_event_at: live.lastEventAt,
					last_event_type: live.lastEventType,
				}
			: { source: "sqlite", event_count: 0, last_event_at: null, last_event_type: null },
	};
}

function monitorEventRecord(event: object): MonitorEventRecord {
	const payload: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(event)) payload[key] = jsonSafe(value);
	const at = eventTimestamp(payload) ?? Date.now();
	return { type: event.constructor.name || "Event", at, payload };
}

function eventTimestamp(payload: Record<string, unknown>): number | undefined {
	for (const key of ["finishedAt", "deliveredAt", "startedAt", "at"]) {
		const value = payload[key];
		if (typeof value === "number" && Number.isFinite(value)) return value;
	}
	return undefined;
}

function jsonSafe(value: unknown, depth = 0): unknown {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
	if (value instanceof Date) return value.toISOString();
	if (depth >= 3) return "[truncated]";
	if (Array.isArray(value)) return value.slice(0, 50).map((item) => jsonSafe(item, depth + 1));
	if (typeof value === "object") {
		const result: Record<string, unknown> = {};
		for (const [key, nested] of Object.entries(value).slice(0, 100)) result[key] = jsonSafe(nested, depth + 1);
		return result;
	}
	return String(value);
}

interface PageResult {
	items: unknown[];
	total: number;
	page: number;
	page_size: number;
}

function listDeliveries(db: DatabaseSync, params: URLSearchParams): PageResult {
	const page = clampPage(parseNumeric(params.get("page")) ?? 1);
	const pageSize = clampPageSize(parseNumeric(params.get("page_size")) ?? 50);
	const sessionKey = params.get("session_key") ?? "";
	const deliveredFrom = parseNumeric(params.get("delivered_from"));
	const deliveredTo = parseNumeric(params.get("delivered_to"));
	const where: string[] = [];
	const args: Array<string | number> = [];
	if (sessionKey) {
		where.push("session_key = ?");
		args.push(sessionKey);
	}
	if (deliveredFrom !== undefined) {
		where.push("delivered_at >= ?");
		args.push(deliveredFrom);
	}
	if (deliveredTo !== undefined) {
		where.push("delivered_at <= ?");
		args.push(deliveredTo);
	}
	const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
	const total = (db.prepare(`SELECT COUNT(*) AS count FROM deliveries ${whereSql}`).get(...args) as { count: number })
		.count;
	const items = db
		.prepare(`SELECT * FROM deliveries ${whereSql} ORDER BY delivered_at DESC, id DESC LIMIT ? OFFSET ?`)
		.all(...args, pageSize, (page - 1) * pageSize);
	return { items, total, page, page_size: pageSize };
}

function listPendingDeliveries(db: DatabaseSync, params: URLSearchParams): PageResult {
	const page = clampPage(parseNumeric(params.get("page")) ?? 1);
	const pageSize = clampPageSize(parseNumeric(params.get("page_size")) ?? 50);
	const total = (db.prepare(`SELECT COUNT(*) AS count FROM deliveries WHERE acked = 0`).get() as { count: number })
		.count;
	const items = db
		.prepare(
			`SELECT * FROM deliveries WHERE acked = 0
			 ORDER BY delivered_at ASC, id ASC LIMIT ? OFFSET ?`,
		)
		.all(pageSize, (page - 1) * pageSize);
	return { items, total, page, page_size: pageSize };
}

function listSourceRows(
	db: DatabaseSync,
	table: "source_quarantine" | "source_failures",
	orderColumn: string,
	params: URLSearchParams,
): PageResult {
	const page = clampPage(parseNumeric(params.get("page")) ?? 1);
	const pageSize = clampPageSize(parseNumeric(params.get("page_size")) ?? 50);
	const sourceId = params.get("source_id") ?? "";
	const where = sourceId ? "WHERE source_id = ?" : "";
	const args: Array<string | number> = sourceId ? [sourceId] : [];
	const total = (db.prepare(`SELECT COUNT(*) AS count FROM ${table} ${where}`).get(...args) as { count: number })
		.count;
	const items = db
		.prepare(`SELECT * FROM ${table} ${where} ORDER BY ${orderColumn} DESC, rowid DESC LIMIT ? OFFSET ?`)
		.all(...args, pageSize, (page - 1) * pageSize);
	return { items, total, page, page_size: pageSize };
}

function listSourceAcknowledgements(db: DatabaseSync, params: URLSearchParams): PageResult {
	const page = clampPage(parseNumeric(params.get("page")) ?? 1);
	const pageSize = clampPageSize(parseNumeric(params.get("page_size")) ?? 50);
	const sourceId = params.get("source_id") ?? "";
	const where = sourceId ? "WHERE source_id = ?" : "";
	const args: Array<string | number> = sourceId ? [sourceId] : [];
	const total = (
		db.prepare(`SELECT COUNT(*) AS count FROM source_ack_queue ${where}`).get(...args) as { count: number }
	).count;
	const items = db
		.prepare(
			`SELECT * FROM source_ack_queue ${where}
			 ORDER BY queued_at ASC, source_id ASC, event_id ASC LIMIT ? OFFSET ?`,
		)
		.all(...args, pageSize, (page - 1) * pageSize);
	return { items, total, page, page_size: pageSize };
}

function sourceMetrics(db: DatabaseSync, params: URLSearchParams): Record<string, unknown> {
	const sourceId = params.get("source_id") ?? "";
	const rows = db
		.prepare(
			`SELECT key, value FROM state
			 WHERE key LIKE 'health.source.%' ${sourceId ? "AND key = ?" : ""}
			 ORDER BY key ASC`,
		)
		.all(...(sourceId ? [`health.source.${sourceId}`] : [])) as Array<{ key: string; value: string | null }>;
	const items = rows.map((row) => {
		const id = row.key.slice("health.source.".length);
		try {
			const parsed: unknown = JSON.parse(row.value ?? "null");
			return isRecord(parsed) ? { source_id: id, ...parsed } : { source_id: id, status: "corrupt" };
		} catch {
			return { source_id: id, status: "corrupt" };
		}
	});
	const pendingAcks = (db.prepare("SELECT COUNT(*) AS count FROM source_ack_queue").get() as { count: number }).count;
	const failedAcks = (
		db.prepare("SELECT COALESCE(SUM(attempts), 0) AS attempts FROM source_ack_queue").get() as { attempts: number }
	).attempts;
	return {
		items,
		total: items.length,
		ack: { pending: pendingAcks, attempts: failedAcks },
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function listWakeRows(
	db: DatabaseSync,
	table: "wake_tick_log" | "reservoir_quarantine" | "pending_acknowledgements",
	orderColumn: string,
	params: URLSearchParams,
	additionalWhere?: string,
	orderDirection = "DESC",
): PageResult {
	const page = clampPage(parseNumeric(params.get("page")) ?? 1);
	const pageSize = clampPageSize(parseNumeric(params.get("page_size")) ?? 50);
	const sessionKey = params.get("session_key") ?? "";
	const sourceId = params.get("source_id") ?? "";
	const where: string[] = [];
	const args: Array<string | number> = [];
	if (additionalWhere) where.push(additionalWhere);
	if (sessionKey && table === "wake_tick_log") {
		where.push("session_key = ?");
		args.push(sessionKey);
	}
	if (sourceId && (table === "reservoir_quarantine" || table === "pending_acknowledgements")) {
		where.push("source_id = ?");
		args.push(sourceId);
	}
	const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
	const total = (db.prepare(`SELECT COUNT(*) AS count FROM ${table} ${whereSql}`).get(...args) as { count: number })
		.count;
	const items = db
		.prepare(
			`SELECT * FROM ${table} ${whereSql} ORDER BY ${orderColumn} ${orderDirection}, rowid ${orderDirection} LIMIT ? OFFSET ?`,
		)
		.all(...args, pageSize, (page - 1) * pageSize);
	return { items, total, page, page_size: pageSize };
}

function listTickLogs(db: DatabaseSync, params: URLSearchParams, driftDb?: DatabaseSync | null): PageResult {
	const page = clampPage(parseNumeric(params.get("page")) ?? 1);
	const pageSize = clampPageSize(parseNumeric(params.get("page_size")) ?? 50);
	const sessionKey = params.get("session_key") ?? "";
	const action = params.get("action") ?? "";
	const skipReason = params.get("skip_reason") ?? "";
	const flow = params.get("flow") ?? "";
	const startedFrom = parseNumeric(params.get("started_from"));
	const startedTo = parseNumeric(params.get("started_to"));
	const sortBy = TICK_LOG_SORT_COLUMNS.has(params.get("sort_by") ?? "")
		? (params.get("sort_by") as string)
		: "started_at";
	const sortOrder = (params.get("sort_order") ?? "desc").toLowerCase() === "asc" ? "ASC" : "DESC";

	// 三进程模式:drift.db 的 runs 以 flow=drift 并入同一时间线(akashic dashboard flow 过滤)。
	const includeDrift = flow !== "proactive" && driftDb !== undefined && driftDb !== null;
	const driftTimeline = includeDrift
		? loadDriftTimeline(driftDb as DatabaseSync, { sessionKey, action, startedFrom, startedTo })
		: [];

	const where: string[] = [];
	const args: Array<string | number> = [];
	if (sessionKey) {
		where.push("session_key = ?");
		args.push(sessionKey);
	}
	if (action) {
		where.push("action = ?");
		args.push(action);
	}
	if (skipReason) {
		where.push("skip_reason = ?");
		args.push(skipReason);
	}
	if (flow === "drift") {
		where.push("action = 'drift'");
	} else if (flow === "proactive") {
		where.push("action != 'drift'");
	}
	if (startedFrom !== undefined) {
		where.push("started_at >= ?");
		args.push(startedFrom);
	}
	if (startedTo !== undefined) {
		where.push("started_at <= ?");
		args.push(startedTo);
	}
	const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
	const total = (db.prepare(`SELECT COUNT(*) AS count FROM tick_log ${whereSql}`).get(...args) as { count: number })
		.count;
	const proactiveItems = db
		.prepare(`SELECT * FROM tick_log ${whereSql} ORDER BY ${sortBy} ${sortOrder}, id DESC LIMIT ? OFFSET ?`)
		.all(...args, pageSize, (page - 1) * pageSize) as Array<Record<string, unknown>>;
	for (const row of proactiveItems) row.flow = String(row.action) === "drift" ? "drift" : "proactive";
	const merged = [...proactiveItems, ...driftTimeline];
	merged.sort((a, b) => {
		const left = Number(a.started_at ?? 0);
		const right = Number(b.started_at ?? 0);
		if (left !== right) return sortOrder === "ASC" ? left - right : right - left;
		return Number(b.id ?? 0) - Number(a.id ?? 0);
	});
	const mergedTotal = total + driftTimeline.length;
	const items = merged.slice((page - 1) * pageSize, page * pageSize);
	return { items, total: mergedTotal, page, page_size: pageSize };
}

/** 把 drift.db 的 runs 读成 tick 时间线条目(flow=drift,三进程统一审计)。 */
function loadDriftTimeline(
	db: DatabaseSync,
	filters: { sessionKey: string; action: string; startedFrom?: number; startedTo?: number },
): Array<Record<string, unknown>> {
	const where: string[] = [];
	const args: Array<string | number> = [];
	if (filters.sessionKey) {
		where.push("session_key = ?");
		args.push(filters.sessionKey);
	}
	// 非 drift action 过滤 → drift 行全部排除。
	if (filters.action && filters.action !== "drift") return [];
	if (filters.startedFrom !== undefined) {
		where.push("run_at >= ?");
		args.push(new Date(filters.startedFrom).toISOString());
	}
	if (filters.startedTo !== undefined) {
		where.push("run_at <= ?");
		args.push(new Date(filters.startedTo).toISOString());
	}
	const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
	const rows = db
		.prepare(
			`SELECT id, run_id, session_key, run_at, skill_name, status, briefing, message_result
			 FROM runs ${whereSql}`,
		)
		.all(...args) as Array<Record<string, unknown>>;
	return rows.map((row) => {
		const startedAt = Date.parse(String(row.run_at ?? ""));
		return {
			id: Number(row.id),
			tick_id: String(row.run_id ?? ""),
			session_key: String(row.session_key ?? "local"),
			started_at: Number.isFinite(startedAt) ? startedAt : 0,
			finished_at: Number.isFinite(startedAt) ? startedAt : null,
			action: "drift",
			skip_reason: String(row.status ?? ""),
			steps: 0,
			base_score: null,
			final_message: String(row.briefing ?? ""),
			skill_name: String(row.skill_name ?? ""),
			message_result: String(row.message_result ?? "silent"),
			flow: "drift",
			drift_run: true,
		};
	});
}

function getTickLog(db: DatabaseSync, id: number): Record<string, unknown> | undefined {
	return db.prepare(`SELECT * FROM tick_log WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
}

function listTickSteps(db: DatabaseSync, tickId: number): unknown[] {
	return db.prepare(`SELECT * FROM tick_steps WHERE tick_id = ? ORDER BY step_index ASC`).all(tickId) as unknown[];
}

// ------------------------------------------------------------------
// Drift 观测(drift.db;只读)
// ------------------------------------------------------------------

function listDriftRuns(db: DatabaseSync, params: URLSearchParams): PageResult {
	const page = clampPage(parseNumeric(params.get("page")) ?? 1);
	const pageSize = clampPageSize(parseNumeric(params.get("page_size")) ?? 30);
	const skillName = params.get("skill_name") ?? "";
	const where = skillName ? "WHERE skill_name = ?" : "";
	const args: Array<string | number> = skillName ? [skillName] : [];
	const total = (db.prepare(`SELECT COUNT(*) AS count FROM runs ${where}`).get(...args) as { count: number }).count;
	const items = db
		.prepare(
			`SELECT id, run_at, skill_name, status, briefing, message_result, message_hash
			 FROM runs ${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
		)
		.all(...args, pageSize, (page - 1) * pageSize);
	return { items, total, page, page_size: pageSize };
}

function listDriftSteps(db: DatabaseSync, params: URLSearchParams): PageResult {
	const page = clampPage(parseNumeric(params.get("page")) ?? 1);
	const pageSize = clampPageSize(parseNumeric(params.get("page_size")) ?? 50);
	const runId = parseNumeric(params.get("run_id"));
	const where = runId !== undefined ? "WHERE run_id = ?" : "";
	const args: Array<string | number> = runId !== undefined ? [runId] : [];
	const total = (db.prepare(`SELECT COUNT(*) AS count FROM run_steps ${where}`).get(...args) as { count: number })
		.count;
	const items = db
		.prepare(
			`SELECT id, run_id, step_index, tool_name, input_preview, output_preview, created_at
			 FROM run_steps ${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
		)
		.all(...args, pageSize, (page - 1) * pageSize);
	return { items, total, page, page_size: pageSize };
}

function listDriftActiveRuns(db: DatabaseSync, params: URLSearchParams): PageResult {
	const page = clampPage(parseNumeric(params.get("page")) ?? 1);
	const pageSize = clampPageSize(parseNumeric(params.get("page_size")) ?? 30);
	const total = (db.prepare("SELECT COUNT(*) AS count FROM drift_active_runs").get() as { count: number }).count;
	const items = db
		.prepare(
			`SELECT run_id, session_key, started_at, updated_at, stage, skill_name, message_hash
			 FROM drift_active_runs ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
		)
		.all(pageSize, (page - 1) * pageSize);
	return { items, total, page, page_size: pageSize };
}

function getDriftDiagnostics(db: DatabaseSync, runId: string): Record<string, unknown> | null {
	const run = db.prepare("SELECT * FROM runs WHERE run_id = ? LIMIT 1").get(runId) as
		| Record<string, unknown>
		| undefined;
	const active = db
		.prepare(
			`SELECT run_id, session_key, started_at, updated_at, stage, skill_name, message_hash
			 FROM drift_active_runs WHERE run_id = ? LIMIT 1`,
		)
		.get(runId) as Record<string, unknown> | undefined;
	if (!run && !active) return null;
	const historyId = Number(run?.id ?? 0);
	const steps = db
		.prepare(
			`SELECT id, run_id, run_key, step_index, tool_name, input_preview, output_preview, created_at
			 FROM run_steps WHERE run_key = ? OR (? > 0 AND run_id = ?) ORDER BY id ASC`,
		)
		.all(runId, historyId, historyId);
	return { run: run ?? null, active: active ?? null, steps };
}

// ------------------------------------------------------------------
// HTTP helpers
// ------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Content-Length": Buffer.byteLength(payload),
	});
	res.end(payload);
}

function sendText(res: ServerResponse, status: number, text: string): void {
	res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Content-Length": Buffer.byteLength(text) });
	res.end(text);
}
