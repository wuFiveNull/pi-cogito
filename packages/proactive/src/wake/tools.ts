/**
 * Wake 内容工具(akashic plugins/wake_proactive/tools.py port)。
 * scratchpad → investigate_candidates(并发抓正文 + 偏好探针)→ share_content / skip_content。
 */

import { recallPreferences, recallPreferencesRanked } from "@cogito/gate";
import { renderShare } from "./renderer.ts";
import type { WakeStateStore } from "./state.ts";
import {
	contentCandidateMap,
	contentEventMap,
	eventItemId,
	type InitialInterest,
	type PreferenceProbe,
	type ScratchItem,
	type WakeContext,
	type WakeEvent,
} from "./types.ts";

export const MAX_INVESTIGATION_CANDIDATES = 8;
export const MAX_SHARE_ITEMS = 5;

export interface WakeToolDeps {
	/** 可选 web 抓取(url → 纯文本)。 */
	webFetchFn?: (url: string, maxChars: number) => Promise<{ text?: string; error?: string; truncated?: boolean }>;
	/** 可选记忆检索(memory.sqlite 只读偏好召回)。 */
	memoryDbPath?: string;
	/** 可选批量嵌入(提供时 recall_memory 走向量精排 + relevance floor)。 */
	embeddingFn?: (texts: string[]) => Promise<number[][]>;
	maxChars: number;
	maxConcurrency: number;
	stateStore: WakeStateStore;
}

export interface ChatTool {
	type: "function";
	function: { name: string; description: string; parameters: Record<string, unknown> };
}

export function toolSchema(name: string, description: string, parameters: Record<string, unknown>): ChatTool {
	return { type: "function", function: { name, description, parameters } };
}

export const TOOL_SCHEMAS: ChatTool[] = [
	toolSchema(
		"scratchpad",
		"只记录需要查正文或确认用户兴趣的候选。未列出的标题视为本轮不调查,不产生用户反馈或训练标签。",
		{
			type: "object",
			properties: {
				items: {
					type: "array",
					maxItems: MAX_INVESTIGATION_CANDIDATES,
					items: {
						type: "object",
						properties: {
							item_id: { type: "string", description: "本轮标题页中的 candidate_N 引用。" },
							initial_interest: {
								type: "string",
								enum: ["likely_interesting", "uncertain"],
							},
							question: { type: "string" },
						},
						required: ["item_id", "initial_interest"],
					},
				},
				preference_probe: {
					type: "object",
					description:
						"可选且每轮最多一个。入选候选的价值取决于用户对一种内容形态或打扰类型的态度,且固定上下文没有直接证据时可以填写。query 查询真实态度和打扰价值,不复述新闻标题。",
					properties: {
						candidate_ids: {
							type: "array",
							items: { type: "string" },
							minItems: 1,
							maxItems: MAX_INVESTIGATION_CANDIDATES,
						},
						topic: { type: "string" },
						query: { type: "string" },
					},
					required: ["candidate_ids", "topic", "query"],
				},
			},
			required: ["items"],
		},
	),
	toolSchema(
		"investigate_candidates",
		"按 scratchpad 并发抓取全部正文,并在存在 preference_probe 时只执行一次只读兴趣查询。",
		{ type: "object", properties: {}, required: [] },
	),
	toolSchema("share_content", "把最终选中的内容渲染成一条自然消息,并保存稳定序号到 event id 的映射。", {
		type: "object",
		properties: {
			message: { type: "string", description: "基于已验证正文写成的一条自然主动消息,不使用固定资讯模板。" },
			opening: { type: "string" },
			items: {
				type: "array",
				maxItems: MAX_SHARE_ITEMS,
				items: {
					type: "object",
					properties: {
						item_id: { type: "string", description: "本轮标题页中的 candidate_N 引用。" },
						summary: { type: "string" },
						why_it_matters: { type: "string" },
					},
					required: ["item_id", "summary"],
				},
			},
			closing: { type: "string" },
		},
		required: ["items"],
	}),
	toolSchema("skip_content", "调查完成后确认本轮没有值得分享的内容;只消费本轮窗口,不产生兴趣反馈标签。", {
		type: "object",
		properties: { reason: { type: "string" } },
		required: ["reason"],
	}),
];

