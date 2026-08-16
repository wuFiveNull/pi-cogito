/**
 * tool_search: dynamic tool discovery, mounted as a hidden inline extension.
 *
 * Follows the loader-tool pattern from the dynamic tool loading docs: the tool
 * searches the catalog and activates matching tools with setActiveTools()
 * (purely additive). The host wrapper records the newly added names on the
 * tool result as addedToolNames, so agent-core exposes the definitions on the
 * immediately following request — natively via deferred loading
 * (tool_search_call/tool_search_output, tool_reference) when the model
 * supports it, otherwise via the regular active tool list.
 */

import { Type } from "typebox";
import type { AgentToolResult } from "../extensions/index.ts";
import { defineTool } from "../extensions/index.ts";
import type { Extension, RegisteredTool } from "../extensions/types.ts";
import type { SourceInfo } from "../source-info.ts";
import { createSyntheticSourceInfo } from "../source-info.ts";
import type { ToolCatalog, ToolCatalogMatch } from "../tool-catalog.ts";

const toolSearchSchema = Type.Object({
	query: Type.String({ description: '要查找的功能关键词或自然语言描述，例如："记忆 检索"、"文件读取"、"定时任务"' }),
	limit: Type.Optional(Type.Number({ description: "最大返回工具数，默认 8" })),
});

/** Runtime hooks the tool needs to activate matched tools. */
export interface ToolSearchRuntimeHooks {
	getActiveTools: () => string[];
	setActiveTools: (toolNames: string[]) => void;
}

const MAX_LIMIT = 20;

function clampLimit(limit: number | undefined): number {
	if (limit === undefined) return 8;
	return Math.min(Math.max(1, Math.floor(limit)), MAX_LIMIT);
}

function toTextResult(text: string): AgentToolResult<undefined> {
	return { content: [{ type: "text", text }], details: undefined };
}

function formatMatch(match: ToolCatalogMatch): Record<string, unknown> {
	return {
		name: match.name,
		description: match.description.length > 120 ? `${match.description.slice(0, 120)}...` : match.description,
		whyMatched: match.whyMatched,
		source: match.source,
	};
}

/**
 * Tool definition for tool_search. The execute closure searches the catalog
 * and activates matched tools through the runtime hooks.
 */
export function createToolSearchToolDefinition(catalog: ToolCatalog, hooks: ToolSearchRuntimeHooks) {
	return defineTool({
		name: "tool_search",
		label: "tool_search",
		description:
			"在工具目录中按关键词搜索可用工具，并立即激活匹配的工具，之后可直接调用。\n\n" +
			"调用时机：\n" +
			"- 需要某类功能，但不知道工具名称 → 必须调用\n" +
			"- 知道工具名且当前可用 → 直接调用，不要先搜索\n" +
			'- 收到"工具不存在"错误 → 必须调用，用错误中的建议关键词搜索\n' +
			"- 纯对话/推理，不涉及工具能力 → 不调用\n\n" +
			"查询形式：\n" +
			'- 功能关键词："记忆"、"文件读取"、"定时提醒"、"搜索网络"\n' +
			'- 工具名（精确匹配优先）："read"、"recall_memory"\n\n' +
			"正确流程：tool_search(query) → 从 matched 中选择工具 → 直接调用（不需要二次搜索）",
		promptSnippet: "Search and activate additional tools",
		promptGuidelines: [
			"Use tool_search when the task needs a capability that is not in your current tool list.",
			"After tool_search, call the matched tool directly; do not search again.",
		],
		parameters: toolSearchSchema,
		async execute(_toolCallId, params): Promise<AgentToolResult<undefined>> {
			const query = (params.query ?? "").trim();
			if (query === "") {
				return toTextResult(JSON.stringify({ matched: [], added: [], tip: "query 不能为空，请描述你需要的功能" }));
			}

			const matches = catalog.search(query, {
				limit: clampLimit(params.limit),
				excludedNames: new Set(["tool_search"]),
			});

			const active = hooks.getActiveTools();
			const added = matches.map((match) => match.name).filter((name) => !active.includes(name));
			if (added.length > 0) {
				hooks.setActiveTools([...active, ...added]);
			}

			if (matches.length === 0) {
				return toTextResult(JSON.stringify({ matched: [], added: [], tip: "没有找到匹配工具，请换个关键词重试" }));
			}

			const result: Record<string, unknown> = {
				matched: matches.map(formatMatch),
				added,
			};
			if (added.length > 0) {
				result.tip = `已激活工具: ${added.join(", ")}，下一步直接调用，不要再次 tool_search`;
			} else {
				result.tip = "匹配工具已在当前工具列表中，直接调用即可";
			}
			return toTextResult(JSON.stringify(result));
		},
	});
}

/**
 * Hidden inline extension that registers tool_search through the same data
 * path as pi.registerTool() (extension.tools.set with sourceInfo), so it flows
 * through the regular extension pipeline: wrapping, active-tool tracking, and
 * catalog indexing. AgentSession mounts it in _buildRuntime.
 */
export function createToolSearchExtension(catalog: ToolCatalog, hooks: ToolSearchRuntimeHooks): Extension {
	const sourceInfo: SourceInfo = createSyntheticSourceInfo("<tool-search>", { source: "builtin" });
	const registeredTool: RegisteredTool = {
		definition: createToolSearchToolDefinition(catalog, hooks),
		sourceInfo,
	};
	return {
		path: "<tool-search>",
		resolvedPath: "<tool-search>",
		hidden: true,
		sourceInfo,
		handlers: new Map(),
		tools: new Map<string, RegisteredTool>([["tool_search", registeredTool]]),
		messageRenderers: new Map(),
		entryRenderers: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
	};
}
