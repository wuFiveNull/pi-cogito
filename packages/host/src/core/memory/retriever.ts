/**
 * Memory retriever (akashic memory2 design).
 *
 * Fusion retrieval: vector lane (semantic) + keyword lane (literal), merged
 * with Reciprocal Rank Fusion. The injection block builder selects candidates
 * per memory kind, force-injects procedures with tool requirements, and
 * applies a character budget.
 */

import type { MemoryStore } from "./store.ts";
import type {
	InjectionBlock,
	MemoryHit,
	MemoryScope,
	MemoryType,
	PostResponseLlm,
	RetrieveOptions,
	RetrieverOptions,
	TextEmbedder,
} from "./types.ts";

const RRF_K = 60;
const KEYWORD_RRF_WEIGHT = 0.5;
const EMBED_TIMEOUT_MS = 8000;

const CJK_STOPWORDS = new Set([
	"一个",
	"什么",
	"我们",
	"你们",
	"他们",
	"这个",
	"那个",
	"自己",
	"因为",
	"所以",
	"但是",
	"如果",
	"可以",
	"需要",
	"没有",
	"不是",
	"就是",
	"还是",
	"或者",
	"然后",
	"怎么",
	"怎样",
	"哪个",
	"哪些",
	"是否",
	"如何",
	"以及",
	"还有",
	"现在",
	"今天",
]);

interface SectionPart {
	title: string;
	lines: string[];
	ids: string[];
}

export class Retriever {
	readonly store: MemoryStore;
	private readonly embedder: TextEmbedder | undefined;
	private readonly topK: number;
	private readonly scoreThreshold: number;
	private readonly scoreThresholds: Record<MemoryType, number>;
	private readonly injectMaxChars: number;
	private readonly injectMaxForced: number;
	private readonly injectMaxProcedurePreference: number;
	private readonly injectMaxEventProfile: number;
	private readonly procedureGuardEnabled: boolean;
	private readonly highInjectDelta: number;
	private readonly hotnessAlpha: number;
	private readonly hotnessHalfLifeDays: number;

	constructor(store: MemoryStore, embedder: TextEmbedder | undefined, options: RetrieverOptions = {}) {
		this.store = store;
		this.embedder = embedder;
		this.topK = options.topK ?? 8;
		this.scoreThreshold = options.scoreThreshold ?? 0.45;
		this.scoreThresholds = {
			procedure: options.scoreThresholds?.procedure ?? this.scoreThreshold,
			preference: options.scoreThresholds?.preference ?? this.scoreThreshold,
			event: options.scoreThresholds?.event ?? this.scoreThreshold,
			profile: options.scoreThresholds?.profile ?? this.scoreThreshold,
		};
		this.injectMaxChars = Math.max(200, options.injectMaxChars ?? 1200);
		this.injectMaxForced = Math.max(1, options.injectMaxForced ?? 3);
		this.injectMaxProcedurePreference = Math.max(1, options.injectMaxProcedurePreference ?? 4);
		this.injectMaxEventProfile = Math.max(0, options.injectMaxEventProfile ?? 2);
		this.procedureGuardEnabled = options.procedureGuardEnabled ?? true;
		this.highInjectDelta = Math.max(0, options.highInjectDelta ?? 0.15);
		this.hotnessAlpha = Math.max(0, Math.min(1, options.hotnessAlpha ?? 0.2));
		this.hotnessHalfLifeDays = Math.max(1, options.hotnessHalfLifeDays ?? 14);
	}

	/** Fused vector + keyword retrieval (intent-routed, akashic engine.query). */
	async retrieve(query: string, options: RetrieveOptions = {}): Promise<MemoryHit[]> {
		const intent = options.intent ?? "context";
		let memoryTypes = options.memoryTypes;
		if (intent === "interest" && !memoryTypes) memoryTypes = ["preference", "profile"];
		if (intent === "procedure" && !memoryTypes) memoryTypes = ["procedure"];
		const auxQueries = options.auxQueries ? [...options.auxQueries] : [];
		if (intent === "answer" && options.hypothesisLlm) {
			const [hyp1, hyp2] = await Promise.all([
				generateHypothesis(options.hypothesisLlm, query, "event"),
				generateHypothesis(options.hypothesisLlm, query, "general"),
			]);
			for (const hypothesis of [hyp1, hyp2]) {
				if (hypothesis) auxQueries.push(hypothesis);
			}
		}
		const actualTopK = Math.max(1, options.topK ?? this.topK);
		const actualThreshold = options.scoreThreshold ?? this.scoreThreshold;
		const scope = options.scope;
		const requireScopeMatch = options.requireScopeMatch ?? false;
		const searchOptions = {
			topK: actualTopK,
			scoreThreshold: actualThreshold,
			memoryTypes,
			scope,
			requireScopeMatch,
			hotnessAlpha: this.hotnessAlpha,
			hotnessHalfLifeDays: this.hotnessHalfLifeDays,
			timeStart: options.timeStart,
			timeEnd: options.timeEnd,
		};

		const queryTexts = dedupeTexts([query, ...auxQueries]);
		const vectorItems = await this.retrieveVectorLanes(queryTexts, searchOptions);

		let keywordItems: MemoryHit[] = [];
		if (options.keywordEnabled ?? true) {
			const terms = extractTerms(query);
			if (terms.length > 0) {
				keywordItems = this.store.keywordSearchSummary(terms, searchOptions);
			}
		}

		return rrfMerge(vectorItems, keywordItems, actualTopK);
	}

