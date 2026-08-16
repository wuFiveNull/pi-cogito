import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
	type CredentialStore,
	createEmbeddingsProvider,
	type EmbeddingModel,
	type EmbeddingsApi,
	envApiKeyAuth,
	type MutableEmbeddingsModels,
} from "@cogito/ai";
import { siliconflowEmbeddingsApi } from "@cogito/ai/api/siliconflow-embeddings.lazy";
import { builtinEmbeddingsModels } from "@cogito/ai/providers/embeddings/all";
import { createNodeSqliteFactory, type SqliteDatabaseFactory } from "@cogito/storage-sqlite-node";
import { getLoadablePath } from "sqlite-vec";
import { AuthStorage } from "../auth-storage.ts";
import { ModelConfig, type ModelsJsonEmbeddingModel } from "../model-config.ts";
import { type JsonlIndexHit, JsonlSessionIndexer, type TextEmbedder } from "./jsonl-indexer.ts";

export interface SessionIndexSetupOptions {
	/** Agent config directory (e.g. ~/.pi/agent). */
	agentDir: string;
	/** Credential store for embedding API keys. Defaults to auth.json in agentDir. */
	credentials?: CredentialStore;
	/** Parsed models.json. Defaults to loading it from agentDir. */
	modelConfig?: ModelConfig;
	/** SQLite backend. Defaults to node:sqlite. */
	sqlite?: SqliteDatabaseFactory;
	/** Path to the sqlite-vec native extension. Defaults to the sqlite-vec package's binary. */
	extensionPath?: string;
}

export interface SessionEmbedderResult {
	embedder: TextEmbedder;
	dimensions: number;
	extensionPath: string;
	embeddingModel: EmbeddingModel<EmbeddingsApi>;
}

/**
 * Build the shared embeddings wiring (models.json + auth.json + sqlite-vec
 * path) used by the session indexer and the memory engine.
 */
export async function createSessionEmbedder(options: {
	agentDir: string;
	credentials?: CredentialStore;
	modelConfig?: ModelConfig;
	extensionPath?: string;
}): Promise<SessionEmbedderResult | undefined> {
	const credentials = options.credentials ?? AuthStorage.create(resolve(options.agentDir, "auth.json"));
	const modelConfig = options.modelConfig ?? (await ModelConfig.load(resolve(options.agentDir, "models.json")));
	const models = builtinEmbeddingsModels({ credentials });

	applyCustomEmbeddingModels(models, modelConfig);

	const embeddingModel = pickEmbeddingModel(models);
	if (!embeddingModel) return undefined;
	try {
		const extensionPath = options.extensionPath ?? getLoadablePath();
		return {
			embedder: createTextEmbedder(models, embeddingModel),
			dimensions: embeddingModel.dimensions,
			extensionPath,
			embeddingModel,
		};
	} catch {
		return undefined;
	}
}

export interface SessionSearchOptions {
	/** "keyword" (FTS5 bm25) or "vector" (embedding KNN). Default: "keyword". */
	mode?: "keyword" | "vector";
	cwd?: string;
	limit?: number;
}

/** Session-level keyword/vector search over the sqlite index. */
export class SessionIndexSearcher {
	private readonly indexer: JsonlSessionIndexer;

	constructor(indexer: JsonlSessionIndexer) {
		this.indexer = indexer;
	}

	/** Entry-level search results with raw scores (bm25 / cosine distance). */
	async searchHits(query: string, options: SessionSearchOptions = {}): Promise<JsonlIndexHit[]> {
		if (options.mode === "vector") {
			const vector = await this.indexer.embedQuery(query);
			if (!vector) return [];
			return this.indexer.search({ vector, cwd: options.cwd, limit: options.limit });
		}
		return this.indexer.search({ text: query, cwd: options.cwd, limit: options.limit });
	}

	/**
	 * Search sessions by query text. Returns a map of sessionId to score
	 * (lower is better) for the best-matching entry per session, or undefined
	 * when the index is unavailable.
	 */
	async search(query: string, limit = 30): Promise<Map<string, number> | undefined> {
		try {
			const hits = await this.indexer.search({ text: query, limit: limit * 4 });
			const scores = new Map<string, number>();
			for (const hit of hits) {
				const score = hit.score ?? 0;
				const current = scores.get(hit.sessionId);
				if (current === undefined || score < current) scores.set(hit.sessionId, score);
			}
			return scores;
		} catch {
			return undefined;
		}
	}

	async dispose(): Promise<void> {
		await this.indexer[Symbol.asyncDispose]();
	}
}

export interface SessionIndexerResult {
	indexer: JsonlSessionIndexer;
	searcher: SessionIndexSearcher;
	/** The embedding model in use, when vector search is enabled. */
	embeddingModel?: EmbeddingModel<EmbeddingsApi>;
}

