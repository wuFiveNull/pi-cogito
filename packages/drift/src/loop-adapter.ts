/**
 * Drift agent-loop adapter.
 *
 * Drives DriftTurnPipeline's execute phase through pi-agent-core's
 * runAgentLoop, reusing the agent runtime (turn orchestration, tool
 * execution, hook-based control flow) instead of the bespoke executeLoop.
 *
 * The DriftLlmFn single-call seam is preserved: the adapter synthesizes an
 * AssistantMessageEventStream around each LLM call so callers (tests, hosts)
 * keep injecting the same DriftLlmFn. The multi-turn loop, phase tool
 * filtering, constraint rejection handling, and wrap-up state machine live
 * here.
 */

import type {
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	AgentToolResult,
	StreamFn,
} from "@cogito/agent-core";
import { runAgentLoop } from "@cogito/agent-core";
import type { AssistantMessage, AssistantMessageEvent, Model } from "@cogito/ai";
import { EventStream } from "@cogito/ai/utils/event-stream";
import { Type } from "typebox";
import type { DriftLlmFn, DriftRunContext, LlmToolCall } from "./runtime.ts";
import type { DriftStateStore } from "./state.ts";
import { type DriftTool, type DriftToolCallEvent, type DriftToolDeps, getDriftToolMeta } from "./tools.ts";

const BEFORE_SELECT_TOOLS = new Set(["select_skill", "idle_drift"]);
const AFTER_SEND_TOOLS = new Set(["finish_drift"]);
const TOOL_CONSTRAINT_RETRY_LIMIT = 2;
const WRAP_UP_MAX_ATTEMPTS = 2;

const WRAP_UP_MESSAGE =
	"【系统强制收尾】本轮 Drift 可用步数已耗尽。" +
	"不要继续推进任务，只根据上方已发生的工具结果调用 finish_drift。" +
	"如果本轮小闭环已完成，status 写 completed。" +
	"如果没做完，status 写 paused，并在 scratchpad_update 写清已经做到哪里、" +
	"当前卡在什么条件、下次从哪里继续。" +
	"不要编造额外下一步。";

const DEFAULT_MODEL: Model<any> = {
	id: "unknown",
	name: "unknown",
	api: "unknown",
	provider: "unknown",
	baseUrl: "",
	reasoning: false,
	input: [],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 0,
	maxTokens: 0,
};

const EMPTY_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** Options for {@link runDriftAgentLoop}. */
export interface RunDriftLoopOptions {
	ctx: DriftRunContext;
	llmFn: DriftLlmFn;
	/** Full drift tool registry (used for schemas and execution). */
	tools: DriftTool[];
	store: DriftStateStore;
	toolDeps: DriftToolDeps;
	maxSteps: number;
	/** Hard deadline (epoch ms); exceeded → wrap-up. */
	deadline: number;
	/** Max chars of one tool result forwarded to the next model request. */
	maxToolResultChars: number;
	/** Merged system prompt (drift base prompt + runtime context frame). */
	systemPrompt: string;
	/** Called via agent_end when the run ends without finish_drift. */
	onUnfinished: () => void;
	/** Optional audit hook for tool calls (drift_tool_called events). */
	onToolCall?: (event: DriftToolCallEvent) => void | Promise<void>;
}

/** 一轮 drift 的 LLM usage 汇总(akashic record_llm_cache 的 run 级形态)。 */
export interface DriftLoopUsage {
	cacheRead: number;
	cacheWrite: number;
}

/**
 * Run the drift execute phase through pi-agent-core's runAgentLoop.
 *
 * Preserves drift's loop semantics:
 * - phase allowlists (select_skill/idle_drift first, finish_drift after send)
 * - constraint rejection counting (2 strikes → wrap-up)
 * - maxSteps / maxDurationMs budgets → forced wrap-up
 * - wrap-up: up to 2 forced finish_drift attempts, then fallback pause
 * - tool errors end the run (fallback pause)
 *
 * Returns the accumulated LLM cache usage across all calls in this run.
 */
