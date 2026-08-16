/**
 * Generic MCP source.
 *
 * Connects to any MCP server (stdio / HTTP / unix socket) via the shared
 * mcp-client-core library and drives configured tool calls. New MCP data
 * sources are pure configuration — no code changes needed.
 *
 * Config (from proactive.json sources.mcp):
 * {
 *   "servers": [
 *     {
 *       "name": "agent-reach",
 *       "command": "/home/wu/projects/pi-cogito/agent-reach-mcp/.venv/bin/python",
 *       "args": ["/home/wu/projects/pi-cogito/agent-reach-mcp/server.py"],
 *       "calls": [
 *         { "tool": "v2ex_hot", "args": { "limit": 20 } },
 *         { "tool": "github_issues", "args": { "repo": "owner/repo", "limit": 10 } }
 *       ]
 *     },
 *     { "name": "remote", "url": "https://mcp.example.com/sse",
 *       "calls": [{ "tool": "news", "args": {} }] }
 *   ]
 * }
 */

import { createHash } from "node:crypto";
import { McpServerManager } from "@cogito/mcp";
import type { ProactiveSource, ProactiveSourceStateStore, SourceFetchDiagnostics, WakeEvent } from "../types.ts";

const DEFAULT_MAX_PAGES = 256;

export interface McpServerCallConfig {
	name: string;
	command?: string;
	args?: string[];
	url?: string;
	socket?: string;
	headers?: Record<string, string>;
	/** Tool calls to run on every fetch. */
	calls: Array<{ tool: string; args?: Record<string, unknown>; pagination?: McpPaginationConfig }>;
}

export interface McpPaginationConfig {
	/** offset (default) or cursor pagination. */
	mode?: "offset" | "cursor";
	pageSize: number;
	maxPages?: number;
	offsetArg?: string;
	limitArg?: string;
	cursorArg?: string;
	initialCursor?: string;
	/** Dot path in the decoded tool result, e.g. "meta.next_cursor". */
	nextCursorPath?: string;
}

export interface McpAckConfig {
	server: string;
	tool: string;
	args?: Record<string, unknown>;
	/** 注入事件 id 的参数名,默认 event_ids。 */
	eventIdsArg?: string;
	/** 事件里的 ackSourceId 属于哪些来源;多 MCP source 时用于路由。 */
	sourceIds?: string[];
}

export interface McpSourceConfig {
	servers?: McpServerCallConfig[];
	ack?: McpAckConfig;
}

export default class McpSource implements ProactiveSource {
	id = "mcp";
	label = "通用 MCP 数据源";
	defaultIntervalMs = 60 * 60 * 1000;
	configSchema = {
		servers: [{ name: "string", calls: [{ tool: "string", args: {}, pagination: { pageSize: "number" } }] }],
	};
	channels = ["content"] as const;
	private lastDiagnostics: SourceFetchDiagnostics = { attempted: 0, succeeded: 0, failed: 0 };
	private stateStore: ProactiveSourceStateStore | undefined;
	private readonly stagedCursorStates = new Map<string, McpCursorState>();
	private readonly manager = new McpServerManager();
	private readonly connectionKeys = new Map<string, string>();
	private closed = false;

	setStateStore(store: ProactiveSourceStateStore): void {
		this.stateStore = store;
	}

	commitFetchState(): void {
		if (!this.stateStore) {
			this.stagedCursorStates.clear();
			return;
		}
		for (const [key, staged] of this.stagedCursorStates) {
			const current = readCursorState(this.stateStore, key);
			this.stateStore.setState(
				key,
				JSON.stringify({
					committedOffset: staged.pendingOffset ?? current.committedOffset,
					committedCursor: staged.pendingCursor ?? null,
				}),
			);
		}
		this.stagedCursorStates.clear();
	}

