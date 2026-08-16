/**
 * Memory engine types (akashic memory2 design).
 *
 * Four memory kinds with distinct write/retrieval semantics:
 * - event:      one-off facts, decisions, completed work (timestamped)
 * - profile:    stable user facts (identity, status, purchase, ...)
 * - preference: user preferences and rules
 * - procedure:  multi-step workflows with optional tool requirements
 */

export type MemoryType = "event" | "profile" | "preference" | "procedure";

export const MEMORY_TYPES: readonly MemoryType[] = ["event", "profile", "preference", "procedure"];

/** Optional scope for channel/chat scoped memory (IM integrations). Empty = local default. */
export interface MemoryScope {
	channel: string;
	chatId: string;
}

export function isMemoryType(value: string): value is MemoryType {
	return MEMORY_TYPES.includes(value as MemoryType);
}

export function defaultMemoryType(value: string | undefined): MemoryType {
	return value !== undefined && isMemoryType(value) ? value : "event";
}

/** One retrieved memory candidate. */
export interface MemoryHit {
	id: string;
	memoryType: MemoryType;
	summary: string;
	sourceRef: string;
	happenedAt: string | null;
	/** Final fused score (vector similarity or keyword score). */
	score: number;
	keywordScore?: number;
	extra?: Record<string, unknown>;
	/** True when a procedure with a tool requirement was force-injected. */
	forced?: boolean;
	confidenceLabel?: string;
	rrfScore?: number;
}

/** A formatted injection block plus the ids it contains. */
export interface InjectionBlock {
	text: string;
	injectedIds: string[];
}

/** Text embedder used by the vector lane. */
export interface TextEmbedder {
	embed(texts: readonly string[]): Promise<number[][]>;
}

export interface MemoryStoreOptions {
	/** Vector dimensionality of the embedder output. Defaults to 1024. */
	vecDim?: number;
	/** Path to the sqlite-vec native extension. When absent or unloadable, vector search falls back to a full scan. */
	extensionPath?: string;
}

export interface MemoryStoreSearchOptions {
	topK?: number;
	scoreThreshold?: number;
	memoryTypes?: readonly MemoryType[];
	includeSuperseded?: boolean;
	scope?: MemoryScope;
	requireScopeMatch?: boolean;
	/** Blend factor for hotness (reinforcement x recency): final = (1-alpha)*semantic + alpha*hotness. */
	hotnessAlpha?: number;
	hotnessHalfLifeDays?: number;
	timeStart?: Date;
	timeEnd?: Date;
}

export interface RetrieverOptions {
	topK?: number;
	scoreThreshold?: number;
	scoreThresholds?: Partial<Record<MemoryType, number>>;
	injectMaxChars?: number;
	injectMaxForced?: number;
	injectMaxProcedurePreference?: number;
	injectMaxEventProfile?: number;
	procedureGuardEnabled?: boolean;
	highInjectDelta?: number;
	hotnessAlpha?: number;
	hotnessHalfLifeDays?: number;
}

export interface RetrieveOptions {
	memoryTypes?: readonly MemoryType[];
	topK?: number;
	scope?: MemoryScope;
	requireScopeMatch?: boolean;
	auxQueries?: readonly string[];
	scoreThreshold?: number;
	timeStart?: Date;
	timeEnd?: Date;
	keywordEnabled?: boolean;
}

export interface SaveItemOptions {
	summary: string;
	memoryType: MemoryType;
	extra?: Record<string, unknown>;
	sourceRef?: string;
	happenedAt?: string;
	emotionalWeight?: number;
	scope?: MemoryScope;
}

export interface SaveItemWithSupersedeOptions extends SaveItemOptions {
	/** Similarity at which explicit procedure merge targets are considered. */
	mergeThreshold?: number;
	/** Similarity at which similar older items are retired. */
	supersedeThreshold?: number;
}

export interface BehaviorUpdate {
	memoryType: MemoryType;
	summary: string;
	extra?: Record<string, unknown>;
	happenedAt?: string;
	emotionalWeight?: number;
}
