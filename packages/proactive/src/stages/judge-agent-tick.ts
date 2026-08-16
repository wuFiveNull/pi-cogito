/**
 * Proactive agent tick — LLM judgment loop with evidence (akashic AgentTick +
 * ProactiveJudge design).
 *
 * Each proactive tick runs a bounded LLM loop with tools:
 * - fetch_evidence(item_id): fetch the candidate's body text as evidence
 *   (akashic: evidence-first; every fact in the final message must trace back
 *   to an evidence id)
 * - get_content(item_id): return the candidate's cached body (no verdict)
 * - mark_interesting(item_ids, reason) / mark_not_interesting(item_ids, reason):
 *   explicit per-item classification (akashic mark_*; observable so the
 *   completeness loop can tell "considered" from "ignored")
 * - get_recent_chat(): recent conversation, used to judge whether it is a good
 *   time to disturb the user (akashic get_recent_chat)
 * - recall_memory(query): preference recall for 雷点/interest checks (akashic
 *   recall_memory)
 * - web_fetch(url) / web_search(query): rule verification with the shared
 *   SSRF-safe web policy (@cogito/gate/web.ts)
 * - message_push(message, evidence_ids): stage a draft without ending the loop
 * - finish_judgment(action, item_ids, skip_reason): terminal action
 *
 * Alert fast path (akashic prompt.py): kind=alert candidates are high-priority;
 * they skip classification, are merged into one send, and their ids fill the
 * evidence list. Completeness enforcement only applies to content candidates.
 *
 * Terminal actions: "send" | "skip" | "context_only". When the step budget is
 * exhausted without a finish, the tick defaults to skip. Unclassified
 * candidates are never sent.
 */

import {
	type ChatCompletionClient,
	type ChatCompletionMessage,
	type ChatCompletionResponse,
	type ChatCompletionTool,
	OpenAICompatibleChatClient,
} from "@cogito/ai/chat";
import type { ProactiveItem, ProactiveStore } from "../store.ts";

export type TerminalAction = "send" | "skip" | "context_only";

export interface Evidence {
	id: string;
	itemId: number;
	source: string;
	title: string;
	snippet: string;
	url: string;
}

export interface TickConfig {
	/** agent_tick_max_steps: step budget per tick. */
	maxSteps?: number;
	/** judge_send_threshold: LLM confidence floor for send (reserved; the LLM decides). */
	judgeSendThreshold?: number;
	/** agent_tick_web_fetch_max_chars: evidence snippet cap. */
	webFetchMaxChars?: number;
	requestTimeoutMs?: number;
	/** Injectable HTTP fetch (tests). */
	fetchFn?: typeof fetch;
}

/** Judge-time tool providers (akashic ToolDeps 的 pi 形态;缺省的提供器不注册对应工具)。 */
export interface TickToolDeps {
	/** get_recent_chat:最近对话文本(≤20 条,过滤 context frame)。 */
	recentChatFn?: () => Promise<string> | string;
	/** recall_memory:偏好召回(雷点/兴趣判断)。 */
	recallMemoryFn?: (query: string) => Promise<string> | string;
	/** web_fetch:带安全策略的抓取(缺省用 gate 内置实现 + webPolicy)。 */
	webFetchFn?: (url: string, maxChars: number, timeoutMs: number) => Promise<WebFetchResult>;
	/** web_search:带安全策略的搜索(缺省用 webSearchUrl)。 */
	webSearchFn?: (query: string, maxResults: number, timeoutMs: number) => Promise<WebSearchItem[]>;
	webFetchMaxChars?: number;
	webSearchMaxResults?: number;
	webRequestTimeoutMs?: number;
}

export interface WebFetchResult {
	text?: string;
	error?: string;
	truncated?: boolean;
	url?: string;
}

export interface WebSearchItem {
	title: string;
	url: string;
	snippet: string;
}

export interface TickContext {
	stepsTaken: number;
	terminalAction: TerminalAction | null;
	interestingItemIds: number[];
	discardedItemIds: number[];
	skipReason: string;
	skipNote: string;
	evidence: Evidence[];
	/** send 终局实际引用的条目(akashic cited_item_ids;tick_log 审计用)。 */
	citedItemIds: number[];
	/** 成功 LLM 调用次数(akashic llm_call_count)。 */
	llmCallCount: number;
	/** judge 内 message_push 暂存的草稿(akashic message_push;resolve 优先使用)。 */
	draftMessage: string | null;
	/** LLM cache token 统计(akashic record_llm_cache)。 */
	llmCacheReadTokens: number;
	llmCacheWriteTokens: number;
}