	async fetch(config: unknown): Promise<WakeEvent[]> {
		if (this.closed) throw new Error("MCP source is closed");
		const cfg = (config ?? {}) as McpSourceConfig;
		const servers = cfg.servers ?? [];
		if (servers.length === 0) {
			this.lastDiagnostics = { attempted: 0, succeeded: 0, failed: 0 };
			return [];
		}

		const items: WakeEvent[] = [];
		let attemptedCalls = 0;
		let successfulCalls = 0;
		attemptedCalls = servers.reduce((total, server) => total + (server.calls?.length ?? 0), 0);
		const results = await Promise.allSettled(
			servers.map(async (server) => {
				const connection = await this.ensureConnection(server);
				const calls = await Promise.allSettled(
					(server.calls ?? []).map(async (call, callIndex) =>
						this.fetchCall(connection.client, server.name, call, callIndex),
					),
				);
				return { server, calls };
			}),
		);
		for (const [index, result] of results.entries()) {
			const server = servers[index]!;
			if (result.status === "rejected") {
				console.error(`proactive MCP server failed server=${server.name}: ${formatError(result.reason)}`);
				continue;
			}
			for (const [callIndex, callResult] of result.value.calls.entries()) {
				const call = server.calls[callIndex]!;
				if (callResult.status === "fulfilled") {
					successfulCalls++;
					items.push(...callResult.value);
				} else {
					console.error(
						`proactive MCP tool failed server=${server.name} tool=${call.tool}: ${formatError(callResult.reason)}`,
					);
				}
			}
		}
		this.lastDiagnostics = {
			attempted: attemptedCalls,
			succeeded: successfulCalls,
			failed: attemptedCalls - successfulCalls,
		};
		if (attemptedCalls > 0 && successfulCalls === 0) {
			throw new Error(`all MCP tool calls failed (${attemptedCalls})`);
		}
		return items;
	}

	private async fetchCall(
		client: { callTool(input: { name: string; arguments: Record<string, unknown> }): Promise<unknown> },
		serverName: string,
		call: { tool: string; args?: Record<string, unknown>; pagination?: McpPaginationConfig },
		callIndex: number,
	): Promise<WakeEvent[]> {
		const pagination = normalizePagination(call.pagination);
		if (!pagination) {
			const result = await client.callTool({ name: call.tool, arguments: call.args ?? {} });
			return normalizeToolResult(call.tool, result);
		}

		const stateKey = mcpCursorStateKey(serverName, call.tool, callIndex);
		const stored = readCursorState(this.stateStore, stateKey);
		const cursorMode = pagination.mode === "cursor";
		let offset = stored.committedOffset ?? 0;
		let cursor = cursorMode
			? stored.committedCursor !== undefined
				? stored.committedCursor
				: pagination.initialCursor
			: undefined;
		const items: WakeEvent[] = [];
		const seenCursors = new Set<string>();
		let pendingCursor: string | null = cursorMode ? (cursor ?? null) : null;
		let pendingOffset = offset;
		let completed = false;

		for (let page = 0; page < pagination.maxPages; page++) {
			const args = { ...(call.args ?? {}) };
			if (cursorMode) {
				if (cursor !== undefined && cursor !== null) args[pagination.cursorArg ?? "cursor"] = cursor;
				args[pagination.limitArg ?? "limit"] = pagination.pageSize;
			} else {
				args[pagination.offsetArg ?? "offset"] = offset;
				args[pagination.limitArg ?? "limit"] = pagination.pageSize;
			}
			const result = await client.callTool({ name: call.tool, arguments: args });
			const pageResult = extractToolPage(result, pagination.nextCursorPath);
			items.push(...normalizeToolEntries(call.tool, pageResult.items));

			if (cursorMode) {
				const nextCursor = pageResult.nextCursor;
				if (nextCursor === null || nextCursor === undefined || pageResult.hasMore === false) {
					pendingCursor = null;
					completed = true;
					break;
				}
				if (seenCursors.has(nextCursor))
					throw new Error(`MCP pagination cursor repeated: ${serverName}.${call.tool}`);
				seenCursors.add(nextCursor);
				cursor = nextCursor;
				pendingCursor = nextCursor;
				continue;
			}

			offset += pageResult.items.length;
			pendingOffset = offset;
			if (pageResult.items.length < pagination.pageSize || pageResult.hasMore === false) {
				completed = true;
				break;
			}
		}

		if (!completed)
			throw new Error(`MCP pagination exceeded ${pagination.maxPages} pages: ${serverName}.${call.tool}`);
		this.stageCursorState(stateKey, { pendingCursor, pendingOffset });
		return items;
	}

