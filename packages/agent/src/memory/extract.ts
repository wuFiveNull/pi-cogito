/**
 * 对话记忆提取器(akashic core/memory/markdown.py consolidation 移植,范围 B)。
 *
 * 从会话中按窗口选择新消息 → LLM 提取 history_entries(向量库事件)+ pending_items
 * (7 种 tag + 硬过滤规则)→ 校验并格式化 → appendPendingOnce(按 source_ref 幂等)
 * → 通过 onConsolidated 回调把 history_entries/conversation/scope 交给向量层桥
 * (host ConsolidationBridge)→ 推进游标。
 */

import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { atomicWriteText, type MarkdownMemoryStore } from "./markdown-store.ts";
import type { MemoryLlm } from "./optimizer.ts";
import { refreshRecentContext } from "./recent-context.ts";

const ALLOWED_PENDING_TAGS = new Set([
	"identity",
	"preference",
	"key_info",
	"health_long_term",
	"requested_memory",
	"correction",
	"agent_context",
]);

export interface SessionMessageLike {
	id?: string;
	role?: string;
	content?: unknown;
	timestamp?: string;
	proactive?: boolean;
}

export interface ConsolidationWindow {
	oldMessages: SessionMessageLike[];
	consolidateUpTo: number;
}

export interface ConsolidationConfig {
	/** 保留在会话里的最新消息数(akashic keep_count)。 */
	keepCount?: number;
	/** 至少新增多少条才触发一次 consolidation(akashic max(5, keep_count//2))。 */
	minNewMessages?: number;
	/** 单页对话最大字符数(akashic consolidation_input_budget)。 */
	maxConversationChars?: number;
	force?: boolean;
}

const DEFAULT_KEEP_COUNT = 50;
const DEFAULT_MAX_CONVERSATION_CHARS = 100_000;

// ------------------------------------------------------------------
// 窗口选择(akashic _select_consolidation_window / _limit_consolidation_window)
// ------------------------------------------------------------------

export function selectConsolidationWindow(options: {
	messages: SessionMessageLike[];
	lastConsolidated: number;
	keepCount: number;
	minNewMessages: number;
	force?: boolean;
}): ConsolidationWindow | null {
	const { messages, lastConsolidated, keepCount, minNewMessages, force = false } = options;
	const total = messages.length;
	if (total - lastConsolidated <= 0) return null;
	if (!force && total <= keepCount) return null;
	const consolidateUpTo = force ? total : total - keepCount;
	const oldMessages = messages.slice(lastConsolidated, consolidateUpTo);
	if (oldMessages.length === 0) return null;
	if (!force && oldMessages.length < Math.max(1, minNewMessages)) return null;
	return { oldMessages, consolidateUpTo };
}

/** 按语义回合分组 + 字符预算装页,返回选定消息与绝对游标(akashic _limit_consolidation_window)。 */
export function limitWindowByChars(
	window: ConsolidationWindow,
	maxChars: number,
): { selected: SessionMessageLike[]; consolidateUpTo: number } {
	const groups: SessionMessageLike[][] = [];
	for (const message of window.oldMessages) {
		if (message.role === "user" || groups.length === 0) groups.push([]);
		groups[groups.length - 1]!.push(message);
	}
	const selected: SessionMessageLike[] = [];
	let usedChars = 0;
	for (const group of groups) {
		const rendered = formatConversation(group);
		const addedChars = rendered.length + (rendered && selected.length > 0 ? 1 : 0);
		if (selected.length > 0 && usedChars + addedChars > maxChars) break;
		selected.push(...group);
		usedChars += addedChars;
	}
	return {
		selected,
		consolidateUpTo:
			selected.length === window.oldMessages.length
				? window.consolidateUpTo
				: window.consolidateUpTo - window.oldMessages.length + selected.length,
	};
}

/** 会话格式化为 "[ts] ROLE: content"(akashic _format_conversation_for_consolidation)。 */
export function formatConversation(messages: SessionMessageLike[]): string {
	const lines: string[] = [];
	for (const message of messages) {
		if (!message.content || message.role === "tool") continue;
		if (message.role === "assistant" && message.proactive) continue;
		const role = String(message.role ?? "").toUpperCase();
		const ts = String(message.timestamp ?? "?").slice(0, 16);
		lines.push(`[${ts}] ${role}: ${messageText(message.content)}`);
	}
	return lines.join("\n");
}

