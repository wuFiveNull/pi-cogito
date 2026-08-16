/**
 * Memory memorizer (akashic memory2 design).
 *
 * Write path with maintenance:
 * - procedure/preference: retire similar older items above the supersede
 *   threshold; explicit procedures additionally merge into same-tool items
 * - profile (status/purchase categories): retire same-category stale facts
 * - event consolidation: source_ref dedup + semantic dedup (recent similar
 *   events are reinforced instead of duplicated)
 */

import { coerceEmotionalWeight, type MemoryStore } from "./store.ts";
import type {
	BehaviorUpdate,
	MemoryScope,
	SaveItemOptions,
	SaveItemWithSupersedeOptions,
	TextEmbedder,
} from "./types.ts";

export interface ProcedureRuleSchema {
	requiredTools: string[];
	forbiddenTools: string[];
	mentionedTools: string[];
}

const NEGATIVE_TOOL_PREFIXES = [
	"不能直接使用",
	"不能直接用",
	"不要直接使用",
	"不要直接用",
	"别直接使用",
	"别直接用",
	"不能先使用",
	"不能先用",
	"不要先使用",
	"不要先用",
	"别先使用",
	"别先用",
	"不能使用",
	"不能用",
	"不要使用",
	"不要用",
	"别使用",
	"别用",
	"禁止使用",
	"禁止用",
];

const POSITIVE_TOOL_PREFIXES = [
	"必须先使用",
	"必须先用",
	"必须使用",
	"必须用",
	"先使用",
	"先用",
	"优先使用",
	"优先用",
	"应先使用",
	"应先用",
	"应该使用",
	"应该用",
	"直接使用",
	"直接用",
];

export class Memorizer {
	private readonly store: MemoryStore;
	private readonly embedder: TextEmbedder | undefined;

	constructor(store: MemoryStore, embedder: TextEmbedder | undefined) {
		this.store = store;
		this.embedder = embedder;
	}

	/** embed -> content-hash upsert. Returns "new:<id>" or "reinforced:<id>". */
	async saveItem(options: SaveItemOptions): Promise<string> {
		validateProcedureMetadata(options.summary, options.memoryType, options.extra);
		const embedding = await this.embed(options.summary);
		return this.store.upsertItem({
			...options,
			embedding,
		});
	}

	/**
	 * Write with supersede/merge maintenance:
	 * - procedure / preference: retire items with similarity >= supersedeThreshold;
	 *   procedures additionally merge into an explicit same-tool-requirement item.
	 * - profile (status/purchase): retire same-category facts above threshold.
	 */
	async saveItemWithSupersede(options: SaveItemWithSupersedeOptions): Promise<string> {
		validateProcedureMetadata(options.summary, options.memoryType, options.extra);
		const mergeThreshold = options.mergeThreshold ?? 0.7;
		const supersedeThreshold = options.supersedeThreshold ?? 0.9;
		const embedding = await this.embed(options.summary);

		let similar: Array<{ id: string; summary: string; score: number; extra?: Record<string, unknown> }> = [];
		if (embedding) {
			similar = this.store.vectorSearch(embedding, {
				topK: 5,
				memoryTypes: [options.memoryType],
				scoreThreshold: Math.min(mergeThreshold, supersedeThreshold),
			});
		}
		if (options.memoryType === "procedure" || options.memoryType === "preference") {
			if (options.memoryType === "procedure") {
				const mergeTarget = pickExplicitMergeTarget(similar, options.extra, mergeThreshold);
				if (mergeTarget) {
					const mergedSummary = mergeSummaryText(mergeTarget.summary, options.summary);
					await this.mergeItem(mergeTarget.id, mergedSummary, options.extra);
					return `merged:${mergeTarget.id}`;
				}
			}
			const supersedeIds = similar.filter((item) => item.score >= supersedeThreshold).map((item) => item.id);
			if (supersedeIds.length > 0) {
				this.store.markSupersededBatch(supersedeIds, options.sourceRef);
			}
		} else if (options.memoryType === "profile") {
			const category = String(options.extra?.category ?? "");
			if (category === "status" || category === "purchase") {
				let similar: Array<{ id: string; score: number; extra?: Record<string, unknown> }> = [];
				if (embedding) {
					similar = this.store.vectorSearch(embedding, {
						topK: 5,
						memoryTypes: ["profile"],
						scoreThreshold: supersedeThreshold,
					});
				}
				const sameCategory: string[] = [];
				for (const item of similar) {
					const itemCategory = String(item.extra?.category ?? "");
					const threshold = coerceEmotionalWeight(item.extra?._emotional_weight) >= 7 ? 0.92 : supersedeThreshold;
					if (itemCategory === category && item.score >= threshold) {
						sameCategory.push(item.id);
					}
				}
				if (sameCategory.length > 0) {
					this.store.markSupersededBatch(sameCategory, options.sourceRef);
				}
			}
		}

		return this.store.upsertItem({
			...options,
			embedding,
		});
	}

