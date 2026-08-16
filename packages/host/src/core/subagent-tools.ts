/**
 * Spawn tools — registerTool()-ready tool definitions backed by SubagentManager.
 *
 * Akashic equivalent: agent/tools/spawn.py (SpawnTool + SpawnManageTool).
 * Parameters follow the akashic shape: task description, optional tool
 * whitelist, and the `run_in_background` flag (default false = synchronous).
 */

import { Type } from "typebox";
import { type AgentToolResult, defineTool, type ToolDefinition } from "./extensions/types.ts";
import type { SubagentManager, SubagentRunRequest, SubagentRunResult } from "./subagent-manager.ts";

export const DEFAULT_SUBAGENT_BACKGROUND_RESULT_MAX_CHARS = 12_000;

export interface SpawnToolOptions {
	manager: SubagentManager;
}

const spawnDescription = [
	"把一个有界的多步任务交给独立 subagent 执行,主 agent 专注决策和用户沟通。",
	"何时使用 spawn(同时满足所有条件):",
	"- 预计需要 4 步以上工具调用",
	"- 可以完全独立完成,中途不需要用户确认",
	'- 产出是报告 / 分析结论 / 独立文件,而非"立刻执行的行动"',
	"何时不用 spawn:",
	"- 只需 1-3 次工具调用或直接回答 → 直接做,更快",
	"- 任务需要修改当前会话状态,或需要和用户来回确认",
	"- 用户要求立即生效的行动(发送 / 告诉 / 立即执行)",
	"执行模式(run_in_background):",
	"- false(默认):同步执行,主会话等待结果后继续;适合研究后需要立即回答的任务",
	"- true:后台执行,主会话立即继续;完成后结果会作为新消息带回当前会话继续处理",
	"如何写好 task 参数(subagent 没有看过当前会话,像给新同事写交接文档):",
	"1. 任务目标:一句话说清楚产出物",
	"2. 关键约束:格式 / 范围 / 截止 / 不能做什么",
	"3. 关键上下文:用户偏好、当前状态摘要、已经试过什么",
	"4. 期望输出格式:文本报告 / Markdown / JSON / 写入文件",
].join("\n");

/** Register the delegation tool set on an extension API. Returns the registered definitions. */
export function createSpawnTool(options: SpawnToolOptions): ToolDefinition {
	const manager = options.manager;
	return defineTool({
		name: "spawn",
		label: "spawn",
		description: spawnDescription,
		promptSnippet: "Delegate a bounded multi-step task to a subagent",
		promptGuidelines: [
			"Use spawn only for tasks that are fully self-contained (4+ tool steps, no user confirmation needed).",
			"Default subagent tools are read-only (read/grep/find/ls); whitelist write/bash tools only when the task requires them.",
		],
		parameters: Type.Object({
			task: Type.String({
				description: "交给 subagent 的完整任务描述,必须包含:任务目标、关键约束、关键上下文、期望输出格式",
			}),
			label: Type.Optional(Type.String({ description: "3-5 字的任务短标签,用于状态显示" })),
			tools: Type.Optional(
				Type.Array(Type.String(), {
					description: "子任务工具白名单(read/grep/find/ls/bash/edit/write);默认只读调研工具集",
				}),
			),
			run_in_background: Type.Optional(
				Type.Boolean({ description: "true:后台执行立即返回;false(默认):同步执行等待结果" }),
			),
			timeout_seconds: Type.Optional(Type.Number({ description: "任务超时秒数;默认不限制(0 表示不限制)" })),
		}),
		async execute(_toolCallId, params): Promise<AgentToolResult<undefined>> {
			const request: SubagentRunRequest = {
				task: params.task,
				label: params.label,
				tools: params.tools,
				timeoutMs:
					params.timeout_seconds !== undefined
						? Math.max(0, Math.floor(params.timeout_seconds * 1000))
						: undefined,
			};
			try {
				if (params.run_in_background) {
					const ack = manager.spawn(request);
					return textResult(ack);
				}
				const result = await manager.spawnSync(request);
				return textResult(result);
			} catch (error) {
				return textResult(`[错误] spawn 失败:${error instanceof Error ? error.message : String(error)}`);
			}
		},
	});
}

/** Query or cancel background sub-tasks. */
export function createSpawnManageTool(manager: SubagentManager): ToolDefinition {
	return defineTool({
		name: "spawn_manage",
		label: "spawn_manage",
		description: [
			"管理当前运行中的后台 subagent。",
			"可用 action:",
			"- list:列出运行中的后台任务(job_id、label、任务摘要、启动时间)",
			'- cancel:按 job_id 取消后台任务;取消后系统会把"已取消"结果带回当前会话',
			"只在用户询问后台任务状态、要求查看 job_id、或明确要求停止某个后台任务时使用。",
		].join("\n"),
		promptSnippet: "Manage running background subagents",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("list"), Type.Literal("cancel")], {
				description: "list 查看运行中任务;cancel 取消指定 job_id",
			}),
			job_id: Type.Optional(Type.String({ description: "action=cancel 时要取消的后台任务 job_id" })),
		}),
		async execute(_toolCallId, params): Promise<AgentToolResult<undefined>> {
			if (params.action === "list") {
				return textResult(
					JSON.stringify({
						running_count: manager.getRunningCount(),
						jobs: manager.listRunningJobs(),
					}),
				);
			}
			const jobId = (params.job_id ?? "").trim();
			if (jobId.length === 0) {
				return textResult(JSON.stringify({ error: "缺少 job_id" }));
			}
			const cancelled = manager.cancel(jobId);
			return textResult(
				JSON.stringify({
					job_id: jobId,
					status: cancelled ? "cancel_requested" : "not_found",
				}),
			);
		},
	});
}

/** Both spawn tools in one array (register both via pi.registerTool). */
export function createSubagentTools(options: SpawnToolOptions): ToolDefinition[] {
	return [createSpawnTool(options), createSpawnManageTool(options.manager)];
}

/** Format a background completion for delivery back to the origin session. */
export function formatSubagentCompletion(
	jobId: string,
	result: SubagentRunResult,
	maxChars: number = DEFAULT_SUBAGENT_BACKGROUND_RESULT_MAX_CHARS,
): string {
	let text = result.result;
	if (text.length > maxChars) {
		const originalLength = text.length;
		text = `${text.slice(0, maxChars)}\n...[结果已截断,原始长度 ${originalLength}]`;
	}
	return `[后台子任务完成 job_id=${jobId}]\n状态: ${result.status}\n退出原因: ${result.exitReason}\n\n${text}`;
}

function textResult(text: string): AgentToolResult<undefined> {
	return { content: [{ type: "text", text }], details: undefined };
}
