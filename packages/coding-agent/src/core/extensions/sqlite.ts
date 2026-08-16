import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createSqliteDatabase, type SqliteDatabase } from "@earendil-works/pi-agent-core/sqlite";

export type ExtensionSqliteValue = string | number | bigint | null | Uint8Array;

export interface ExtensionSqliteRunResult {
	changes: number;
	lastInsertRowid?: number;
}

export interface ExtensionSqliteDatabase {
	exec(sql: string): void;
	run(sql: string, ...params: ExtensionSqliteValue[]): ExtensionSqliteRunResult;
	query(sql: string, ...params: ExtensionSqliteValue[]): Record<string, unknown>[];
	get(sql: string, ...params: ExtensionSqliteValue[]): Record<string, unknown> | undefined;
	/** Run fn atomically. fn must be synchronous: other extensions' writes cannot interleave. */
	transaction<T>(fn: () => T): T;
}

export interface ExtensionIndexDatabase {
	query(sql: string, ...params: ExtensionSqliteValue[]): Record<string, unknown>[];
	get(sql: string, ...params: ExtensionSqliteValue[]): Record<string, unknown> | undefined;
}

const OPLOG_TABLE = "_oplog";

function paramsToJson(params: ExtensionSqliteValue[]): string {
	return JSON.stringify(
		params.map((param) => (param instanceof Uint8Array ? { $uint8: Buffer.from(param).toString("base64") } : param)),
	);
}

function isOplogWrite(sql: string): boolean {
	if (!sql.includes(OPLOG_TABLE)) return false;
	const upper = sql.toUpperCase().trim();
	return !upper.startsWith("INSERT") && !upper.startsWith("SELECT") && !upper.startsWith("WITH");
}

/**
 * One shared extensions database (writable, audit-logged via `_oplog`) plus a
 * read-only view of the session index database. All extension writes go through
 * this single connection, so statements serialize on the JS event loop and no
 * lock conflicts are possible.
 */
export class ExtensionSqlite {
	private readonly extensionDb: SqliteDatabase;
	private readonly indexDb: SqliteDatabase | undefined;
	private readonly getExtensionId: () => string;
	private inTransaction = false;
	private pendingTxId: string | undefined;
	private txCounter = 0;

	private constructor(extensionDb: SqliteDatabase, indexDb: SqliteDatabase | undefined, getExtensionId: () => string) {
		this.extensionDb = extensionDb;
		this.indexDb = indexDb;
		this.getExtensionId = getExtensionId;
	}

	/** Open (creating if needed) the shared extensions db and the read-only index view. */
	static create(agentDir: string, getExtensionId: () => string = () => "unknown"): ExtensionSqlite {
		const extensionsPath = join(agentDir, "extensions.sqlite");
		mkdirSync(dirname(extensionsPath), { recursive: true });
		const extensionDb = createSqliteDatabase(extensionsPath);
		extensionDb.exec("PRAGMA journal_mode=WAL");
		extensionDb.exec("PRAGMA busy_timeout=5000");
		extensionDb.exec(`
CREATE TABLE IF NOT EXISTS ${OPLOG_TABLE} (
	seq INTEGER PRIMARY KEY AUTOINCREMENT,
	ts INTEGER NOT NULL,
	extension_id TEXT NOT NULL,
	tx_id TEXT NOT NULL,
	op TEXT NOT NULL,
	sql TEXT NOT NULL,
	params TEXT,
	changes INTEGER,
	last_insert_rowid INTEGER,
	error TEXT
);
`);
		const indexPath = join(agentDir, "sessions-index", "sessions.sqlite");
		const indexDb = existsSync(indexPath) ? createSqliteDatabase(indexPath) : undefined;
		return new ExtensionSqlite(extensionDb, indexDb, getExtensionId);
	}

