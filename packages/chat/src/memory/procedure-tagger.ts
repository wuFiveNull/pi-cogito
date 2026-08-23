/**
 * 过程记忆标注(akashic memory2/procedure_tagger.py 的 chat 侧等价)。
 *
 * afterTurn 异步运行(不阻塞回复):从「用户消息 + 本轮回合摘要」提取过程规则,
 * 写 procedure 记忆(extra.trigger_tags 供工具执行拦截器使用)。
 *
 * 保守策略:只在用户明确表达流程/规则("以后/下次/必须先/不要直接")时提取;
 * 限流(同会话两次运行间隔 ≥ minIntervalMs);任何失败吞掉。
 */

import type { MemoryScope } from "@cogito/host";
import type { ChatMemory } from "../memory.ts";

/** 与 host PostResponseLlm 同形的轻模型适配。 */
export interface ProcedureTaggerLlm {
	chat(system: string, user: string, maxTokens: number): Promise<string>;
}

export interface ProcedureTaggerOptions {
	llm: ProcedureTaggerLlm;
	memory: ChatMemory;
	/** 同会话两次运行的间隔(毫秒)。默认 10 分钟。 */
	minIntervalMs?: number;
	enabled?: boolean;
	log?: (message: string) => void;
}

const DEFAULT_MIN_INTERVAL_MS = 10 * 60_000;

const TAGGER_SYSTEM = "你是过程记忆提取器。只返回 JSON。";

function buildTaggerPrompt(userMessage: string, turnText: string): string {
	return `从下面的对话中提取用户明确表达的「过程规则」(agent 以后执行任务时应遵循的步骤/顺序/禁忌)。

只提取用户亲口说的、面向未来的规则,例如:
- "以后查库存前先调用 steam_query"
- "下次写文档前先看 CONTRIBUTING.md"
- "不要直接发消息,先确认"

不提取:
- 一次性任务指令、当前问题的解决步骤
- 用户对助手回答的确认、寒暄、闲聊
- 没有明确"以后/下次/必须/先/不要"等规则意味的内容

输出对象数组,每条:
{"summary": "规则的一句话描述(第三人称,保留工具名与关键词)", "tools": ["相关工具名"], "keywords": ["触发关键词"]}

没有合格规则时返回 []。

用户消息:${userMessage}

本轮对话摘要:
${turnText.slice(0, 4000)}

只返回 JSON 数组,不要 markdown 代码块。`;
}

export interface ExtractedProcedure {
	summary: string;
	tools: string[];
	keywords: string[];
}

/** 宽容解析 JSON 数组;结构非法抛错(调用方吞掉)。 */
export function parseProcedureOutput(raw: string): ExtractedProcedure[] {
	const trimmed = raw.trim();
	const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```\s*$/);
	const candidate = (fenced ? (fenced[1] ?? "").trim() : trimmed).trim();
	let parsed: unknown;
	try {
		parsed = JSON.parse(candidate) as unknown;
	} catch {
		const start = candidate.indexOf("[");
		const end = candidate.lastIndexOf("]");
		if (start >= 0 && end > start) {
			try {
				parsed = JSON.parse(candidate.slice(start, end + 1)) as unknown;
			} catch {
				throw new Error("procedure tagger returned unparseable JSON");
			}
		} else {
			throw new Error("procedure tagger returned unparseable JSON");
		}
	}
	if (!Array.isArray(parsed)) throw new Error("procedure tagger must return a JSON array");
	const results: ExtractedProcedure[] = [];
	for (const item of parsed) {
		if (typeof item !== "object" || item === null) continue;
		const record = item as Record<string, unknown>;
		const summary = typeof record.summary === "string" ? record.summary.trim() : "";
		if (!summary) continue;
		results.push({
			summary: summary.slice(0, 500),
			tools: stringArray(record.tools),
			keywords: stringArray(record.keywords),
		});
	}
	return results;
}

function stringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
		.map((item) => item.trim().slice(0, 100));
}

export class ProcedureTagger {
	private readonly llm: ProcedureTaggerLlm;
	private readonly memory: ChatMemory;
	private readonly minIntervalMs: number;
	private readonly enabled: boolean;
	private readonly log: (message: string) => void;
	private readonly lastRunByScope = new Map<string, number>();

	constructor(options: ProcedureTaggerOptions) {
		this.llm = options.llm;
		this.memory = options.memory;
		this.minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
		this.enabled = options.enabled ?? true;
		this.log = options.log ?? (() => undefined);
	}

	/** 运行一次标注(按会话限流 + 失败吞掉);返回是否真的执行了 LLM 调用。 */
	async run(userMessage: string, turnText: string, scope: MemoryScope): Promise<boolean> {
		if (!this.enabled) return false;
		const scopeKey = `${scope.channel}:${scope.chatId}`;
		const now = Date.now();
		const lastRunAt = this.lastRunByScope.get(scopeKey) ?? 0;
		if (now - lastRunAt < this.minIntervalMs) return false;
		this.lastRunByScope.set(scopeKey, now);
		try {
			const raw = await this.llm.chat(TAGGER_SYSTEM, buildTaggerPrompt(userMessage, turnText), 512);
			const procedures = parseProcedureOutput(raw);
			for (const procedure of procedures) {
				const triggerTags = [...procedure.tools, ...procedure.keywords].filter((tag) => tag.length > 0);
				await this.memory.remember({
					summary: procedure.summary,
					memoryType: "procedure",
					scope,
					sourceRef: `chat:${scope.channel}:${scope.chatId}@procedure_tagger`,
					extra: {
						...(triggerTags.length > 0 ? { trigger_tags: triggerTags } : {}),
						...(procedure.tools.length > 0 ? { tagged_tools: procedure.tools } : {}),
					},
				});
				this.log(`procedure tagger: wrote "${procedure.summary.slice(0, 60)}" tags=[${triggerTags.join(",")}]`);
			}
			return true;
		} catch (error) {
			this.log(`procedure tagger failed: ${error instanceof Error ? error.message : String(error)}`);
			return false;
		}
	}
}
