/**
 * 记忆优化器(akashic proactive_v2/memory_optimizer.py 移植)。
 *
 * 两步优化:
 * 1. 合并 PENDING.md → MEMORY.md(缺席成本测试 + 四分类档案契约)
 * 2. 更新 SELF.md(只允许既有三段,不得新增 section)
 *
 * 两阶段提交:snapshot 移走 PENDING → merge 成功 commit / 失败 rollback,
 * 任何一步失败都不丢数据。
 */

import { DEFAULT_SELF_MD, type MarkdownMemoryStore } from "./markdown-store.ts";

export class MemoryOptimizerBusy extends Error {}
export class MemoryOptimizerOutputError extends Error {}

export interface MemoryLlm {
	/** 单轮文本补全(system + user → 纯文本)。 */
	chat(system: string, user: string, maxTokens: number): Promise<string>;
}

const MERGE_SYSTEM = `你是一个用户长期记忆整理器。
你的工作不是概括对话,而是从记忆中剔除噪音,只保留对未来每次对话都产生底色影响的长期记忆。`;

const MERGE_PROMPT = `今日日期:{today}

你的任务是将「现有用户档案」重新整理为一份精炼的长期记忆,同时合并「待合并事实」中的新内容。
但更重要的是:**你必须剔除那些不应该存在于用户档案中的内容。**

## 核心判断标准:缺席成本测试

对每一条内容,问自己:
> 在 6 个月后的一次全新对话中,如果这条信息没有被注入,agent 是否会在某个回复中出现方向性失误?

是 → 保留。否 → 删除。

## 三种应保留的内容

- 「用户事实」:关于用户稳定身份的信息——他是谁、他有什么、他身上不可改变或长期稳定的事实;**当前正在进行的社会角色(就读学校/专业、实习公司+部门+岗位、在职单位+职位)也属于用户事实,必须保留具体细节和现在时态,不得转化为过去时或抽象化**
- 「用户偏好」:用户在对话中持续的审美取向、交互禁忌和根本价值判断——不是具体的爱好列表,而是定义了他是什么样的人的方向性偏好
- 「用户明确要求长期记住的关键内容」:用户亲口说"记住""写进长期记忆"的内容,保持原文连贯性,不删减

待合并事实来自 PENDING.md,采用带 tag 的 bullet 格式:
- [identity] ...
- [preference] ...
- [key_info] ...
- [health_long_term] ...
- [requested_memory] ...
- [correction] ...
- [agent_context] ...

tag 含义:
- identity:基础信息、稳定背景、长期技术方向、经历、长期设备、长期维护项目
- preference:稳定偏好、禁忌、审美、游戏口味、价值取向
- key_info:允许长期保存的 key / token / id / 账号信息
- health_long_term:长期健康状态的一阶事实,不展开动态指标
- requested_memory:用户明确要求长期记住的关键内容;允许比普通事实更连贯、更完整
- correction:对已有 MEMORY.md 内容的显式修正
- agent_context:助手操作用户环境所需的工具性配置,如服务端口、环境变量名、工具分工、常用登录站点;具体参数(端口号、变量名)必须完整保留,不得抽象化或删除

## 什么必须剔除

### 网络运维细节
内网 IP、路由模式(如"CGNAT""桥接模式""NAT")、运营商名称、MAC 地址等网络层配置。
→ 这些是瞬时运维信息,不是用户画像。项目路径、配置文件名、环境变量名等与用户开发环境直接相关的信息可以保留。

### 时效性数字和瞬时情绪
具体数字的动态指标(如 Star 数、增长率)、版本变更叙事("V4 发布后切换")、瞬时情绪("失落""失望")。
→ 保留背后的价值观(如"高度认可某模型"),删除数字和事件过程。

### 临时状态描述
描述当前正在进行、随时会结束的状态(如"最近加班频繁""这周在赶项目""目前在等 offer")。
→ 与规律性习惯区分:每周/每天持续的行为模式(如"每周去健身房""喜欢手冲咖啡")可以保留;带"最近""这周""目前"等时间限定词的瞬时状态必须删除。
→ **例外:就读、实习、在职三类社会角色不在此限**,它们定义用户当前的身份位置,应完整保留机构、部门、岗位名称。删除的是角色内部发生的活动描述,而不是角色本身。

### Agent 执行规则伪装成用户偏好
以"偏好"开头但实际描述 agent 应如何执行(如检索维度划分策略、元数据标注规范等)。
→ 这些是 procedure,不是用户身份,删除。

## 整理原则
- 合并同类、上收方向**只适用于偏好类内容**;身份事实(机构名称、部门、具体岗位、学校/专业)不做上收,不得丢失具体信息,不得抽象化
- 同类重复只保留最终版本
- correction 要直接反映到最终内容中,不要保留"旧值 → 新值"痕迹
- 不要生成 agent 执行规则、SOP、工具调用规范
- 不要保留短期状态、时效性事件
- 普通事实保持简洁;requested_memory 允许保留更完整的连贯描述

## agent_context 特殊规则
- agent_context 条目**必须完整保留**,包括端口号、变量名、URL 等具体参数;不得以"助手可访问某服务"之类的模糊描述替代
- agent_context 内容归入第四节「助手操作上下文」,不与用户事实混合

## 输出格式
- 标题 # 用户长期记忆
- 四个大分类:## 用户事实、## 用户偏好、## 用户明确要求长期记住的关键内容、## 助手操作上下文
- 每个分类内用 bullet 列表,每条 1-2 行
- ## 助手操作上下文 若无内容则省略该节
- 直接输出完整档案,不要 JSON,不要代码块,不要任何解释

---

现有用户档案:
{memory}

待合并事实(若有新内容则合并进去,若为空则忽略):
{pending}`;

