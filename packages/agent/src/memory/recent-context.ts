/**
 * 近期语境压缩(akashic core/memory/markdown.py recent_context 部分移植)。
 *
 * consolidation 时把窗口对话交给 LLM 保守压缩为五类近期语境
 * (active_topics / user_preferences / follow_ups / avoidances / ongoing_threads),
 * 渲染成 RECENT_CONTEXT.md(Compression + Ongoing Threads + Recent Turns),
 * 供 chat 每轮注入与 proactive/drift 参考。
 *
 * 与 akashic 的差异:akashic 有独立 recent_context_provider,cogito 复用
 * MemoryLlm(同一次 consolidation 的第二段 LLM 调用);失败只跳过写入,
 * 不阻断主提取流程。
 */

import type { SessionMessageLike } from "./extract.ts";
import { parseJsonLoose } from "./extract.ts";
import type { MarkdownMemoryStore } from "./markdown-store.ts";
import type { MemoryLlm } from "./optimizer.ts";

export const RECENT_CONTEXT_SYSTEM = "你是近期语境压缩代理，只返回合法 JSON。";

/** 近期语境五类压缩字段(akashic _normalize_recent_context_compression)。 */
export interface RecentContextCompression {
	activeTopics: string[];
	userPreferences: string[];
	followUps: string[];
	avoidances: string[];
	ongoingThreads: string[];
}

export function emptyCompression(): RecentContextCompression {
	return { activeTopics: [], userPreferences: [], followUps: [], avoidances: [], ongoingThreads: [] };
}

/** Recent Turns 保留条数(akashic _recent_turn_count)。 */
export function recentTurnCount(keepCount: number): number {
	return Math.max(1, Math.floor(keepCount / 2));
}

// ------------------------------------------------------------------
// 近期语境 prompt(akashic _build_recent_context_prompt 移植)
// ------------------------------------------------------------------

export function buildRecentContextPrompt(options: {
	oldRecentContext: string;
	conversation: string;
	recentTurns: string;
}): string {
	return `你是近期语境压缩代理。你的任务不是自由总结，而是为后续 proactive 和 drift 保守地抽取近期语境。

目标：
1. 提取用户最近持续关注的话题
2. 提取最近新暴露、但尚未沉淀为长期记忆的显式偏好
3. 提取最近适合自然续接的话题
4. 提取最近应避免打扰、应避免推荐、或明显不想聊的方向
5. 提取跨窗口持续存在的重要现实线索（ongoing_threads）

规则：
- 只允许依据 USER 明确表达过的内容输出；ASSISTANT 的建议、解释、命名、延伸，一律不得当作证据
- recent_topics 可以总结"用户最近在讨论什么"，但必须贴近 USER 原话，不得升级成长期偏好
- active_topics 和 follow_ups 要优先写"话题层级"的概括，不要写 JSON Schema、函数名、字段名、具体术语翻译这类实现细节，除非用户明确把该细节当作核心关注点反复强调
- user_preferences 只允许在 USER 出现明确偏好/要求/禁忌表达时输出，例如：喜欢、偏好、希望、别、不要、避免、不想
- 不要把技术方案讨论、架构设想、问题求证、头脑风暴自动写成"用户偏好"
- 对技术讨论场景，只有当 USER 明确表达"以后都这样做 / 我就是偏好这种方式 / 我不要另一种方式 / 以后统一按这个来"时，才允许写 user_preferences；否则一律视为 active_topics 或 follow_ups
- 用户用"为什么不……""能不能……""是不是可以……"这类方式提出方案设想或追问时，默认视为设计提议，不视为稳定偏好
- avoidances 只允许在 USER 明确表达"不要/别/避免/不想"时输出；没有明确否定表达就留空
- 如果最新 recent turns 显示话题已经明显切换，不要把较早窗口的技术讨论升级成当前偏好或避免事项
- 只保留未来几轮仍会影响主动行为的信息
- 不要记录工具细节、推理过程、普通寒暄
- 每个字段最多 3 条，每条尽量 1 句
- 没有把握就留空；宁可漏掉，也不要脑补

ongoing_threads 严格限制：
- 只记录用户正在经历、推进或承受的重要事情
- 必须是对用户当前生活、情绪、工作、学习、关系或健康有持续影响的线索
- 普通提问、技术讨论、方案脑暴、一次性 ask、知识求证，一律不得写入 ongoing_threads
- 若旧的 ongoing_threads 中已有某条重要线索，而当前窗口没有明确终结它，默认保留
- 只有当用户明确表示这件事已解决、结束、过去了、不再关心，才允许删除
- ongoing_threads 的写入门槛高于 active_topics；宁可少写，也不要把普通话题升级进去

专项禁令：
- 用户讨论"某个设计有没有依据/有没有实践/是否可行/为什么不这样做"，这是方案讨论，不是偏好；默认只能进入 active_topics 或 follow_ups，不能进入 user_preferences
- 用户说"为什么不让前台……"是在提出一种实现设想，不等于"用户偏好以后统一这样做"
- 用户说"这样也不会引入额外延迟""有没有这样的设计"，这是在分析方案目标，不等于稳定偏好
- 用户讨论"零延迟""预加载""流式预取""前瞻性检索"这类设计目标时，默认视为当前方案讨论，不得直接提炼成 user_preferences
- 对方案讨论里的具体实现细节，优先上收一层概括，例如写"下一轮检索规划""流式预取方案"，不要写"JSON Schema""结构化预取指令"这类细碎实现点
- 用户说"睡觉了""头有点疼""身体不适"，这只是当前状态；除非用户明确说"别再聊这个""不要继续""我不想讨论"，否则不得生成 avoidances
- assistant 说"今晚先别想架构和代码了""先休息"，这是 assistant 建议，不是用户 avoidances
- 如果较早窗口是技术方案讨论，而最新 recent turns 已切到睡眠/头痛/身体状态，则 user_preferences 和 avoidances 默认应为空；技术方案最多保留在 active_topics / follow_ups
- "最近在讨论前瞻性检索/流式预取方案"只能进入 active_topics / follow_ups，不能进入 ongoing_threads
- "用户最近几天反复因面试失败而情绪低落""用户近期持续受睡眠紊乱影响"这类重要现实线索，才允许进入 ongoing_threads

输出前自检：
1. 检查 user_preferences 中每一条，是否都能在 USER 原话里找到明确偏好/要求词（如"希望/不要/避免/不想/偏好/喜欢"）
2. 若找不到明确偏好/要求词，删除该条
3. 检查 avoidances 中每一条，是否都能在 USER 原话里找到明确否定/回避表达
4. 若找不到明确否定/回避表达，删除该条
5. 如果删除后为空，返回空数组，不要为了"信息完整"硬填

【上一版 recent context（仅供延续，不要机械复述）】
${options.oldRecentContext || "（空）"}

【较早窗口（本次待压缩）】
${options.conversation || "（空）"}

【最新 recent turns（只用于判断是否已切话题，不可把 assistant 内容当证据）】
${options.recentTurns || "（空）"}

返回 JSON：
{
  "active_topics": [],
  "user_preferences": [],
  "follow_ups": [],
  "avoidances": [],
  "ongoing_threads": []
}`;
}

