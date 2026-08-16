/**
 * @cogito/drift — idle-time background task engine.
 *
 * Runs when the proactive loop finds nothing worth pushing: the agent scans
 * user-written drift skills (SKILL.md), selects one, executes a small atomic
 * action with tools, and closes the run with finish_drift (completed/paused +
 * scratchpad/cursor continuity). Built on the akashic drift_flow design.
 *
 * Also hosts the shared memory-read helpers used by both drift and proactive
 * (recallPreferences reads the memory engine database).
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
	type DriftChatClient,
	OpenAICompatibleDriftChatClient,
	type OpenAICompatibleDriftChatClientOptions,
} from "./llm.ts";
import type { DriftLlmFn } from "./runtime.ts";

export type {
	DriftAttachmentKind,
	DriftDecision,
	DriftDriveResult,
	DriftOutboundAttachment,
	DriftStagedDelivery,
	RecalledPreference,
} from "@cogito/gate";
export {
	advanceDriftDrive,
	formatPreferenceBlock,
	hashOutboundMessage,
	pickDaemonModel,
	recallPreferences,
	recallPreferencesRanked,
	sampleDriftDelayHours,
} from "@cogito/gate";
export type {
	DriftContextProvider,
	DriftContextSnapshot,
	FileDriftContextProviderOptions,
} from "./context.ts";
export { DriftVedaLoadError, FileDriftContextProvider } from "./context.ts";
export type { HostDriftLlmOptions, HostRecentChatOptions } from "./host.ts";
export { createHostDriftLlmFn, createHostRecentChatFn } from "./host.ts";
export type {
	DriftChatClient,
	DriftChatRequest,
	DriftChatResponse,
	DriftChatToolCall,
	DriftChatToolChoice,
	OpenAICompatibleDriftChatClientOptions,
} from "./llm.ts";
export { DriftLlmRequestError, OpenAICompatibleDriftChatClient } from "./llm.ts";
export {
	type RunDriftLoopOptions,
	runDriftAgentLoop,
	toolSchema,
	wrapDriftToolAsAgentTool,
} from "./loop-adapter.ts";
export type {
	DriftContextSection,
	DriftEvent,
	DriftEventSink,
	DriftHostAdapter,
	DriftLlmFn,
	DriftMemoryTextFn,
	DriftRunContext,
	DriftTurnPipelineDeps,
} from "./runtime.ts";
export { createDriftContext, DriftTurnPipeline } from "./runtime.ts";
export { DriftEngine, ScanSkillsStrategy, TurnPipelineExecutionStrategy } from "./stages/index.ts";
export type { DriftExecutionStrategy, DriftScanStrategy } from "./stages/types.ts";
export type {
	DriftActiveRunRecord,
	DriftRetentionOptions,
	DriftRetentionResult,
	DriftRunDiagnostics,
	DriftRunLease,
	DriftRunStage,
	DriftRunStepRecord,
	DriftStateStoreOptions,
	SkillMeta,
} from "./state.ts";
export { DriftRunAlreadyActiveError, DriftStateStore } from "./state.ts";
export type {
	DriftDeliveryReceipt,
	DriftDeliveryRecord,
	DriftDeliverySink,
	DriftDeliveryStatus,
	DriftMcpConnections,
	DriftMcpServer,
	DriftMcpTool,
	DriftPathPolicy,
	DriftSessionAccess,
	DriftSessionMessage,
	DriftTool,
	DriftToolAuthorizationRequest,
	DriftToolAuthorizationResult,
	DriftToolCallEvent,
	DriftToolDeps,
	DriftToolMeta,
	DriftToolPolicy,
	DriftToolRisk,
	DriftWebDnsLookupFn,
	DriftWebFetchFn,
	DriftWebFetchResult,
	DriftWebPolicy,
	DriftWebResolvedAddress,
	DriftWebSearchFn,
	DriftWebSearchItem,
} from "./tools.ts";
export {
	buildDriftToolRegistry,
	DriftToolRegistry,
	getDriftToolMeta,
	inferDriftToolMeta,
} from "./tools.ts";

export interface DriftLlmEndpoint {
	model: string;
	baseUrl: string;
	apiKey: string | undefined;
	requestTimeoutMs?: number;
	maxRetries?: number;
}

export interface BuildDriftLlmFnOptions {
	client?: DriftChatClient;
	observer?: DriftLlmObserver;
}

export interface DriftLlmObserver {
	onRequest?(input: { model: string; messageCount: number; toolCount: number }): void | Promise<void>;
	onResponse?(input: { model: string; durationMs: number; toolCallCount: number }): void | Promise<void>;
	onError?(input: { model: string; durationMs: number; error: unknown }): void | Promise<void>;
}

/** OpenAI-compatible drift LLM adapter: returns one tool call or null. */
export function buildDriftLlmFn(endpoint: DriftLlmEndpoint, options: BuildDriftLlmFnOptions = {}): DriftLlmFn {
	const clientOptions: OpenAICompatibleDriftChatClientOptions = {
		model: endpoint.model,
		baseUrl: endpoint.baseUrl,
		apiKey: endpoint.apiKey,
		requestTimeoutMs: endpoint.requestTimeoutMs,
		maxRetries: endpoint.maxRetries,
	};
	const client = options.client ?? new OpenAICompatibleDriftChatClient(clientOptions);
	return async (messages, schemas, toolChoice, systemPrompt) => {
		const startedAt = Date.now();
		await notifyLlmObserver(options.observer?.onRequest, {
			model: endpoint.model,
			messageCount: messages.length,
			toolCount: schemas.length,
		});
		try {
			// OpenAI 兼容端点要求消息以 user/assistant 结尾;akashic 的 provider 内部处理,
			// 此处补一条占位 user 消息(不改变 Drift 语义)。host loop 把 system prompt
			// 放在消息列表之外,经第 4 参传入后前置。
			const withSystem = systemPrompt ? [{ role: "system", content: systemPrompt }] : [];
			const last = messages[messages.length - 1];
			const outbound = [
				...withSystem,
				...messages,
				...(last && (last.role === "user" || last.role === "assistant")
					? []
					: [{ role: "user", content: "请根据上方 context 决定下一步工具调用。" }]),
			];
			const response = await client.complete({
				messages: outbound,
				schemas,
				toolChoice,
				maxTokens: 2048,
				temperature: 0,
			});
			const call = response?.toolCalls[0];
			await notifyLlmObserver(options.observer?.onResponse, {
				model: endpoint.model,
				durationMs: Date.now() - startedAt,
				toolCallCount: response?.toolCalls.length ?? 0,
			});
			if (!call) return null;
			return {
				id: call.id,
				name: call.name,
				input: parseToolArguments(call.arguments),
				usage: response?.usage
					? { cacheRead: response.usage.cacheRead, cacheWrite: response.usage.cacheWrite }
					: undefined,
			};
		} catch (error) {
			await notifyLlmObserver(options.observer?.onError, {
				model: endpoint.model,
				durationMs: Date.now() - startedAt,
				error,
			});
			throw error;
		}
	};
}

