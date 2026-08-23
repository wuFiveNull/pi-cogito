/**
 * Post-response memory worker (akashic memory2/post_response_worker.py 移植)。
 *
 * 每轮对话结束后异步运行:检测用户是否明确否定 agent 的某个既有行为
 * ("错了/不对/不要再/忘掉/废弃/过时/改掉"),召回相关的 procedure/preference
 * 条目,由轻模型判定后把真正过时的旧条目 supersede 掉,让用户纠正立即生效,
 * 而不是等 0.9 相似度阈值偶然碰撞。
 *
 * 与 akashic 的差异:无事件总线,由 chat 层在 agent_end 后显式调用 run();
 * 无独立 light provider,复用调用方提供的 PostResponseLlm(chat(system,user,maxTokens))。
 */

import type { Memorizer } from "./memorizer.ts";
import type { Retriever } from "./retriever.ts";
import type { MemoryHit, PostResponseLlm } from "./types.ts";

export type { PostResponseLlm } from "./types.ts";

/** 工具链中的一次调用(只关心 memorize 调用的结果)。 */
export interface ToolChainCall {
	name?: string;
	result?: unknown;
}

const MEMORIZE_ID_PATTERNS = [
	/id=([A-Za-z0-9:_-]{1,128})/,
	/item_id=([A-Za-z0-9:_-]{1,128})/,
	/(?:new|reinforced|merged):([A-Za-z0-9:_-]{1,128})/,
];

const INVALIDATION_SYSTEM = "你是记忆失效检测器。判断用户消息是否在明确否定 agent 的既有行为。只返回 JSON 数组。";

const INVALIDATION_PROMPT = `判断用户消息是否在明确声明 agent 某个现有行为/流程有误，且希望废弃它。

用户消息：{userMessage}

【必须同时满足才触发】
1. 用户表达了明确的否定/纠错/废弃意图——句子里有"错了/不对/不要再/忘掉/废弃/过时/改掉"等否定词
2. 否定的对象是 agent 的某个操作行为（不是用户自己的事，不是第三方信息）

【以下情况绝对不触发，返回 []】
✗ 用户在询问/确认 agent 的流程（"你的流程是什么""你怎么做的""你是按什么步骤"）
✗ 用户在描述/回顾自己的操作
✗ 用户提问句、疑问句（即使涉及 agent 行为）
✗ 含"也许/可能/猜测"等不确定措辞且无明确废弃指令

若触发，提取受影响的行为主题（简短描述，如"steam查询流程"）。
返回 JSON 数组，大多数消息应返回 []。`;

const CHECK_INVALIDATE_SYSTEM = "你是记忆失效判定器。只返回 JSON 数组。";

function buildCheckInvalidatePrompt(topic: string, candidates: readonly MemoryHit[]): string {
	const oldBlock = candidates.map((candidate) => `- id=${candidate.id} | ${candidate.summary}`).join("\n");
	return `用户明确表示 agent 关于"${topic}"的现有行为/流程有误，需要废弃。
以下是数据库中与该主题相关的现有规则，判断哪些应被标记为废弃：

${oldBlock}

规则：
- 若条目确实描述了"${topic}"相关的 agent 操作流程/行为，输出其 id
- 若条目与该主题无关，不输出
- 若无关联条目，返回 []

只返回 JSON 数组，如 ["abc123"] 或 []`;
}

/** 宽容解析 JSON 字符串数组(容忍 markdown 围栏与前后杂文)。 */
export function parseStringArray(text: string, responseName: string): string[] {
	const trimmed = text.trim();
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
				throw new Error(`${responseName} 返回了无法解析的内容`);
			}
		} else {
			throw new Error(`${responseName} 返回了无法解析的内容`);
		}
	}
	if (!Array.isArray(parsed)) throw new Error(`${responseName} 必须返回 JSON 数组`);
	if (parsed.some((item) => typeof item !== "string" || item.trim().length === 0)) {
		throw new Error(`${responseName} 只能包含非空字符串`);
	}
	return parsed as string[];
}

export interface PostResponseWorkerOptions {
	memorizer: Memorizer;
	retriever: Retriever;
	llm: PostResponseLlm;
	/** 相似度阈值:召回候选中高于该值的才交给模型判定。默认 0.82。 */
	supersedeThreshold?: number;
	/** 每个主题交给模型判定的候选上限。默认 5。 */
	supersedeCandidateK?: number;
	/** 每轮 token 预算。默认 1000。 */
	tokenBudgetPerRun?: number;
	log?: (message: string) => void;
}

export interface PostResponseRunOptions {
	/** 本轮用户消息(失效主题只依据 USER 原话)。 */
	userMessage: string;
	/** 本轮工具链(用于收集 memorize 写入的受保护 id)。 */
	toolChain: ToolChainCall[];
	/** 幂等/审计用 source_ref(如 "chat:<sessionKey>@post_response")。 */
	sourceRef: string;
}