const SELF_SYSTEM = `你是助手本体,只能更新 SELF.md 中现有的三个 section,不得新增其他 section。`;

const SELF_PROMPT = `你的任务是根据当前 SELF.md 和本轮待合并事实,整理一份新的 SELF.md。

## 目标
- 只输出完整的 SELF.md
- 只允许保留以下三个 section:
  - ## 人格与形象
  - ## 我对当前用户的理解
  - ## 我们关系的定义
- 绝对禁止新增任何其他 section

## 更新原则
- 当前 SELF.md 是主文本,优先保留其已有的自我认知、语气和关系定义;不要把待合并事实机械改写进 SELF
- 待合并事实只是辅助证据,只能在它们确实帮助澄清以下内容时少量吸收:
  - 助手的定位、说话风格、交互边界
  - 助手对当前用户的稳定理解
  - 助手与当前用户关系的长期定义
- 大多数待合并事实其实与 SELF.md 无关;无关时直接忽略,不要为了"有输入"而强行改写
- 尤其不要把以下内容写进 SELF.md:
  - 用户资料清单、账号、key、设备参数
  - 健康状态、动态指标、短期计划、近期事件
  - 工具规范、SOP、调用规则、执行流程
  - 对话事件复盘、事件流水账、阶段性经历总结
- 如果没有足够高价值的新信息,宁可输出与当前 SELF.md 基本一致的版本
- 保持语气稳定、简洁、有立场;它是自我认知,不是用户档案,也不是工作日志

## 输出约束
- 输出必须以 # 助手自我认知 开头
- 只能包含标题和 bullet 列表
- 不要代码块,不要解释,不要额外说明

---

当前 SELF.md:
{self_content}

待合并事实:
{pending}`;

const MEMORY_REQUIRED_HEADINGS = ["# 用户长期记忆", "## 用户事实", "## 用户偏好", "## 用户明确要求长期记住的关键内容"];
const MEMORY_OPTIONAL_HEADING = "## 助手操作上下文";
const SELF_REQUIRED_HEADINGS = ["# 助手自我认知", "## 人格与形象", "## 我对当前用户的理解", "## 我们关系的定义"];

function markdownHeadings(content: string): string[] {
	return content
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.startsWith("#"));
}

/** 拒绝不符合长期记忆完整档案契约的模型输出(akashic _validate_memory_output)。 */
export function validateMemoryOutput(content: string): void {
	const headings = markdownHeadings(content);
	const validHeadings = [MEMORY_REQUIRED_HEADINGS, [...MEMORY_REQUIRED_HEADINGS, MEMORY_OPTIONAL_HEADING]];
	const firstLine = content.split("\n")[0]?.trim() ?? "";
	const headingsMatch = validHeadings.some(
		(valid) => valid.length === headings.length && valid.every((h, i) => h === headings[i]),
	);
	if (firstLine !== MEMORY_REQUIRED_HEADINGS[0] || !headingsMatch || content.includes("```")) {
		throw new MemoryOptimizerOutputError("MEMORY.md 模型输出格式无效");
	}
	// 非空输入不得被悄悄改写成只有标题的空档案。
	if (!content.split("\n").some((line) => line.trimStart().startsWith("- "))) {
		throw new MemoryOptimizerOutputError("MEMORY.md 模型输出不包含任何记忆条目");
	}
}