export interface AgentTickOptions {
	items: ProactiveItem[];
	rulesPanel: string;
	preferenceBlock: string;
	/** 插件贡献的 system_bottom 段(akashic proactive:prompt:system_bottom:*)。 */
	promptSections?: readonly string[];
	/** 本轮是否允许 context_only 兜底(gate 概率开关);undefined = 不提示。 */
	contextAsFallbackOpen?: boolean;
	/** 空候选闲聊模式:只允许 get_recent_chat / message_push / finish_judgment。 */
	chatLevity?: boolean;
	model: string;
	baseUrl: string;
	apiKey: string | undefined;
	/** 宿主注入的 ChatCompletionClient(pi-host ModelRuntime);缺省走配置式客户端。 */
	client?: ChatCompletionClient;
	store: ProactiveStore;
	config?: TickConfig;
	toolDeps?: TickToolDeps;
	/** 工具级审计回调(akashic record_tick_step_log)。 */
	recordToolStep?: (step: {
		toolName: string;
		toolArgs: string;
		resultText: string;
		actionAfter: string;
		skipReasonAfter: string;
		toolCallId?: string;
		interestingIds?: number[];
		discardedIds?: number[];
		citedIds?: number[];
		finalMessage?: string | null;
	}) => void;
}

function buildSystemPrompt(
	rulesPanel: string,
	preferenceBlock: string,
	items: ProactiveItem[],
	contextAsFallbackOpen: boolean | undefined,
	chatLevity: boolean | undefined,
	promptSections: readonly string[] | undefined,
): string {
	const alerts = items.filter((item) => item.kind === "alert");
	const contentItems = items.filter((item) => item.kind !== "alert");
	const alertLines = alerts.map(
		(item) =>
			`- id=${item.id} [${item.sub_source}] ${item.title}` +
			(item.summary ? `\n  内容: ${item.summary.slice(0, 300)}` : ""),
	);
	const contentLines = contentItems.map(
		(item) =>
			`- id=${item.id} [${item.sub_source}] ${item.title}` +
			(item.summary ? `\n  摘要: ${item.summary.slice(0, 200)}` : "") +
			(item.url ? `\n  URL: ${item.url}` : ""),
	);
	if (chatLevity) {
		return [
			"你是主动推送的决策器。本轮没有任何外部候选内容。",
			"你只有两条路:",
			"a. 调用 finish_judgment(action=skip, skip_reason=no_content)(默认,大多数情况选这条)",
			"b. 调用 get_recent_chat:若最近对话有自然延伸的未完成话题,可以 message_push 一条轻松挑起对话的消息,再 finish_judgment(action=context_only)。",
			"路径 b 是低概率选项;若 recent_chat 没有明显未完成话题,必须选 a。",
			"路径 b 的消息不得引用任何外部事件或可验证事实,evidence 必须为空。",
			"禁止在这两条路之外做任何事:不允许捏造任何 item_id。",
			`## 主动推送硬规则(必须遵守,不是参考建议)\n${rulesPanel || "(无)"}`,
			preferenceBlock || "## 用户偏好\n(无)",
		].join("\n\n");
	}
	const sections = [
		"你是主动推送的选题判断器。判断这批候选内容中哪些值得现在主动推送给用户,并收集证据。",
		"【优先级】Alert > Content > Context-fallback(本轮是否允许以 context_only 开关为准)",
		`## 主动推送硬规则(必须遵守,不是参考建议)\n${rulesPanel || "(无)"}`,
		preferenceBlock || "## 用户偏好\n(无)",
		// 插件贡献的 system_bottom 段(akashic proactive:prompt:system_bottom:* → 【主动插件状态】)。
		...(promptSections?.some((section) => section.trim())
			? [
					`## 主动插件状态\n${promptSections
						.map((section) => section.trim())
						.filter(Boolean)
						.join("\n\n")}`,
				]
			: []),
		...(contextAsFallbackOpen !== undefined
			? [
					`## 本轮 context_only 兜底\n${
						contextAsFallbackOpen
							? "允许:没有值得直接推送的内容时,可以用 finish_judgment(context_only) 把候选作为上下文延续。"
							: "不允许:本轮只能用 send 或 skip。"
					}`,
				]
			: []),
		...(alerts.length > 0
			? [
					`## Alerts(时效性高,优先处理)\n${alertLines.join("\n")}`,
					"Alert 快速路径:如有 Alert,把本轮所有 Alert 整合成一条消息,evidence 填写全部 Alert 的 id,然后 finish_judgment(action=send)。Alert 是系统触发的高优先级通知,不走内容筛选流程,可以不调用 fetch_evidence / mark_*。",
				]
			: []),
		...(contentLines.length > 0
			? [
					`## 候选内容(Content)\n${contentLines.join("\n") || "(无候选)"}`,
					"每条 Content 必须被分类:值得推送的用 mark_interesting 或 fetch_evidence,不感兴趣的用 mark_not_interesting;全部处理完后调用 finish_judgment。逐条判断,不能把多条内容打包成一次统一判断。",
				]
			: []),
		"## 工具职责",
		"1. fetch_evidence:抓取候选正文作为证据。消息中的每个具体事实必须能追溯到某条证据。",
		"2. get_content:给当前候选条目补正文(不写入分类)。",
		"3. mark_interesting / mark_not_interesting:写入最终分类结果,尽量附带简短 reason(规则过滤/用户雷点/明显相关/边界验证失败等)。reason 中出现具体排名、归属、日期等可验证事实时,必须是本轮验证过的;未验证写「未验证」或「疑似」。",
		"4. recall_memory:仅用于 Content 评估——判断单条内容是否可能是用户雷点或兴趣点。当标题稀疏时必须把 source(来源/作者名)纳入 query。",
		"5. web_fetch:优先用于抓取当前候选条目的直接来源页面或正文;规则确认、细节核实都优先走它。web_fetch 失败(404/超时)不能直接 mark_not_interesting,应退回 recall_memory 以 source 判断。",
		"6. web_search:按规则要求验证时效性数据(排名/赛况/阵容等)。你的训练知识已过时,不能代替规则要求的验证。",
		"7. get_recent_chat:只在最后判断现在是否适合打扰用户时使用。",
		"8. message_push:暂存消息草稿,不终止 loop。",
		"9. finish_judgment:提交终局动作,终止 loop。",
		"## 信息源规则",
		"1. 主信息源只有本轮已提供的 Alert / Content。只有这些来源里的事实才能进入最终发送内容。",
		"2. 用户偏好、主动推送硬规则、recent_chat 只用于过滤、排序、判断是否打扰;不是事实来源,也不是候选主题列表。",
		"3. 严禁根据偏好或硬规则自行脑补具体新闻、比赛结果、更新或其他外部事件。",
		"4. 当候选条目已自带来源 URL 时,先直接 web_fetch 该来源页面;不要凭记忆补细节。",
		"5. 当 alert 和 content 都为空时,你只有两条路:finish_judgment(action=skip, skip_reason=no_content)(默认);或 get_recent_chat → 有未完成话题才可 message_push + finish_judgment(action=context_only),evidence 必须为空 []。",
		"## 发送要求",
		"- 语气自然,像朋友分享,不是推送通知",
		"- 消息里出现的具体数字、排名、结果必须来自本轮已提供的 Alert/Content 数据或已验证证据;严禁脑补可验证事实",
		"- 有可靠来源链接时在对应内容后自然附上原始链接,不要集中堆到末尾",
		"- 没有实质内容时 finish_judgment(action=skip, skip_reason=no_content) 是正确选择",
		"- finish_judgment.skip_reason 只能是:no_content | user_busy | already_sent_similar | other",
	];
	return sections.join("\n\n");
}

