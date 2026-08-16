/**
 * Tool catalog: keyword search over the registered tool set (tool_search backend).
 *
 * Scoring semantics follow the akashic SearchBackend/KeywordSearchBackend:
 *   name parts (exact/partial/fallback) -> 10/5/3
 *   searchHint substring               -> +4
 *   description substring              -> +2
 *
 * Chinese queries are handled with char-level substring plus CJK bigrams;
 * no external tokenizer or synonym table is used. whyMatched is generated
 * independently from the score.
 */

import type { ToolDefinition } from "./extensions/types.ts";
import type { SourceInfo } from "./source-info.ts";

/** Tool catalog entry source. Normalized from SourceInfo.source. */
export type ToolCatalogSource = "builtin" | "extension" | "chat" | "sdk" | (string & {});

/** A tool document in the catalog index. */
export interface ToolCatalogEntry {
	name: string;
	label?: string;
	description: string;
	searchHint?: string;
	source: string;
}

/** A search hit with the reasons it matched. */
export interface ToolCatalogMatch {
	name: string;
	description: string;
	whyMatched: string[];
	source: string;
}

export interface ToolCatalogSearchOptions {
	/** Maximum number of results. Defaults to 8. */
	limit?: number;
	/** Tool names to exclude from results. */
	excludedNames?: ReadonlySet<string>;
}

/**
 * Map SourceInfo.source to the catalog source label:
 * builtin tools, SDK custom tools, chat inline extensions, and local extension
 * files get stable labels; anything else keeps its raw source string.
 */
export function catalogSourceFromSourceInfo(sourceInfo: SourceInfo): string {
	switch (sourceInfo.source) {
		case "builtin":
			return "builtin";
		case "sdk":
			return "sdk";
		case "inline":
			return "chat";
		case "local":
			return "extension";
		default:
			return sourceInfo.source;
	}
}

/** Build a catalog entry from a ToolDefinition and its source metadata. */
export function catalogEntryFromToolDefinition(
	definition: Pick<ToolDefinition, "name" | "label" | "description" | "searchHint">,
	sourceInfo: SourceInfo,
): ToolCatalogEntry {
	return {
		name: definition.name,
		label: definition.label,
		description: definition.description,
		...(definition.searchHint ? { searchHint: definition.searchHint } : {}),
		source: catalogSourceFromSourceInfo(sourceInfo),
	};
}

/**
 * Normalize a query into a search term set:
 * 1. whole query (lowercased, stripped)
 * 2. whitespace-split parts
 * 3. CJK / non-CJK boundary segments ("RSS订阅" -> "rss", "订阅")
 * 4. CJK bigrams plus single CJK chars
 */
export function normalizeQuery(query: string): Set<string> {
	const queryLower = query.toLowerCase().trim();
	const tokens = new Set<string>();
	tokens.add(queryLower);

	for (const part of queryLower.split(/\s+/)) {
		if (part) tokens.add(part);
	}

	for (const segment of queryLower.split(/([\u4e00-\u9fff]+)/)) {
		const trimmed = segment.trim();
		if (trimmed) tokens.add(trimmed);
	}

	const cjkChars: string[] = [];
	for (const char of queryLower) {
		if (char >= "\u4e00" && char <= "\u9fff") cjkChars.push(char);
	}
	for (let index = 0; index < cjkChars.length - 1; index++) {
		tokens.add(cjkChars[index] + cjkChars[index + 1]);
	}
	for (const char of cjkChars) tokens.add(char);

	tokens.delete("");
	return tokens;
}

/** Score one catalog entry against the query terms. */
export function scoreCatalogEntry(entry: ToolCatalogEntry, keywords: ReadonlySet<string>): number {
	const nameLower = entry.name.toLowerCase();
	const nameParts = nameLower.split("_").filter((part) => part.length > 0);
	const hintLower = (entry.searchHint ?? "").toLowerCase();
	const descLower = entry.description.toLowerCase();

	let score = 0;
	for (const keyword of keywords) {
		if (nameParts.includes(keyword)) {
			score += 10;
		} else if (nameParts.some((part) => keyword.includes(part) || part.includes(keyword))) {
			score += 5;
		} else if (nameLower.includes(keyword)) {
			score += 3;
		}

		if (hintLower.length > 0 && hintLower.includes(keyword)) score += 4;
		if (descLower.includes(keyword)) score += 2;
	}
	return score;
}

