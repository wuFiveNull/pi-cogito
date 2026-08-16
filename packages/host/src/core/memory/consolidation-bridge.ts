/**
 * Consolidation bridge (akashic plugins/default_memory/engine.py 移植)。
 *
 * 把 agent-core markdown 层 consolidation 的产物同步写入 host MemoryEngine:
 * - history_entries → event 条目(source_ref 幂等 + 近 7 天语义去重,
 *   akashic Memorizer.save_from_consolidation);
 * - profile / preference / procedure → 第二遍 LLM 隐式长期提取,提示词只允许
 *   依据 USER 原话(禁止反推 assistant 内容),经 saveItemWithSupersede 写入
 *   (akashic _extract_implicit_long_term / _save_implicit_long_term);
 * - scope:写入时保留来源会话的 channel/chatId,与 chat 的 scoped 检索语义一致;
 * - 降级:嵌入模型缺失时整体跳过向量写入,只写 markdown(行为与现状一致)。
 *
 * 依赖方向:本模块只依赖 @cogito/agent-core 的类型(结构上来自 extract.ts 的
 * ConsolidatedPayload),运行时零依赖;真正的接线在 proactive(host 之上)。
 */

import { createHash } from "node:crypto";

import type { ConsolidatedPayload } from "@cogito/agent-core/node";

import type { Memorizer } from "./memorizer.ts";
import type { MemoryStore } from "./store.ts";
import { coerceEmotionalWeight } from "./store.ts";
import type { TextEmbedder } from "./types.ts";

/** 与 agent MemoryLlm 同形的文本补全接口(只接收 system/user 两段)。 */
export interface ConsolidationLlm {
	chat(system: string, user: string, maxTokens: number): Promise<string>;
}

export interface ConsolidationBridgeEngine {
	store: MemoryStore;
	memorizer: Memorizer;
	/** 共享嵌入器(createSessionEmbedder 配置);缺失时桥整体跳过。 */
	embedder: TextEmbedder | undefined;
}

export interface ConsolidationBridgeOptions {
	engine: ConsolidationBridgeEngine;
	llm: ConsolidationLlm;
	/** 第二遍 LLM 隐式长期提取开关。默认 true。 */
	implicitExtraction?: boolean;
	log?: (message: string) => void;
}

export interface ConsolidationBridgeResult {
	mode: "synced" | "no_embedder";
	/** 每条 history entry 的写入状态(saveFromConsolidation.eventStatus)。 */
	eventStatuses: string[];
	saved: { profile: number; preference: number; procedure: number };
}

const IMPLICIT_MAX_TOKENS = 600;

/** 事件条目稳定子键(akashic _build_entry_source_ref + consolidation: 前缀)。 */
function buildEntrySourceRef(baseSourceRef: string, entry: string): string {
	const text = (entry ?? "").trim();
	const digest = createHash("sha1").update(text, "utf8").digest("hex").slice(0, 12);
	return `consolidation:${baseSourceRef}#h:${text ? digest : "empty"}`;
}

export class ConsolidationBridge {
	private readonly engine: ConsolidationBridgeEngine;
	private readonly llm: ConsolidationLlm;
	private readonly implicitExtraction: boolean;
	private readonly log: (message: string) => void;

	constructor(options: ConsolidationBridgeOptions) {
		this.engine = options.engine;
		this.llm = options.llm;
		this.implicitExtraction = options.implicitExtraction ?? true;
		this.log = options.log ?? (() => undefined);
	}

