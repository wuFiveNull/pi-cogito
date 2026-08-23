/**
 * Memory engine factory registry (akashic core/memory/engine.py + plugin.py 移植)。
 *
 * The default factory wires the dedicated SQLite store, the fusion retriever
 * and the supersede-aware memorizer around the shared embeddings wiring
 * (models.json + auth.json + sqlite-vec). Additional engines can be registered
 * under a name and selected via `MemoryEngineOptions.engine`, mirroring
 * akashic's pluggable `[memory].engine`; unknown names fall back to "default".
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
	/** Engine name from the registry (akashic `[memory].engine`). Defaults to "default". */
	engine?: string;
}

export interface MemoryEngine {
	store: MemoryStore;
	retriever: Retriever;
	memorizer: Memorizer;
	/** The shared embedder (undefined when no embedding model is configured). */
	embedder: TextEmbedder | undefined;
	close(): void;
}

/** 引擎工厂:按 options 构造一个 MemoryEngine(akashic MemoryPlugin.build)。 */
export type MemoryEngineFactory = (options: MemoryEngineOptions) => Promise<MemoryEngine>;

const DEFAULT_ENGINE_NAME = "default";

const engineFactories = new Map<string, MemoryEngineFactory>();

/** 注册命名记忆引擎工厂(替换/扩展默认实现,akashic `[memory].engine` 语义)。 */
export function registerMemoryEngineFactory(name: string, factory: MemoryEngineFactory): void {
	if (!name || name === DEFAULT_ENGINE_NAME) {
		throw new Error(`memory engine name must be non-empty and not "${DEFAULT_ENGINE_NAME}"`);
	}
	engineFactories.set(name, factory);
}

/** 已注册的引擎名(不含内置 default)。 */
export function listMemoryEngineFactories(): readonly string[] {
	return [...engineFactories.keys()];
}

async function createDefaultMemoryEngine(options: MemoryEngineOptions): Promise<MemoryEngine> {
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

export async function createMemoryEngine(options: MemoryEngineOptions): Promise<MemoryEngine> {
	const name = options.engine ?? DEFAULT_ENGINE_NAME;
	const factory = engineFactories.get(name) ?? createDefaultMemoryEngine;
	return factory(options);
}

export type {
	ConsolidationBridgeEngine,
	ConsolidationBridgeOptions,
	ConsolidationBridgeResult,
	ConsolidationLlm,
} from "./consolidation-bridge.ts";
export { ConsolidationBridge } from "./consolidation-bridge.ts";
export { Memorizer, MemoryStore, Retriever };
export {
	extractHappenedAt,
	parseProcedureSteps,
	parseToolRequirement,
	resolveProcedureRuleSchema,
} from "./memorizer.ts";
export type {
	PostResponseRunOptions,
	PostResponseRunResult,
	PostResponseWorkerOptions,
	ToolChainCall,
} from "./post-response-worker.ts";
export {
	collectProtectedMemoryIds,
	PostResponseMemoryWorker,
	parseStringArray,
} from "./post-response-worker.ts";
export { extractTerms, generateHypothesis, rrfMerge } from "./retriever.ts";
export { contentHash, cosineSimilarity, hotnessScore, normalizeVector } from "./store.ts";
export type {
	MemoryHit,
	MemoryQueryIntent,
	MemoryScope,
	MemoryType,
	PostResponseLlm,
	RetrieveOptions,
	RetrieverOptions,
	SaveItemOptions,
	SaveItemWithSupersedeOptions,
	TextEmbedder,
} from "./types.ts";
export { defaultMemoryType, isMemoryType, MEMORY_TYPES } from "./types.ts";
