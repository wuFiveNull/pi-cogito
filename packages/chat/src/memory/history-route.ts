/**
 * 历史路由门控(akashic RETRIEVE/NO_RETRIEVE 的 chat 侧等价)。
 *
 * 每次注入记忆检索前,用轻模型判断该用户消息是否需要检索长期记忆:
 * - skip:纯寒暄/即时延续,不发起向量检索(省一次检索 + 注入 token);
 * - retrieve:正常检索,可携带改写后的查询(更适合向量匹配)。
 *
 * 任何失败 → retrieve + 原查询(fail-open);决策按 sessionKey+query 缓存
 * (默认 10min),同轮 tool loop 内复用。
 */

export type HistoryRouteDecision = "retrieve" | "skip";

export interface HistoryRouteResult {
	decision: HistoryRouteDecision;
	/** 改写后的检索查询(decision=skip 时等于原查询)。 */
	query: string;
}

/** 与 host PostResponseLlm 同形的轻模型适配。 */
export interface HistoryRouteLlm {
	chat(system: string, user: string, maxTokens: number): Promise<string>;
}

export interface HistoryRouteGateOptions {
	llm: HistoryRouteLlm;
	/** 决策缓存 TTL(毫秒)。默认 10 分钟。 */
	cacheTtlMs?: number;
	/** 总开关。默认 true。 */
	enabled?: boolean;
	log?: (message: string) => void;
}

const DEFAULT_CACHE_TTL_MS = 10 * 60_000;

const ROUTE_SYSTEM = "你是记忆检索路由。决定当前用户消息是否需要检索长期记忆,只返回 JSON。";

function buildRoutePrompt(query: string): string {
	return `判断下面这条用户消息是否需要检索长期记忆(用户偏好/禁忌/规则/历史事实/流程)。

需要检索:
- 消息涉及用户过去的事、偏好、禁忌、习惯、长期流程规则
- 之前讨论过的内容、只有记忆才能回答的问题
- 用户明确说"记得/上次/以前/我提到过"之类

不需要检索:
- 纯寒暄、问候、道谢
- 当前对话的即时延续,只依赖刚才说的内容
- 与长期记忆无关的日常闲聊、一次性提问

保守起见:不确定时选 retrieve,不要为了省检索而 skip。

改写查询:把消息改写成更适合向量检索的简洁关键词查询(第三人称,如"用户 喜欢 手冲咖啡");不需要检索时 query 填原消息。

用户消息:${query}

只返回 JSON:{"decision": "retrieve" | "skip", "query": "改写后的查询"}`;
}

interface CachedDecision {
	at: number;
	result: HistoryRouteResult;
}

export class HistoryRouteGate {
	private readonly llm: HistoryRouteLlm;
	private readonly cacheTtlMs: number;
	private readonly enabled: boolean;
	private readonly log: (message: string) => void;
	private readonly cache = new Map<string, CachedDecision>();

	constructor(options: HistoryRouteGateOptions) {
		this.llm = options.llm;
		this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
		this.enabled = options.enabled ?? true;
		this.log = options.log ?? (() => undefined);
	}

	/** 决策(带缓存):失败/解析失败 → retrieve + 原查询(fail-open)。 */
	async decide(sessionKey: string, query: string): Promise<HistoryRouteResult> {
		const fallback: HistoryRouteResult = { decision: "retrieve", query };
		if (!this.enabled) return fallback;
		const trimmed = query.trim().slice(0, 300);
		if (!trimmed) return fallback;
		const cacheKey = `${sessionKey}:${trimmed}`;
		const cached = this.cache.get(cacheKey);
		if (cached && Date.now() - cached.at < this.cacheTtlMs) {
			return cached.result;
		}
		try {
			const raw = await this.llm.chat(ROUTE_SYSTEM, buildRoutePrompt(trimmed), 96);
			const result = parseRouteResult(raw, trimmed);
			this.cache.set(cacheKey, { at: Date.now(), result });
			return result;
		} catch (error) {
			this.log(
				`history route failed, fallback to retrieve: ${error instanceof Error ? error.message : String(error)}`,
			);
			return fallback;
		}
	}

	/** 清空缓存(会话切换/测试)。 */
	clear(): void {
		this.cache.clear();
	}
}

/** 宽容解析 {"decision","query"}:结构非法时抛错(调用方 fail-open)。 */
export function parseRouteResult(raw: string, fallbackQuery: string): HistoryRouteResult {
	const trimmed = raw.trim();
	const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```\s*$/);
	const candidate = (fenced ? (fenced[1] ?? "").trim() : trimmed).trim();
	let parsed: unknown;
	try {
		parsed = JSON.parse(candidate) as unknown;
	} catch {
		const start = candidate.indexOf("{");
		const end = candidate.lastIndexOf("}");
		if (start >= 0 && end > start) {
			try {
				parsed = JSON.parse(candidate.slice(start, end + 1)) as unknown;
			} catch {
				throw new Error("history route returned unparseable JSON");
			}
		} else {
			throw new Error("history route returned unparseable JSON");
		}
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("history route returned non-object JSON");
	}
	const record = parsed as Record<string, unknown>;
	const decision = record.decision;
	if (decision !== "retrieve" && decision !== "skip") {
		throw new Error(`history route returned invalid decision: ${String(decision)}`);
	}
	const query =
		typeof record.query === "string" && record.query.trim().length > 0
			? record.query.trim().slice(0, 300)
			: fallbackQuery;
	return { decision, query };
}
