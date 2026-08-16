/**
 * Subagent runner — executes one sub-task on an isolated in-process Agent.
 *
 * Akashic equivalent: SubagentSpec + SubagentRuntime (agent/background/
 * subagent_profiles.py) — a lightweight agent loop with its own transcript,
 * system prompt, and tool set, sharing only the parent's model runtime.
 *
 * Design decisions (see task deliverable notes):
 * - Model/thinking level follow the main session (caller passes the same
 *   model and thinking level); the system prompt is an independent focused
 *   worker prompt, not the parent's full system prompt.
 * - Tools default to a read-only research set (read/grep/find/ls) so
 *   sub-agents cannot mutate the project by default; a per-job whitelist can
 *   extend them. The spawn tool itself is never inherited (recursion guard).
 * - Each job gets a fresh `Agent` (isolated context, no transcript pollution);
 *   the agent is garbage-collected after the run, so no session/file state
 *   needs cleanup.
 */

import type { AgentMessage, AgentTool, StreamFn, ThinkingLevel } from "@cogito/agent-core";
import { Agent } from "@cogito/agent-core";
import { contentText } from "@cogito/ai";
import type { Model } from "@cogito/ai/compat";
import type { SubagentRunner, SubagentRunRequest, SubagentRunResult } from "./subagent-manager.ts";
import { createReadOnlyTools, createTool, type ToolName } from "./tools/index.ts";

/** Default read-only research tool set (akashic "research" profile equivalent). */
export const DEFAULT_SUBAGENT_TOOLS: readonly string[] = ["read", "grep", "find", "ls"];
/** Default tool-loop iteration cap per sub-task (akashic research profile max_iterations). */
export const DEFAULT_SUBAGENT_MAX_ITERATIONS = 20;

const DEFAULT_SUBAGENT_SYSTEM_PROMPT = `You are a focused subagent executing a delegated task in isolation.
- You have not seen the main conversation; rely only on the task description below.
- Work autonomously and do not ask the user for confirmation.
- Produce the requested deliverable (report, analysis, or files).
- End your reply with the final result text; the parent agent will relay it.`;

export interface SubagentAgentRunnerOptions {
	/** Model for sub-agent calls (follows the main session). */
	model: Model<any>;
	/** Thinking level for sub-agent calls (follows the main session). */
	thinkingLevel?: ThinkingLevel;
	/** Working directory for tool execution. */
	cwd: string;
	/**
	 * Stream function for sub-agent calls. Mirror the main session wiring
	 * (e.g. modelRuntime.streamSimple with provider retry settings); must
	 * honor the `signal` option so timeouts/cancellation can abort the run.
	 */
	streamFn: StreamFn;
	/** Base system prompt for sub-agents. Defaults to a focused worker prompt. */
	systemPrompt?: string;
	/** Default tool set when a request does not whitelist tools. */
	defaultTools?: readonly string[];
	/** Max tool-loop iterations per job. 0 disables the cap. Default: 20. */
	maxIterations?: number;
	/** Session identifier forwarded to providers for cache-aware backends. */
	sessionId?: string;
}

export function createSubagentAgentRunner(options: SubagentAgentRunnerOptions): SubagentRunner {
	const defaultTools = options.defaultTools ?? DEFAULT_SUBAGENT_TOOLS;
	const maxIterations = options.maxIterations ?? DEFAULT_SUBAGENT_MAX_ITERATIONS;
	const systemPrompt = options.systemPrompt ?? DEFAULT_SUBAGENT_SYSTEM_PROMPT;
	const streamFn = options.streamFn;

	return {
		async run(request: SubagentRunRequest, signal: AbortSignal): Promise<SubagentRunResult> {
			if (signal.aborted) {
				return { status: "cancelled", exitReason: "aborted", result: "子任务在开始前已被取消。" };
			}
			const tools = resolveTools(request.tools, defaultTools, options.cwd);
			const agent = new Agent({
				initialState: {
					model: options.model,
					thinkingLevel: options.thinkingLevel,
					systemPrompt: request.systemPrompt ?? systemPrompt,
					tools,
				},
				streamFn,
				sessionId: options.sessionId,
				shouldStopAfterTurn:
					maxIterations > 0 ? (context) => assistantTurnCount(context.newMessages) >= maxIterations : undefined,
			});

			// Bridge the manager's signal (timeout/cancel) to the agent run.
			const abortAgent = (): void => agent.abort();
			signal.addEventListener("abort", abortAgent, { once: true });
			try {
				await agent.prompt(request.task);
			} catch (error) {
				if (signal.aborted) {
					return { status: "cancelled", exitReason: "aborted", result: "子任务已取消。" };
				}
				return {
					status: "failed",
					exitReason: "error",
					result: error instanceof Error ? error.message : String(error),
				};
			} finally {
				signal.removeEventListener("abort", abortAgent);
			}

			const lastAssistant = findLastAssistant(agent.state.messages);
			if (!lastAssistant) {
				return { status: "failed", exitReason: "no_output", result: "子任务没有产生输出。" };
			}
			if (lastAssistant.stopReason === "aborted") {
				return { status: "cancelled", exitReason: "aborted", result: "子任务已取消。" };
			}
			if (lastAssistant.stopReason === "error") {
				const errorMessage = lastAssistant.errorMessage ?? "子任务执行出错。";
				return { status: "failed", exitReason: "error", result: errorMessage };
			}
			const text = contentText(lastAssistant.content, "").trim();
			if (text.length === 0) {
				return { status: "failed", exitReason: "no_output", result: "子任务没有产生输出。" };
			}
			return { status: "completed", exitReason: "completed", result: text };
		},
		shutdown: async () => {},
	};
}

function resolveTools(requestTools: string[] | undefined, defaultTools: readonly string[], cwd: string): AgentTool[] {
	const names = requestTools && requestTools.length > 0 ? requestTools : defaultTools;
	const tools: AgentTool[] = [];
	const seen = new Set<string>();
	for (const name of names) {
		if (seen.has(name)) continue;
		seen.add(name);
		try {
			tools.push(createTool(name as ToolName, cwd));
		} catch {
			// Unknown tools (including "spawn") are skipped: sub-agents never
			// inherit the delegation tool, preventing recursive spawning.
		}
	}
	return tools.length > 0 ? tools : createReadOnlyTools(cwd);
}

function assistantTurnCount(messages: AgentMessage[]): number {
	let count = 0;
	for (const message of messages) {
		if (message.role === "assistant") count++;
	}
	return count;
}

function findLastAssistant(messages: AgentMessage[]): Extract<AgentMessage, { role: "assistant" }> | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role === "assistant") {
			return message as Extract<AgentMessage, { role: "assistant" }>;
		}
	}
	return undefined;
}