function buildToolSchemas(toolDeps: TickToolDeps | undefined, chatLevity: boolean | undefined): ChatCompletionTool[] {
	if (chatLevity) {
		return [
			{
				name: "get_recent_chat",
				description: "读取最近对话,判断是否有自然延伸的未完成话题。",
				parameters: { type: "object", properties: {}, required: [] },
			},
			{
				name: "message_push",
				description: "暂存一条要发送给用户的轻消息(不终止本轮)。",
				parameters: {
					type: "object",
					properties: { message: { type: "string", description: "消息文本" } },
					required: ["message"],
				},
			},
			...FINISH_SCHEMAS,
		];
	}
	const schemas: ChatCompletionTool[] = [
		{
			name: "fetch_evidence",
			description:
				"抓取某个候选的正文内容作为证据。每个你打算推荐的候选,都应该先抓取证据;消息中的每个事实必须能追溯到证据。",
			parameters: {
				type: "object",
				properties: { item_id: { type: "number", description: "候选内容的 id" } },
				required: ["item_id"],
			},
		},
		{
			name: "get_content",
			description: "返回候选条目的正文内容(不写入分类,不改变证据)。",
			parameters: {
				type: "object",
				properties: { item_id: { type: "number", description: "候选内容的 id" } },
				required: ["item_id"],
			},
		},
		{
			name: "mark_interesting",
			description: "将指定候选明确标记为感兴趣。",
			parameters: {
				type: "object",
				properties: {
					item_ids: { type: "array", items: { type: "number" }, description: "候选内容的 id 列表" },
					reason: { type: "string", description: "简短说明原因(规则命中/明显相关等)" },
				},
				required: ["item_ids"],
			},
		},
		{
			name: "mark_not_interesting",
			description:
				"将指定候选明确标记为不感兴趣,完成分类。每条候选都必须被分类:值得推送的用 mark_interesting 或 fetch_evidence,不感兴趣的用 mark_not_interesting 标记。",
			parameters: {
				type: "object",
				properties: {
					item_ids: { type: "array", items: { type: "number" }, description: "候选内容的 id 列表" },
					reason: { type: "string", description: "可选,简短说明原因" },
				},
				required: ["item_ids"],
			},
		},
		...(toolDeps?.recentChatFn
			? [
					{
						name: "get_recent_chat",
						description: "读取最近对话,用于判断现在是否适合打扰用户。",
						parameters: { type: "object", properties: {}, required: [] },
					},
				]
			: []),
		...(toolDeps?.recallMemoryFn
			? [
					{
						name: "recall_memory",
						description:
							"查询用户长期记忆/偏好,判断候选是否可能是用户雷点或兴趣点。标题稀疏时必须把来源/作者名纳入 query。",
						parameters: {
							type: "object",
							properties: { query: { type: "string", description: "查询关键词(含来源名)" } },
							required: ["query"],
						},
					},
				]
			: []),
		...(toolDeps?.webFetchFn
			? [
					{
						name: "web_fetch",
						description: "按安全策略抓取指定 URL 的正文,用于规则确认与细节核实。",
						parameters: {
							type: "object",
							properties: { url: { type: "string", description: "http(s) URL" } },
							required: ["url"],
						},
					},
				]
			: []),
		...(toolDeps?.webSearchFn
			? [
					{
						name: "web_search",
						description: "搜索网页,用于验证时效性数据(排名/赛况/阵容等)。",
						parameters: {
							type: "object",
							properties: { query: { type: "string", description: "搜索关键词或问题" } },
							required: ["query"],
						},
					},
				]
			: []),
		{
			name: "message_push",
			description: "暂存一条要发送给用户的消息草稿(不终止本轮;后续可继续抓证据)。",
			parameters: {
				type: "object",
				properties: {
					message: { type: "string", description: "消息文本" },
					evidence_ids: { type: "array", items: { type: "string" }, description: "本条消息引用的证据 id" },
				},
				required: ["message"],
			},
		},
		...FINISH_SCHEMAS,
	];
	return schemas;
}

