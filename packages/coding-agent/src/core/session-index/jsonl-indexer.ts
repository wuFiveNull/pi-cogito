import type { SqliteDatabase, SqliteDatabaseFactory } from "@earendil-works/pi-storage-sqlite-node";
import { parseSessionEntries, type SessionEntry } from "../session-manager.ts";
import { entryToIndexPayload, isHeader } from "./text.ts";

/** Pluggable text embedder used for vector search. */
export interface TextEmbedder {
	embed(texts: readonly string[]): Promise<number[][]>;
}

export interface JsonlIndexVectorOptions {
	embedder: TextEmbedder;
	/** Vector dimensionality of the embedder output. */
	dimensions: number;
	/** Path to the sqlite-vec native extension. */
	extensionPath: string;
	/**
	 * Bump to force a full re-embedding (e.g. after embedding strategy changes).
	 * Stored in index_meta; a mismatch drops the vec table and re-indexes all files.
	 */
	version?: string;
}

export interface JsonlSessionIndexerOptions {
	sqlite: SqliteDatabaseFactory;
	databasePath: string;
	/** Directory containing session jsonl files (e.g. ~/.pi/agent/sessions). */
	sessionsDir: string;
	/** Optional vector search support. When absent, only keyword search is available. */
	vector?: JsonlIndexVectorOptions;
	/** Filesystem helpers, mirroring the agent package's FileSystem surface. */
	fs: {
		absolutePath(path: string): Promise<string>;
		createDir(path: string, options?: { recursive?: boolean }): Promise<void>;
		listDir(path: string): Promise<string[]>;
		readTextFile(path: string): Promise<string>;
		stat(path: string): Promise<{ mtimeMs: number; size: number }>;
	};
}

export interface JsonlIndexSearchOptions {
	/** Keyword query (FTS5 trigram). */
	text?: string;
	/** Query vector for KNN search. Requires vector support. */
	vector?: number[];
	cwd?: string;
	limit?: number;
}

export interface JsonlIndexHit {
	sessionId: string;
	entrySeq: number;
	entryId: string;
	type: string;
	timestamp: string;
	text: string;
	/** bm25 score for keyword hits, cosine distance for vector hits. */
	score?: number;
}

const INDEX_META_DIMENSIONS = "vector_dimensions";
const INDEX_META_VERSION = "vector_version";

export class JsonlSessionIndexer {
	private readonly options: JsonlSessionIndexerOptions;
	private dbPromise: Promise<SqliteDatabase> | undefined;
	private vecLoaded = false;
	private vectorsInvalidated = false;
	private tail: Promise<void> = Promise.resolve();

	constructor(options: JsonlSessionIndexerOptions) {
		this.options = options;
	}

	/** Serialize all public operations so ensureIndexed/appendEntry cannot interleave. */
	private enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.tail.then(operation);
		this.tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	/**
	 * Real-time mirror of one appended session entry (dual-write path).
	 * Fire-and-forget: failures are swallowed and the file is unmarked so the
	 * next ensureIndexed() rebuilds it from jsonl (jsonl stays authoritative).
	 */
	appendEntry(sessionId: string, cwd: string, entry: SessionEntry): void {
		void this.enqueue(async () => {
			try {
				const db = await this.getDatabase();
				const row = await db
					.prepare("SELECT MAX(entry_seq) AS seq FROM entries WHERE session_id = ?")
					.get<{ seq: number | null }>(sessionId);
				const entrySeq = (row?.seq ?? 0) + 1;
				await db.prepare("INSERT OR IGNORE INTO sessions (id, cwd) VALUES (?, ?)").run(sessionId, cwd);
				const indexed = entryToIndexPayload(entry);
				const result = await db
					.prepare(
						"INSERT INTO entries (session_id, entry_seq, entry_id, type, timestamp, payload) VALUES (?, ?, ?, ?, ?, ?)",
					)
					.run(sessionId, entrySeq, entry.id, entry.type, entry.timestamp, indexed.payload);
				if (indexed.text && this.options.vector) {
					const vectors = await this.options.vector.embedder.embed([indexed.text]);
					const vector = vectors[0];
					if (vector) {
						await db
							.prepare("INSERT INTO entries_vec (rowid, embedding) VALUES (?, ?)")
							.run(BigInt(result.lastInsertRowid ?? 0), new Float32Array(vector));
					}
				}
				// Mark the session file so ensureIndexed() skips it until the jsonl changes.
				const path = await this.resolveSessionPath(sessionId);
				if (path) {
					const stat = await this.options.fs.stat(path);
					await db
						.prepare("INSERT OR REPLACE INTO indexed_files (path, session_id, mtime, size) VALUES (?, ?, ?, ?)")
						.run(path, sessionId, String(stat.mtimeMs), stat.size);
				}
			} catch {
				// Unmark the session so the next ensureIndexed() rebuilds it from jsonl.
				try {
					const db = await this.getDatabase();
					await db.prepare("DELETE FROM indexed_files WHERE session_id = ?").run(sessionId);
				} catch {
					// Ignore cleanup failures; ensureIndexed() will reconcile by file scan anyway.
				}
			}
		});
	}