	/** 处理一次 consolidation 产物:event 条目 + 隐式长期提取。失败逐项吞掉并记日志。 */
	async handleConsolidated(payload: ConsolidatedPayload): Promise<ConsolidationBridgeResult> {
		const empty = { profile: 0, preference: 0, procedure: 0 };
		if (!this.engine.embedder) {
			return { mode: "no_embedder", eventStatuses: [], saved: empty };
		}

		const eventStatuses: string[] = [];
		for (const entry of payload.historyEntries) {
			const sourceRef = buildEntrySourceRef(payload.sourceRef, entry.summary);
			try {
				const result = await this.engine.memorizer.saveFromConsolidation({
					historyEntry: entry.summary,
					sourceRef,
					scope: payload.scope,
					emotionalWeight: entry.emotionalWeight,
				});
				eventStatuses.push(result.eventStatus);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				this.log(`consolidation event save failed: ${message}`);
				eventStatuses.push(`error:${message}`);
			}
		}

		const saved = { ...empty };
		if (this.implicitExtraction && payload.conversation.trim()) {
			try {
				const parsed = await this.extractImplicitLongTerm(payload.conversation);
				if (parsed) {
					Object.assign(saved, await this.saveImplicitLongTerm(parsed, payload));
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				this.log(`consolidation implicit extraction failed: ${message}`);
			}
		}
		return { mode: "synced", eventStatuses, saved };
	}

	// ------------------------------------------------------------------
	// 第二遍 LLM 隐式长期提取(akashic _extract_implicit_long_term)
	// ------------------------------------------------------------------

	private async extractImplicitLongTerm(conversation: string): Promise<Record<string, unknown> | undefined> {
		const prompt = buildLongTermPrompt({ conversation, existingProfile: "" });
		const raw = (await this.llm.chat(IMPLICIT_SYSTEM, prompt, IMPLICIT_MAX_TOKENS)).trim();
		const parsed = parseJsonObjectLoose(raw);
		if (!parsed) {
			this.log("consolidation implicit extraction returned non-object JSON");
			return undefined;
		}
		return parsed;
	}

	private async saveImplicitLongTerm(
		result: Record<string, unknown>,
		payload: ConsolidatedPayload,
	): Promise<{ profile: number; preference: number; procedure: number }> {
		const scope = payload.scope;
		const saved = { profile: 0, preference: 0, procedure: 0 };
		const scopeExtra = { scope_channel: scope.channel, scope_chat_id: scope.chatId };

		// 1. profile:用户画像事实(akashic #profile 子键)。
		for (const item of dictItems(result.profile)) {
			const summary = String(item.summary ?? "").trim();
			if (!summary) continue;
			const category = String(item.category ?? "personal_fact").trim() || "personal_fact";
			const happenedAt = typeof item.happened_at === "string" ? item.happened_at : undefined;
			try {
				await this.engine.memorizer.saveItemWithSupersede({
					summary,
					memoryType: "profile",
					extra: { category, ...scopeExtra },
					sourceRef: `consolidation:${payload.sourceRef}#profile`,
					happenedAt,
					emotionalWeight: coerceEmotionalWeight(item.emotional_weight),
					scope,
				});
				saved.profile += 1;
			} catch (error) {
				this.log(`consolidation implicit profile save failed: ${formatError(error)}`);
			}
		}

		// 2. preference / procedure:行为偏好与执行规则(akashic #implicit 子键)。
		for (const memoryType of ["preference", "procedure"] as const) {
			for (const item of dictItems(result[memoryType])) {
				const summary = String(item.summary ?? "").trim();
				if (!summary) continue;
				const extra: Record<string, unknown> = {
					tool_requirement: item.tool_requirement,
					steps: item.steps ?? [],
					...scopeExtra,
				};
				if (memoryType === "procedure" && isRecord(item.rule_schema)) {
					extra.rule_schema = item.rule_schema;
				}
				try {
					await this.engine.memorizer.saveItemWithSupersede({
						summary,
						memoryType,
						extra,
						sourceRef: `consolidation:${payload.sourceRef}#implicit`,
						emotionalWeight: coerceEmotionalWeight(item.emotional_weight),
						scope,
					});
					saved[memoryType] += 1;
				} catch (error) {
					this.log(`consolidation implicit ${memoryType} save failed: ${formatError(error)}`);
				}
			}
		}
		return saved;
	}
}

// ------------------------------------------------------------------
// 隐式长期提取 prompt(akashic _build_long_term_prompt 移植,只依据 USER 原话)
// ------------------------------------------------------------------

const IMPLICIT_SYSTEM = "你是长期记忆提取专家,只返回合法 JSON,不要 markdown 代码块。";

export function buildLongTermPrompt(options: { conversation: string; existingProfile?: string }): string {
	return `你是长期记忆提取专家。从对话窗口中一次性提取三类长期记忆,返回 JSON。

默认答案是所有数组为空。提取门槛要高,宁可不提取,也不要把临时信息写进长期记忆。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【核心判断标准】
把这条信息放进 6 个月后的一次全新对话,它还有用吗?
→ 是 → 可能是长期记忆,继续检查
→ 否 → 不是长期记忆,留空

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【三类记忆的语义】

profile — 关于用户本人或其客观处境的事实
  语义:身份背景、持有物、爱好、健康事实、长期状态、重要决定
  允许 category:personal_fact / purchase / decision / status
  要求:只有 USER 在对话中直接陈述自身的事实,才允许提取
  禁止:用户提问、追问、反问、记忆测试句一律不算事实披露,绝对禁止反推
· "你还记得我什么时候开始戴 fitbit 手环的吗" → 返回空
· "你记得我住哪里吗" → 返回空
· "我之前是不是买过这个" → 返回空

preference — 用户希望怎样被服务、怎样被讲解、怎样被推荐
  语义:跨 session 稳定成立的偏好/厌恶/倾向,而非硬约束
  来自 USER 明确表达

procedure — agent 在未来类似场景下应遵守的长期执行规则
  语义:面向 agent 的行为规则,跨任务可复用
  来自 USER 的长期要求,或被 USER 明确确认过的非显然做法

绝对不输出:event(有时间性的具体事件)

每条记忆都必须额外输出 emotional_weight(0-10):
- 纯技术讨论、普通事实陈述、工具步骤、没有明显情绪色彩 → 0
- 有明确喜欢/厌恶、明显情绪波动、关系张力、受挫或强烈在意 → 3-9
- 不确定时保守输出 0

区分三类:
- "用户是什么/拥有什么/处在什么客观背景里" → profile
- "用户希望 agent 怎么服务他、怎么讲解、怎么推荐" → preference
- "agent 在某类请求下必须怎么做/用什么工具" → procedure(有明确执行步骤/工具要求)
- 只是方向性偏好 → preference(优先选 preference)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【preference / procedure 提取前四项检查,顺序执行,任一不通过即不提取】

▸ 检查 0 — 元讨论/举例说明
先判断 USER 是在提供长期规则,还是在讨论"什么该记、怎么记、你是否理解、请举例说明"。
  - 元讨论场景:只允许提取 USER 自己明确说出的长期规则/筛选标准
  - ASSISTANT 为说明概念而举出的任何例子、类比、假设场景一律不得提取
  - 即使 ASSISTANT 的示例内容本身合理、未来有用,也不能因"看起来像长期规则"就入库

▸ 检查 A — USER 原话锚点
在 USER 消息里找到支撑这条记忆的直接原句(逐字存在,不是推断)。
  - 找不到 USER 的直接原句 → 不提取
  - ASSISTANT 的解释、建议、工具返回的数据,不算 USER 原句
  - USER 没有反驳 ASSISTANT ≠ USER 认同且希望长期记忆
  - USER 消息是纯状态汇报("复习中"/"在看书"/"工作中"等) → 不提取

▸ 检查 B — 时效性
  - 涉及当前任务、当前时间段、当前情境(本次/今天/这个项目) → 不提取
  - 只有明确跨 session 稳定成立,才继续

▸ 检查 C — 来源方向
  - 核心内容来自 ASSISTANT(解释/建议/工具结果) → 不提取
  - ASSISTANT 主动给出建议,USER 没有明确说"以后都这样"/"记住这个" → 不提取
  - "USER 没有反驳"不等于"USER 授权 AGENT 长期执行这条规则"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【profile 专用规则】

仅允许以下 4 类 category:
- purchase:用户购买 / 下单了什么
- decision:用户明确拍板了什么方案 / 计划
- status:用户某件事的状态变化(等待/完成/放弃/里程碑达成)
- personal_fact:用户关于自身的事实性披露(身份/背景/持有物/爱好/习惯/经验背景)

必须遵守:
- 纯技术讨论、闲聊、打招呼不输出
- 若 existing_profile 已有相同事实,不重复输出
- summary 简洁、可独立检索;personal_fact 默认不填 happened_at
- 每一件具体的事单独一条,绝对不合并
  ✗ 错误:"用户购买了多件商品"
  ✓ 正确:每件商品单独一条,写出具体名称/型号
- ASSISTANT 的回复只作背景参考,不作提取证据
  即使 ASSISTANT 说"你之前买了 X""你是 XX 方向的学生",也不得作为事实来源

额外禁止:
- 工程操作(安装/更新/配置工具/依赖)→ 这些是工程 event,不是 profile
- 项目内讨论(架构决策/重构方案/代码评审)
- 用户表达的观点/意见 → 必须是客观事实
- 纯 event:例如"这周日去徒步""昨晚去了超市""明天要开会"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【示例】

<example id="keep_profile_personal_fact">
USER: 我在互联网公司做产品经理,今年30岁,住在上海,有一块 Fitbit 手表,爱好是弹钢琴。
→ profile: [
  {"summary": "用户在互联网公司做产品经理", "category": "personal_fact"},
  {"summary": "用户今年30岁", "category": "personal_fact"},
  {"summary": "用户住在上海", "category": "personal_fact"},
  {"summary": "用户有一块 Fitbit 手表", "category": "personal_fact"},
  {"summary": "用户的爱好是弹钢琴", "category": "personal_fact"}
]
</example>

<example id="drop_profile_memory_test">
USER: 你还记得我什么时候开始戴 fitbit 手环的吗
→ profile: [](提问不是事实披露,绝对不反推)
</example>

<example id="profile_event_split">
USER: 这周日朋友约我去徒步,我其实不常徒步,不知道该买什么装备。
→ profile: [
  {"summary": "用户不常徒步", "category": "personal_fact"},
  {"summary": "用户目前缺少徒步相关装备准备", "category": "personal_fact"}
]
不提取:"这周日去徒步"(是 event)
</example>

<example id="profile_not_preference">
USER: 我家有 10 套房,我平时爱弹钢琴,而且我有一块 Fitbit 手表
→ profile: [以上三条 personal_fact]
→ preference/procedure: []
(这些是用户身份事实,不是"用户希望被怎样服务")
</example>

<example id="keep_explicit_rule">
USER: 以后帮我查菜谱只给 20 分钟以内能做完的,我没时间搞复杂的
检查A: "以后帮我查菜谱只给20分钟以内能做完的" ✓
检查B: "以后"明确跨 session ✓
检查C: 来自 USER 主动要求 ✓
→ procedure: [{"summary": "查询菜谱时只推荐 20 分钟内可完成的菜式"}]
</example>

<example id="keep_multi_source_research">
USER: 以后帮我查耳机先看 B 站评测和 Reddit 讨论,别只看官网参数
→ procedure: [{"summary": "查询耳机时先看 B 站评测和 Reddit 讨论,不只依赖官网参数"}]
</example>

<example id="keep_preference_trimmed">
USER: 我不喜欢这种悬疑风格的游戏,太压抑了
ASSISTANT: 明白!你是偏好轻松明快风格的玩家,喜欢治愈系或休闲类游戏……
→ preference: [{"summary": "不喜欢悬疑压抑风格的游戏"}]
✗ 不能写:"偏好治愈系或休闲类游戏"(USER 没说过,来自 ASSISTANT 延伸)
</example>

<example id="keep_preference_service_style">
USER: 你给我讲内容的时候最好附带一个很棒的例子,并且最好贯穿始终
→ preference: [{"summary": "讲解内容时最好附带贯穿始终的例子"}]
(这是"希望被怎样讲解",是 preference 不是 profile)
</example>

<example id="drop_situational">
USER: 今晚几个同学来,想找个气氛好的日料店
→ 全部为空("今晚"是当前情境,不跨 session)
✗ 不能提取:"用户喜欢日料"(推断)
</example>

<example id="drop_knowledge">
USER: TCP 和 UDP 的区别是什么
ASSISTANT: TCP 是可靠传输协议,有拥塞控制和重传机制……
→ 全部为空(USER 在提问,知识内容来自 ASSISTANT)
✗ 不能提取:"TCP 是可靠传输协议"
</example>

<example id="drop_assistant_proactive_advice">
USER: 在赶代码
ASSISTANT: 别忘了每隔一段时间起来活动下,喝点水,久坐对颈椎不好……
→ 全部为空
✗ 不能提取:"每隔45分钟应起身活动并补水"(来自 ASSISTANT,USER 没有授权)
关键判断:ASSISTANT 建议得再具体再合理,只要 USER 没有明确授权,就不是长期记忆
</example>

<example id="drop_meta_discussion_example">
USER: 我希望只有每轮对话里真正重要的参考信息才值得存入 memory.md,你举个例子我看看你理解没有
ASSISTANT: 明白。比如智能家居架构应坚持纯本地化部署,拒绝云端依赖……
检查0: USER 在讨论记忆标准并要求举例,是元讨论
可提取:USER 自己说出的筛选标准
ASSISTANT 的智能家居举例只是教学示范,不是 USER 新提供的规则
→ procedure: [{"summary": "每轮对话中真正重要的参考信息才值得存入 memory.md"}]
✗ 不能提取:"智能家居架构坚持纯本地化部署"
</example>

<example id="drop_workaround">
USER: 那就直接写个脚本绕过去吧
→ 全部为空(当前任务临时策略,不跨 session)
✗ 不能提取:"遇到此类问题应优先用 Python 脚本绕过"
</example>

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【summary 写法约束】
- 只包含 USER 原话中直接出现的内容,不能加推断或延伸
- summary 语气不得强于 USER 原话("不太喜欢" ≠ "强烈反感且要求永久避免")
- summary 脱离对话也能独立成立,不含"这次""今天""当前"等时间锚
- 不能只是原话碎片,必须是完整句
- profile:每条 summary 只表达一条完整事实,绝对不合并

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【当前已有 profile(用于 profile 查重)】
${options.existingProfile || "（空）"}

【待处理对话(只允许依据 USER 原话提取,禁止反推 ASSISTANT 内容)】
${options.conversation}

只返回合法 JSON:
{
  "profile": [
    {"summary": "...", "category": "personal_fact|purchase|decision|status", "happened_at": null, "emotional_weight": 0}
  ],
  "preference": [
    {"summary": "...", "emotional_weight": 0}
  ],
  "procedure": [
    {"summary": "...", "emotional_weight": 0, "tool_requirement": null, "steps": [], "rule_schema": {"required_tools": [], "forbidden_tools": [], "mentioned_tools": []}}
  ]
}`;
}

// ------------------------------------------------------------------
// 工具
// ------------------------------------------------------------------

function dictItems(value: unknown): Array<Record<string, unknown>> {
	if (!Array.isArray(value)) return [];
	const items: Array<Record<string, unknown>> = [];
	for (const item of value) {
		if (typeof item === "object" && item !== null && !Array.isArray(item)) {
			items.push(item as Record<string, unknown>);
		}
	}
	return items;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 宽松 JSON 对象解析:容忍 ```json 围栏与前后杂文。 */
export function parseJsonObjectLoose(text: string): Record<string, unknown> | undefined {
	const trimmed = text.trim();
	const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```\s*$/);
	const candidate = (fenced ? (fenced[1] ?? "").trim() : trimmed).trim();
	try {
		const parsed = JSON.parse(candidate) as unknown;
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		const start = candidate.indexOf("{");
		const end = candidate.lastIndexOf("}");
		if (start >= 0 && end > start) {
			try {
				const parsed = JSON.parse(candidate.slice(start, end + 1)) as unknown;
				return isRecord(parsed) ? parsed : undefined;
			} catch {
				return undefined;
			}
		}
		return undefined;
	}
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