const FINISH_SCHEMAS: ChatCompletionTool[] = [
	{
		name: "finish_judgment",
		description:
			"结束本轮判断,给出终局动作。send=推荐这些候选;skip=都不推;context_only=只把候选作为上下文延续,不直接推送。宁缺毋滥:没有高置信度的候选就 skip。未分类的 content 不允许直接 skip,必须先抓证据或标记。skip_reason 只能是:no_content | user_busy | already_sent_similar | other。",
		parameters: {
			type: "object",
			properties: {
				action: { type: "string", enum: ["send", "skip", "context_only"] },
				item_ids: { type: "array", items: { type: "number" }, description: "send 时推荐发送的候选 id 列表" },
				skip_reason: {
					type: "string",
					description: "skip 或部分舍弃时的原因(no_content/user_busy/already_sent_similar/other)",
				},
			},
			required: ["action", "item_ids"],
		},
	},
];

function parseToolArguments(raw: string | Record<string, unknown>): Record<string, unknown> {
	if (typeof raw !== "string") return raw;
	try {
		const parsed = JSON.parse(raw) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

/** Strip HTML tags and collapse whitespace for evidence snippets. */
export function htmlToText(html: string): string {
	return html
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/\s+/g, " ")
		.trim();
}

async function fetchEvidenceSnippet(
	item: ProactiveItem,
	maxChars: number,
	store: ProactiveStore,
	fetchFn: typeof fetch,
	timeoutMs: number,
): Promise<string> {
	// 预取缓存优先(akashic content_store):prepare 阶段已并行抓取正文。
	const cached = store.getItem(item.id)?.evidence;
	if (cached && cached.trim().length > 20) return cached.slice(0, maxChars);
	if (item.url) {
		try {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), timeoutMs);
			try {
				const response = await fetchFn(item.url, { signal: controller.signal });
				if (response.ok) {
					const text = await response.text();
					const plain = htmlToText(text);
					if (plain.length > 20) return plain.slice(0, maxChars);
				}
			} finally {
				clearTimeout(timeout);
			}
		} catch {
			// Fall through to summary.
		}
	}
	return (item.summary ?? item.title).slice(0, maxChars);
}

function buildEvidenceBlock(evidence: Evidence[]): string {
	if (evidence.length === 0) return "(尚未抓取证据)";
	return evidence
		.map((ev) => `[${ev.id}] 来源: ${ev.source} | 标题: ${ev.title}\n正文片段: ${ev.snippet.slice(0, 1200)}`)
		.join("\n\n");
}

/** 完整性回环上限(akashic judge.py: completeness 最多 5 轮)。 */
const MAX_COMPLETENESS_ROUNDS = 5;
/** 缺证据/未收尾回环上限(akashic judge.py: reflection 最多 3 轮)。 */
const MAX_REFLECTION_ROUNDS = 3;

function buildCompletenessPrompt(unclassified: ProactiveItem[]): string {
	const lines = unclassified.map((item) => `- id=${item.id}（${item.title.slice(0, 40)}）`).join("\n");
	return (
		`【系统提示】以下 ${unclassified.length} 个条目尚未完成分类：\n${lines}\n` +
		"请对每条做出处理:值得推送的用 mark_interesting 或 fetch_evidence 抓取证据,不感兴趣的用 mark_not_interesting 标记。" +
		"全部处理完毕后再调用 finish_judgment 给出终局动作。"
	);
}