	/** Incrementally index all jsonl files under sessionsDir. Idempotent. Returns files rebuilt. */
	async ensureIndexed(): Promise<number> {
		return this.enqueue(async () => {
			const db = await this.getDatabase();
			const dir = await this.options.fs.absolutePath(this.options.sessionsDir);
			let files: string[];
			try {
				files = await this.listJsonlFiles(dir);
			} catch {
				// The sessions directory is missing (or unreadable): treat as empty so
				// stale index entries for deleted sessions are cleaned up below.
				files = [];
			}
			const indexed = await this.listIndexedFiles();
			const current = new Set<string>();
			let rebuilt = 0;
			const pendingVectors: { rowid: number; text: string }[] = [];
			const completedFiles: { path: string; sessionId: string }[] = [];

			for (const path of files) {
				const stat = await this.options.fs.stat(path);
				const key = `${stat.mtimeMs}:${stat.size}`;
				current.add(path);
				if (!this.vectorsInvalidated && indexed.get(path)?.key === key) continue;
				const result = await this.indexFileEntries(db, path);
				pendingVectors.push(...result.textRows);
				completedFiles.push({ path, sessionId: result.sessionId });
				rebuilt++;
			}

			for (const [path, entry] of indexed) {
				if (current.has(path)) continue;
				await this.deleteSession(db, entry.sessionId);
				rebuilt++;
			}

			if (pendingVectors.length > 0 && this.options.vector) {
				await this.embedAndStoreVectors(db, pendingVectors);
			}
			// Mark files only after their entries (and vectors, when enabled) are fully stored,
			// so interrupted indexing is retried on the next run.
			if (completedFiles.length > 0) {
				await db.transaction(async () => {
					for (const file of completedFiles) {
						const stat = await this.options.fs.stat(file.path);
						await db
							.prepare(
								"INSERT OR REPLACE INTO indexed_files (path, session_id, mtime, size) VALUES (?, ?, ?, ?)",
							)
							.run(file.path, file.sessionId, String(stat.mtimeMs), stat.size);
					}
				});
			}
			return rebuilt;
		});
	}

	async search(options: JsonlIndexSearchOptions): Promise<JsonlIndexHit[]> {
		await this.ensureIndexed();
		// Read queries run on a dedicated read-only connection (WAL snapshot), so
		// they never interleave with writer statements or see partial rebuilds.
		const db = await this.getReadDatabase();
		const limit = options.limit ?? 20;
		const cwd = options.cwd ?? null;

		if (options.vector !== undefined && options.vector.length > 0) {
			return this.searchVector(db, options.vector, cwd, limit);
		}
		if (options.text?.trim()) {
			return this.searchKeyword(db, options.text, cwd, limit);
		}
		return [];
	}

	/** Query the embedded vector for a text (vector search). Returns undefined when vector support is off. */
	async embedQuery(text: string): Promise<number[] | undefined> {
		if (!this.options.vector) return undefined;
		const vectors = await this.options.vector.embedder.embed([text]);
		return vectors[0];
	}

	async [Symbol.asyncDispose](): Promise<void> {
		if (!this.dbPromise && !this.readDbPromise) return;
		if (this.readDbPromise) {
			const readDb = await this.readDbPromise;
			this.readDbPromise = undefined;
			await readDb.close();
		}
		if (this.dbPromise) {
			const db = await this.dbPromise;
			this.dbPromise = undefined;
			await db.close();
		}
	}

