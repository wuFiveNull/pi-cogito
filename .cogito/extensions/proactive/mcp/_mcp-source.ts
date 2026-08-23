/**
 * MCP 数据源共享实现(放在 extensions/proactive/mcp/ 下,自包含)。
 *
 * 通用 MCP 源:连接任意 MCP server(stdio / HTTP / unix socket),驱动配置的
 * 工具调用,结果归一化为 RawItem。新 MCP 数据源 = 一个薄封装文件,纯配置。
 *
 * 用法(如 dailyhot-mcp.ts):
 *   import { McpExtensionSource } from "./_mcp-source.ts";
 *   export default class DailyhotMcpSource extends McpExtensionSource {
 *       id = "dailyhot-mcp";
 *       label = "dailyhot MCP 热榜";
 *       defaultCalls = [{ tool: "get_all_hot_lists", args: {} }];
 *       constructor() { super({ name: "dailyhot-mcp", command: "python", args: ["/path/server.py"] }); }
 *   }
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { McpServerManager } from "@cogito/mcp";

/** 数据源产出的一条候选内容。 */
export interface RawItem {
	/** 子源 id,如工具名。 */
	source: string;
	title: string;
	url?: string;
	summary?: string;
	publishedAt?: number;
	/** 兴趣分 [0,1],wake 用。 */
	preprocessScore?: number;
}

/** 主动推送数据源接口。 */
export interface ProactiveSource {
	id: string;
	label: string;
	defaultIntervalMs?: number;
	configSchema?: unknown;
	fetch(config: unknown): Promise<RawItem[]>;
}

interface McpServerConfig {
	name: string;
	command?: string;
	args?: string[];
	url?: string;
	socket?: string;
	headers?: Record<string, string>;
	env?: Record<string, string>;
}

/**
 * 通用 MCP 数据源:子类只提供 server name(配置统一读 ~/.cogito/agent/mcp.json,
 * 与 pi agent 运行时共用同一份)与默认工具调用。
 */
export abstract class McpExtensionSource implements ProactiveSource {
	abstract id: string;
	abstract label: string;
	abstract defaultCalls: Array<{ tool: string; args?: Record<string, unknown> }>;
	defaultIntervalMs = 60 * 60 * 1000;
	configSchema = { calls: [{ tool: "string", args: {} }] };

	/** mcp.json 里的 server 名(agent 运行时同一份配置)。 */
	abstract serverName: string;

	/** 从 mcp.json 读取 server 配置;读不到时返回 undefined(该源不工作)。 */
	private serverConfig(): McpServerConfig | undefined {
		const entry = loadMcpServerConfig(this.serverName);
		if (!entry) return undefined;
		return {
			name: this.serverName,
			command: entry.command,
			args: entry.args,
			url: entry.url,
			headers: entry.headers,
			env: entry.env,
		};
	}

	async fetch(config: unknown): Promise<RawItem[]> {
		const cfg = (config ?? {}) as { calls?: Array<{ tool: string; args?: Record<string, unknown> }> };
		const calls = cfg.calls ?? this.defaultCalls;
		if (calls.length === 0) return [];

		const server = this.serverConfig();
		if (!server) {
			console.error(`[mcp-source] server "${this.serverName}" not found in mcp.json, skipping`);
			return [];
		}

		const manager = new McpServerManager();
		const items: RawItem[] = [];
		try {
			await manager.connect(server.name, {
				command: server.command,
				args: server.args,
				url: server.url,
				headers: server.headers,
				env: server.env,
				lifecycle: "eager",
			});
			const connection = manager.getConnection(server.name);
			if (!connection) return items;

			for (const call of calls) {
				try {
					const result = await connection.client.callTool({
						name: call.tool,
						arguments: call.args ?? {},
					});
					items.push(...normalizeToolResult(call.tool, result));
				} catch {
					// 单个工具失败不影响其他调用。
				}
			}
		} catch {
			// server 连接失败:返回空。
		} finally {
			await manager.close(server.name).catch(() => {});
		}
		return items;
	}
}

/** 把任意工具结果归一化为 RawItem[]。 */
function normalizeToolResult(tool: string, result: unknown): RawItem[] {
	const text = contentText(result);
	const parsed = tryParseJson(text);
	const list = Array.isArray(parsed) ? parsed : findList(parsed);

	const items: RawItem[] = [];
	if (Array.isArray(list)) {
		for (const [index, entry] of list.entries()) {
			if (typeof entry !== "object" || entry === null) continue;
			const record = entry as Record<string, unknown>;
			const title = firstString(record, ["title", "name", "subject", "topic_title", "full_name"]);
			if (!title) continue;
			items.push({
				source: tool,
				title,
				url: firstString(record, ["url", "link", "html_url", "mobileUrl"]),
				summary: firstString(record, ["desc", "description", "summary", "content", "excerpt"]),
				publishedAt: firstNumber(record, ["timestamp", "created_at", "published_at", "onboard_time"]),
				preprocessScore: scoreFor(record, index),
			});
		}
	}
	if (items.length === 0 && text.trim()) {
		// 非结构化文本结果:整体作为一条;工具错误文本不当作内容。
		const trimmed = text.trim();
		if (/^error[\s:]/i.test(trimmed) || trimmed.includes("Error calling tool")) {
			return items;
		}
		items.push({ source: tool, title: trimmed.slice(0, 200) });
	}
	return items;
}

/** 兴趣分 [0,1]:有 stars/likes/hot 数值按对数归一化,否则按位次递减(0.9 起每名 -0.08)。 */
function scoreFor(record: Record<string, unknown>, index: number): number {
	const heat = firstNumber(record, ["stars", "likes", "hot", "score", "popularity"]);
	if (typeof heat === "number" && Number.isFinite(heat) && heat > 0) {
		return Math.min(0.95, Math.max(0.05, 0.25 + Math.log10(1 + heat) / 10));
	}
	return Math.max(0.05, 0.9 - index * 0.08);
}

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

function findList(parsed: unknown): unknown {
	if (Array.isArray(parsed)) return parsed;
	if (typeof parsed === "object" && parsed !== null) {
		for (const value of Object.values(parsed as Record<string, unknown>)) {
			if (Array.isArray(value)) return value;
		}
	}
	return undefined;
}

function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) return value;
	}
	return undefined;
}

function firstNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "number") return value;
		if (typeof value === "string") {
			const parsed = Number(value);
			if (Number.isFinite(parsed)) return parsed;
		}
	}
	return undefined;
}

interface McpJsonServer {
	command?: string;
	args?: string[];
	url?: string;
	headers?: Record<string, string>;
	env?: Record<string, string>;
}

/** 读 agent 目录的 mcp.json 的 server 配置(与 pi agent 运行时共用)。 */
export function loadMcpServerConfig(name: string): McpJsonServer | undefined {
	try {
		const path = mcpJsonPath();
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
			mcpServers?: Record<string, McpJsonServer>;
		};
		return parsed.mcpServers?.[name];
	} catch {
		return undefined;
	}
}

/** mcp.json 路径:优先跟随 agent 目录环境变量,否则默认 home 下的 agent 目录。 */
function mcpJsonPath(): string {
	const agentDir = process.env.COGITO_CODING_AGENT_DIR || process.env.PI_AGENT_DIR;
	if (agentDir) return join(agentDir, "mcp.json");
	return join(homedir(), ".cogito", "agent", "mcp.json");
}