	private async retrieveVectorLanes(
		queryTexts: string[],
		searchOptions: Parameters<MemoryStore["vectorSearch"]>[1],
	): Promise<MemoryHit[]> {
		if (!this.embedder || queryTexts.length === 0) return [];
		const vectors = await this.embedLanes(queryTexts);
		if (vectors.length === 0) return [];

		const hitGroups = this.store.vectorSearchBatch(vectors, searchOptions);
		const seen = new Map<string, MemoryHit>();
		for (const hits of hitGroups) {
			for (const hit of hits) {
				const existing = seen.get(hit.id);
				if (!existing || hit.score > existing.score) {
					seen.set(hit.id, hit);
				}
			}
		}
		return [...seen.values()];
	}

	private async embedLanes(queryTexts: string[]): Promise<number[][]> {
		const results = await Promise.all(
			queryTexts.map(async (text) => {
				try {
					return await Promise.race([
						this.embedder!.embed([text]).then((vectors) => vectors[0]),
						new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), EMBED_TIMEOUT_MS)),
					]);
				} catch {
					return undefined;
				}
			}),
		);
		return results.filter((vector): vector is number[] => vector !== undefined);
	}

	/** Select candidates and format the per-turn injection block. */
	buildInjectionBlock(items: MemoryHit[]): InjectionBlock {
		const sections = this.selectInjectionSections(items);
		if (sections.length === 0) return { text: "", injectedIds: [] };
		return applyCharBudget(sections, this.injectMaxChars);
	}

	private selectInjectionSections(items: MemoryHit[]): SectionPart[] {
		if (items.length === 0) return [];
		const sorted = [...items].sort((a, b) => b.score - a.score);

		const forced: SectionPart = { title: "## 【强制约束】记忆规则(必须执行)", lines: [], ids: [] };
		const norms: SectionPart = { title: "## 【流程规范】用户偏好与规则", lines: [], ids: [] };
		const events: SectionPart = {
			title: "## 【相关历史】过往对话(来自记忆检索,时间戳可信,可直接引用;数字/金额/地名等具体值以记录为准,不得用常识替换)",
			lines: [],
			ids: [],
		};

		for (const item of sorted) {
			const extra = item.extra ?? {};
			const typeThreshold = this.scoreThresholds[item.memoryType] ?? this.scoreThreshold;

			if (this.procedureGuardEnabled && item.memoryType === "procedure" && extra.tool_requirement) {
				if (forced.lines.length >= this.injectMaxForced) continue;
				item.forced = true;
				forced.lines.push(`- [${item.id}] ${item.summary}(必须调用工具:${String(extra.tool_requirement)})`);
				forced.ids.push(item.id);
				continue;
			}

			if (item.score < typeThreshold) continue;
			let confidenceLabel = "";
			if (item.score < typeThreshold + this.highInjectDelta) {
				confidenceLabel = "有印象,不确定";
				item.confidenceLabel = confidenceLabel;
			}

			if (item.memoryType === "procedure" || item.memoryType === "preference") {
				if (norms.lines.length >= this.injectMaxProcedurePreference) continue;
				const meta = formatMemoryMeta(confidenceLabel);
				norms.lines.push(`- [${item.id}] ${item.summary}${meta}`);
				norms.ids.push(item.id);
			} else if (item.memoryType === "event" || item.memoryType === "profile") {
				if (events.lines.length >= this.injectMaxEventProfile) continue;
				const ts = item.happenedAt ? `[${item.happenedAt}] ` : "";
				const meta = formatMemoryMeta(confidenceLabel);
				events.lines.push(`- [${item.id}] ${ts}${item.summary}${meta}`);
				events.ids.push(item.id);
			}
		}

		const sections: SectionPart[] = [];
		if (forced.lines.length > 0) sections.push(forced);
		if (norms.lines.length > 0) sections.push(norms);
		if (events.lines.length > 0) sections.push(events);
		return sections;
	}
}

function formatMemoryMeta(confidenceLabel: string): string {
	const parts: string[] = [];
	if (confidenceLabel) parts.push(`(${confidenceLabel})`);
	return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

function applyCharBudget(sections: SectionPart[], budget: number): InjectionBlock {
	const parts: string[] = [];
	const injectedIds: string[] = [];
	const seenIds = new Set<string>();
	let total = 0;

	for (const section of sections) {
		const body = section.lines.join("\n");
		const block = `${section.title}\n${body}`;
		const addLen = block.length + (parts.length > 0 ? 2 : 0);
		if (total + addLen > budget) break;
		parts.push(block);
		total += addLen;
		for (const id of section.ids) {
			if (!seenIds.has(id)) {
				seenIds.add(id);
				injectedIds.push(id);
			}
		}
	}
	if (parts.length === 0) return { text: "", injectedIds: [] };
	return { text: parts.join("\n\n"), injectedIds };
}

function dedupeTexts(texts: readonly string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const text of texts) {
		const trimmed = text.trim();
		if (!trimmed || seen.has(trimmed)) continue;
		seen.add(trimmed);
		result.push(trimmed);
	}
	return result;
}