	get db(): ExtensionSqliteDatabase {
		return {
			exec: (sql) =>
				this.withLog("exec", sql, [], () => {
					this.extensionDb.exec(sql);
					return { changes: 0 };
				}),
			run: (sql, ...params) =>
				this.withLog("run", sql, params, () => {
					const result = this.extensionDb.prepare(sql).run(...params);
					const lastInsertRowid = Number(result.lastInsertRowid ?? 0) || undefined;
					return { changes: Number(result.changes), lastInsertRowid };
				}),
			query: (sql, ...params) => this.extensionDb.prepare(sql).all(...params) as Record<string, unknown>[],
			get: (sql, ...params) => this.extensionDb.prepare(sql).get(...params) as Record<string, unknown> | undefined,
			transaction: <T>(fn: () => T): T => this.withTransaction(fn),
		};
	}

	get indexDbView(): ExtensionIndexDatabase {
		const indexDb = this.indexDb;
		if (!indexDb) {
			return { query: () => [], get: () => undefined };
		}
		return {
			query: (sql, ...params) => indexDb.prepare(sql).all(...params) as Record<string, unknown>[],
			get: (sql, ...params) => indexDb.prepare(sql).get(...params) as Record<string, unknown> | undefined,
		};
	}

	close(): void {
		this.extensionDb.close();
		this.indexDb?.close();
	}

	private withTransaction<T>(fn: () => T): T {
		if (this.inTransaction) {
			throw new Error("Nested extension sqlite transactions are not supported");
		}
		const txId = `${Date.now()}-${++this.txCounter}`;
		this.extensionDb.exec("BEGIN");
		this.inTransaction = true;
		this.pendingTxId = txId;
		try {
			this.logLocked("transaction", "BEGIN", [], txId);
			const result = fn();
			this.logLocked("transaction", "COMMIT", [], txId);
			this.extensionDb.exec("COMMIT");
			return result;
		} catch (error) {
			try {
				this.logLocked("transaction", "ROLLBACK", [], txId, error);
			} catch {
				// Audit failed; still roll back.
			}
			this.extensionDb.exec("ROLLBACK");
			throw error;
		} finally {
			this.inTransaction = false;
			this.pendingTxId = undefined;
		}
	}

	private withLog(
		op: string,
		sql: string,
		params: ExtensionSqliteValue[],
		run: () => ExtensionSqliteRunResult,
	): ExtensionSqliteRunResult {
		if (isOplogWrite(sql)) {
			throw new Error(`Refusing to modify the ${OPLOG_TABLE} audit table`);
		}
		const txId = this.inTransaction ? (this.pendingTxId ?? "unknown") : `${Date.now()}-${++this.txCounter}`;
		const startedOwnTx = !this.inTransaction;
		if (startedOwnTx) this.extensionDb.exec("BEGIN");
		try {
			const result = run();
			this.logLocked(op, sql, params, txId, undefined, result);
			if (startedOwnTx) this.extensionDb.exec("COMMIT");
			return result;
		} catch (error) {
			if (startedOwnTx) {
				this.extensionDb.exec("ROLLBACK");
				// Record the failed attempt in its own implicit transaction so it
				// survives the rollback of the business write.
				try {
					this.logLocked(op, sql, params, txId, error);
				} catch {
					// Audit failed; the business write is already rolled back.
				}
			}
			throw error;
		}
	}

	private logLocked(
		op: string,
		sql: string,
		params: ExtensionSqliteValue[],
		txId: string,
		error?: unknown,
		result?: ExtensionSqliteRunResult,
	): void {
		this.extensionDb
			.prepare(
				`INSERT INTO ${OPLOG_TABLE} (ts, extension_id, tx_id, op, sql, params, changes, last_insert_rowid, error)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				Date.now(),
				this.getExtensionId(),
				txId,
				op,
				sql,
				paramsToJson(params),
				result?.changes ?? null,
				result?.lastInsertRowid ?? null,
				error instanceof Error ? error.message : error === undefined ? null : String(error),
			);
	}
}
