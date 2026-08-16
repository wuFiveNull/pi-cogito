/**
 * Memory engine SQLite store (akashic memory2 design).
 *
 * Dedicated database (agentDir/memory/memory.sqlite) with:
 * - memory_items: one row per memory (typed, hashed, embedded, scoped)
 * - consolidation_events: source_ref dedup for turn-level consolidation
 * - memory_replacements: audit log for supersede/merge/forget operations
 * - vec_items: sqlite-vec virtual table for ANN; falls back to a full scan
 *   over stored embeddings when the extension is unavailable
 */

import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createSqliteDatabase, type SqliteDatabase } from "@earendil-works/pi-agent-core/sqlite";

import type { MemoryHit, MemoryScope, MemoryStoreOptions, MemoryStoreSearchOptions, MemoryType } from "./types.ts";

const DEFAULT_VEC_DIM = 1024;
const VEC_FALLBACK_SAMPLE_LIMIT = 5000;

export interface MemoryRow {
	id: string;
	memoryType: MemoryType;
	summary: string;
	contentHash: string;
	embedding: string | null;
	reinforcement: number;
	emotionalWeight: number;
	extraJson: string | null;
	sourceRef: string;
	happenedAt: string | null;
	status: string;
	scopeChannel: string;
	scopeChatId: string;
	createdAt: string;
	updatedAt: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memory_items (
	id            TEXT PRIMARY KEY,
	memory_type   TEXT NOT NULL,
	summary       TEXT NOT NULL,
	content_hash  TEXT NOT NULL,
	embedding     TEXT,
	reinforcement INTEGER NOT NULL DEFAULT 1,
	emotional_weight INTEGER NOT NULL DEFAULT 0,
	extra_json    TEXT,
	source_ref    TEXT,
	happened_at   TEXT,
	status        TEXT NOT NULL DEFAULT 'active',
	scope_channel TEXT NOT NULL DEFAULT '',
	scope_chat_id TEXT NOT NULL DEFAULT '',
	created_at    TEXT NOT NULL,
	updated_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_items_hash
	ON memory_items (content_hash, memory_type);
CREATE INDEX IF NOT EXISTS ix_items_status
	ON memory_items (status);
CREATE INDEX IF NOT EXISTS ix_items_type_status
	ON memory_items (memory_type, status);
CREATE TABLE IF NOT EXISTS consolidation_events (
	source_ref  TEXT PRIMARY KEY,
	item_id     TEXT,
	created_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_replacements (
	id                INTEGER PRIMARY KEY AUTOINCREMENT,
	old_item_id       TEXT NOT NULL,
	old_memory_type   TEXT NOT NULL,
	old_summary       TEXT NOT NULL,
	old_source_ref    TEXT,
	old_happened_at   TEXT,
	old_extra_json    TEXT,
	new_item_id       TEXT NOT NULL,
	new_memory_type   TEXT NOT NULL,
	new_summary       TEXT NOT NULL,
	new_source_ref    TEXT,
	new_happened_at   TEXT,
	new_extra_json    TEXT,
	relation_type     TEXT NOT NULL DEFAULT 'supersede',
	source_ref        TEXT,
	created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_memory_replacements_old_item
	ON memory_replacements (old_item_id, created_at);
`;

function nowIso(): string {
	return new Date().toISOString();
}

/** Whitespace-collapsed, lowercased content hash (same normalization as akashic). */
export function contentHash(summary: string, memoryType: string): string {
	const text = `${summary.toLowerCase().replace(/\s+/g, " ").trim()}${memoryType}`;
	return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

function generateItemId(chash: string): string {
	return createHash("md5").update(`${chash}${Date.now()}`).digest("hex").slice(0, 12);
}

export function coerceEmotionalWeight(value: unknown): number {
	if (typeof value !== "number") return 0;
	if (!Number.isFinite(value)) return 0;
	return Math.max(0, Math.min(10, Math.trunc(value)));
}

export function coerceFloat(value: unknown, fallback = 0): number {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const parsed = Number.parseFloat(value);
		return Number.isFinite(parsed) ? parsed : fallback;
	}
	return fallback;
}

export function coerceInt(value: unknown, fallback = 0): number {
	if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
	if (typeof value === "string") {
		const parsed = Number.parseInt(value, 10);
		return Number.isFinite(parsed) ? parsed : fallback;
	}
	return fallback;
}

function parseEmbedding(raw: unknown): number[] | null {
	if (raw === null || raw === undefined) return null;
	if (typeof raw !== "string") return null;
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed)) return null;
		return parsed.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
	} catch {
		return null;
	}
}

function stringifyEmbedding(embedding: number[] | null | undefined): string | null {
	if (!embedding || embedding.length === 0) return null;
	return JSON.stringify(embedding);
}

export function cosineSimilarity(a: number[], b: number[]): number {
	const length = Math.min(a.length, b.length);
	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (let i = 0; i < length; i++) {
		const av = a[i] ?? 0;
		const bv = b[i] ?? 0;
		dot += av * bv;
		normA += av * av;
		normB += bv * bv;
	}
	if (normA === 0 || normB === 0) return 0;
	return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** L2-normalize a vector (unit vectors make L2 distance rank equal cosine). */
export function normalizeVector(embedding: number[]): number[] {
	let norm = 0;
	for (const value of embedding) norm += value * value;
	norm = Math.sqrt(norm);
	if (norm < 1e-9) return embedding;
	return embedding.map((value) => value / norm);
}

function l2DistanceToCosine(distance: number): number {
	// |a-b|^2 = 2(1-cos) on the unit sphere -> cos = 1 - d^2/2
	return Math.max(-1, Math.min(1, 1 - (distance * distance) / 2));
}

/**
 * Hotness score in (0, 1): reinforcement frequency x exponential recency
 * decay. Emotional weight extends the half-life by up to 50%.
 */
export function hotnessScore(
	reinforcement: number,
	updatedAtIso: string,
	now: Date = new Date(),
	halfLifeDays = 14,
	emotionalWeight = 0,
): number {
	const updated = Date.parse(updatedAtIso);
	if (Number.isNaN(updated)) return 0;
	const freq = 1 / (1 + Math.exp(-Math.log1p(Math.max(0, reinforcement))));
	const effectiveHalfLife = Math.max(halfLifeDays * (1 + (0.5 * coerceEmotionalWeight(emotionalWeight)) / 10), 0.1);
	const ageDays = Math.max((now.getTime() - updated) / 86_400_000, 0);
	const recency = Math.exp((-Math.log(2) / effectiveHalfLife) * ageDays);
	return freq * recency;
}

/** Normalize a happened_at value to "YYYY-MM-DDTHH:mm:ss" when parseable. */
export function normalizeHappenedAt(raw: string | null | undefined): string | null {
	if (!raw) return null;
	const text = String(raw).trim();
	if (!text) return null;
	const parsed = Date.parse(text);
	if (Number.isNaN(parsed)) return text;
	const date = new Date(parsed);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function isoRangeStart(date: Date | undefined): string | null {
	if (!date) return null;
	return normalizeHappenedAt(date.toISOString());
}

export class MemoryStore {
	private readonly db: SqliteDatabase;
	private readonly vecDim: number;
	private vecEnabled = false;
	private vecInitError: string | null = null;

	constructor(dbPath: string, options: MemoryStoreOptions = {}) {
		mkdirSync(dirname(dbPath), { recursive: true });
		this.db = createSqliteDatabase(dbPath);
		this.db.exec("PRAGMA journal_mode=WAL");
		this.db.exec("PRAGMA busy_timeout=5000");
		this.db.exec(SCHEMA);
		this.vecDim = options.vecDim ?? DEFAULT_VEC_DIM;

		const extensionPath = options.extensionPath;
		if (extensionPath) {
			try {
				this.db.loadExtension(extensionPath);
				this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_items USING vec0(embedding float[${this.vecDim}])`);
				this.vecEnabled = true;
			} catch (error) {
				this.vecEnabled = false;
				this.vecInitError = error instanceof Error ? error.message : String(error);
			}
		} else {
			this.vecInitError = "no sqlite-vec extension path provided";
		}
	}

	close(): void {
		this.db.close();
	}

	isVectorEnabled(): boolean {
		return this.vecEnabled;
	}

	vectorInitError(): string | null {
		return this.vecInitError;
	}

	// ------------------------------------------------------------------
	// Writes
	// ------------------------------------------------------------------

	/** Write or reinforce one memory. Returns "new:<id>" or "reinforced:<id>". */
	upsertItem(options: {
		memoryType: MemoryType;
		summary: string;
		embedding?: number[] | null;
		sourceRef?: string;
		extra?: Record<string, unknown>;
		happenedAt?: string;
		emotionalWeight?: number;
		scope?: MemoryScope;
	}): string {
		const summary = options.summary.trim();
		if (!summary) throw new Error("memory summary must not be empty");
		const memoryType = options.memoryType;
		const chash = contentHash(summary, memoryType);
		const emotionalWeight = coerceEmotionalWeight(options.emotionalWeight);
		const normalizedHappenedAt = normalizeHappenedAt(options.happenedAt);
		const embedding = options.embedding && options.embedding.length > 0 ? normalizeVector(options.embedding) : null;
		const scope = options.scope ?? { channel: "", chatId: "" };

		const existing = this.db
			.prepare("SELECT id, status FROM memory_items WHERE content_hash = ? AND memory_type = ?")
			.get(chash, memoryType) as { id: string; status: string } | undefined;
		if (existing) {
			const isSuperseded = existing.status === "superseded";
			this.db
				.prepare(
					`UPDATE memory_items
					 SET status = 'active', reinforcement = reinforcement + 1, updated_at = ?,
					     emotional_weight = MAX(emotional_weight, ?),
					     embedding = COALESCE(?, embedding)
					 WHERE id = ?`,
				)
				.run(nowIso(), emotionalWeight, stringifyEmbedding(embedding), existing.id);
			if (isSuperseded && embedding) {
				const row = this.db.prepare("SELECT rowid FROM memory_items WHERE id = ?").get(existing.id) as
					| { rowid: number }
					| undefined;
				if (row) this.syncVecRow(row.rowid, embedding);
			}
			return `reinforced:${existing.id}`;
		}

		const itemId = generateItemId(chash);
		const result = this.db
			.prepare(
				`INSERT INTO memory_items
				 (id, memory_type, summary, content_hash, embedding, reinforcement, emotional_weight,
				  extra_json, source_ref, happened_at, status, scope_channel, scope_chat_id, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
			)
			.run(
				itemId,
				memoryType,
				summary,
				chash,
				stringifyEmbedding(embedding),
				emotionalWeight,
				options.extra ? JSON.stringify(options.extra) : null,
				options.sourceRef?.trim() || null,
				normalizedHappenedAt,
				scope.channel,
				scope.chatId,
				nowIso(),
				nowIso(),
			);
		const rowId = result.lastInsertRowid;
		if (embedding && typeof rowId === "number") {
			this.syncVecRow(rowId, embedding);
		}
		return `new:${itemId}`;
	}

	/** Record one consolidation event (source_ref dedup). Returns the write result string. */
	upsertConsolidationEvent(options: {
		sourceRef: string;
		summary: string;
		embedding?: number[] | null;
		extra?: Record<string, unknown>;
		happenedAt?: string;
		emotionalWeight?: number;
		scope?: MemoryScope;
	}): string {
		const sourceRef = options.sourceRef.trim();
		if (!sourceRef) throw new Error("consolidation event requires a source_ref");
		if (this.hasConsolidationSourceRef(sourceRef)) {
			return `skipped:${sourceRef}`;
		}
		const result = this.upsertItem({
			memoryType: "event",
			summary: options.summary,
			embedding: options.embedding,
			sourceRef,
			extra: options.extra,
			happenedAt: options.happenedAt,
			emotionalWeight: options.emotionalWeight,
			scope: options.scope,
		});
		const itemId = result.startsWith("reinforced:")
			? result.slice("reinforced:".length)
			: result.slice("new:".length);
		this.db
			.prepare("INSERT OR REPLACE INTO consolidation_events (source_ref, item_id, created_at) VALUES (?, ?, ?)")
			.run(sourceRef, itemId, nowIso());
		return result;
	}

	hasConsolidationSourceRef(sourceRef: string): boolean {
		const row = this.db.prepare("SELECT 1 AS found FROM consolidation_events WHERE source_ref = ?").get(sourceRef) as
			| { found: number }
			| undefined;
		return row !== undefined;
	}

	/** Retire items (supersede) and log the replacements. */
	markSupersededBatch(ids: readonly string[], sourceRef?: string): number {
		let count = 0;
		const select = this.db.prepare(
			"SELECT id, memory_type, summary, source_ref, happened_at, extra_json FROM memory_items WHERE id = ? AND status = 'active'",
		);
		const update = this.db.prepare(
			"UPDATE memory_items SET status = 'superseded', updated_at = ? WHERE id = ? AND status = 'active'",
		);
		const log = this.db.prepare(
			`INSERT INTO memory_replacements
			 (old_item_id, old_memory_type, old_summary, old_source_ref, old_happened_at, old_extra_json,
			  new_item_id, new_memory_type, new_summary, new_source_ref, new_happened_at, new_extra_json,
			  relation_type, source_ref, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'supersede', ?, ?)`,
		);
		for (const id of ids) {
			const row = select.get(id) as
				| {
						id: string;
						memory_type: string;
						summary: string;
						source_ref: string | null;
						happened_at: string | null;
						extra_json: string | null;
				  }
				| undefined;
			if (!row) continue;
			update.run(nowIso(), id);
			log.run(
				row.id,
				row.memory_type,
				row.summary,
				row.source_ref,
				row.happened_at,
				row.extra_json,
				"",
				"",
				"",
				"",
				"",
				"",
				sourceRef?.trim() || null,
				nowIso(),
			);
			count++;
		}
		return count;
	}

	/** Soft-delete (forget) items; superseded rows stay queryable via replacements log. */
	deleteItems(ids: readonly string[]): { affected: string[]; missing: string[] } {
		const affected: string[] = [];
		const missing: string[] = [];
		for (const id of ids) {
			const row = this.db.prepare("SELECT id FROM memory_items WHERE id = ? AND status = 'active'").get(id) as
				| { id: string }
				| undefined;
			if (!row) {
				missing.push(id);
				continue;
			}
			this.markSupersededBatch([id]);
			affected.push(id);
		}
		return { affected, missing };
	}

	reinforceItemsBatch(ids: readonly string[], emotionalWeight = 0): number {
		let count = 0;
		const update = this.db.prepare(
			"UPDATE memory_items SET reinforcement = reinforcement + 1, emotional_weight = MAX(emotional_weight, ?), updated_at = ? WHERE id = ? AND status = 'active'",
		);
		for (const id of ids) {
			const result = update.run(coerceEmotionalWeight(emotionalWeight), nowIso(), id);
			count += Number(result.changes);
		}
		return count;
	}

	getItemMergeMetadata(itemId: string): { memoryType: MemoryType; extra: Record<string, unknown> } {
		const row = this.db.prepare("SELECT memory_type, extra_json FROM memory_items WHERE id = ?").get(itemId) as
			| { memory_type: string; extra_json: string | null }
			| undefined;
		if (!row) throw new Error(`memory item not found: ${itemId}`);
		let extra: Record<string, unknown> = {};
		if (row.extra_json) {
			try {
				const parsed = JSON.parse(row.extra_json) as unknown;
				if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
					extra = parsed as Record<string, unknown>;
				}
			} catch {
				// Corrupt extra_json is replaced by the merge.
			}
		}
		return { memoryType: row.memory_type as MemoryType, extra };
	}

	/** Merge summary/embedding/metadata into one item and re-embed its vector row. */
	mergeItemRaw(options: {
		itemId: string;
		newSummary: string;
		newEmbedding?: number[] | null;
		extraPatch?: Record<string, unknown>;
	}): void {
		const { itemId, newSummary } = options;
		if (!newSummary.trim() || !itemId) {
			throw new Error("mergeItemRaw requires a non-empty item_id and summary");
		}
		const existing = this.getItemMergeMetadata(itemId);
		const mergedExtra = { ...existing.extra, ...(options.extraPatch ?? {}), _merge_note: newSummary.trim() };
		const embedding =
			options.newEmbedding && options.newEmbedding.length > 0 ? normalizeVector(options.newEmbedding) : null;
		const result = this.db
			.prepare(
				`UPDATE memory_items
				 SET summary = ?, embedding = COALESCE(?, embedding), extra_json = ?, updated_at = ?
				 WHERE id = ?`,
			)
			.run(
				newSummary.trim(),
				stringifyEmbedding(embedding),
				Object.keys(mergedExtra).length > 0 ? JSON.stringify(mergedExtra) : null,
				nowIso(),
				itemId,
			);
		if (Number(result.changes) === 0) {
			throw new Error(`memory item not found: ${itemId}`);
		}
		if (embedding) {
			const row = this.db.prepare("SELECT rowid FROM memory_items WHERE id = ?").get(itemId) as
				| { rowid: number }
				| undefined;
			if (row) this.syncVecRow(row.rowid, embedding);
		}
	}

	getItem(itemId: string): MemoryHit | undefined {
		const row = this.db
			.prepare(
				`SELECT id, memory_type, summary, source_ref, happened_at, extra_json, status
				 FROM memory_items WHERE id = ?`,
			)
			.get(itemId) as
			| {
					id: string;
					memory_type: string;
					summary: string;
					source_ref: string | null;
					happened_at: string | null;
					extra_json: string | null;
					status: string;
			  }
			| undefined;
		if (!row) return undefined;
		return this.rowToHit(row, { score: 0, status: row.status });
	}

	// ------------------------------------------------------------------
	// Retrieval
	// ------------------------------------------------------------------

	/**
	 * Cosine-similarity search with optional hotness blend:
	 * final = (1 - alpha) * semantic + alpha * hotness.
	 */
	vectorSearch(queryVec: number[], options: MemoryStoreSearchOptions = {}): MemoryHit[] {
		const hasTimeFilter = options.timeStart !== undefined || options.timeEnd !== undefined;
		if (hasTimeFilter || !this.vecEnabled) {
			return this.vectorSearchFullscan(queryVec, options);
		}
		return this.vectorSearchVec(queryVec, options);
	}

	/** Batch vector search; one result list per query vector (used by multi-lane retrieval). */
	vectorSearchBatch(queryVecs: readonly number[][], options: MemoryStoreSearchOptions = {}): MemoryHit[][] {
		return queryVecs.map((vector) => this.vectorSearch(vector, options));
	}

	private vectorSearchVec(queryVec: number[], options: MemoryStoreSearchOptions): MemoryHit[] {
		const topK = options.topK ?? 8;
		const threshold = options.scoreThreshold ?? 0;
		const alpha = options.hotnessAlpha ?? 0;
		const halfLife = options.hotnessHalfLifeDays ?? 14;
		const normalized = normalizeVector(queryVec);

		const clauses: string[] = [];
		const params: (string | number)[] = [];
		if (!options.includeSuperseded) {
			clauses.push("mi.status = 'active'");
		}
		if (options.memoryTypes && options.memoryTypes.length > 0) {
			clauses.push(`mi.memory_type IN (${options.memoryTypes.map(() => "?").join(", ")})`);
			params.push(...options.memoryTypes);
		}
		if (options.requireScopeMatch) {
			const scope = options.scope ?? { channel: "", chatId: "" };
			clauses.push("mi.scope_channel = ?");
			clauses.push("mi.scope_chat_id = ?");
			params.push(scope.channel, scope.chatId);
		}
		const where = clauses.join(" AND ");
		const rows = this.db
			.prepare(
				`SELECT mi.id, mi.memory_type, mi.summary, mi.source_ref, mi.happened_at, mi.extra_json,
				        mi.reinforcement, mi.emotional_weight, mi.updated_at, v.distance
				 FROM (SELECT rowid, distance FROM vec_items WHERE embedding MATCH ? ORDER BY distance LIMIT ?) AS v
				 JOIN memory_items mi ON mi.rowid = v.rowid
				 WHERE ${where}
				 ORDER BY v.distance ASC`,
			)
			.all(new Float32Array(normalized), Math.max(topK * 4, 50), ...params) as Array<{
			rowid: number;
			distance: number;
			id: string;
			memory_type: string;
			summary: string;
			source_ref: string | null;
			happened_at: string | null;
			extra_json: string | null;
			reinforcement: number;
			emotional_weight: number;
			updated_at: string;
		}>;

		const hits: MemoryHit[] = [];
		for (const row of rows) {
			const semantic = l2DistanceToCosine(Number(row.distance));
			const hotness = hotnessScore(
				Number(row.reinforcement),
				String(row.updated_at),
				new Date(),
				halfLife,
				Number(row.emotional_weight),
			);
			const score = alpha > 0 ? (1 - alpha) * semantic + alpha * hotness : semantic;
			if (score < threshold) continue;
			hits.push(this.rowToHit(row, { score, status: "active" }));
		}
		hits.sort((a, b) => b.score - a.score);
		return hits.slice(0, topK);
	}

	private vectorSearchFullscan(queryVec: number[], options: MemoryStoreSearchOptions): MemoryHit[] {
		const topK = options.topK ?? 8;
		const threshold = options.scoreThreshold ?? 0;
		const alpha = options.hotnessAlpha ?? 0;
		const halfLife = options.hotnessHalfLifeDays ?? 14;
		const normalized = normalizeVector(queryVec);

		const clauses: string[] = ["status = 'active'"];
		const params: (string | number)[] = [];
		if (options.memoryTypes && options.memoryTypes.length > 0) {
			clauses.push(`memory_type IN (${options.memoryTypes.map(() => "?").join(", ")})`);
			params.push(...options.memoryTypes);
		}
		if (options.requireScopeMatch) {
			const scope = options.scope ?? { channel: "", chatId: "" };
			clauses.push("scope_channel = ?");
			clauses.push("scope_chat_id = ?");
			params.push(scope.channel, scope.chatId);
		}
		const where = clauses.join(" AND ");
		const rows = this.db
			.prepare(
				`SELECT id, memory_type, summary, source_ref, happened_at, extra_json, reinforcement,
				        emotional_weight, updated_at, embedding
				 FROM memory_items
				 WHERE ${where}
				 ORDER BY updated_at DESC
				 LIMIT ?`,
			)
			.all(...params, VEC_FALLBACK_SAMPLE_LIMIT) as Array<{
			id: string;
			memory_type: string;
			summary: string;
			source_ref: string | null;
			happened_at: string | null;
			extra_json: string | null;
			reinforcement: number;
			emotional_weight: number;
			updated_at: string;
			embedding: string | null;
		}>;

		const hits: MemoryHit[] = [];
		for (const row of rows) {
			const embedding = parseEmbedding(row.embedding);
			if (!embedding) continue;
			const semantic = cosineSimilarity(normalized, embedding);
			const hotness = hotnessScore(
				Number(row.reinforcement),
				String(row.updated_at),
				new Date(),
				halfLife,
				Number(row.emotional_weight),
			);
			const score = alpha > 0 ? (1 - alpha) * semantic + alpha * hotness : semantic;
			if (score < threshold) continue;
			hits.push(this.rowToHit(row, { score, status: "active" }));
		}
		hits.sort((a, b) => b.score - a.score);
		return hits.slice(0, topK);
	}

	/**
	 * OR-LIKE keyword search over summaries; keyword_score = hit terms / total
	 * terms so it can be fused with the vector lane via RRF.
	 */
	keywordSearchSummary(terms: readonly string[], options: MemoryStoreSearchOptions = {}): MemoryHit[] {
		const cleanTerms = [...new Set(terms.filter((term) => term && term.length >= 2))];
		if (cleanTerms.length === 0) return [];
		const limit = options.topK ?? 20;

		const likeVals = cleanTerms.map((term) => `%${term}%`);
		const orConditions = cleanTerms.map(() => "summary LIKE ?").join(" OR ");
		const scoreExpr = cleanTerms.map(() => "(CASE WHEN summary LIKE ? THEN 1 ELSE 0 END)").join(" + ");

		const clauses: string[] = ["status = 'active'"];
		const params: (string | number)[] = [];
		if (options.memoryTypes && options.memoryTypes.length > 0) {
			clauses.push(`memory_type IN (${options.memoryTypes.map(() => "?").join(", ")})`);
			params.push(...options.memoryTypes);
		}
		if (options.requireScopeMatch) {
			const scope = options.scope ?? { channel: "", chatId: "" };
			clauses.push("scope_channel = ?");
			clauses.push("scope_chat_id = ?");
			params.push(scope.channel, scope.chatId);
		}
		if (options.timeStart || options.timeEnd) {
			clauses.push("happened_at IS NOT NULL");
			clauses.push("TRIM(happened_at) != ''");
			const start = isoRangeStart(options.timeStart);
			const end = isoRangeStart(options.timeEnd);
			if (start) {
				clauses.push("happened_at >= ?");
				params.push(start);
			}
			if (end) {
				clauses.push("happened_at < ?");
				params.push(end);
			}
		}
		const where = clauses.join(" AND ");

		const rows = this.db
			.prepare(
				`SELECT id, memory_type, summary, source_ref, happened_at, extra_json, reinforcement,
				        emotional_weight, updated_at, (${scoreExpr}) AS kw_score
				 FROM memory_items
				 WHERE ${where} AND (${orConditions})
				 ORDER BY kw_score DESC, reinforcement DESC, id ASC
				 LIMIT ?`,
			)
			.all(...likeVals, ...likeVals, ...params, Math.max(limit, 100)) as Array<{
			id: string;
			memory_type: string;
			summary: string;
			source_ref: string | null;
			happened_at: string | null;
			extra_json: string | null;
			reinforcement: number;
			emotional_weight: number;
			updated_at: string;
			kw_score: number;
		}>;

		const hits: MemoryHit[] = [];
		for (const row of rows) {
			const keywordScore = coerceFloat(row.kw_score, 0) / cleanTerms.length;
			const hit = this.rowToHit(row, { score: keywordScore, status: "active" });
			hit.keywordScore = keywordScore;
			hits.push(hit);
		}
		return hits.slice(0, limit);
	}

	/** Recent semantically-similar events (used for consolidation dedup). */
	findSimilarRecentEvents(queryVec: number[], threshold: number, daysBack = 7): string[] {
		const since = new Date(Date.now() - daysBack * 86_400_000);
		const hits = this.vectorSearch(queryVec, {
			memoryTypes: ["event"],
			scoreThreshold: threshold,
			topK: 5,
			timeStart: since,
		});
		return hits.map((hit) => hit.id);
	}

	// ------------------------------------------------------------------
	// Vec mirror helpers
	// ------------------------------------------------------------------

	private syncVecRow(rowId: number, embedding: number[]): void {
		if (!this.vecEnabled) return;
		try {
			this.db
				.prepare("INSERT OR REPLACE INTO vec_items (rowid, embedding) VALUES (?, ?)")
				.run(BigInt(rowId), new Float32Array(normalizeVector(embedding)));
		} catch {
			// Vector mirror failure degrades to full-scan retrieval.
		}
	}

	private rowToHit(
		row: {
			id: string;
			memory_type: string;
			summary: string;
			source_ref: string | null;
			happened_at: string | null;
			extra_json: string | null;
		},
		extraFields: { score: number; status: string },
	): MemoryHit {
		let extra: Record<string, unknown> | undefined;
		if (row.extra_json) {
			try {
				const parsed = JSON.parse(row.extra_json) as unknown;
				if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
					extra = parsed as Record<string, unknown>;
				}
			} catch {
				extra = undefined;
			}
		}
		return {
			id: row.id,
			memoryType: row.memory_type as MemoryType,
			summary: row.summary,
			sourceRef: row.source_ref ?? "",
			happenedAt: row.happened_at,
			score: extraFields.score,
			...(extra ? { extra } : {}),
		};
	}
}