async function notifyLlmObserver<T>(
	callback: ((input: T) => void | Promise<void>) | undefined,
	input: T,
): Promise<void> {
	if (!callback) return;
	try {
		await callback(input);
	} catch {
		// Observability must never change Drift control flow.
	}
}

function parseToolArguments(argumentsValue: string | Record<string, unknown>): Record<string, unknown> {
	if (typeof argumentsValue !== "string") return argumentsValue;
	try {
		const parsed = JSON.parse(argumentsValue) as unknown;
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

/** 首次运行无 skill 时写入内置示例(照 akashic create-drift-skill)。 */
export function seedExampleDriftSkill(skillsDir: string): void {
	const dir = join(skillsDir, "create-drift-skill");
	const file = join(dir, "SKILL.md");
	if (existsSync(file)) return;
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		file,
		`---
name: create-drift-skill
description: 当此刻想反复进行的活动还没有合适 skill,或近期多轮行为显露出可发展的兴趣时,在 Drift 工作区创建或更新一个可再次选择的活动。
---

# 创建 Drift Skill

## 目标

把空闲时仍愿意再次做的小活动沉淀到 \`skills/<skill_name>/SKILL.md\`。
本轮处于设计期,只负责给未来的 Drift 写一份可选择的活动说明书,不执行新活动本身。

## 未来如何被选择

新 skill 不会因为文件创建成功就立刻运行,也没有独立的定时触发器。
从下一轮 Drift 起进入候选列表,runtime 展示 name/description/过去状态,agent 自由选择。

## 何时使用

- 发现一种以后还可能想做的活动
- 近期多轮总在做相似的小动作,开始显露出一个值得独立发展的活动
- 此刻确实想做一件事,但现有 skill 都不能自然表达它
- 不要因为"应该扩充能力"而强行创建;没有自然想法时可以做别的或休息

## 工作流

1. 先说明为什么以后还会想做这件事,以及什么空闲情境下可能会选择它;再回答"连续运行三次后,会积累或改变什么"。如果答案是什么也不会改变,就不要创建。
2. 从这个活动形成一个不同于 \`create-drift-skill\` 的目标名称,再检查 \`skills/<skill_name>/\` 是否已存在。
3. 读取目标的 \`SKILL.md\`;如果已存在就在原基础上更新,不存在再创建。
4. 只把可长期复用、可独立闭环的小活动沉淀成 drift skill;一次性进展写入 \`finish_drift\`,不要创建新 skill。
5. 先定义"何时可能选择"和一次 Drift run 的最小闭环,再决定是否需要脚本。
6. \`SKILL.md\` 顶部 frontmatter 至少包含 name 与 description(做什么,以及什么空闲情境下适合选择)。
7. 正文只写未来选中后真正需要的最小流程,避免空泛模板。

## 值得成为 skill 的最低条件

- 每轮至少产生一种真实变化:形成新的理解、留下可继续使用的素材、推进一个兴趣、改善已有能力,或为用户准备以后可能有价值的东西。
- 活动来源至少有一个实际依据:用户兴趣、近期行为、自我观察,或当下确实想再次进行的动作。
- 它必须区别于已有能力。单纯"不打扰""安静待着"已经由 \`idle_drift\` 表达,不要包装成新 skill。
- \`message_push\` 是 fire-and-forget。新 skill 可以发消息或轻问题,但发送成功就必须自行闭环,不能把等待回答、没有回答或下轮追问当作状态。

## 状态模型

新 drift skill 必须使用 runtime 统一状态,不要自行维护并行状态文件:

- \`scratchpad_update\`:自然语言前情,例如"下次先检查哪个文件"。
- \`cursor_update\`:结构化游标,供脚本或下轮流程直接决定下一步。
- \`journal_append\`:append-only 记录已经完成、问过、审计过、生成过的事实。
- 不要把连续性状态写到 skill 目录下的 \`state.json\`。

## 约束

- skill 文件必须通过 runtime 文件工具写到 \`skills/<skill_name>/\`,不要使用宿主机绝对路径
- 不要为了一个一次性动作创建 skill
- 如果只是当前 skill 的进展变化,优先通过 \`finish_drift\` 的 \`scratchpad_update\`、\`cursor_update\` 或 \`journal_append\` 保存连续性,不要修改 skill 文件
- 结束流程必须写清 \`finish_drift.status\`:本轮创建或更新已闭环写 \`completed\`,尚未写完写 \`paused\`
- \`paused\` 必须写 \`scratchpad_update\`,说明下次从哪里继续
- 已完成事实必须通过 \`journal_append\` 记录,避免下轮重复处理同一对象

## 收尾

- 成功闭环:finish_drift(status="completed", self_update={pattern: "ordinary", reflection: "...", next_tendency: "..."}, ...)
- 未完成但可继续:finish_drift(status="paused", scratchpad_update="...", ...)
- 每次收尾都重新判断 next_tendency,不要在说明书里复制一个固定句子
`,
		"utf-8",
	);
}