function canonicalItemId(candidateMap: Record<string, WakeEvent>, candidateRef: string): string {
	return eventItemId(candidateMap[candidateRef]!);
}

function save(ctx: WakeContext, deps: WakeToolDeps): void {
	deps.stateStore.save(ctx);
}

function preferenceProbe(
	rawProbe: unknown,
	options: { plannedCandidateRefs: Set<string>; candidateMap: Record<string, WakeEvent> },
): PreferenceProbe | null {
	if (rawProbe === null || rawProbe === undefined) return null;
	if (typeof rawProbe !== "object" || Array.isArray(rawProbe)) throw new Error("preference_probe must be an object");
	const probePayload = rawProbe as Record<string, unknown>;
	const rawCandidateIds = probePayload.candidate_ids;
	if (!Array.isArray(rawCandidateIds)) throw new Error("preference_probe candidate_ids must be an array");
	const rawIds = rawCandidateIds.map((item) => String(item).trim());
	if (rawIds.length === 0 || rawIds.length !== new Set(rawIds).size) {
		throw new Error("preference_probe candidate_ids must be unique and non-empty");
	}
	const unknown = [...new Set(rawIds)].filter((id) => !options.plannedCandidateRefs.has(id));
	if (unknown.length > 0) throw new Error(`preference_probe contains unplanned candidate_id: ${unknown}`);
	const topic = String(probePayload.topic ?? "").trim();
	const query = String(probePayload.query ?? "").trim();
	if (!topic || !query) throw new Error("preference_probe requires topic and query");
	return {
		candidateIds: rawIds.map((id) => canonicalItemId(options.candidateMap, id)),
		topic,
		query,
	};
}

function scratchpad(ctx: WakeContext, args: Record<string, unknown>, deps: WakeToolDeps): string {
	if (ctx.screeningCompleted) throw new Error("scratchpad already recorded for this wake");
	const candidateMap = contentCandidateMap(ctx);
	const validIds = new Set(Object.keys(candidateMap));
	const rawItems = Array.isArray(args.items) ? (args.items as Array<Record<string, unknown>>) : [];
	if (rawItems.length > MAX_INVESTIGATION_CANDIDATES) {
		throw new Error(`scratchpad supports at most ${MAX_INVESTIGATION_CANDIDATES} candidates`);
	}
	const rawItemIds = rawItems.map((item) => String(item.item_id ?? "").trim());
	const unknown = [...new Set(rawItemIds)].filter((id) => !validIds.has(id));
	if (unknown.length > 0) throw new Error(`scratchpad contains unknown item_id: ${unknown}`);
	const itemIds = rawItemIds.map((id) => canonicalItemId(candidateMap, id));
	if (itemIds.length !== new Set(itemIds).size) throw new Error("scratchpad contains duplicate item_id");

	const allowedInterest = new Set(["likely_interesting", "uncertain"]);
	const planned: Record<string, ScratchItem> = {};
	for (const [index, raw] of rawItems.entries()) {
		const interest = String(raw.initial_interest ?? "");
		if (interest === "not_interesting") continue;
		if (!allowedInterest.has(interest)) throw new Error(`invalid scratchpad decision for ${itemIds[index]}`);
		planned[itemIds[index]!] = {
			itemId: itemIds[index]!,
			initialInterest: interest as InitialInterest,
			question: String(raw.question ?? "").trim(),
		};
	}
	ctx.scratchpad = planned;
	const plannedCandidateRefs = new Set(rawItemIds.filter((id) => planned[canonicalItemId(candidateMap, id)]));
	ctx.preferenceProbe = preferenceProbe(args.preference_probe, { plannedCandidateRefs, candidateMap });
	ctx.screeningCompleted = true;
	save(ctx, deps);
	return JSON.stringify({
		ok: true,
		screened: validIds.size,
		planned: Object.keys(ctx.scratchpad).length,
		to_investigate: Object.keys(ctx.scratchpad).length,
		preference_probe: ctx.preferenceProbe !== null,
	});
}