/** Generate the whyMatched explanations for a catalog entry (decoupled from scoring). */
export function explainCatalogMatch(entry: ToolCatalogEntry, keywords: ReadonlySet<string>): string[] {
	const nameLower = entry.name.toLowerCase();
	const nameParts = nameLower.split("_").filter((part) => part.length > 0);
	const hintLower = (entry.searchHint ?? "").toLowerCase();
	const descLower = entry.description.toLowerCase();

	const reasons: string[] = [];
	for (const keyword of keywords) {
		if (nameParts.includes(keyword)) {
			reasons.push(`名称精确:${keyword}`);
		} else if (nameParts.some((part) => keyword.includes(part) || part.includes(keyword))) {
			reasons.push(`名称部分:${keyword}`);
		} else if (nameLower.includes(keyword)) {
			reasons.push(`名称:${keyword}`);
		}

		if (hintLower.length > 0 && hintLower.includes(keyword)) reasons.push(`提示:${keyword}`);
		if (descLower.includes(keyword)) reasons.push(`描述:${keyword}`);
	}
	return reasons;
}

/**
 * Keyword search backend: owns the document index and implements
 * rebuild/add/remove (incremental maintenance) and scored search.
 */
export class KeywordSearchBackend {
	private documents = new Map<string, ToolCatalogEntry>();

	/** Replace the whole index with the given entries. */
	rebuild(entries: readonly ToolCatalogEntry[]): void {
		this.documents.clear();
		for (const entry of entries) {
			this.documents.set(entry.name, entry);
		}
	}

	/** Incrementally add or update one entry (dynamic registration). */
	add(entry: ToolCatalogEntry): void {
		this.documents.set(entry.name, entry);
	}

	/** Remove one entry from the index (dynamic unregistration). */
	remove(name: string): void {
		this.documents.delete(name);
	}

	has(name: string): boolean {
		return this.documents.has(name);
	}

	get(name: string): ToolCatalogEntry | undefined {
		return this.documents.get(name);
	}

	names(): Set<string> {
		return new Set(this.documents.keys());
	}

	entries(): ToolCatalogEntry[] {
		return Array.from(this.documents.values());
	}

	/**
	 * Search the catalog. Exact name matches short-circuit with a single hit;
	 * otherwise entries are scored by name parts, searchHint, and description.
	 * Results are ordered by score descending, then name ascending.
	 */
	search(query: string, options?: ToolCatalogSearchOptions): ToolCatalogMatch[] {
		const limit = options?.limit ?? 8;
		const excluded = options?.excludedNames;

		const queryStripped = query.trim();
		if (queryStripped === "") return [];

		// Fast path: exact name match skips the scoring loop.
		const exact = this.documents.get(queryStripped);
		if (exact && !excluded?.has(queryStripped)) {
			return [toCatalogMatch(exact, ["名称:精确匹配"])];
		}

		const keywords = normalizeQuery(query);
		if (keywords.size === 0) return [];

		const results: Array<{ entry: ToolCatalogEntry; score: number }> = [];
		for (const entry of this.documents.values()) {
			if (excluded?.has(entry.name)) continue;
			const score = scoreCatalogEntry(entry, keywords);
			if (score > 0) results.push({ entry, score });
		}

		results.sort((a, b) => {
			if (b.score !== a.score) return b.score - a.score;
			return a.entry.name < b.entry.name ? -1 : a.entry.name > b.entry.name ? 1 : 0;
		});

		return results
			.slice(0, Math.max(0, limit))
			.map(({ entry }) => toCatalogMatch(entry, explainCatalogMatch(entry, keywords)));
	}
}

function toCatalogMatch(entry: ToolCatalogEntry, whyMatched: string[]): ToolCatalogMatch {
	return {
		name: entry.name,
		description: entry.description,
		whyMatched,
		source: entry.source,
	};
}

/**
 * Tool catalog facade used by the host registration pipeline and tool_search.
 * Entries are maintained incrementally at the registration collection point
 * (AgentSession._refreshToolRegistry): add() on register, remove() on unregister,
 * rebuild() for full reindexing at startup.
 */
export class ToolCatalog {
	private readonly backend = new KeywordSearchBackend();

	/** Add or update one tool entry. */
	add(entry: ToolCatalogEntry): void {
		this.backend.add(entry);
	}

	/** Remove one tool entry by name. */
	remove(name: string): void {
		this.backend.remove(name);
	}

	/** Rebuild the index from a full entry list. */
	rebuild(entries: readonly ToolCatalogEntry[]): void {
		this.backend.rebuild(entries);
	}

	has(name: string): boolean {
		return this.backend.has(name);
	}

	get(name: string): ToolCatalogEntry | undefined {
		return this.backend.get(name);
	}

	/** Names of all indexed tools. */
	names(): Set<string> {
		return this.backend.names();
	}

	/** All indexed entries. */
	entries(): ToolCatalogEntry[] {
		return this.backend.entries();
	}

	/** Search the indexed tool set. */
	search(query: string, options?: ToolCatalogSearchOptions): ToolCatalogMatch[] {
		return this.backend.search(query, options);
	}
}