	/**
	 * Persist one consolidation pass: the turn history entry becomes an event
	 * (source_ref + semantic dedup), behavior updates become typed items via
	 * the supersede-aware path.
	 */
	async saveFromConsolidation(options: {
		historyEntry?: string;
		behaviorUpdates?: readonly BehaviorUpdate[];
		sourceRef: string;
		scope?: MemoryScope;
		emotionalWeight?: number;
	}): Promise<{ eventStatus: string; updates: string[] }> {
		const updates: string[] = [];
		const emotionalWeight = options.emotionalWeight ?? 0;

		let eventStatus = "skipped:empty";
		const historyEntry = options.historyEntry?.trim();
		if (historyEntry) {
			if (this.store.hasConsolidationSourceRef(options.sourceRef)) {
				eventStatus = `skipped:${options.sourceRef}`;
			} else {
				const embedding = await this.embed(historyEntry);
				if (embedding && (await this.shouldSemanticDedupEvent(embedding, emotionalWeight))) {
					eventStatus = "skipped:semantic_dedup";
				} else {
					eventStatus = this.store.upsertConsolidationEvent({
						sourceRef: options.sourceRef,
						summary: historyEntry,
						embedding,
						extra: {
							scope_channel: options.scope?.channel ?? "",
							scope_chat_id: options.scope?.chatId ?? "",
						},
						happenedAt: extractHappenedAt(historyEntry) ?? undefined,
						emotionalWeight,
						scope: options.scope,
					});
				}
			}
		}

		for (const update of options.behaviorUpdates ?? []) {
			try {
				const result = await this.saveItemWithSupersede({
					summary: update.summary,
					memoryType: update.memoryType,
					extra: update.extra,
					sourceRef: options.sourceRef,
					happenedAt: update.happenedAt,
					emotionalWeight: update.emotionalWeight ?? emotionalWeight,
					scope: options.scope,
				});
				updates.push(result);
			} catch {
				// One bad behavior update must not fail the whole consolidation.
			}
		}

		return { eventStatus, updates };
	}

	/** Merge a summary and metadata patch into an existing item. */
	async mergeItem(itemId: string, mergedSummary: string, extraPatch?: Record<string, unknown>): Promise<void> {
		mergedSummary = mergedSummary.trim();
		if (!mergedSummary || !itemId) {
			throw new Error("mergeItem requires a non-empty item_id and merged summary");
		}
		const { memoryType, extra } = this.store.getItemMergeMetadata(itemId);
		const newExtra = { ...extra };
		newExtra._merge_note = mergedSummary;
		if (extraPatch) {
			if (extraPatch.tool_requirement !== undefined) {
				const toolRequirement = parseToolRequirement(extraPatch.tool_requirement);
				if (toolRequirement) newExtra.tool_requirement = toolRequirement;
			}
			if (extraPatch.steps !== undefined) {
				const incomingSteps = parseProcedureSteps(extraPatch.steps);
				if (incomingSteps.length > 0) {
					const existingSteps = parseProcedureSteps(extra.steps ?? []);
					newExtra.steps = mergeSteps(existingSteps, incomingSteps);
				}
			}
		}
		if (memoryType === "procedure") {
			newExtra.rule_schema = resolveProcedureRuleSchema(mergedSummary, newExtra);
			// Trigger tags were derived from an older summary; drop for consistency.
			delete newExtra.trigger_tags;
		}

		const newEmbedding = await this.embed(mergedSummary);
		this.store.mergeItemRaw({
			itemId,
			newSummary: mergedSummary,
			newEmbedding,
			extraPatch: newExtra,
		});
	}

	supersedeBatch(ids: readonly string[]): number {
		return this.store.markSupersededBatch(ids);
	}

	private async shouldSemanticDedupEvent(embedding: number[], emotionalWeight = 0): Promise<boolean> {
		const similarIds = this.store.findSimilarRecentEvents(embedding, 0.92, 7);
		if (similarIds.length === 0) return false;
		this.store.reinforceItemsBatch(similarIds.slice(0, 1), emotionalWeight);
		return true;
	}

	private async embed(text: string): Promise<number[] | null> {
		if (!this.embedder) return null;
		try {
			const vectors = await this.embedder.embed([text]);
			return vectors[0] ?? null;
		} catch {
			return null;
		}
	}
}

function validateProcedureMetadata(summary: string, memoryType: string, extra?: Record<string, unknown>): void {
	if (memoryType === "procedure") {
		resolveProcedureRuleSchema(summary, extra ?? {});
	}
}

// ------------------------------------------------------------------
// Procedure rule schema (compact port of akashic rule_schema.py)
// ------------------------------------------------------------------