async function fetchContent(event: WakeEvent, deps: WakeToolDeps): Promise<Record<string, unknown>> {
	const url = String(event.url ?? "").trim();
	if (!url) {
		const inline = String(event.content ?? event.body ?? "");
		return { text: inline.slice(0, deps.maxChars), url: "", truncated: inline.length > deps.maxChars };
	}
	if (!deps.webFetchFn) return { error: "web_fetch tool not configured", url };
	try {
		return await deps.webFetchFn(url, deps.maxChars);
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error), url };
	}
}

async function recallPreference(query: string, deps: WakeToolDeps): Promise<Record<string, unknown>> {
	if (!deps.memoryDbPath) return { hits: 0, records: [], trace: {}, error: "memory not configured" };
	try {
		// 有嵌入时走向量精排 + relevance floor(akashic memory.query
		// relevance_floor="strong" 的近似,limit=12);否则 LIKE 召回。
		const embeddingFn = deps.embeddingFn;
		const ranked = embeddingFn !== undefined;
		const records = ranked
			? await recallPreferencesRanked(deps.memoryDbPath, query, 12, embeddingFn, { minScore: 0.3 })
			: recallPreferences(deps.memoryDbPath, query, 12);
		return {
			hits: records.length,
			records: records.map((record) => ({
				id: record.id,
				summary: String(record.summary).slice(0, 600),
				engine: ranked ? "sqlite+embedding" : "sqlite",
			})),
			trace: { engine: ranked ? "sqlite+embedding" : "sqlite" },
		};
	} catch (error) {
		return { hits: 0, records: [], trace: {}, error: error instanceof Error ? error.message : String(error) };
	}
}

async function investigateCandidates(ctx: WakeContext, deps: WakeToolDeps): Promise<string> {
	if (!ctx.screeningCompleted) throw new Error("investigate_candidates requires scratchpad first");
	if (ctx.investigationCompleted) throw new Error("investigate_candidates already called this wake");
	const events = contentEventMap(ctx.contentEvents);
	const candidateRefs: Record<string, string> = {};
	for (const [candidateRef, event] of Object.entries(contentCandidateMap(ctx))) {
		candidateRefs[eventItemId(event)] = candidateRef;
	}

	const items = Object.values(ctx.scratchpad);
	const results: Record<string, Record<string, unknown>> = {};
	await runBoundedConcurrency(items, deps.maxConcurrency, async (item) => {
		const result: Record<string, unknown> = { initial_interest: item.initialInterest, question: item.question };
		const event = events[item.itemId];
		if (event) result.content = await fetchContent(event, deps);
		results[item.itemId] = result;
	});

	const probe = ctx.preferenceProbe;
	let evidence: Record<string, unknown> = {};
	if (probe !== null) {
		const recall = await recallPreference(probe.query, deps);
		evidence = { topic: probe.topic, candidate_ids: probe.candidateIds, query: probe.query, ...recall };
	}
	ctx.investigationResults = results;
	ctx.preferenceEvidence = evidence;
	ctx.investigationCompleted = true;
	save(ctx, deps);

	const verifiedResults: Record<string, unknown> = {};
	for (const [itemId, result] of Object.entries(results)) {
		const content = result.content;
		if (
			typeof content === "object" &&
			content !== null &&
			!(content as Record<string, unknown>).error &&
			String((content as Record<string, unknown>).text ?? "").trim()
		) {
			verifiedResults[candidateRefs[itemId] ?? itemId] = result;
		}
	}
	return JSON.stringify({
		items: verifiedResults,
		count: Object.keys(verifiedResults).length,
		preference_evidence: evidence,
	});
}