// ------------------------------------------------------------------
// 校验与渲染(akashic _normalize_recent_context_compression / _render_recent_context)
// ------------------------------------------------------------------

const COMPRESSION_FIELDS = [
	"active_topics",
	"user_preferences",
	"follow_ups",
	"avoidances",
	"ongoing_threads",
] as const;

/**
 * 校验模型输出的近期语境字段:每个字段必须是字符串数组,保留最多 3 条;
 * 结构非法时抛错(调用方跳过本次写入,不污染旧文件)。
 */
export function normalizeRecentContextCompression(payload: unknown): RecentContextCompression {
	const compression = emptyCompression();
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
		throw new Error("recent context payload must be an object");
	}
	const record = payload as Record<string, unknown>;
	for (const key of COMPRESSION_FIELDS) {
		const rawItems = record[key];
		if (rawItems === undefined) continue;
		if (!Array.isArray(rawItems)) throw new Error(`recent context ${key} must be an array`);
		const items: string[] = [];
		for (const item of rawItems) {
			if (typeof item !== "string") throw new Error(`recent context ${key} entries must be strings`);
			const value = item.trim();
			if (value) items.push(value);
		}
		switch (key) {
			case "active_topics":
				compression.activeTopics = items.slice(0, 3);
				break;
			case "user_preferences":
				compression.userPreferences = items.slice(0, 3);
				break;
			case "follow_ups":
				compression.followUps = items.slice(0, 3);
				break;
			case "avoidances":
				compression.avoidances = items.slice(0, 3);
				break;
			case "ongoing_threads":
				compression.ongoingThreads = items.slice(0, 3);
				break;
		}
	}
	return compression;
}