export interface PostResponseRunResult {
	/** 本次被 supersede 的旧记忆 id。 */
	supersededIds: string[];
	/** 提取到的失效主题(仅调试观测)。 */
	topics: string[];
}

/**
 * 回复后记忆失效器:检测用户对 agent 旧行为的明确否定并 supersede 相关旧条目。
 * 任何一步失败只记日志,不抛错(异步增强步骤,不阻断对话)。
 */
export class PostResponseMemoryWorker {
	private readonly memorizer: Memorizer;
	private readonly retriever: Retriever;
	private readonly llm: PostResponseLlm;
	private readonly supersedeThreshold: number;
	private readonly supersedeCandidateK: number;
	private readonly tokenBudgetPerRun: number;
	private readonly log: ((message: string) => void) | undefined;

	constructor(options: PostResponseWorkerOptions) {
		this.memorizer = options.memorizer;
		this.retriever = options.retriever;
		this.llm = options.llm;
		this.supersedeThreshold = options.supersedeThreshold ?? 0.82;
		this.supersedeCandidateK = Math.max(1, options.supersedeCandidateK ?? 5);
		this.tokenBudgetPerRun = Math.max(1, options.tokenBudgetPerRun ?? 1000);
		this.log = options.log;
	}

	async run(options: PostResponseRunOptions): Promise<PostResponseRunResult> {
		try {
			const protectedIds = collectProtectedMemoryIds(options.toolChain);
			this.log?.(`post_response start sourceRef=${options.sourceRef} protected=${protectedIds.size}`);
			const { topics, supersededIds } = await this.handleInvalidations(options.userMessage, protectedIds);
			this.log?.(
				`post_response done sourceRef=${options.sourceRef} topics=${topics.length} superseded=${supersededIds.length}`,
			);
			return { supersededIds, topics };
		} catch (error) {
			this.log?.(`post_response failed: ${error instanceof Error ? error.message : String(error)}`);
			return { supersededIds: [], topics: [] };
		}
	}

	private async handleInvalidations(
		userMessage: string,
		protectedIds: ReadonlySet<string>,
	): Promise<{ topics: string[]; supersededIds: string[] }> {
		const topics = await this.extractInvalidationTopics(userMessage);
		const supersededIds: string[] = [];
		for (const topic of topics) {
			const candidates = await this.retriever.retrieve(topic, {
				memoryTypes: ["procedure", "preference"],
			});
			const highSim = candidates
				.filter((candidate) => candidate.score >= this.supersedeThreshold && !protectedIds.has(candidate.id))
				.slice(0, this.supersedeCandidateK);
			if (highSim.length === 0) continue;
			const selectedIds = await this.checkInvalidate(topic, highSim);
			if (selectedIds.length > 0) {
				this.memorizer.supersedeBatch(selectedIds);
				this.log?.(`post_response invalidation: superseded ${selectedIds.join(",")} for topic '${topic}'`);
				supersededIds.push(...selectedIds);
			}
		}
		return { topics, supersededIds };
	}

	private async extractInvalidationTopics(userMessage: string): Promise<string[]> {
		const raw = await this.llm.chat(
			INVALIDATION_SYSTEM,
			INVALIDATION_PROMPT.replace("{userMessage}", userMessage),
			96,
		);
		return parseStringArray(raw, "extract_invalidation_topics");
	}

	private async checkInvalidate(topic: string, candidates: readonly MemoryHit[]): Promise<string[]> {
		const raw = await this.llm.chat(CHECK_INVALIDATE_SYSTEM, buildCheckInvalidatePrompt(topic, candidates), 96);
		const selectedIds = parseStringArray(raw, "check_invalidate");
		const validIds = new Set(candidates.map((candidate) => candidate.id));
		const unknownIds = selectedIds.filter((id) => !validIds.has(id));
		if (unknownIds.length > 0) {
			throw new Error(`check_invalidate 返回了未知候选 ID: ${unknownIds.join(",")}`);
		}
		return selectedIds;
	}
}

/** 收集本轮 memorize 工具真实写入的记忆 ID(结果字符串解析,不校验入参)。 */
export function collectProtectedMemoryIds(toolChain: readonly ToolChainCall[]): Set<string> {
	const protectedIds = new Set<string>();
	for (const call of toolChain) {
		if (call.name !== "memorize") continue;
		const result = typeof call.result === "string" ? call.result : "";
		for (const pattern of MEMORIZE_ID_PATTERNS) {
			const match = result.match(pattern);
			if (match?.[1]) {
				protectedIds.add(match[1]);
				break;
			}
		}
	}
	return protectedIds;
}