	private async searchKeyword(
		db: SqliteDatabase,
		text: string,
		cwd: string | null,
		limit: number,
	): Promise<JsonlIndexHit[]> {
		const query = `"${text.replaceAll('"', '""')}"`;
		const rows = await db
			.prepare(
				`SELECT e.session_id, e.entry_seq, e.entry_id, e.type, e.timestamp, e.payload, bm25(entries_fts) AS score
				 FROM entries_fts
				 JOIN entries e ON e.rowid = entries_fts.rowid
				 JOIN sessions s ON s.id = e.session_id
				 WHERE entries_fts MATCH ? AND (? IS NULL OR s.cwd = ?)
				 ORDER BY score
				 LIMIT ?`,
			)
			.all<IndexRow>(query, cwd, cwd, limit);
		return rows.map((row) => this.rowToHit(row));
	}

	private async searchVector(
		db: SqliteDatabase,
		vector: number[],
		cwd: string | null,
		limit: number,
	): Promise<JsonlIndexHit[]> {
		if (!this.options.vector) {
			throw new Error("Vector search requires the indexer to be created with vector support");
		}
		const rows = await db
			.prepare(
				`SELECT e.session_id, e.entry_seq, e.entry_id, e.type, e.timestamp, e.payload, v.distance AS score
				 FROM (SELECT rowid, distance FROM entries_vec WHERE embedding MATCH ? ORDER BY distance LIMIT ?) AS v
				 JOIN entries e ON e.rowid = v.rowid
				 JOIN sessions s ON s.id = e.session_id
				 WHERE (? IS NULL OR s.cwd = ?)
				 ORDER BY v.distance
				 LIMIT ?`,
			)
			.all<IndexRow>(new Float32Array(vector), limit * 4 + 50, cwd, cwd, limit);
		return rows.map((row) => this.rowToHit(row));
	}

	private rowToHit(row: IndexRow): JsonlIndexHit {
		const payload = JSON.parse(row.payload) as { text?: string };
		return {
			sessionId: row.session_id,
			entrySeq: row.entry_seq,
			entryId: row.entry_id,
			type: row.type,
			timestamp: row.timestamp,
			text: payload.text ?? "",
			score: row.score,
		};
	}

	/** Index one file's entries; returns text rows pending vector embedding. */
	private async indexFileEntries(
		db: SqliteDatabase,
		path: string,
	): Promise<{ sessionId: string; textRows: { rowid: number; text: string }[] }> {
		const content = await this.options.fs.readTextFile(path);
		const entries = parseSessionEntries(content);
		const header = entries.find(isHeader);
		const name = path.slice(path.lastIndexOf("/") + 1);
		const sessionId = header?.id ?? name.replace(/\.jsonl$/, "");
		const cwd = header?.cwd ?? "";
		const textRows: { rowid: number; text: string }[] = [];

		await db.transaction(async () => {
			await this.deleteSession(db, sessionId);
			await db.prepare("INSERT INTO sessions (id, cwd) VALUES (?, ?)").run(sessionId, cwd);

			let entrySeq = 0;
			for (const entry of entries) {
				if (entry.type === "session") continue;
				entrySeq++;
				const indexed = entryToIndexPayload(entry);
				const result = await db
					.prepare(
						"INSERT INTO entries (session_id, entry_seq, entry_id, type, timestamp, payload) VALUES (?, ?, ?, ?, ?, ?)",
					)
					.run(sessionId, entrySeq, entry.id, entry.type, entry.timestamp, indexed.payload);
				if (indexed.text) textRows.push({ rowid: result.lastInsertRowid ?? 0, text: indexed.text });
			}
		});
		return { sessionId, textRows };
	}

	/** Batch-embed pending texts with bounded concurrency and store vectors. */
	private async embedAndStoreVectors(db: SqliteDatabase, textRows: { rowid: number; text: string }[]): Promise<void> {
		const vectors: { rowid: number; embedding: Float32Array }[] = [];
		const batchSize = 8;
		const batches: { rowid: number; text: string }[][] = [];
		for (let start = 0; start < textRows.length; start += batchSize) {
			batches.push(textRows.slice(start, start + batchSize));
		}

		// Four concurrent embedding lanes; failures are isolated per batch.
		const concurrency = 4;
		let nextIndex = 0;
		const results = await Promise.all(
			Array.from({ length: Math.min(concurrency, batches.length) }, async () => {
				const lane: { rowid: number; embedding: Float32Array }[] = [];
				while (true) {
					const index = nextIndex++;
					if (index >= batches.length) break;
					lane.push(...(await this.embedBatch(batches[index]!)));
				}
				return lane;
			}),
		);
		for (const lane of results) vectors.push(...lane);
		if (vectors.length === 0) return;

		await db.transaction(async () => {
			const insertVec = db.prepare("INSERT INTO entries_vec (rowid, embedding) VALUES (?, ?)");
			for (const row of vectors) {
				await insertVec.run(BigInt(row.rowid), row.embedding);
			}
		});
	}

