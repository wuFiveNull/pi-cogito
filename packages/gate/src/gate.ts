/**
 * 三进程 drift 门控(共享层)。
 *
 * proactive 进程写许可,drift daemon 读许可 — 双方都只依赖本包,
 * 互不引用。gate 状态存于 drift.db 的 drift_gate 表(共享 SQLite,无 IPC)。
 */

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** One drift gate row: proactive's verdict for the drift daemon. */
export interface DriftGate {
	sessionKey: string;
	verdict: "allowed" | "suppressed";
	reason: string;
	/** Context events prefetched by the writer (proactive), for drift's driftCurrentContext. */
	context: string;
	grantedAt: Date;
	ttlHours: number;
}

/** 写入 drift 许可的回调(由宿主注入;生产实现 = DriftGateStore.writeDriftGate)。 */
export type DriftGateWriter = (gate: {
	sessionKey: string;
	verdict: "allowed" | "suppressed";
	reason?: string;
	/** 写入方预取的上下文事件文本(供 drift 的 driftCurrentContext 使用)。 */
	context?: string;
	grantedAt: Date;
	ttlHours: number;
}) => void | Promise<void>;

/** Wake 空闲时写「允许」许可的默认 TTL(小时);proactive 每 tick 刷新。 */
export const WAKE_DRIFT_GATE_TTL_HOURS = 1;

const GATE_SCHEMA = `
CREATE TABLE IF NOT EXISTS drift_gate (
	session_key TEXT PRIMARY KEY,
	verdict TEXT NOT NULL,
	reason TEXT NOT NULL DEFAULT '',
	context TEXT NOT NULL DEFAULT '',
	granted_at TEXT NOT NULL,
	ttl_hours REAL NOT NULL
);
`;

/** Options for {@link DriftGateStore}. */
export interface DriftGateStoreOptions {
	/** Directory containing drift.db (used when dbFile is not given). */
	driftDir?: string;
	/** The exact database file path. */
	dbFile?: string;
}

/**
 * Shared drift gate store: owns the drift_gate table read/write.
 * proactive writes; the drift daemon reads (TTL-expired rows read as null).
 */
export class DriftGateStore {
	readonly dbFile: string;
	private db: DatabaseSync | null = null;

	constructor(options: DriftGateStoreOptions) {
		this.dbFile = options.dbFile ?? join(options.driftDir ?? ".", "drift.db");
		mkdirSync(dirname(this.dbFile), { recursive: true });
		this.ensureDb();
	}

	close(): void {
		this.db?.close();
		this.db = null;
	}

	private conn(): DatabaseSync {
		this.db ??= new DatabaseSync(this.dbFile);
		return this.db;
	}

	private ensureDb(): void {
		this.conn().exec("PRAGMA busy_timeout = 5000");
		this.conn().exec("PRAGMA journal_mode = WAL");
		this.conn().exec(GATE_SCHEMA);
		const gateCols = new Set(
			(this.conn().prepare("PRAGMA table_info(drift_gate)").all() as Array<{ name: string }>).map((c) => c.name),
		);
		if (!gateCols.has("context")) {
			this.conn().exec("ALTER TABLE drift_gate ADD COLUMN context TEXT NOT NULL DEFAULT ''");
		}
	}

	/** 写入(upsert)drift 许可;verdict 为 allowed 或 suppressed。 */
	writeDriftGate(gate: {
		sessionKey: string;
		verdict: "allowed" | "suppressed";
		reason?: string;
		/** 写入方预取的上下文事件文本(供 drift 的 driftCurrentContext 使用)。 */
		context?: string;
		grantedAt: Date;
		ttlHours: number;
	}): void {
		this.conn()
			.prepare(
				`INSERT INTO drift_gate (session_key, verdict, reason, context, granted_at, ttl_hours)
				 VALUES (?, ?, ?, ?, ?, ?)
				 ON CONFLICT(session_key) DO UPDATE SET
					verdict = excluded.verdict,
					reason = excluded.reason,
					context = excluded.context,
					granted_at = excluded.granted_at,
					ttl_hours = excluded.ttl_hours`,
			)
			.run(
				gate.sessionKey,
				gate.verdict,
				gate.reason ?? "",
				gate.context ?? "",
				gate.grantedAt.toISOString(),
				gate.ttlHours,
			);
	}

	/** 读取未过期的 drift 许可;过期或缺失返回 null。 */
	readDriftGate(sessionKey: string, now: Date = new Date()): DriftGate | null {
		const row = this.conn()
			.prepare(
				`SELECT session_key, verdict, reason, context, granted_at, ttl_hours FROM drift_gate WHERE session_key = ?`,
			)
			.get(sessionKey) as Record<string, unknown> | undefined;
		if (!row) return null;
		const grantedAt = new Date(String(row.granted_at ?? ""));
		if (Number.isNaN(grantedAt.getTime())) return null;
		const ttlHours = Number(row.ttl_hours ?? 0);
		if (now.getTime() >= grantedAt.getTime() + ttlHours * 3600_000) return null;
		return {
			sessionKey: String(row.session_key),
			verdict: row.verdict === "suppressed" ? "suppressed" : "allowed",
			reason: String(row.reason ?? ""),
			context: String(row.context ?? ""),
			grantedAt,
			ttlHours,
		};
	}
}
