import { createRequire } from "node:module";

export interface SqliteRunResult {
	changes: number | bigint;
	lastInsertRowid?: number | bigint;
}

export interface SqliteStatement {
	run(...params: unknown[]): SqliteRunResult;
	get(...params: unknown[]): unknown;
	all(...params: unknown[]): unknown[];
}

export interface SqliteDatabase {
	exec(sql: string): void;
	prepare(sql: string): SqliteStatement;
	close(): void;
	enableLoadExtension?(enabled: boolean): void;
	loadExtension(path: string): void;
}

interface NodeSqliteModule {
	DatabaseSync: new (path: string, options?: { allowExtension?: boolean }) => SqliteDatabase;
}

interface BunSqliteModule {
	Database: new (path: string) => SqliteDatabase;
}

const runtimeRequire = createRequire(import.meta.url);

/** Open SQLite through Node's node:sqlite or Bun's bun:sqlite implementation. */
export function createSqliteDatabase(path: string, options?: { allowExtension?: boolean }): SqliteDatabase {
	const moduleName = process.versions.bun === undefined ? "node:sqlite" : "bun:sqlite";
	const sqliteModule = runtimeRequire(moduleName) as NodeSqliteModule | BunSqliteModule;
	if (process.versions.bun !== undefined) {
		return new (sqliteModule as BunSqliteModule).Database(path);
	}
	const NodeDatabaseSync = (sqliteModule as NodeSqliteModule).DatabaseSync;
	return options === undefined ? new NodeDatabaseSync(path) : new NodeDatabaseSync(path, options);
}