	private stageCursorState(key: string, state: McpCursorState): void {
		this.stagedCursorStates.set(key, state);
		if (!this.stateStore) return;
		const current = readCursorState(this.stateStore, key);
		this.stateStore.setState(
			key,
			JSON.stringify({
				committedOffset: current.committedOffset,
				committedCursor: current.committedCursor,
				pendingOffset: state.pendingOffset,
				pendingCursor: state.pendingCursor,
			}),
		);
	}

	fetchDiagnostics(): SourceFetchDiagnostics {
		return { ...this.lastDiagnostics };
	}

	async ack(config: unknown, eventIds: string[]): Promise<void> {
		if (this.closed) throw new Error("MCP source is closed");
		const cfg = (config ?? {}) as McpSourceConfig;
		const ack = cfg.ack;
		if (!ack || eventIds.length === 0) return;
		const server = cfg.servers?.find((candidate) => candidate.name === ack.server);
		if (!server) throw new Error(`MCP ack server not configured: ${ack.server}`);

		const connection = await this.ensureConnection(server);
		await connection.client.callTool({
			name: ack.tool,
			arguments: { ...(ack.args ?? {}), [ack.eventIdsArg ?? "event_ids"]: eventIds },
		});
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.connectionKeys.clear();
		await this.manager.closeAll();
	}

	private async ensureConnection(server: McpServerCallConfig) {
		const definitionKey = serverDefinitionKey(server);
		const existingKey = this.connectionKeys.get(server.name);
		if (existingKey !== undefined && existingKey !== definitionKey) {
			await this.manager.close(server.name);
			this.connectionKeys.delete(server.name);
		}
		const connection = await this.manager.connect(server.name, {
			command: server.command,
			args: server.args,
			url: server.url,
			socket: server.socket,
			headers: server.headers,
			lifecycle: "eager",
		});
		this.connectionKeys.set(server.name, definitionKey);
		return connection;
	}
}

interface McpCursorState {
	committedOffset?: number;
	committedCursor?: string | null;
	pendingOffset?: number;
	pendingCursor?: string | null;
}

function serverDefinitionKey(server: McpServerCallConfig): string {
	return JSON.stringify({
		command: server.command,
		args: server.args,
		url: server.url,
		socket: server.socket,
		headers: server.headers,
	});
}

export function mcpCursorStateKey(serverName: string, tool: string, callIndex: number): string {
	const identity = `${serverName}\u0000${tool}\u0000${callIndex}`;
	return `source.mcp.cursor.${createHash("sha256").update(identity).digest("hex").slice(0, 24)}`;
}

function readCursorState(store: ProactiveSourceStateStore | undefined, key: string): McpCursorState {
	const raw = store?.getState(key);
	if (!raw) return {};
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!isRecord(parsed)) return {};
		const state: McpCursorState = {};
		if (typeof parsed.committedOffset === "number" && Number.isFinite(parsed.committedOffset)) {
			state.committedOffset = Math.max(0, Math.floor(parsed.committedOffset));
		}
		if (parsed.committedCursor === null || typeof parsed.committedCursor === "string") {
			state.committedCursor = parsed.committedCursor;
		}
		return state;
	} catch {
		return {};
	}
}

function normalizePagination(config: McpPaginationConfig | undefined): Required<McpPaginationConfig> | undefined {
	if (!config || !Number.isFinite(config.pageSize) || config.pageSize <= 0) return undefined;
	return {
		mode: config.mode ?? (config.cursorArg !== undefined ? "cursor" : "offset"),
		pageSize: Math.max(1, Math.floor(config.pageSize)),
		maxPages: Math.min(DEFAULT_MAX_PAGES, Math.max(1, Math.floor(config.maxPages ?? DEFAULT_MAX_PAGES))),
		offsetArg: config.offsetArg ?? "offset",
		limitArg: config.limitArg ?? "limit",
		cursorArg: config.cursorArg ?? "cursor",
		initialCursor: config.initialCursor ?? "",
		nextCursorPath: config.nextCursorPath ?? "",
	};
}