	/**
	 * Embed a batch; retry once on failure, then halve to isolate and skip
	 * only the failing item so one bad entry cannot block the whole index.
	 */
	private async embedBatch(
		batch: { rowid: number; text: string }[],
		retried = false,
	): Promise<{ rowid: number; embedding: Float32Array }[]> {
		const { embedder } = this.options.vector!;
		try {
			const embedded = await embedder.embed(batch.map((row) => row.text));
			const out: { rowid: number; embedding: Float32Array }[] = [];
			for (let index = 0; index < batch.length; index++) {
				const vector = embedded[index];
				if (vector) out.push({ rowid: batch[index]!.rowid, embedding: new Float32Array(vector) });
			}
			return out;
		} catch {
			if (batch.length === 1) return []; // Skip the failing item.
			if (!retried) {
				// Transient network/server errors often succeed on retry.
				return this.embedBatch(batch, true);
			}
			const mid = Math.ceil(batch.length / 2);
			const left = await this.embedBatch(batch.slice(0, mid), true);
			const right = await this.embedBatch(batch.slice(mid), true);
			return [...left, ...right];
		}
	}

	private async deleteSession(db: SqliteDatabase, sessionId: string): Promise<void> {
		const rows = await db.prepare("SELECT rowid FROM entries WHERE session_id = ?").all<{ rowid: number }>(sessionId);
		if (rows.length > 0 && this.options.vector) {
			for (const row of rows) {
				await db.prepare("DELETE FROM entries_vec WHERE rowid = ?").run(BigInt(row.rowid));
			}
		}
		await db.prepare("DELETE FROM entries WHERE session_id = ?").run(sessionId);
		await db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
		await db.prepare("DELETE FROM indexed_files WHERE session_id = ?").run(sessionId);
	}

	private async listJsonlFiles(dir: string): Promise<string[]> {
		const out: string[] = [];
		for (const name of await this.options.fs.listDir(dir)) {
			const path = `${dir}/${name}`;
			if (name.endsWith(".jsonl")) {
				out.push(path);
				continue;
			}
			// Session files live under per-cwd subdirectories; recurse one level.
			try {
				for (const subName of await this.options.fs.listDir(path)) {
					if (subName.endsWith(".jsonl")) out.push(`${path}/${subName}`);
				}
			} catch {
				// Not a directory; skip.
			}
		}
		return out;
	}

	private sessionPaths = new Map<string, string>();

	/** Locate the jsonl file for a session id under sessionsDir (cached). */
	private async resolveSessionPath(sessionId: string): Promise<string | undefined> {
		const cached = this.sessionPaths.get(sessionId);
		if (cached) return cached;
		const dir = await this.options.fs.absolutePath(this.options.sessionsDir);
		for (const name of await this.listJsonlFiles(dir)) {
			if (name.includes(sessionId)) {
				this.sessionPaths.set(sessionId, name);
				return name;
			}
		}
		return undefined;
	}

	private async listIndexedFiles(): Promise<Map<string, { sessionId: string; key: string }>> {
		const db = await this.getDatabase();
		const rows = await db
			.prepare("SELECT path, session_id, mtime, size FROM indexed_files")
			.all<{ path: string; session_id: string; mtime: string; size: number }>();
		return new Map(rows.map((row) => [row.path, { sessionId: row.session_id, key: `${row.mtime}:${row.size}` }]));
	}

	private readDbPromise: Promise<SqliteDatabase> | undefined;

	private async getReadDatabase(): Promise<SqliteDatabase> {
		if (!this.readDbPromise) this.readDbPromise = this.openReadDatabase();
		return this.readDbPromise;
	}

