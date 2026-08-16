/**
 * Memory recall for the proactive judge (akashic: judge recalls user
 * preferences from the memory engine; preference_block feeds both selection
 * and message writing).
 *
 * Reads agentDir/memory/memory.sqlite (the memory engine's database) directly
 * and extracts active preference/profile/procedure rules that match the
 * candidate items. Never writes to the memory database.
 */

import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export interface RecalledPreference {
	memoryType: string;
	summary: string;
	id: string;
}

/** 批量文本嵌入(宿主注入;如 proactive 的 buildEmbeddingApi.embedBatch)。 */
export type RecallEmbeddingFn = (texts: string[]) => Promise<number[][]>;

/** Open a read-only handle on the memory engine database, if it exists. */
function openMemoryDb(memoryDbPath: string): DatabaseSync | undefined {
	if (!existsSync(memoryDbPath)) return undefined;
	try {
		const db = new DatabaseSync(memoryDbPath, { readOnly: true });
		// 表不存在(旧库/未初始化)时优雅降级。
		const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_items'").get() as
			| { name: string }
			| undefined;
		if (!row) {
			db.close();
			return undefined;
		}
		return db;
	} catch {
		return undefined;
	}
}

/**
 * Recall active preference/profile/procedure rules. When query is provided,
 * only rules whose summary contains one of its terms are returned; without a
 * query, all active rules are returned (used as the standing preference
 * block). Cap limits the block size.
 */
export function recallPreferences(memoryDbPath: string, query?: string, limit = 8): RecalledPreference[] {
	const db = openMemoryDb(memoryDbPath);
	if (!db) return [];
	try {
		const terms = extractTerms(query ?? "");
		if (terms.length > 0) {
			return queryActiveByTerms(db, terms, limit).map(toPreference);
		}
		return allActive(db, limit).map(toPreference);
	} finally {
		db.close();
	}
}

/**
 * 向量召回变体:LIKE 粗筛(候选上限 40)后用嵌入余弦相似度精排 top-k;
 * 嵌入失败(服务不可用/数量不匹配)时降级为 LIKE 结果。仅供 recall_memory 工具使用。
 */
export async function recallPreferencesRanked(
	memoryDbPath: string,
	query: string,
	limit: number,
	embeddingFn: RecallEmbeddingFn,
	options: { minScore?: number } = {},
): Promise<RecalledPreference[]> {
	const db = openMemoryDb(memoryDbPath);
	if (!db) return [];
	try {
		const terms = extractTerms(query);
		if (terms.length === 0) return [];
		const candidates = queryActiveByTerms(db, terms, 40);
		try {
			return await rankByEmbedding(query, candidates, limit, embeddingFn, options.minScore);
		} catch {
			// 嵌入失败降级为 LIKE 结果。
			return candidates.slice(0, limit).map(toPreference);
		}
	} finally {
		db.close();
	}
}

interface PreferenceRow {
	id: string;
	memory_type: string;
	summary: string;
}

function toPreference(row: PreferenceRow): RecalledPreference {
	return { id: row.id, memoryType: row.memory_type, summary: row.summary };
}

function queryActiveByTerms(db: DatabaseSync, terms: string[], limit: number): PreferenceRow[] {
	return db
		.prepare(
			`SELECT id, memory_type, summary FROM memory_items
			 WHERE status = 'active' AND memory_type IN ('preference', 'procedure', 'profile')
			   AND (${terms.map(() => "summary LIKE ?").join(" OR ")})
			 ORDER BY reinforcement DESC, updated_at DESC
			 LIMIT ?`,
		)
		.all(...terms.map((term) => `%${term}%`), limit) as unknown as PreferenceRow[];
}

function allActive(db: DatabaseSync, limit: number): PreferenceRow[] {
	return db
		.prepare(
			`SELECT id, memory_type, summary FROM memory_items
			 WHERE status = 'active' AND memory_type IN ('preference', 'procedure', 'profile')
			 ORDER BY reinforcement DESC, updated_at DESC
			 LIMIT ?`,
		)
		.all(limit) as unknown as PreferenceRow[];
}

/** 向量精排:query 与候选 summary 余弦相似度 top-k(akashic memory retriever 语义)。 */
async function rankByEmbedding(
	query: string,
	candidates: PreferenceRow[],
	limit: number,
	embeddingFn: RecallEmbeddingFn,
	minScore: number | undefined,
): Promise<RecalledPreference[]> {
	const texts = [query, ...candidates.map((candidate) => candidate.summary)];
	const vectors = await embeddingFn(texts);
	if (vectors.length !== texts.length) throw new Error("embedding count mismatch");
	const queryVec = vectors[0]!;
	const scored = candidates.map((candidate, index) => ({
		candidate,
		score: cosineSimilarity(queryVec, vectors[index + 1]!),
	}));
	scored.sort((a, b) => b.score - a.score);
	// relevance floor(akashic relevance_floor 的近似):低于阈值的召回丢弃。
	const aboveFloor = minScore === undefined ? scored : scored.filter(({ score }) => score >= minScore);
	return aboveFloor.slice(0, limit).map(({ candidate }) => toPreference(candidate));
}

function cosineSimilarity(a: number[], b: number[]): number {
	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i]! * b[i]!;
		normA += a[i]! * a[i]!;
		normB += b[i]! * b[i]!;
	}
	if (normA === 0 || normB === 0) return 0;
	return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** Format the recalled rules as the preference_block fed to the LLM. */
export function formatPreferenceBlock(preferences: RecalledPreference[]): string {
	if (preferences.length === 0) return "";
	const lines = preferences.map((p) => `- [${p.memoryType}] ${p.summary}`);
	return `## 用户偏好记录(仅用于选题与消息写作,不得用于编造内容)\n${lines.join("\n")}`;
}

/** ASCII tokens + CJK bigrams (same extraction as the memory retriever). */
function extractTerms(query: string): string[] {
	const terms: string[] = [];
	terms.push(...(query.match(/[a-zA-Z0-9_\-.]{2,}/g) ?? []));
	const cjkChunks = query.match(/[\u4e00-\u9fff\u3040-\u30ff]{2,}/g) ?? [];
	for (const chunk of cjkChunks) {
		if (chunk.length <= 4) {
			terms.push(chunk);
			continue;
		}
		for (let i = 0; i < chunk.length - 1; i++) {
			terms.push(chunk.slice(i, i + 2));
		}
	}
	return [...new Set(terms)].slice(0, 20);
}