interface ToolPage {
	items: unknown[];
	nextCursor: string | null | undefined;
	hasMore: boolean | undefined;
}

function extractToolPage(result: unknown, nextCursorPath = ""): ToolPage {
	const text = contentText(result);
	const parsed = tryParseJson(text);
	const record = isRecord(parsed) ? parsed : undefined;
	const items = Array.isArray(parsed) ? parsed : (findList(parsed) ?? []);
	const cursorValue = nextCursorPath
		? readPath(parsed, nextCursorPath)
		: firstDefined(record, ["next_cursor", "nextCursor", "next_cursor_id", "cursor"]);
	const nextCursor =
		cursorValue === null
			? null
			: typeof cursorValue === "string" && cursorValue.trim()
				? cursorValue.trim()
				: cursorValue === undefined
					? undefined
					: String(cursorValue);
	const hasMoreValue = firstDefined(record, ["has_more", "hasMore", "has_next", "hasNext"]);
	return {
		items,
		nextCursor,
		hasMore: typeof hasMoreValue === "boolean" ? hasMoreValue : undefined,
	};
}

/** Best-effort normalization of arbitrary tool results into WakeEvent[] (wake 字段透传)。 */
export function normalizeToolResult(tool: string, result: unknown): WakeEvent[] {
	const text = contentText(result);
	const items = normalizeToolEntries(tool, extractToolPage(result).items);
	if (items.length === 0 && text.trim()) {
		// Unstructured text result: one item whose title is the raw text.
		items.push({ source: tool, title: text.trim().slice(0, 200) });
	}
	return items;
}

function normalizeToolEntries(tool: string, list: unknown[]): WakeEvent[] {
	const items: WakeEvent[] = [];
	for (const entry of list) {
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
		const record = entry as Record<string, unknown>;
		const title = firstString(record, ["title", "name", "subject", "topic_title", "full_name"]);
		if (!title) continue;
		const item: WakeEvent = {
			source: tool,
			eventId: firstIdentifier(record, ["event_id", "eventId", "id"]),
			title,
			url: firstString(record, ["url", "link", "html_url", "mobileUrl"]),
			summary: firstString(record, ["desc", "description", "summary", "content", "excerpt"]),
			publishedAt: firstNumber(record, ["timestamp", "created_at", "published_at", "onboard_time"]),
		};
		for (const key of [
			"kind",
			"eventId",
			"event_id",
			"ackSourceId",
			"id",
			"preprocessScore",
			"preprocess_score",
			"sourceId",
			"source_name",
			"content",
			"body",
			"wakeEligible",
		] as const) {
			const value = record[key];
			if (value !== undefined) (item as Record<string, unknown>)[key] = value;
		}
		items.push(item);
	}
	return items;
}

/** Extract concatenated text from an MCP callTool result. */
function contentText(result: unknown): string {
	const content = (result as { content?: Array<{ type?: string; text?: string }> })?.content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part) => typeof part?.text === "string")
		.map((part) => part.text)
		.join("\n");
}

function tryParseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/** Find the first array inside a nested result object. */
function findList(value: unknown): unknown[] | undefined {
	if (!value || typeof value !== "object") return undefined;
	for (const field of ["data", "items", "results", "list", "topics", "issues"]) {
		const candidate = (value as Record<string, unknown>)[field];
		if (Array.isArray(candidate)) return candidate;
	}
	return undefined;
}

function readPath(value: unknown, path: string): unknown {
	let current: unknown = value;
	for (const segment of path.split(".").filter(Boolean)) {
		if (!isRecord(current)) return undefined;
		current = current[segment];
	}
	return current;
}

function firstDefined(record: Record<string, unknown> | undefined, keys: string[]): unknown {
	if (!record) return undefined;
	for (const key of keys) {
		if (record[key] !== undefined) return record[key];
	}
	return undefined;
}

function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return undefined;
}

function firstIdentifier(record: Record<string, unknown>, keys: string[]): string | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) return value.trim();
		if (typeof value === "number" && Number.isFinite(value)) return String(value);
	}
	return undefined;
}

function firstNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "number" && Number.isFinite(value)) return value;
	}
	return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