const sharedIndexerPromises = new Map<string, Promise<SessionIndexerResult | undefined>>();

/**
 * Process-wide shared indexer for one agent dir. All consumers (session
 * selector, ctx.searchSessions) use the same instance so dual-writes and
 * reads serialize on one writer connection.
 */
export function getSharedSessionIndexer(agentDir: string): Promise<SessionIndexerResult | undefined> {
	const key = resolve(agentDir);
	if (!sharedIndexerPromises.has(key)) {
		sharedIndexerPromises.set(
			key,
			createSessionIndexer({ agentDir }).catch(() => undefined),
		);
	}
	return sharedIndexerPromises.get(key)!;
}

/** Build the session indexer for an agent dir, wiring models.json + auth.json into the embedder. */
export async function createSessionIndexer(options: SessionIndexSetupOptions): Promise<SessionIndexerResult> {
	const vector = await createSessionEmbedder({
		agentDir: options.agentDir,
		credentials: options.credentials,
		modelConfig: options.modelConfig,
		extensionPath: options.extensionPath,
	});
	const indexerVector = vector
		? {
				embedder: vector.embedder,
				dimensions: vector.dimensions,
				extensionPath: vector.extensionPath,
				version: "2",
			}
		: undefined;

	const fs = {
		absolutePath: async (path: string) => resolve(path),
		createDir: async (path: string) => {
			mkdirSync(path, { recursive: true });
		},
		listDir: async (path: string) => readdirSync(path),
		readTextFile: async (path: string) => readFileSync(path, "utf-8"),
		stat: async (path: string) => {
			const stat = statSync(path);
			return { mtimeMs: stat.mtimeMs, size: stat.size };
		},
	};

	const indexer = new JsonlSessionIndexer({
		sqlite: options.sqlite ?? createNodeSqliteFactory(),
		databasePath: resolve(options.agentDir, "sessions-index", "sessions.sqlite"),
		sessionsDir: resolve(options.agentDir, "sessions"),
		vector: indexerVector,
		fs,
	});
	return {
		indexer,
		searcher: new SessionIndexSearcher(indexer),
		...(vector ? { embeddingModel: vector.embeddingModel } : {}),
	};
}

function createTextEmbedder(models: MutableEmbeddingsModels, model: EmbeddingModel<EmbeddingsApi>): TextEmbedder {
	// Character cap: bge-m3 accepts 8192 tokens. 1 char/token is the worst case
	// for Chinese; English is ~4 chars/token, so this is conservative and safe.
	const charLimit = model.maxInputTokens ?? 8192;
	return {
		embed: async (texts) => {
			const input = texts.map((text) => (text.length > charLimit ? text.slice(0, charLimit) : text));
			const result = await models.embedTexts(model, { input }, { timeoutMs: 60_000, maxRetries: 2 });
			if (result.stopReason !== "stop") {
				throw new Error(result.errorMessage ?? "Embedding request failed");
			}
			return result.embeddings;
		},
	};
}

/** First available model: custom models.json models win over built-ins. */
function pickEmbeddingModel(models: MutableEmbeddingsModels): EmbeddingModel<EmbeddingsApi> | undefined {
	for (const provider of models.getProviders()) {
		const model = provider.getModels()[0];
		if (model) return model;
	}
	return undefined;
}

/**
 * Register models.json `embeddingModels` as providers, replacing built-ins
 * with the same provider id. Only the built-in `siliconflow-embeddings` api
 * is wired for now; other apis are skipped.
 */
function applyCustomEmbeddingModels(models: MutableEmbeddingsModels, modelConfig: ModelConfig): void {
	for (const providerId of modelConfig.getProviderIds()) {
		const definitions = modelConfig.getEmbeddingModels(providerId);
		if (!definitions?.length) continue;
		const supported = definitions.filter(
			(definition) => definition.api === undefined || definition.api === "siliconflow-embeddings",
		);
		if (supported.length === 0) continue;

		const builtin = models.getProvider(providerId);
		const defaultBaseUrl = builtin?.getModels()[0]?.baseUrl;
		const embeddingModels = supported.map((definition: ModelsJsonEmbeddingModel) =>
			modelConfig.toEmbeddingModel(providerId, definition, { baseUrl: defaultBaseUrl }),
		);
		models.setProvider(
			createEmbeddingsProvider({
				id: providerId,
				name: builtin?.name ?? providerId,
				auth: builtin?.auth ?? { apiKey: envApiKeyAuth(`${providerId} API key`, []) },
				models: embeddingModels,
				api: siliconflowEmbeddingsApi(),
			}),
		);
	}
}