/** 从已渲染文本提取 Compression + Ongoing Threads(akashic _extract_recent_context_compression)。 */
export function extractCompressionFromText(text: string): RecentContextCompression | null {
	if (!text.trim()) return null;
	const compression = emptyCompression();
	const sectionMatch = text.match(/## Compression\n([\s\S]*?)(?:\n## Ongoing Threads\n|$)/);
	if (!sectionMatch) return null;
	const titleMap: Record<string, keyof RecentContextCompression> = {
		最近持续关注: "activeTopics",
		最近明确偏好: "userPreferences",
		最近待延续话题: "followUps",
		最近避免事项: "avoidances",
	};
	for (const rawLine of (sectionMatch[1] ?? "").split("\n")) {
		const line = rawLine.trim();
		if (!line || line.startsWith("until:") || line === "- none" || !line.startsWith("- ")) continue;
		const payload = line.slice(2);
		const colon = payload.indexOf("：");
		if (colon < 0) continue;
		const key = titleMap[payload.slice(0, colon).trim()];
		if (!key) continue;
		const items = payload
			.slice(colon + 1)
			.split("；")
			.map((part) => part.trim())
			.filter((part) => part.length > 0);
		compression[key] = items.slice(0, 3);
	}
	const ongoingMatch = text.match(/## Ongoing Threads\n([\s\S]*?)(?:\n## Recent Turns\n|$)/);
	if (ongoingMatch) {
		const items: string[] = [];
		for (const rawLine of (ongoingMatch[1] ?? "").split("\n")) {
			const line = rawLine.trim();
			if (!line.startsWith("- ")) continue;
			const item = line.slice(2).trim();
			if (item && item !== "none") items.push(item);
		}
		compression.ongoingThreads = items.slice(0, 3);
	}
	return compression;
}

/** 渲染 RECENT_CONTEXT.md(akashic _render_recent_context,格式与 chat 注入端兼容)。 */
export function renderRecentContext(options: {
	compression: RecentContextCompression | null;
	compressionUntil: string;
	recentTurns: string;
}): string {
	const compression = options.compression ?? emptyCompression();
	const sections: Array<[string, string[]]> = [
		["最近持续关注", compression.activeTopics],
		["最近明确偏好", compression.userPreferences],
		["最近待延续话题", compression.followUps],
		["最近避免事项", compression.avoidances],
	];
	const lines = ["# Recent Context", "", "## Compression", `until: ${options.compressionUntil || "none"}`];
	let renderedAny = false;
	for (const [title, items] of sections) {
		const cleaned = items.filter((item) => item.trim().length > 0);
		if (cleaned.length === 0) continue;
		renderedAny = true;
		lines.push(`- ${title}：${cleaned.slice(0, 3).join("；")}`);
	}
	if (!renderedAny) lines.push("- none");
	lines.push("", "## Ongoing Threads");
	if (compression.ongoingThreads.length > 0) {
		for (const item of compression.ongoingThreads.slice(0, 3)) lines.push(`- ${item}`);
	} else {
		lines.push("- none");
	}
	lines.push("", "## Recent Turns", "<!-- a-preview = assistant reply preview only -->");
	if (options.recentTurns.trim()) {
		lines.push(options.recentTurns.trim());
	} else {
		lines.push("- none");
	}
	return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

// ------------------------------------------------------------------
// Recent Turns 格式化(akashic _format_recent_context_messages)
// ------------------------------------------------------------------

/** user 消息全文 + assistant 回复前 60 字符预览;跳过 tool/proactive 消息。 */
export function formatRecentContextTurns(messages: SessionMessageLike[]): string {
	const lines: string[] = [];
	for (const message of messages) {
		const content = messageText(message.content);
		const role = String(message.role ?? "").toLowerCase();
		if (!content || (role !== "user" && role !== "assistant")) continue;
		if (role === "assistant" && message.proactive) continue;
		if (role === "assistant") {
			const preview = content.slice(0, 60);
			if (preview) lines.push(`[a-preview] ${preview}`);
			continue;
		}
		lines.push(`[user] ${content}`);
	}
	return lines.join("\n").trim();
}

function messageText(content: unknown): string {
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
// 整合入口:consolidation 后刷新 RECENT_CONTEXT.md
// ------------------------------------------------------------------

export interface RefreshRecentContextOptions {
	store: MarkdownMemoryStore;
	llm: MemoryLlm;
	/** 完整会话消息(取尾部 recent turns)。 */
	messages: SessionMessageLike[];
	/** 本次压缩窗口(已格式化对话文本)。 */
	conversation: string;
	/** 窗口最后一条消息时间戳(compression until)。 */
	compressionUntil: string;
	keepCount?: number;
}

/**
 * 用窗口对话刷新 RECENT_CONTEXT.md:LLM 压缩五类语境 → 渲染 → 原子写入。
 * 任何失败只跳过本次写入,不抛错(增强步骤,不阻断主提取)。
 */
export async function refreshRecentContext(options: RefreshRecentContextOptions): Promise<void> {
	try {
		const { store, llm, messages, conversation, compressionUntil } = options;
		const keepCount = Math.max(2, options.keepCount ?? 50);
		const recentCount = recentTurnCount(keepCount);
		const tail = messages.slice(-recentCount);
		const oldRecentContext = store.readRecentContext();
		const recentTurnsForPrompt = formatRecentContextTurns(tail);
		const prompt = buildRecentContextPrompt({
			oldRecentContext,
			conversation,
			recentTurns: recentTurnsForPrompt,
		});
		const raw = await llm.chat(RECENT_CONTEXT_SYSTEM, prompt, 512);
		const parsed = parseJsonLoose(raw);
		const compression = normalizeRecentContextCompression(parsed);
		store.writeRecentContext(
			renderRecentContext({
				compression,
				compressionUntil,
				recentTurns: recentTurnsForPrompt,
			}),
		);
	} catch {
		// 单轮压缩失败(网络/解析/结构非法)不阻断 consolidation 主流程。
	}
}