	private async openReadDatabase(): Promise<SqliteDatabase> {
		const path = await this.options.fs.absolutePath(this.options.databasePath);
		const db = await this.options.sqlite.open(path);
		if (this.options.vector) {
			try {
				await db.loadExtension?.(this.options.vector.extensionPath);
			} catch {
				// Vector queries degrade to keyword-only on this connection.
			}
		}
		return db;
	}

	private async getDatabase(): Promise<SqliteDatabase> {
		if (!this.dbPromise) this.dbPromise = this.openDatabase();
		return this.dbPromise;
	}

	private async openDatabase(): Promise<SqliteDatabase> {
		const path = await this.options.fs.absolutePath(this.options.databasePath);
		const lastSlash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
		const directory = lastSlash >= 0 ? path.slice(0, lastSlash) : ".";
		await this.options.fs.createDir(directory, { recursive: true });
		const db = await this.options.sqlite.open(path);
		await db.exec(`
CREATE TABLE IF NOT EXISTS indexed_files (
	path TEXT PRIMARY KEY,
	session_id TEXT NOT NULL,
	mtime TEXT NOT NULL,
	size INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
	id TEXT PRIMARY KEY,
	cwd TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS entries (
	session_id TEXT NOT NULL,
	entry_seq INTEGER NOT NULL,
	entry_id TEXT NOT NULL,
	type TEXT NOT NULL,
	timestamp TEXT NOT NULL,
	payload TEXT NOT NULL,
	PRIMARY KEY (session_id, entry_seq)
);
CREATE INDEX IF NOT EXISTS idx_entries_session ON entries(session_id, entry_seq);
CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
	payload,
	content = 'entries',
	content_rowid = 'rowid',
	tokenize = 'trigram remove_diacritics 1'
);
CREATE TRIGGER IF NOT EXISTS entries_fts_ai AFTER INSERT ON entries BEGIN
	INSERT INTO entries_fts(rowid, payload) VALUES (new.rowid, new.payload);
END;
CREATE TRIGGER IF NOT EXISTS entries_fts_ad AFTER DELETE ON entries BEGIN
	INSERT INTO entries_fts(entries_fts, rowid, payload) VALUES('delete', old.rowid, old.payload);
END;
CREATE TRIGGER IF NOT EXISTS entries_fts_au AFTER UPDATE OF payload ON entries BEGIN
	INSERT INTO entries_fts(entries_fts, rowid, payload) VALUES('delete', old.rowid, old.payload);
	INSERT INTO entries_fts(rowid, payload) VALUES (new.rowid, new.payload);
END;
CREATE TABLE IF NOT EXISTS index_meta (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
);
`);
		if (this.options.vector) {
			if (!this.vecLoaded) {
				await db.loadExtension?.(this.options.vector.extensionPath);
				this.vecLoaded = true;
			}
			const existing = await db
				.prepare("SELECT value FROM index_meta WHERE key = ?")
				.get<{ value: string }>(INDEX_META_DIMENSIONS);
			const dimensions = String(this.options.vector.dimensions);
			const version = this.options.vector.version ?? "1";
			const existingVersion = await db
				.prepare("SELECT value FROM index_meta WHERE key = ?")
				.get<{ value: string }>(INDEX_META_VERSION);
			// Rebuild when dimensions or the embedding version changed, or when a
			// pre-version database lacks the marker (upgrade from old indexer).
			const versionMismatch = existingVersion ? existingVersion.value !== version : existing !== undefined;
			if ((existing && existing.value !== dimensions) || versionMismatch) {
				await db.exec("DROP TABLE IF EXISTS entries_vec");
				await db.prepare("DELETE FROM index_meta WHERE key = ?").run(INDEX_META_DIMENSIONS);
				await db.prepare("DELETE FROM index_meta WHERE key = ?").run(INDEX_META_VERSION);
				this.vectorsInvalidated = true;
			}
			await db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS entries_vec USING vec0(embedding float[${dimensions}])`);
			await db
				.prepare("INSERT OR REPLACE INTO index_meta (key, value) VALUES (?, ?)")
				.run(INDEX_META_DIMENSIONS, dimensions);
			await db
				.prepare("INSERT OR REPLACE INTO index_meta (key, value) VALUES (?, ?)")
				.run(INDEX_META_VERSION, version);
		}
		return db;
	}
}

interface IndexRow {
	session_id: string;
	entry_seq: number;
	entry_id: string;
	type: string;
	timestamp: string;
	payload: string;
	score: number;
}