export function messageText(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (Array.isArray(content)) {
		return content
			.filter((part): part is { type: string; text?: string } => typeof part === "object" && part !== null)
			.map((part) => (part.type === "text" ? (part.text ?? "") : ""))
			.join(" ")
			.trim();
	}
	return "";
}

// ------------------------------------------------------------------
// 输出校验(akashic _format_pending_items)
// ------------------------------------------------------------------

export function formatPendingItems(rawItems: unknown): string {
	if (!Array.isArray(rawItems)) throw new Error("pending_items must be an array");
	const lines: string[] = [];
	const seen = new Set<string>();
	for (const item of rawItems) {
		if (typeof item !== "object" || item === null) throw new Error("pending_items entries must be objects");
		const record = item as Record<string, unknown>;
		const rawTag = record.tag;
		const rawContent = record.content;
		if (typeof rawTag !== "string" || typeof rawContent !== "string") {
			throw new Error("pending_items tag and content must be strings");
		}
		const tag = rawTag.trim().toLowerCase();
		const content = rawContent.trim();
		if (!ALLOWED_PENDING_TAGS.has(tag) || !content) continue;
		const line = `- [${tag}] ${content}`;
		if (seen.has(line)) continue;
		seen.add(line);
		lines.push(line);
	}
	return lines.join("\n");
}

/** 单条 history entry(向量库 event 类型写入用)。 */
export interface HistoryEntry {
	summary: string;
	emotionalWeight: number;
}

/** 宽容归一化 emotional_weight(akashic engine._coerce_emotional_weight):非法值归 0,范围 0-10。 */
export function coerceEmotionalWeight(value: unknown): number {
	const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
	if (!Number.isFinite(parsed)) return 0;
	return Math.max(0, Math.min(10, Math.trunc(parsed)));
}

/**
 * 校验并归一化模型输出的 history_entries(akashic _normalize_history_entries):
 * 兼容字符串数组与 {summary, emotional_weight} 对象数组,按摘要去重;
 * summary 非字符串视为结构性错误(整页失败),其余非法值跳过。
 */
export function normalizeHistoryEntries(rawEntries: unknown): HistoryEntry[] {
	const entries: HistoryEntry[] = [];
	const seen = new Set<string>();
	const candidates: unknown[] = [];
	if (Array.isArray(rawEntries)) {
		candidates.push(...rawEntries);
	} else if (rawEntries !== undefined && rawEntries !== null) {
		if (typeof rawEntries !== "string" && (typeof rawEntries !== "object" || Array.isArray(rawEntries))) {
			throw new Error("history_entries must be an array or object");
		}
		candidates.push(rawEntries);
	}
	for (const item of candidates) {
		let summary: string;
		let emotionalWeight = 0;
		if (typeof item === "string") {
			summary = item.trim();
		} else if (typeof item === "object" && item !== null) {
			const record = item as Record<string, unknown>;
			if (typeof record.summary !== "string") {
				throw new Error("history entry summary must be a string");
			}
			summary = record.summary.trim();
			emotionalWeight = coerceEmotionalWeight(record.emotional_weight);
		} else {
			throw new Error("history_entries entries must be strings or objects");
		}
		if (!summary || seen.has(summary)) continue;
		seen.add(summary);
		entries.push({ summary, emotionalWeight });
	}
	return entries;
}