function buildReflectionPrompt(missingIds: number[]): string {
	return (
		`【系统提示】你已把以下条目选入发送列表,但尚未抓取证据:${missingIds.join(", ")}。\n` +
		"消息中的每个事实必须能追溯到证据。请先对这些条目调用 fetch_evidence,然后再调用 finish_judgment。"
	);
}

/**
 * Run one bounded LLM judgment loop over the candidate items.
 * Returns the tick context; terminalAction defaults to "skip" when the
 * budget is exhausted without a finish call.
 */
export async function runAgentTick(options: AgentTickOptions): Promise<TickContext> {
	const { items, rulesPanel, preferenceBlock, model, baseUrl, apiKey, store, config = {}, toolDeps } = options;
	const recordToolStep = options.recordToolStep;
	const chatLevity = options.chatLevity === true;
	const maxSteps = config.maxSteps ?? 35; // agent_tick_max_steps(akashic 默认 35)
	const webFetchMaxChars = config.webFetchMaxChars ?? 8000;
	const timeoutMs = config.requestTimeoutMs ?? 60_000;
	const fetchFn = config.fetchFn ?? fetch;
	const client = options.client;

	const ctx: TickContext = {
		stepsTaken: 0,
		terminalAction: null,
		interestingItemIds: [],
		discardedItemIds: [],
		skipReason: "",
		skipNote: "",
		evidence: [],
		citedItemIds: [],
		llmCallCount: 0,
		draftMessage: null,
		llmCacheReadTokens: 0,
		llmCacheWriteTokens: 0,
	};

	const messages: ChatCompletionMessage[] = [
		{
			role: "system",
			content: buildSystemPrompt(
				rulesPanel,
				preferenceBlock,
				items,
				options.contextAsFallbackOpen,
				chatLevity,
				options.promptSections,
			),
		},
	];
	const tools = buildToolSchemas(toolDeps, chatLevity);
	// 回环注入的提示(在下一轮作为 user 消息附带,避免连续两条 user 消息)。
	let extraPrompt = "";
	let completenessRounds = 0;
	let sendReflectionRounds = 0;

	/** Alert 条目:免分类,直接可发送;未抓证据也可随 send 发送。 */
	const alertIds = new Set(items.filter((item) => item.kind === "alert").map((item) => item.id));
	/** Content 条目(completeness 只对它生效)。 */
	const contentItems = items.filter((item) => item.kind !== "alert");

	/** 已显式 mark_interesting 的条目。 */
	const explicitlyInteresting = new Set<number>();

	const step = (
		toolName: string,
		toolArgs: string,
		resultText: string,
		callId: string,
		actionAfter: string,
		skipReasonAfter: string,
	): void => {
		messages.push({ role: "tool", toolCallId: callId, content: resultText });
		recordToolStep?.({
			toolName,
			toolArgs,
			resultText,
			actionAfter,
			skipReasonAfter,
			toolCallId: callId,
			interestingIds: [...ctx.interestingItemIds],
			discardedIds: [...ctx.discardedItemIds],
			citedIds: [...ctx.citedItemIds],
			finalMessage: ctx.draftMessage,
		});
	};

	/** 执行一轮 LLM 工具步骤。"finish"=已给出终局;"stop"=本轮无工具调用,终止;否则继续。 */
	const runLlmRound = async (): Promise<"finish" | "continue" | "stop"> => {
		const baseContent = chatLevity
			? "请根据规则决定本轮动作:没有值得发送的内容就 finish_judgment(action=skip, skip_reason=no_content);只有 recent_chat 显示明显未完成话题时才走轻消息路径。"
			: ctx.evidence.length === 0
				? "请逐个判断候选内容:值得推送的用 fetch_evidence 抓取证据或 mark_interesting 标记,不感兴趣的用 mark_not_interesting 标记,然后调用 finish_judgment 给出终局动作。"
				: "已收集的证据如下。可以继续抓取更多证据,或者调用 finish_judgment 给出终局动作。\n\n" +
					buildEvidenceBlock(ctx.evidence);
		const userContent = extraPrompt ? `${baseContent}\n\n${extraPrompt}` : baseContent;
		extraPrompt = "";
		const turnMessages: ChatCompletionMessage[] = [...messages, { role: "user", content: userContent }];

		const response = await callChat(turnMessages, model, baseUrl, apiKey, timeoutMs, fetchFn, client, tools);
		if (!response) {
			ctx.terminalAction = "skip";
			ctx.skipReason = "tick_llm_unavailable";
			return "finish";
		}
		ctx.llmCallCount++;
		const usage = response.message.usage;
		if (usage) {
			ctx.llmCacheReadTokens += Number(usage.cacheRead ?? 0);
			ctx.llmCacheWriteTokens += Number(usage.cacheWrite ?? 0);
		}

		const assistantContent = response.content || null;
		const toolCalls = response.toolCalls.map((call) => ({
			id: call.id,
			name: call.name,
			arguments: parseToolArguments(call.arguments),
		}));
		const assistantMessage: ChatCompletionMessage = {
			role: "assistant",
			...(assistantContent ? { content: assistantContent } : {}),
			...(toolCalls.length > 0 ? { toolCalls } : {}),
		};
		messages.push(assistantMessage);
		ctx.stepsTaken++;

		if (toolCalls.length === 0) {
			// No tool call: invalid finish. Budget exhaustion will default to skip.
			ctx.skipReason = "no_tool_call";
			return "stop";
		}

		let finished = false;
		for (const call of toolCalls) {
			if (finished) break;
			const callId = call.id;
			if (call.name === "fetch_evidence") {
				const itemId = Number(call.arguments.item_id);
				const item = items.find((candidate) => candidate.id === itemId);
				if (item) {
					const snippet = await fetchEvidenceSnippet(item, webFetchMaxChars, store, fetchFn, timeoutMs);
					const evidence: Evidence = {
						id: `ev${ctx.evidence.length + 1}`,
						itemId: item.id,
						source: item.sub_source,
						title: item.title,
						snippet,
						url: item.url ?? "",
					};
					ctx.evidence.push(evidence);
					store.setItemEvidence(item.id, snippet.slice(0, 2000));
					store.setVerdict(item.id, "interesting", "");
					step(
						"fetch_evidence",
						JSON.stringify({ item_id: itemId }),
						`已抓取证据 [${evidence.id}]: ${evidence.title}`,
						callId,
						ctx.terminalAction ?? "continue",
						ctx.skipReason,
					);
				} else {
					step(
						"fetch_evidence",
						JSON.stringify({ item_id: itemId }),
						`未知 item_id: ${itemId}`,
						callId,
						ctx.terminalAction ?? "continue",
						ctx.skipReason,
					);
				}
			} else if (call.name === "get_content") {
				const itemId = Number(call.arguments.item_id);
				const item = items.find((candidate) => candidate.id === itemId);
				if (item) {
					const text = await fetchEvidenceSnippet(item, webFetchMaxChars, store, fetchFn, timeoutMs);
					step(
						"get_content",
						JSON.stringify({ item_id: itemId }),
						`正文:\n${text.slice(0, 1200)}`,
						callId,
						ctx.terminalAction ?? "continue",
						ctx.skipReason,
					);
				} else {
					step(
						"get_content",
						JSON.stringify({ item_id: itemId }),
						`未知 item_id: ${itemId}`,
						callId,
						ctx.terminalAction ?? "continue",
						ctx.skipReason,
					);
				}
			} else if (call.name === "mark_interesting") {
				const ids = validIds(call.arguments.item_ids, items);
				const reason = String(call.arguments.reason ?? "");
				for (const id of ids) {
					explicitlyInteresting.add(id);
					if (!ctx.interestingItemIds.includes(id)) ctx.interestingItemIds.push(id);
					store.setVerdict(id, "interesting", reason);
				}
				step(
					"mark_interesting",
					JSON.stringify({ item_ids: ids, reason }),
					`已标记感兴趣: ${ids.join(", ")}`,
					callId,
					ctx.terminalAction ?? "continue",
					ctx.skipReason,
				);
			} else if (call.name === "mark_not_interesting") {
				const ids = validIds(call.arguments.item_ids, items);
				const reason = String(call.arguments.reason ?? "");
				for (const id of ids) {
					if (!ctx.discardedItemIds.includes(id)) ctx.discardedItemIds.push(id);
					store.setVerdict(id, "not_interesting", reason);
					store.markDismissed(id);
				}
				step(
					"mark_not_interesting",
					JSON.stringify({ item_ids: ids, reason }),
					`已标记不感兴趣: ${ids.join(", ")}`,
					callId,
					ctx.terminalAction ?? "continue",
					ctx.skipReason,
				);
			} else if (call.name === "get_recent_chat" && toolDeps?.recentChatFn) {
				const text = String(await toolDeps.recentChatFn()).slice(0, 4000);
				step(
					"get_recent_chat",
					"{}",
					`最近对话:\n${text || "(空)"}`,
					callId,
					ctx.terminalAction ?? "continue",
					ctx.skipReason,
				);
			} else if (call.name === "recall_memory" && toolDeps?.recallMemoryFn) {
				const query = String(call.arguments.query ?? "").trim();
				const text = String(await toolDeps.recallMemoryFn(query)).slice(0, 3000);
				step(
					"recall_memory",
					JSON.stringify({ query }),
					`记忆召回:\n${text || "(无结果)"}`,
					callId,
					ctx.terminalAction ?? "continue",
					ctx.skipReason,
				);
			} else if (call.name === "web_fetch" && toolDeps?.webFetchFn) {
				const url = String(call.arguments.url ?? "").trim();
				const result = await toolDeps.webFetchFn(
					url,
					toolDeps.webFetchMaxChars ?? webFetchMaxChars,
					toolDeps.webRequestTimeoutMs ?? timeoutMs,
				);
				step(
					"web_fetch",
					JSON.stringify({ url }),
					result.error ? `抓取失败: ${result.error}` : `正文:\n${(result.text ?? "").slice(0, 1200)}`,
					callId,
					ctx.terminalAction ?? "continue",
					ctx.skipReason,
				);
			} else if (call.name === "web_search" && toolDeps?.webSearchFn) {
				const query = String(call.arguments.query ?? "").trim();
				const results = await toolDeps.webSearchFn(
					query,
					toolDeps.webSearchMaxResults ?? 5,
					toolDeps.webRequestTimeoutMs ?? timeoutMs,
				);
				const lines = results.map(
					(item, index) => `[${index + 1}] ${item.title}\n   url=${item.url}\n   ${item.snippet.slice(0, 300)}`,
				);
				step(
					"web_search",
					JSON.stringify({ query }),
					`搜索结果:\n${lines.join("\n") || "(无结果)"}`,
					callId,
					ctx.terminalAction ?? "continue",
					ctx.skipReason,
				);
			} else if (call.name === "message_push") {
				const message = String(call.arguments.message ?? "").trim();
				if (!message) {
					step(
						"message_push",
						"{}",
						"错误:message 不能为空",
						callId,
						ctx.terminalAction ?? "continue",
						ctx.skipReason,
					);
				} else if (ctx.draftMessage !== null) {
					step(
						"message_push",
						JSON.stringify({ message }),
						"错误:本轮已暂存过消息,不要重复调用;直接 finish_judgment",
						callId,
						ctx.terminalAction ?? "continue",
						ctx.skipReason,
					);
				} else {
					ctx.draftMessage = message;
					step(
						"message_push",
						JSON.stringify({ message }),
						"草稿已暂存。可以继续抓取证据,或直接 finish_judgment 提交。",
						callId,
						ctx.terminalAction ?? "continue",
						ctx.skipReason,
					);
				}
			} else if (call.name === "finish_judgment") {
				const action = call.arguments.action;
				const itemIds = validIds(call.arguments.item_ids, items);
				// Alert 快速路径:send 时 alert 条目自动进入 evidence(无需先抓证据)。
				if (action === "send") {
					for (const id of itemIds) {
						if (!alertIds.has(id)) continue;
						if (ctx.evidence.some((evidence) => evidence.itemId === id)) continue;
						const item = items.find((candidate) => candidate.id === id);
						if (!item) continue;
						ctx.evidence.push({
							id: `ev${ctx.evidence.length + 1}`,
							itemId: id,
							source: item.sub_source,
							title: item.title,
							snippet: (item.summary ?? item.title).slice(0, 1200),
							url: item.url ?? "",
						});
					}
				}
				// 完整性回环(akashic judge.py):skip 时若还有未分类 content → 要求补齐分类。
				const unclassified = contentItems.filter(
					(item) =>
						!ctx.evidence.some((evidence) => evidence.itemId === item.id) &&
						!ctx.discardedItemIds.includes(item.id) &&
						!explicitlyInteresting.has(item.id),
				);
				if (action === "skip" && unclassified.length > 0 && completenessRounds < MAX_COMPLETENESS_ROUNDS) {
					completenessRounds++;
					extraPrompt = buildCompletenessPrompt(unclassified);
					continue;
				}
				// 发送缺证据回环(akashic reflection 的 pi 适配):send 的 content 条目必须有证据(alert 豁免)。
				const missingEvidence = itemIds.filter(
					(id) => !alertIds.has(id) && !ctx.evidence.some((evidence) => evidence.itemId === id),
				);
				if (action === "send" && missingEvidence.length > 0 && sendReflectionRounds < MAX_REFLECTION_ROUNDS) {
					sendReflectionRounds++;
					extraPrompt = buildReflectionPrompt(missingEvidence);
					continue;
				}
				// message_push 草稿是可选的(akashic: 草稿供 resolve 优先使用;最终消息仍由证据生成)。
				ctx.terminalAction = action === "send" || action === "context_only" ? action : "skip";
				ctx.interestingItemIds = ctx.terminalAction === "send" ? itemIds : [];
				// 引用的条目 = 终局 send 选中的条目(akashic cited_item_ids)。
				ctx.citedItemIds = ctx.terminalAction === "send" ? itemIds : [];
				ctx.skipReason = ctx.terminalAction === "skip" ? String(call.arguments.skip_reason ?? "judgment_skip") : "";
				ctx.skipNote = String(call.arguments.skip_reason ?? "");
				finished = true;
			}
		}
		return finished ? "finish" : "continue";
	};

	while (ctx.stepsTaken < maxSteps) {
		const outcome = await runLlmRound();
		if (outcome !== "continue") break;
	}

	// 证据已收集但未给出终局 → 强制收尾(akashic judge.py reflection,最多 3 轮)。
	let forceFinishRounds = 0;
	while (
		ctx.terminalAction === null &&
		ctx.evidence.length > 0 &&
		ctx.stepsTaken < maxSteps &&
		forceFinishRounds < MAX_REFLECTION_ROUNDS
	) {
		forceFinishRounds++;
		extraPrompt =
			"【系统提示】你已收集证据,但尚未调用 finish_judgment 给出终局动作。请立即调用 finish_judgment(send/skip/context_only)。";
		const outcome = await runLlmRound();
		if (outcome !== "continue") break;
	}

	if (ctx.terminalAction === null) {
		ctx.terminalAction = "skip";
		if (!ctx.skipReason) ctx.skipReason = "step_budget_exhausted";
	}
	// 未分类或已标记不感兴趣的候选一律不发送;alert 条目随 send 自动带上证据。
	ctx.interestingItemIds = ctx.interestingItemIds.filter(
		(id) =>
			!ctx.discardedItemIds.includes(id) &&
			(ctx.evidence.some((evidence) => evidence.itemId === id) || alertIds.has(id)),
	);
	ctx.citedItemIds = ctx.citedItemIds.filter((id) => ctx.interestingItemIds.includes(id));
	return ctx;
}

