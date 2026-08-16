import {
	createSqliteDatabase,
	type SqliteDatabase as RuntimeSqliteDatabase,
	type SqliteStatement as RuntimeSqliteStatement,
} from "@cogito/agent-core/sqlite";
import type { SqliteDatabase, SqliteDatabaseFactory, SqliteRunResult, SqliteStatement } from "./sqlite/types.ts";

function isNamedParameters(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object") return false;
	if (Array.isArray(value) || ArrayBuffer.isView(value)) return false;
	return true;
}

class NodeSqliteStatement implements SqliteStatement {
	private readonly statement: RuntimeSqliteStatement;

	constructor(statement: RuntimeSqliteStatement) {
		this.statement = statement;
	}

	async run(...params: unknown[]): Promise<SqliteRunResult> {
		const [first, ...rest] = params;
		const result = isNamedParameters(first) ? this.statement.run(first, ...rest) : this.statement.run(...params);
		return {
			changes: Number(result.changes),
			lastInsertRowid: result.lastInsertRowid === undefined ? undefined : Number(result.lastInsertRowid),
		};
	}

	async get<TRow extends object>(...params: unknown[]): Promise<TRow | undefined> {
		const [first, ...rest] = params;
		return (isNamedParameters(first) ? this.statement.get(first, ...rest) : this.statement.get(...params)) as
			| TRow
			| undefined;
	}

	async all<TRow extends object>(...params: unknown[]): Promise<TRow[]> {
		const [first, ...rest] = params;
		return (isNamedParameters(first) ? this.statement.all(first, ...rest) : this.statement.all(...params)) as TRow[];
	}
}

class NodeSqliteDatabase implements SqliteDatabase {
	private readonly db: RuntimeSqliteDatabase;
	private readonly loadedExtensions = new Set<string>();

	constructor(db: RuntimeSqliteDatabase) {
		this.db = db;
	}

	async exec(sql: string): Promise<void> {
		this.db.exec(sql);
	}

	prepare(sql: string): SqliteStatement {
		return new NodeSqliteStatement(this.db.prepare(sql));
	}

	async transaction<T>(fn: () => Promise<T>): Promise<T> {
		this.db.exec("BEGIN");
		try {
			const result = await fn();
			this.db.exec("COMMIT");
			return result;
		} catch (error) {
			try {
				this.db.exec("ROLLBACK");
			} catch {
				// Ignore rollback errors to rethrow original error.
			}
			throw error;
		}
	}

	async loadExtension(path: string): Promise<void> {
		if (this.loadedExtensions.has(path)) return;
		if (!this.db.enableLoadExtension || !this.db.loadExtension) {
			throw new Error("SQLite extension loading is not supported by this runtime");
		}
		this.db.enableLoadExtension(true);
		this.db.loadExtension(path);
		this.loadedExtensions.add(path);
	}

	async close(): Promise<void> {
		this.db.close();
	}
}

export function wrapNodeSqliteDatabase(db: RuntimeSqliteDatabase): SqliteDatabase {
	return new NodeSqliteDatabase(db);
}

export function createNodeSqliteFactory(): SqliteDatabaseFactory {
	return {
		async open(path: string): Promise<SqliteDatabase> {
			// allowExtension enables loadExtension(); extensions are loaded explicitly per connection.
			return new NodeSqliteDatabase(createSqliteDatabase(path, { allowExtension: true }));
		},
	};
}

// Re-export the SQLite session backend and types so this package is a complete node-sqlite backend.
export * from "./sqlite/index.ts";