/** 宽松 JSON 解析(容忍 ```json 围栏与前后杂文)。 */
export function parseJsonLoose(text: string): unknown {
	const trimmed = text.trim();
	const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```\s*$/);
	const candidate = (fenced ? (fenced[1] ?? "").trim() : trimmed).trim();
	try {
		return JSON.parse(candidate) as unknown;
	} catch {
		const start = candidate.indexOf("{");
		const end = candidate.lastIndexOf("}");
		if (start >= 0 && end > start) {
			try {
				return JSON.parse(candidate.slice(start, end + 1)) as unknown;
			} catch {
				return undefined;
			}
		}
		return undefined;
	}
}

// ------------------------------------------------------------------
// 提取 prompt(akashic consolidation prompt 的 pending_items 部分)
// ------------------------------------------------------------------

const EXTRACTION_SYSTEM = `你是记忆提取代理(Memory Extraction Agent)。从对话中精确提取结构化信息,只返回 JSON。`;

export function buildExtractionPrompt(options: {
	conversation: string;
	currentMemory: string;
	recentContext?: string;
}): string {
	return `从对话中提取结构化信息,返回 JSON。

## 字段说明

### 1. "history_entries" → 记忆事件条目(数组,每条对应一个独立主题)
按主题拆分,每个独立话题写一条对象,格式为 {"summary":"...", "emotional_weight":0}。
summary 要求 1-2 句,以 [YYYY-MM-DD HH:MM] 开头,保留足够细节便于后续向量写入和回源判断。
不同主题必须拆成独立条目,不得合并。若整段对话只有一个主题,返回只含一条的数组。

history_entries.emotional_weight 规则:
- 范围 0-10
- 普通技术讨论、普通事务记录、无明显情绪色彩 → 0
- 用户明确表达强烈喜欢/厌恶、明显受挫、关系冲突、情绪波动时按强度给 3-9
- 不确定时保守输出 0

**history_entries 提取规则(严格遵守)**:
1. 只提取 USER 明确表达的行动、经历、计划和状态;ASSISTANT 的建议、推荐、解释一律不写入,即使其中提到了地名、店名或活动。
2. 每条必须是简洁的第三人称摘要句,绝对不能包含 "USER:" 或 "ASSISTANT:" 等原始对话标记,不得复制粘贴原始对话文本。
3. 商家名称、地点、人名、数量、价格、型号等具体细节必须保留,不得用"某商店""某地方"概括。
4. 先判断当前 USER 内容的材料类型:是"用户此刻直接自述",还是"用户正在展示一段外部聊天记录、截图 OCR、转贴 transcript 给助手看"。
5. 若 USER 内容属于外部聊天记录 / transcript,必须先做层级理解:外层是用户把材料发给助手看;内层材料中可能有多个 speaker,这些 speaker 不自动等于当前 USER。只有当某个 speaker 与当前 USER 的映射在当前会话里被明确确认时,才允许把该 speaker 的事实写入摘要。
6. 对 transcript 场景,默认认为 speaker 映射不明确;除非当前会话中有非常明确的显式说明,否则不要判断材料里的昵称/说话人就是用户或对方。
7. 若 speaker 映射不明确,history_entries 只允许写 1 条高层 event,例如"用户向助手展示了一段与某人的聊天记录,内容涉及求职、学校、兴趣等话题"。
8. 对 transcript 场景,禁止输出任何未确认关系的句子,如"用户向对方透露……""对方是……""双方确认……",或把聊天记录里的具体事实直接写成用户个人经历。
9. transcript 场景下,默认最多输出 1 条高层 history_entry;不要下钻成人物小传,不要替 speaker 自动补全身份关系。

### 2. "pending_items" → PENDING.md 候选缓冲
只写用户的长期记忆候选,返回对象数组。每个对象格式:
{"tag": "<tag>", "content": "<string>"}

允许的 tag 只有 7 个:
- "identity":稳定背景事实,如身份、学校/专业、长期技术方向、实习/工作经历、长期设备、长期维护项目
- "preference":稳定偏好、禁忌、审美、游戏口味、价值取向
- "key_info":用户明确允许保存的 key / token / id / 账号信息
- "health_long_term":长期健康状态的一阶事实,只写长期状态,不写动态指标、基线、最近波动
- "requested_memory":用户明确要求"长期记住"的关键内容,可比普通事实更连贯
- "correction":对当前 MEMORY.md 现有事实的明确纠正
- "agent_context":助手操作用户环境所需的工具性配置,如已部署服务的端口、环境变量名、工具分工约定、常用登录站点列表;不是用户画像,但对助手执行操作有长期价值;具体参数(端口号、变量名)必须完整保留。**硬规则:只有当对话明确表明该配置当前有效且助手已被授权使用时才提取;方案讨论、架构设计、网络诊断中出现的端口和地址一律不提取**

必须遵守:
- 只写跨对话仍有长期价值的内容
- 不写 agent 执行规则、SOP、工具调用顺序、流程规范
- 不写短期状态、近期计划、日程、课表、一次性操作
- 不写动态健康数据、实时指标、最近状态
- 不写对话过程总结
- "requested_memory" 只能在用户明确表达"记住这个 / 写进长期记忆 / 以后要能聊到 / 希望你记住"时使用

进阶过滤(四条硬规则,任一触发即不提取):

1. **网络运维细节不提取**
内网 IP、路由模式(如"CGNAT""桥接模式""NAT")、运营商名称、MAC 地址等网络层配置属于瞬时运维信息,不提取。项目路径、配置文件名、环境变量名等与用户开发环境直接相关的信息可以提取。
✗ "家庭网络是联通宽带,光猫路由模式,内网 IP 192.168.1.x" → 不提取(网络层瞬时配置)
✓ "项目位于 /home/user/project,配置文件 config.toml" → 可提取(开发环境画像)

2. **临时状态不提取,规律习惯可提取**
带"最近""这周""目前""正在"等时间限定词的瞬时状态不提取。每周/每天持续的规律性行为模式可以提取为偏好或习惯标识。
✗ "用户最近加班频繁,靠咖啡撑着" → 不提取(瞬时状态,随时会变)
✓ "用户每周去健身房,主要做力量训练" → 可提取(规律性习惯,是长期生活方式)

3. **时效性数字和瞬时情绪不提取**
带有具体数值的动态指标(如 Star 数、增长率、评分)、瞬时情绪描述(如"失落""焦虑")。保留背后的价值判断,不提取数字和情绪本身。
✗ "项目刚突破 500 Star,但增速降到每天 2 个,用户为此很焦虑" → 不提取(数字过期、情绪瞬时)
✓ "用户长期维护某开源项目并重视社区增长" → 可提取(稳定身份信息)

4. **Agent 执行规则不放入 pending_items**
以"偏好"开头但语义上描述 agent 应如何执行的内容(如检索策略、元数据标注规范、输出格式要求等),属于 procedure,不提取。
✗ "偏好搜索结果按来源可信度分层展示" → 不提取(agent 输出规范)
✗ "希望以后推荐前先查最新评测和社区反馈" → 不提取(agent 执行规则)

5. **agent_context 只提取已部署的配置,不提取方案讨论**
判断标准:对话中是否明确表明该服务/工具**当前已在运行**,且助手**已被告知可以使用**。
反例(方案讨论 → 不提取):用户在讨论"可以搭一个 X 服务监听某端口"、"我们可以用 Y 工具穿透"、问助手"这个配置怎么搭"、对话中出现的 IP/端口是为了排查问题或讲解原理。
正例(已部署、已授权 → 提取):用户明确告知助手"X 服务现在跑着,你可以直接用"、"以后遇到 Y 场景就调这个接口"、描述了某个长期运行的工具并期望助手在后续任务中利用它。

若没有合格条目,返回空数组 []。

---

## 当前用户档案(用于查重)
${options.currentMemory || "（空）"}

${
	options.recentContext
		? `## 当前 RECENT_CONTEXT.md(仅用于主题延续参考)
使用原则:这份近期语境只能帮助你理解"当前窗口大概在延续什么话题",不能作为人物身份、说话人归属、关系判断或具体事实归属的直接证据。若与当前窗口原文冲突,必须以当前窗口原文为准。
${options.recentContext}\n`
		: ""
}
## 待处理对话
${options.conversation}

只返回合法 JSON:{"history_entries": [...], "pending_items": [...]}。不要 markdown 代码块。`;
}

// ------------------------------------------------------------------
// 会话游标
// ------------------------------------------------------------------

export interface SessionCursorStore {
	getCursor(sessionFile: string): number;
	setCursor(sessionFile: string, cursor: number): void;
}

/** 基于 memory 目录 JSON 文件的游标存储。 */
export class FileCursorStore implements SessionCursorStore {
	private readonly statePath: string;
	private state: Record<string, number>;

	constructor(memoryDir: string) {
		this.statePath = join(memoryDir, "consolidation_state.json");
		try {
			this.state = JSON.parse(readFileSync(this.statePath, "utf-8")) as Record<string, number>;
		} catch {
			this.state = {};
		}
	}

	getCursor(sessionFile: string): number {
		return this.state[sessionFile] ?? 0;
	}

	setCursor(sessionFile: string, cursor: number): void {
		this.state[sessionFile] = cursor;
		atomicWriteText(this.statePath, JSON.stringify(this.state, null, 2));
	}
}

// ------------------------------------------------------------------
// 提取与提交
// ------------------------------------------------------------------

export interface ExtractPendingOptions {
	conversation: string;
	currentMemory: string;
	recentContext?: string;
}

/** LLM 输出的校验后产物:历史事件条目 + PENDING 行文本。 */
export interface ExtractionPayload {
	historyEntries: HistoryEntry[];
	pendingItems: string;
}

/** 提取器:LLM 输出 → 校验 → historyEntries + "- [tag] content" 行。 */
export class ConsolidationExtractor {
	private readonly llm: MemoryLlm;

	constructor(llm: MemoryLlm) {
		this.llm = llm;
	}

	async extract(options: ExtractPendingOptions): Promise<ExtractionPayload> {
		const prompt = buildExtractionPrompt(options);
		const raw = await this.llm.chat(EXTRACTION_SYSTEM, prompt, 4096);
		const parsed = parseJsonLoose(raw);
		const record =
			parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
		const historyEntries = normalizeHistoryEntries(record.history_entries);
		const items = record.pending_items;
		if (items === undefined) throw new Error("pending_items missing from extraction output");
		return { historyEntries, pendingItems: formatPendingItems(items) };
	}

	/** 兼容旧入口:只返回 PENDING 行文本。 */
	async extractPendingItems(options: ExtractPendingOptions): Promise<string> {
		return (await this.extract(options)).pendingItems;
	}
}

export interface ConsolidateSessionResult {
	extracted: string;
	historyEntries: HistoryEntry[];
	consolidated: number;
	cursor: number;
	sourceRef: string;
}

/**
 * 向量层桥接载荷:markdown 写入完成后交给 host ConsolidationBridge。
 * history_entries 与 conversation 供 event 写入与第二遍隐式长期提取使用。
 */
export interface ConsolidatedPayload {
	/** 本次 consolidation 窗口的 source_ref(与 PENDING 幂等键一致)。 */
	sourceRef: string;
	historyEntries: HistoryEntry[];
	/** 窗口对话文本("[ts] ROLE: content"),隐式长期提取只允许依据 USER 原话。 */
	conversation: string;
	/** 来源会话的渠道作用域;无法推断时为空字符串(全局 scope)。 */
	scope: { channel: string; chatId: string };
}

/** 从会话 key / jsonl 路径启发式推断 channel/chatId(形如 "<channel>:<chatId>.jsonl")。 */
export function parseSessionScope(sessionKey: string): { channel: string; chatId: string } | undefined {
	const base = basename(sessionKey).replace(/\.jsonl$/i, "");
	const colon = base.indexOf(":");
	if (colon <= 0) return undefined;
	const channel = base.slice(0, colon).trim();
	const chatId = base.slice(colon + 1).trim();
	if (!channel || !chatId) return undefined;
	// Windows 盘符("C:foo")不是渠道。
	if (/^[A-Za-z]:/.test(base)) return undefined;
	return { channel, chatId };
}

export interface ConsolidateMessagesOptions {
	store: MarkdownMemoryStore;
	llm: MemoryLlm;
	/** Stable key used by the cursor and pending source reference. */
	sessionKey: string;
	messages: SessionMessageLike[];
	cursorStore: SessionCursorStore;
	config?: ConsolidationConfig;
	/** 向量层桥接回调:markdown 写入后、游标推进前调用;抛错则游标不推进,下轮重试(幂等)。 */
	onConsolidated?: (payload: ConsolidatedPayload) => Promise<void> | void;
	/** 显式作用域解析;缺省按会话文件名启发式推断(parseSessionScope)。 */
	resolveScope?: (sessionFile: string) => { channel: string; chatId: string } | undefined;
	/**
	 * 刷新 RECENT_CONTEXT.md(akashic recent_context 压缩)。只应在低频周期路径
	 * (ConsolidationLoop)开启;before_turn 每轮路径保持关闭,避免逐轮多一次 LLM 调用。
	 */
	writeRecentContext?: boolean;
}

/** 读取一个会话 jsonl 文件为消息列表。 */
export function readSessionJsonl(sessionFile: string): SessionMessageLike[] {
	const messages: SessionMessageLike[] = [];
	let lines: string[];
	try {
		lines = readFileSync(sessionFile, "utf-8").split("\n");
	} catch {
		return messages;
	}
	for (const line of lines) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line) as {
				type?: string;
				id?: string;
				message?: { role?: string; content?: unknown; timestamp?: string };
			};
			if (entry.type !== "message" || !entry.message) continue;
			messages.push({
				id: entry.id,
				role: entry.message.role,
				content: entry.message.content,
				timestamp: entry.message.timestamp,
			});
		} catch {
			// 坏行跳过。
		}
	}
	return messages;
}

/** 对内存中的消息列表 consolidation:选窗 → 提取 → 幂等追加 → 桥接回调 → 推进游标。 */
export async function consolidateMessages(options: ConsolidateMessagesOptions): Promise<ConsolidateSessionResult> {
	const { store, llm, sessionKey, messages, cursorStore, config = {} } = options;
	const keepCount = config.keepCount ?? DEFAULT_KEEP_COUNT;
	const minNewMessages = config.minNewMessages ?? Math.max(5, Math.floor(keepCount / 2));
	const maxChars = config.maxConversationChars ?? DEFAULT_MAX_CONVERSATION_CHARS;
	const cursor = cursorStore.getCursor(sessionKey);

	const window = selectConsolidationWindow({
		messages,
		lastConsolidated: cursor,
		keepCount,
		minNewMessages,
		force: config.force,
	});
	if (!window) return { extracted: "", historyEntries: [], consolidated: 0, cursor, sourceRef: "" };

	const limited = limitWindowByChars(window, maxChars);
	const conversation = formatConversation(limited.selected);
	if (!conversation.trim()) {
		cursorStore.setCursor(sessionKey, limited.consolidateUpTo);
		return {
			extracted: "",
			historyEntries: [],
			consolidated: limited.selected.length,
			cursor: limited.consolidateUpTo,
			sourceRef: "",
		};
	}

	const currentMemory = store.readLongTerm();
	const extractor = new ConsolidationExtractor(llm);
	const extracted = await extractor.extract({
		conversation,
		currentMemory,
		recentContext: store.readRecentContext() || undefined,
	});

	const ids = limited.selected.map((message) => message.id).filter((id): id is string => Boolean(id));
	const sourceRef =
		ids.length > 0 ? JSON.stringify(ids) : `${basename(sessionKey)}:${cursor}-${limited.consolidateUpTo}`;
	if (extracted.pendingItems) {
		store.appendPendingOnce(extracted.pendingItems, { sourceRef, kind: "pending_items" });
	}
	// 近期语境压缩:失败内部吞掉,不阻断主流程。
	if (options.writeRecentContext) {
		const selected = limited.selected;
		await refreshRecentContext({
			store,
			llm,
			messages,
			conversation,
			compressionUntil: selected.length > 0 ? String(selected[selected.length - 1]?.timestamp ?? "") : "",
			keepCount,
		});
	}
	// 向量层同步在游标推进前完成:失败则游标不推进,下轮按 source_ref 幂等重试。
	if (options.onConsolidated) {
		const scope = options.resolveScope?.(sessionKey) ?? parseSessionScope(sessionKey) ?? { channel: "", chatId: "" };
		await options.onConsolidated({
			sourceRef,
			historyEntries: extracted.historyEntries,
			conversation,
			scope,
		});
	}
	cursorStore.setCursor(sessionKey, limited.consolidateUpTo);
	return {
		extracted: extracted.pendingItems,
		historyEntries: extracted.historyEntries,
		consolidated: limited.selected.length,
		cursor: limited.consolidateUpTo,
		sourceRef,
	};
}

/** 单会话 consolidation:选窗 → 提取 → 幂等追加 → 桥接回调 → 推进游标。 */
export async function consolidateSession(options: {
	store: MarkdownMemoryStore;
	llm: MemoryLlm;
	sessionFile: string;
	cursorStore: SessionCursorStore;
	config?: ConsolidationConfig;
	onConsolidated?: ConsolidateMessagesOptions["onConsolidated"];
	resolveScope?: ConsolidateMessagesOptions["resolveScope"];
	writeRecentContext?: boolean;
}): Promise<ConsolidateSessionResult> {
	return consolidateMessages({
		store: options.store,
		llm: options.llm,
		sessionKey: options.sessionFile,
		messages: readSessionJsonl(options.sessionFile),
		cursorStore: options.cursorStore,
		config: options.config,
		onConsolidated: options.onConsolidated,
		resolveScope: options.resolveScope,
		writeRecentContext: options.writeRecentContext,
	});
}

export { DEFAULT_KEEP_COUNT };