function validIds(raw: unknown, items: ProactiveItem[]): number[] {
	const list = Array.isArray(raw) ? raw : [];
	return list
		.map((value) => Number(value))
		.filter((id) => Number.isFinite(id) && items.some((item) => item.id === id));
}

async function callChat(
	messages: ChatCompletionMessage[],
	model: string,
	baseUrl: string,
	apiKey: string | undefined,
	timeoutMs: number,
	fetchFn: typeof fetch,
	client: ChatCompletionClient | undefined,
	tools: ChatCompletionTool[],
): Promise<ChatCompletionResponse | undefined> {
	try {
		if (client) {
			return await client.complete({
				messages,
				tools,
				toolChoice: "auto",
				maxTokens: 2048,
				temperature: 0,
				fetchFn,
			});
		}
		const compatible = new OpenAICompatibleChatClient({
			model,
			baseUrl,
			apiKey: apiKey ?? "",
			requestTimeoutMs: timeoutMs,
		});
		return await compatible.complete({
			messages,
			tools,
			toolChoice: "auto",
			maxTokens: 2048,
			temperature: 0,
			fetchFn,
		});
	} catch {
		return undefined;
	}
}

// ------------------------------------------------------------------
// 判题策略(默认:LLM agent tick,证据收集 + 终局动作)
// ------------------------------------------------------------------