/** Validate that a tool_requirement value is a non-empty string. */
export function parseToolRequirement(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

/** Validate procedure steps as a non-empty string array. */
export function parseProcedureSteps(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const steps: string[] = [];
	for (const raw of value) {
		if (typeof raw !== "string") continue;
		const step = raw.trim();
		if (step && !steps.includes(step)) steps.push(step);
	}
	return steps;
}

/** Build the unified rule structure for a procedure memory item. */
export function resolveProcedureRuleSchema(summary: string, extra: Record<string, unknown>): ProcedureRuleSchema {
	const toolRequirement = parseToolRequirement(extra.tool_requirement);
	const steps = parseProcedureSteps(extra.steps ?? []);
	const explicit = parseRuleSchema(extra.rule_schema);

	if (explicit) {
		return {
			requiredTools: explicit.requiredTools,
			forbiddenTools: explicit.forbiddenTools,
			mentionedTools: explicit.mentionedTools,
		};
	}

	const inferred = inferRuleConstraints(summary, steps, toolRequirement);
	return {
		requiredTools: [...inferred.required],
		forbiddenTools: [...inferred.forbidden],
		mentionedTools: [...inferred.mentioned],
	};
}

function parseRuleSchema(value: unknown): ProcedureRuleSchema | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	const requiredTools = parseSchemaList(record.required_tools);
	const forbiddenTools = parseSchemaList(record.forbidden_tools);
	const mentionedTools = parseSchemaList(record.mentioned_tools);
	if (requiredTools.length === 0 && forbiddenTools.length === 0 && mentionedTools.length === 0) return null;
	return { requiredTools, forbiddenTools, mentionedTools };
}

function parseSchemaList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function inferRuleConstraints(
	summary: string,
	steps: readonly string[],
	toolRequirement: string | null,
): { required: Set<string>; forbidden: Set<string>; mentioned: Set<string> } {
	const required = new Set<string>();
	const forbidden = new Set<string>();
	const mentioned = new Set<string>();

	const allText = [summary, toolRequirement ?? "", ...steps].filter(Boolean).join("\n");
	const asciiAliases = extractAsciiAliases(allText);

	if (toolRequirement) {
		for (const alias of asciiAliases) {
			if (NEGATIVE_TOOL_PREFIXES.some((prefix) => toolRequirement.includes(prefix))) {
				forbidden.add(alias);
			} else {
				required.add(alias);
			}
		}
	}

	for (const clause of [summary, ...steps]) {
		for (const [prefix, target] of iterAliasPrefixes(clause)) {
			if (NEGATIVE_TOOL_PREFIXES.includes(prefix)) {
				forbidden.add(target);
			} else if (POSITIVE_TOOL_PREFIXES.includes(prefix)) {
				required.add(target);
			}
		}
	}

	for (const alias of asciiAliases) {
		mentioned.add(alias);
	}
	return { required, forbidden, mentioned };
}

function extractAsciiAliases(text: string): Set<string> {
	const aliases = new Set<string>();
	for (const match of text.matchAll(/[A-Za-z][A-Za-z0-9_]*/g)) {
		const token = match[0].toLowerCase();
		if (token.length >= 2) aliases.add(token);
	}
	return aliases;
}

function iterAliasPrefixes(clause: string): Array<[string, string]> {
	const result: Array<[string, string]> = [];
	const normalized = clause.toLowerCase();
	for (const prefix of [...NEGATIVE_TOOL_PREFIXES, ...POSITIVE_TOOL_PREFIXES]) {
		const index = normalized.indexOf(prefix);
		if (index === -1) continue;
		const after = clause.slice(index + prefix.length);
		const match = after.match(/^[a-zA-Z][a-zA-Z0-9_]*/);
		if (match) result.push([prefix, match[0].toLowerCase()]);
	}
	return result;
}

function mergeSteps(existing: readonly string[], incoming: readonly string[]): string[] {
	const merged: string[] = [];
	const seen = new Set<string>();
	for (const step of [...existing, ...incoming]) {
		const text = step.trim();
		if (text && !seen.has(text)) {
			seen.add(text);
			merged.push(text);
		}
	}
	return merged;
}

function mergeSummaryText(oldSummary: string, newSummary: string): string {
	const oldText = oldSummary.trim();
	const newText = newSummary.trim();
	if (!oldText) return newText;
	if (!newText) return oldText;
	if (newText.includes(oldText)) return newText;
	if (oldText.includes(newText)) return oldText;
	return `${oldText.replace(/[。；;，,]+$/, "")}；${newText}`;
}

function pickExplicitMergeTarget(
	similar: Array<{ id: string; summary: string; score: number; extra?: Record<string, unknown> }>,
	extra: Record<string, unknown> | undefined,
	mergeThreshold: number,
): { id: string; summary: string } | null {
	const wantedTool = parseToolRequirement(extra?.tool_requirement);
	if (!wantedTool) return null;
	for (const item of similar) {
		if (item.score < mergeThreshold) continue;
		const itemTool = parseToolRequirement(item.extra?.tool_requirement);
		if (itemTool === wantedTool) {
			return { id: item.id, summary: item.summary };
		}
	}
	return null;
}

/** Parse a "[YYYY-MM-DD ...]" prefix from a history entry into happened_at. */
export function extractHappenedAt(text: string): string | null {
	const match = /^\[(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?\]/.exec(text.trim());
	if (!match) return null;
	const date = match[1]!;
	const hour = match[2] ?? "00";
	const minute = match[3] ?? "00";
	const second = match[4] ?? "00";
	return `${date}T${hour}:${minute}:${second}`;
}
