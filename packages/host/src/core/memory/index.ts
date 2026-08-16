/**
 * Memory engine factory (akashic memory2 design).
 *
 * Wires the dedicated SQLite store, the fusion retriever and the
 * supersede-aware memorizer around the shared embeddings wiring
 * (models.json + auth.json + sqlite-vec).
 */

import { join } from "node:path";

import { createSessionEmbedder } from "../session-index/setup.ts";
import { Memorizer } from "./memorizer.ts";
import { Retriever } from "./retriever.ts";
import { MemoryStore } from "./store.ts";
import type { TextEmbedder } from "./types.ts";

export interface MemoryEngineOptions {
	/** Agent config directory (e.g. ~/.pi/agent). */
	agentDir: string;
	/** Database path. Defaults to agentDir/memory/memory.sqlite. */
	dbPath?: string;
	/** Optional embedder override (tests, local deterministic embedders). */
	embedder?: TextEmbedder;
	/** Vector dimensionality. Defaults to 1024. */
	vecDim?: number;
}

export interface MemoryEngine {
	store: MemoryStore;
	retriever: Retriever;
	memorizer: Memorizer;
	/** The shared embedder (undefined when no embedding model is configured). */
	embedder: TextEmbedder | undefined;
	close(): void;
}

export async function createMemoryEngine(options: MemoryEngineOptions): Promise<MemoryEngine> {
	const dbPath = options.dbPath ?? join(options.agentDir, "memory", "memory.sqlite");

	let embedder: TextEmbedder | undefined = options.embedder;
	let extensionPath: string | undefined;
	let vecDim = options.vecDim;
	if (!embedder) {
		try {
			const shared = await createSessionEmbedder({ agentDir: options.agentDir });
			if (shared) {
				embedder = shared.embedder;
				extensionPath = shared.extensionPath;
				vecDim = vecDim ?? shared.dimensions;
			}
		} catch {
			// No embeddings wiring: the engine stays keyword-only.
			embedder = undefined;
		}
	}

	const store = new MemoryStore(dbPath, { vecDim, extensionPath });
	const memorizer = new Memorizer(store, embedder);
	const retriever = new Retriever(store, embedder);
	return {
		store,
		retriever,
		memorizer,
		embedder,
		close() {
			store.close();
		},
	};
}

export { Memorizer, MemoryStore, Retriever };
export {
	extractHappenedAt,
	parseProcedureSteps,
	parseToolRequirement,
	resolveProcedureRuleSchema,
} from "./memorizer.ts";
export { extractTerms, rrfMerge } from "./retriever.ts";
export { contentHash, cosineSimilarity, hotnessScore, normalizeVector } from "./store.ts";
export type {
	MemoryHit,
	MemoryScope,
	MemoryType,
	RetrieveOptions,
	RetrieverOptions,
	SaveItemOptions,
	SaveItemWithSupersedeOptions,
	TextEmbedder,
} from "./types.ts";
export { defaultMemoryType, isMemoryType, MEMORY_TYPES } from "./types.ts";