export async function runDriftAgentLoop(options: RunDriftLoopOptions): Promise<DriftLoopUsage> {
	const {
		ctx,
		llmFn,
		tools,
		store,
		toolDeps,
		maxSteps,
		deadline,
		maxToolResultChars,
		systemPrompt,
		onUnfinished,
		onToolCall,
	} = options;

	const agentTools = tools.map((tool) => wrapDriftToolAsAgentTool(tool, () => ctx));
	const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
	const finishAgentTool = agentTools.find((tool) => tool.name === "finish_drift") ?? agentTools[0]!;

	let steps = 0;
	let rejections = 0;
	let forcing = false;
	let wrapUpAttempts = 0;
	let wrapUpRejection = "";
	let stopRequested = false;
	const startArgsByCallId = new Map<string, unknown>();
	const usageTotal: DriftLoopUsage = { cacheRead: 0, cacheWrite: 0 };

	/** Tools allowed in the current phase; null = all tools. */
	const allowedNames = (): Set<string> | null => {
		if (forcing) return new Set(["finish_drift"]);
		if (!ctx.driftSelectedSkill.trim()) return BEFORE_SELECT_TOOLS;
		if (ctx.driftMessageStaged) return AFTER_SEND_TOOLS;
		return null;
	};

	const phaseSchemas = (): Array<Record<string, unknown>> => {
		const allowed = allowedNames();
		if (allowed === null) return tools.map(toolSchema);
		return tools.filter((tool) => allowed.has(tool.name)).map(toolSchema);
	};

	const appendStep = (toolName: string, args: unknown, output: string): void => {
		try {
			store.appendStep({
				runId: ctx.runId,
				stepIndex: steps,
				toolName,
				inputPreview: previewToolArgs(args as Record<string, unknown>),
				outputPreview: clipToolResult(output, 500),
				nowUtc: ctx.nowUtc,
			});
		} catch {
			// Step recording must never break the run.
		}
	};

	const observeToolCall = async (event: DriftToolCallEvent): Promise<void> => {
		try {
			await toolDeps.toolPolicy?.onCall?.(event, ctx);
		} catch {
			// Tool audit hooks must never break the run.
		}
		if (!onToolCall) return;
		try {
			await onToolCall(event);
		} catch {
			// Tool audit hooks must never break the run.
		}
	};

	// Synthesize a stream around one DriftLlmFn call.
	const streamFn: StreamFn = async (model, context) => {
		// Wrap-up trigger check before each LLM call (matches the original
		// executeLoop's per-iteration guard): step/deadline budgets and
		// constraint-rejection limit.
		if (!forcing && !ctx.driftFinished) {
			if (rejections >= TOOL_CONSTRAINT_RETRY_LIMIT) {
				if (allowedNames()?.has("finish_drift")) {
					forcing = true;
					wrapUpAttempts = 0;
					wrapUpRejection = "";
				} else {
					stopRequested = true;
				}
			} else if (steps >= maxSteps || Date.now() > deadline) {
				forcing = true;
				wrapUpAttempts = 0;
				wrapUpRejection = "";
			}
		}
		const schemas = phaseSchemas();
		const toolChoice = forcing ? { type: "function", function: { name: "finish_drift" } } : "required";
		let call: LlmToolCall | null = null;
		// LLM errors propagate: the pipeline's failure handling records a paused
		// run and rethrows (matching the original executeLoop contract).
		call = await llmFn(
			context.messages as unknown as Array<Record<string, unknown>>,
			schemas,
			toolChoice,
			context.systemPrompt,
		);
		if (forcing && call === null) {
			wrapUpRejection = "没有返回工具调用";
		}
		if (call?.usage) {
			usageTotal.cacheRead += call.usage.cacheRead;
			usageTotal.cacheWrite += call.usage.cacheWrite;
		}
		const message = synthesizeAssistantMessage(model, call);
		return new SyntheticAssistantStream(message);
	};

	const emit = async (event: AgentEvent): Promise<void> => {
		switch (event.type) {
			case "tool_execution_start": {
				steps += 1;
				ctx.stepsTaken += 1;
				startArgsByCallId.set(event.toolCallId, event.args);
				break;
			}
			case "tool_execution_end": {
				const allowed = allowedNames();
				if (event.isError && allowed !== null && !allowed.has(event.toolName)) {
					rejections += 1;
					appendStep(
						event.toolName,
						startArgsByCallId.get(event.toolCallId),
						`错误：当前阶段不能调用 ${event.toolName}。当前只允许调用：${[...allowed].sort().join(", ")}。`,
					);
				}
				startArgsByCallId.delete(event.toolCallId);
				break;
			}
			case "agent_end": {
				if (!ctx.driftFinished) onUnfinished();
				break;
			}
			default:
				break;
		}
	};

	const config: AgentLoopConfig = {
		model: DEFAULT_MODEL,
		convertToLlm: (messages) =>
			messages.filter(
				(message) => message.role === "user" || message.role === "assistant" || message.role === "toolResult",
			),
		beforeToolCall: async (context) => {
			const tool = toolsByName.get(context.toolCall.name);
			if (!tool) return undefined;
			const allowed = allowedNames();
			if (allowed !== null && !allowed.has(context.toolCall.name)) {
				// Defense in depth: schemas are already phase-filtered.
				const reason =
					`错误：当前阶段不能调用 ${context.toolCall.name}。当前只允许调用：${[...allowed].sort().join(", ")}。` +
					(allowed.has("finish_drift") ? "请调用 finish_drift 保存 completed 或 paused 状态。" : "");
				return { block: true, reason };
			}
			const meta = getDriftToolMeta(tool);
			try {
				const authorization = await toolDeps.toolPolicy?.authorize?.({
					tool,
					meta,
					args: context.args as Readonly<Record<string, unknown>>,
					ctx,
				});
				const denied = authorization === false || typeof authorization === "string";
				if (denied) {
					const reason = typeof authorization === "string" ? authorization : "authorization denied";
					const error = `tool denied: ${reason}`;
					appendStep(tool.name, context.args, error);
					await observeToolCall({
						toolName: tool.name,
						meta,
						argsPreview: previewToolArgs(context.args as Record<string, unknown>),
						durationMs: 0,
						result: "denied",
						error,
					});
					stopRequested = true;
					return { block: true, reason: error };
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				appendStep(tool.name, context.args, `tool authorization error: ${message}`);
				stopRequested = true;
				return { block: true, reason: `tool authorization error: ${message}` };
			}
			return undefined;
		},
		afterToolCall: async (context) => {
			const tool = toolsByName.get(context.toolCall.name);
			if (!tool) return undefined;
			const meta = getDriftToolMeta(tool);
			const text = resultText(context.result);
			appendStep(context.toolCall.name, context.args, text);
			// Clip oversized tool results before the next model request.
			let contentOverride: Array<{ type: "text"; text: string }> | undefined;
			if (text.length > maxToolResultChars) {
				contentOverride = [{ type: "text", text: clipToolResult(text, maxToolResultChars) }];
			}
			await observeToolCall({
				toolName: tool.name,
				meta,
				argsPreview: previewToolArgs(context.args as Record<string, unknown>),
				durationMs: 0,
				result: context.isError ? "error" : "success",
				error: context.isError ? text : undefined,
			});
			if (context.toolCall.name === "finish_drift") {
				wrapUpRejection = context.isError ? text : ctx.driftFinished ? "" : `finish_drift 未完成：${text}`;
			}
			if (context.isError && !(forcing && context.toolCall.name === "finish_drift")) {
				// Original executeLoop broke out of the loop on tool errors.
				stopRequested = true;
			}
			return contentOverride ? { content: contentOverride } : undefined;
		},
		prepareNextTurn: async (turn) => {
			if (ctx.driftFinished) {
				stopRequested = true;
				return undefined;
			}
			if (forcing) {
				if (wrapUpAttempts >= WRAP_UP_MAX_ATTEMPTS) {
					stopRequested = true;
					return undefined;
				}
				wrapUpAttempts += 1;
				const message =
					wrapUpAttempts === 1
						? WRAP_UP_MESSAGE
						: `【系统强制收尾重试】上一次收尾无效：${wrapUpRejection}。你已经可以看到本轮完整工具历史，现在只能调用 finish_drift，不能调用任何其他工具。`;
				// akashic 用 system role 注入收尾提示;@cogito/ai 的 Message
				// 联合类型只有 user/assistant/toolResult,且 convertToLlm
				// 会过滤其它角色,因此这里保持 user role(有意偏差,行为等价)。
				return {
					context: {
						systemPrompt,
						messages: [...turn.context.messages, createUserMessage(message)],
						tools: [finishAgentTool],
					},
				};
			}
			const allowed = allowedNames();
			const nextTools = allowed === null ? agentTools : agentTools.filter((tool) => allowed.has(tool.name));
			return { context: { ...turn.context, tools: nextTools } };
		},
		shouldStopAfterTurn: async () =>
			stopRequested || ctx.driftFinished || (forcing && wrapUpAttempts >= WRAP_UP_MAX_ATTEMPTS),
		getFollowUpMessages: async () => [],
	};

	await runAgentLoop([], { systemPrompt, messages: [], tools: agentTools }, config, emit, undefined, streamFn);
	return usageTotal;
}

function createUserMessage(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

function resultText(result: AgentToolResult<any>): string {
	const content = result.content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function synthesizeAssistantMessage(model: Model<any>, call: LlmToolCall | null): AssistantMessage {
	if (call !== null) {
		return {
			role: "assistant",
			content: [{ type: "toolCall", id: call.id, name: call.name, arguments: call.input }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			// 真实 cache usage(akashic record_llm_cache);无 usage 时保持 EMPTY_USAGE。
			usage: call.usage
				? {
						...EMPTY_USAGE,
						cacheRead: call.usage.cacheRead,
						cacheWrite: call.usage.cacheWrite,
					}
				: EMPTY_USAGE,
			stopReason: "toolUse",
			timestamp: Date.now(),
		};
	}
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: EMPTY_USAGE,
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

/** Stream that immediately yields the synthesized assistant message. */
class SyntheticAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor(message: AssistantMessage) {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected synthetic stream event");
			},
		);
		this.push({ type: "start", partial: message });
		this.push({
			type: "done",
			reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
			message,
		});
	}
}

/** Wrap a DriftTool into a pi-agent-core AgentTool for the loop. */
export function wrapDriftToolAsAgentTool(tool: DriftTool, getCtx: () => DriftRunContext): AgentTool<any, unknown> {
	return {
		name: tool.name,
		label: tool.name,
		description: tool.description,
		// Drift performs its own argument handling; skip TypeBox validation.
		// LLM-facing schemas come from the DriftTool registry (toolSchema).
		parameters: Type.Unknown(),
		execute: async (_toolCallId, params, _signal, _onUpdate) => {
			const output = await tool.execute(params as Record<string, unknown>, getCtx());
			return { content: [{ type: "text", text: output }], details: undefined };
		},
	};
}

/** JSON schema + risk metadata for one drift tool (moved from runtime.ts). */
export function toolSchema(tool: DriftTool): {
	type: "function";
	function: { name: string; description: string; parameters: Record<string, unknown> };
} {
	const meta = getDriftToolMeta(tool);
	const risk = `[tool risk=${meta.risk}; source=${meta.source}${meta.requiresApproval ? "; approval=required" : ""}]`;
	return {
		type: "function",
		function: { name: tool.name, description: `${tool.description}\n${risk}`, parameters: tool.parameters },
	};
}

function previewToolArgs(args: Record<string, unknown>): string {
	try {
		return JSON.stringify(redactToolValue(args)).slice(0, 1_000);
	} catch {
		return "[unserializable arguments]";
	}
}

function redactToolValue(value: unknown, depth = 0): unknown {
	if (depth >= 4) return "[truncated]";
	if (Array.isArray(value)) return value.slice(0, 20).map((item) => redactToolValue(item, depth + 1));
	if (typeof value !== "object" || value === null) return value;
	const output: Record<string, unknown> = {};
	for (const [key, nested] of Object.entries(value)) {
		output[key] = /(?:api[-_]?key|authorization|password|secret|token)/i.test(key)
			? "[redacted]"
			: redactToolValue(nested, depth + 1);
	}
	return output;
}

function clipToolResult(text: string, limit: number): string {
	const normalized = String(text ?? "");
	if (normalized.length <= limit) return normalized;
	const marker = `\n\n[tool result truncated by Drift budget; omitted ${normalized.length - limit} chars]`;
	return `${normalized.slice(0, Math.max(0, limit - marker.length))}${marker}`;
}