/** Extract keyword terms: ascii tokens plus CJK chunks/bigrams (akashic style). */
export function extractTerms(query: string): string[] {
	const terms: string[] = [];
	const asciiTokens = query.match(/[a-zA-Z0-9_\-.]{2,}/g) ?? [];
	terms.push(...asciiTokens);

	const cjkChunks = query.match(/[\u4e00-\u9fff\u3040-\u30ff]{2,}/g) ?? [];
	for (const chunk of cjkChunks) {
		if (chunk.length <= 4) {
			if (!CJK_STOPWORDS.has(chunk)) terms.push(chunk);
			continue;
		}
		for (let i = 0; i < chunk.length - 1; i++) {
			const bigram = chunk.slice(i, i + 2);
			if (!CJK_STOPWORDS.has(bigram)) terms.push(bigram);
		}
	}

	const seen = new Set<string>();
	const result: string[] = [];
	for (const term of terms) {
		if (seen.has(term)) continue;
		seen.add(term);
		result.push(term);
	}
	return result.slice(0, 20);
}

const HYPOTHESIS_SYSTEM = "你是个人助手的记忆系统。根据用户提问生成一条假想记忆条目，只输出那一条文本。";

/** HyDE 假设生成 prompt(akashic _explicit_hypothesis_prompt)。 */
export function buildHypothesisPrompt(query: string, style: "event" | "general"): string {
	if (style === "event") {
		return `根据用户提问，生成一条带具体时间的假想记忆条目，格式如 '[2026-03-08] 用户...'
规则：第三人称、简洁事实陈述、只输出那一条文本

用户提问：${query}
假想记忆条目：`;
	}
	return `根据用户提问，生成一条假想记忆条目。
规则：始终生成肯定式、第三人称（'用户…'）、简洁事实陈述、只输出那一条文本

用户提问：${query}
假想记忆条目：`;
}

/**
 * HyDE 假设生成:用轻模型把问题改写为假想记忆条目,并入检索辅助查询。
 * 失败(网络/空输出)返回 undefined,调用方降级为原查询(akashic _gen_hypothesis)。
 */
export async function generateHypothesis(
	llm: PostResponseLlm,
	query: string,
	style: "event" | "general",
): Promise<string | undefined> {
	try {
		const text = await llm.chat(HYPOTHESIS_SYSTEM, buildHypothesisPrompt(query, style), 96);
		const trimmed = text.trim();
		return trimmed.length > 0 ? trimmed.slice(0, 200) : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Reciprocal Rank Fusion: each lane contributes weight / (k + rank).
 * Keyword lane weight is halved so literal hits do not dominate semantics.
 */
export function rrfMerge(vectorItems: MemoryHit[], keywordItems: MemoryHit[], topN: number): MemoryHit[] {
	const vecRank = new Map<string, number>();
	[...vectorItems]
		.sort((a, b) => b.score - a.score)
		.forEach((item, index) => {
			if (!vecRank.has(item.id)) vecRank.set(item.id, index + 1);
		});

	const keywordRank = new Map<string, number>();
	keywordItems.forEach((item, index) => {
		if (!keywordRank.has(item.id)) keywordRank.set(item.id, index + 1);
	});

	const byId = new Map<string, MemoryHit>();
	for (const item of keywordItems) {
		byId.set(item.id, { ...item });
	}
	for (const item of vectorItems) {
		byId.set(item.id, item);
	}

	const scored: Array<{ id: string; rrf: number; score: number }> = [];
	const ids = new Set([...vecRank.keys(), ...keywordRank.keys()]);
	for (const itemId of ids) {
		let rrf = 0;
		const vecRankValue = vecRank.get(itemId);
		if (vecRankValue !== undefined) rrf += 1 / (RRF_K + vecRankValue);
		const keywordRankValue = keywordRank.get(itemId);
		if (keywordRankValue !== undefined) rrf += KEYWORD_RRF_WEIGHT / (RRF_K + keywordRankValue);
		const hit = byId.get(itemId);
		scored.push({ id: itemId, rrf, score: hit?.score ?? 0 });
	}
	scored.sort((a, b) => b.rrf - a.rrf || b.score - a.score || a.id.localeCompare(b.id));

	const result: MemoryHit[] = [];
	for (const entry of scored.slice(0, topN)) {
		const hit = byId.get(entry.id)!;
		result.push({ ...hit, rrfScore: entry.rrf, score: hit.score });
	}
	return result;
}

export type { MemoryHit, MemoryScope, MemoryType };