import type { JudgeStrategy, JudgeVerdict, TurnContext } from "./types.ts";

export interface AgentTickJudgeOptions {
	model: string;
	baseUrl: string;
	apiKey: string | undefined;
	/** 宿主注入的 ChatCompletionClient(pi-host ModelRuntime);缺省走配置式客户端。 */
	client?: ChatCompletionClient;
	config?: TickConfig;
	toolDeps?: TickToolDeps;
}

export class AgentTickJudgeStrategy implements JudgeStrategy {
	readonly id = "agent-tick";
	private readonly options: AgentTickJudgeOptions;

	constructor(options: AgentTickJudgeOptions) {
		this.options = options;
	}

	async judge(items: ProactiveItem[], ctx: TurnContext): Promise<JudgeVerdict> {
		if (!this.options.apiKey && !this.options.client) {
			return { action: "skip", itemIds: [], evidence: [], skipReason: "no_api_key", stepsTaken: 0 };
		}
		const tickCtx = await runAgentTick({
			items,
			rulesPanel: ctx.rulesPanel,
			preferenceBlock: ctx.preferenceBlock,
			promptSections: ctx.promptSections,
			contextAsFallbackOpen: ctx.contextAsFallbackOpen,
			chatLevity: ctx.chatLevity,
			model: this.options.model,
			baseUrl: this.options.baseUrl,
			apiKey: this.options.apiKey,
			client: this.options.client,
			store: ctx.store,
			config: this.options.config,
			toolDeps: this.options.toolDeps,
			recordToolStep: ctx.recordToolStep,
		});
		return {
			action: tickCtx.terminalAction ?? "skip",
			itemIds: tickCtx.interestingItemIds,
			evidence: tickCtx.evidence,
			skipReason: tickCtx.skipReason,
			stepsTaken: tickCtx.stepsTaken,
			discardedItemIds: tickCtx.discardedItemIds,
			citedItemIds: tickCtx.citedItemIds,
			llmCallCount: tickCtx.llmCallCount,
			draftMessage: tickCtx.draftMessage,
			llmCacheReadTokens: tickCtx.llmCacheReadTokens,
			llmCacheWriteTokens: tickCtx.llmCacheWriteTokens,
		};
	}
}
