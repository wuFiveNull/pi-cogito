import type { FileSystem, SessionCreateOptions, SessionMetadata } from "@cogito/agent-core";

/** Result of a prepared SQLite statement execution. */
export interface SqliteRunResult {
	/** Number of rows changed by the statement. */
	changes: number;
	/** Inserted row id when the backend exposes one. */
	lastInsertRowid?: number;
}

/** Prepared SQLite statement capability used by the SQLite session backend. */
export interface SqliteStatement {
	run(...params: unknown[]): Promise<SqliteRunResult>;
	get<TRow extends object>(...params: unknown[]): Promise<TRow | undefined>;
	all<TRow extends object>(...params: unknown[]): Promise<TRow[]>;
}

/** SQLite database capability used by the SQLite session backend. */
export interface SqliteDatabase {
	exec(sql: string): Promise<void>;
	prepare(sql: string): SqliteStatement;
	transaction<T>(fn: () => Promise<T>): Promise<T>;
	/**
	 * Load a native SQLite extension (e.g. sqlite-vec) into this connection.
	 * Implementations may reject this when extension loading was not enabled at open time.
	 */
	loadExtension?(path: string): Promise<void>;
	close(): Promise<void>;
}

export interface SqliteDatabaseFactory {
	open(path: string): Promise<SqliteDatabase>;
}

export interface SqliteSessionMetadata extends SessionMetadata {
	cwd: string;
	path: string;
	parentSessionId?: string;
	metadata?: Record<string, unknown>;
}

export interface SqliteSessionCreateOptions extends SessionCreateOptions {
	cwd: string;
	parentSessionId?: string;
	metadata?: Record<string, unknown>;
}

export interface SqliteSessionListOptions {
	cwd?: string;
}

export type SqliteSessionRepositoryEnv = Pick<FileSystem, "absolutePath" | "createDir" | "exists">;