async function runBoundedConcurrency<T>(items: T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
	const concurrency = Math.max(1, limit);
	let index = 0;
	const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
		while (index < items.length) {
			const current = index++;
			await task(items[current]!);
		}
	});
	await Promise.all(workers);
}

function shareContent(ctx: WakeContext, args: Record<string, unknown>, deps: WakeToolDeps): string {
	if (ctx.terminalAction !== null) throw new Error("wake already finished");
	if (!ctx.screeningCompleted || !ctx.investigationCompleted) {
		throw new Error("share_content requires scratchpad and investigate_candidates first");
	}
	const rawItems = Array.isArray(args.items) ? (args.items as Array<Record<string, string>>) : [];
	if (rawItems.length === 0) throw new Error("share_content requires at least one item");
	if (rawItems.length > MAX_SHARE_ITEMS) throw new Error("share_content supports at most 5 items");
	const candidateMap = contentCandidateMap(ctx);
	const rawItemIds = rawItems.map((item) => String(item.item_id ?? "").trim());
	const unknown = [...new Set(rawItemIds)].filter((id) => !(id in candidateMap));
	if (unknown.length > 0) throw new Error(`share_content contains unknown item_id: ${unknown}`);
	const itemIds = rawItemIds.map((id) => canonicalItemId(candidateMap, id));
	if (itemIds.length !== new Set(itemIds).size) throw new Error("share_content contains duplicate item_id");
	const items = rawItems.map((rawItem, index) => ({ ...rawItem, item_id: itemIds[index] }));

	const withEvidence: Array<Record<string, string>> = [];
	for (const [index, itemId] of itemIds.entries()) {
		const planned = ctx.scratchpad[itemId];
		if (!planned) continue;
		const investigated = ctx.investigationResults[itemId] ?? {};
		const content = investigated.content;
		if (typeof content !== "object" || content === null) continue;
		const typed = content as Record<string, unknown>;
		if (typed.error || !String(typed.text ?? "").trim()) continue;
		withEvidence.push(items[index]!);
	}
	if (withEvidence.length === 0) {
		ctx.terminalAction = "skip";
		save(ctx, deps);
		return JSON.stringify({ ok: true, decision: "skip", reason: "没有可验证的正文证据" });
	}
	const rendered = renderShare({
		message: String(args.message ?? ""),
		opening: String(args.opening ?? ""),
		items: withEvidence,
		closing: String(args.closing ?? ""),
		events: ctx.contentEvents,
	});
	ctx.finalMessage = rendered.message;
	ctx.citedItemIds = rendered.evidence;
	ctx.displayEventMap = rendered.displayEventMap;
	ctx.sourceRefs = rendered.sourceRefs;
	ctx.terminalAction = "reply";
	save(ctx, deps);
	return JSON.stringify({ ok: true, message: ctx.finalMessage, display_event_map: ctx.displayEventMap });
}

function skipContent(ctx: WakeContext, args: Record<string, unknown>, deps: WakeToolDeps): string {
	if (ctx.terminalAction !== null) throw new Error("wake already finished");
	if (!ctx.screeningCompleted || !ctx.investigationCompleted) {
		throw new Error("skip_content requires scratchpad and investigate_candidates first");
	}
	const reason = String(args.reason ?? "").trim();
	if (!reason) throw new Error("skip_content requires reason");
	ctx.terminalAction = "skip";
	save(ctx, deps);
	return JSON.stringify({ ok: true, decision: "skip", reason });
}

export async function executeWakeTool(
	toolName: string,
	args: Record<string, unknown>,
	ctx: WakeContext,
	deps: WakeToolDeps,
): Promise<string> {
	ctx.stepsTaken += 1;
	if (toolName === "scratchpad") return scratchpad(ctx, args, deps);
	if (toolName === "investigate_candidates") return await investigateCandidates(ctx, deps);
	if (toolName === "share_content") return shareContent(ctx, args, deps);
	if (toolName === "skip_content") return skipContent(ctx, args, deps);
	throw new Error(`unknown wake proactive tool: ${toolName}`);
}