/** 拒绝缺节、增节或空节的 SELF 模型输出(akashic _validate_self_output)。 */
export function validateSelfOutput(content: string): void {
	const lines = content.split("\n");
	const firstLine = lines[0]?.trim() ?? "";
	const headings = markdownHeadings(content);
	if (
		firstLine !== SELF_REQUIRED_HEADINGS[0] ||
		headings.length !== SELF_REQUIRED_HEADINGS.length ||
		headings.some((h, i) => h !== SELF_REQUIRED_HEADINGS[i]) ||
		content.includes("```")
	) {
		throw new MemoryOptimizerOutputError("SELF.md 模型输出格式无效");
	}
	// 每个自我认知 section 必须保留至少一条内容(标题区不查,akashic range(1, len))。
	for (let i = 1; i < SELF_REQUIRED_HEADINGS.length; i++) {
		const headingIndex = lines.findIndex((line) => line.trim() === SELF_REQUIRED_HEADINGS[i]);
		const nextIndex =
			i + 1 < SELF_REQUIRED_HEADINGS.length
				? lines.findIndex((line, j) => j > headingIndex && line.trim() === SELF_REQUIRED_HEADINGS[i + 1])
				: lines.length;
		const section = lines.slice(headingIndex + 1, nextIndex === -1 ? lines.length : nextIndex);
		if (!section.some((line) => line.trimStart().startsWith("- "))) {
			throw new MemoryOptimizerOutputError(`SELF.md 模型输出 section 为空: ${SELF_REQUIRED_HEADINGS[i]}`);
		}
	}
}

/** 记忆优化器(akashic MemoryOptimizer)。 */
export class MemoryOptimizer {
	private readonly memory: MarkdownMemoryStore;
	private readonly llm: MemoryLlm;
	private readonly model: string;
	private readonly maxTokens: number;
	private running = false;
	/** 各步骤之间的间隔(秒),避免短时间内连续请求触发限流。 */
	private readonly stepDelaySeconds: number;

	constructor(options: {
		memory: MarkdownMemoryStore;
		llm: MemoryLlm;
		model?: string;
		maxTokens?: number;
		stepDelaySeconds?: number;
	}) {
		this.memory = options.memory;
		this.llm = options.llm;
		this.model = options.model ?? "";
		this.maxTokens = options.maxTokens ?? 16384;
		this.stepDelaySeconds = options.stepDelaySeconds ?? 15;
	}

	get isRunning(): boolean {
		return this.running;
	}

	/** 两步优化:合并 PENDING → MEMORY,更新 SELF。 */
	async optimize(): Promise<void> {
		if (this.running) throw new MemoryOptimizerBusy("memory optimizer 正在运行");
		this.running = true;
		try {
			await this.optimizeInner();
		} finally {
			this.running = false;
		}
	}

	private async optimizeInner(): Promise<void> {
		// 1. 冻结本轮 pending 并读取当前长期记忆。
		const pending = this.memory.snapshotPending();
		// 2. MEMORY 阶段明确提交或回滚后才离开事务。
		try {
			const currentMemory = this.memory.readLongTerm().trim();
			if (!currentMemory && !pending) {
				this.memory.commitPendingSnapshot();
				return;
			}
			const mergedMemory = await this.mergeMemory(currentMemory, pending);
			if (mergedMemory) {
				validateMemoryOutput(mergedMemory);
				if (currentMemory) this.memory.backupLongTerm();
				this.memory.writeLongTerm(mergedMemory);
				this.memory.commitPendingSnapshot();
			} else {
				this.memory.rollbackPendingSnapshot();
			}
		} catch (error) {
			this.memory.rollbackPendingSnapshot();
			throw error;
		}

		// 3. 使用同一批 pending 更新自我认知。
		await new Promise((resolve) => setTimeout(resolve, this.stepDelaySeconds * 1000));
		await this.updateSelf(pending);
	}

	private async mergeMemory(memory: string, pending: string): Promise<string> {
		const today = new Date().toISOString().slice(0, 10);
		const prompt = MERGE_PROMPT.replace("{today}", today)
			.replace("{memory}", memory || "(空)")
			.replace("{pending}", pending || "(无新内容)");
		return await this.requestText(MERGE_SYSTEM, prompt, this.maxTokens);
	}

	private async updateSelf(pending: string): Promise<void> {
		const selfContent = this.memory.readSelf().trim() || DEFAULT_SELF_MD.trim();
		if (!selfContent) return;
		const prompt = SELF_PROMPT.replace("{self_content}", selfContent).replace("{pending}", pending || "(无新内容)");
		const updated = await this.requestText(SELF_SYSTEM, prompt, 2048);
		if (updated) {
			validateSelfOutput(updated);
			this.memory.backupSelf();
			this.memory.writeSelf(updated);
		}
	}

	private async requestText(system: string, user: string, maxTokens: number): Promise<string> {
		const content = await this.llm.chat(system, user, maxTokens);
		return content.trim();
	}
}
