/**
 * agent-reach source — thin wrapper around the generic MCP source.
 *
 * Provides agent-reach specific defaults (server command/path) while reusing
 * the shared MCP client + normalization from sources/mcp.ts. Config:
 *
 * {
 *   "command": "/home/wu/projects/pi-cogito/.cogito/extensions/mcp-servers/agent-reach-mcp/.venv/bin/python",
 *   "serverPath": "/home/wu/projects/pi-cogito/.cogito/extensions/mcp-servers/agent-reach-mcp/server.py",
 *   "calls": [
 *     { "tool": "v2ex_hot", "args": { "limit": 20 } },
 *     { "tool": "github_issues", "args": { "repo": "earendil-works/pi-mono", "limit": 10 } }
 *   ]
 * }
 */

import type { ProactiveSource, SourceFetchDiagnostics, WakeEvent } from "../types.ts";
import McpSource from "./mcp.ts";

export interface AgentReachSourceConfig {
	command?: string;
	serverPath?: string;
	/** Tool calls to run on every fetch. */
	calls?: Array<{ tool: string; args?: Record<string, unknown> }>;
}

const DEFAULT_COMMAND = "/home/wu/projects/pi-cogito/.cogito/extensions/mcp-servers/agent-reach-mcp/.venv/bin/python";
const DEFAULT_SERVER = "/home/wu/projects/pi-cogito/.cogito/extensions/mcp-servers/agent-reach-mcp/server.py";

export default class AgentReachSource implements ProactiveSource {
	id = "agent-reach";
	label = "agent-reach 互联网数据源";
	defaultIntervalMs = 60 * 60 * 1000;
	configSchema = { command: "string", serverPath: "string", calls: [{ tool: "string", args: {} }] };
	channels = ["content"] as const;
	private lastDiagnostics: SourceFetchDiagnostics = { attempted: 0, succeeded: 0, failed: 0 };

	async fetch(config: unknown): Promise<WakeEvent[]> {
		const cfg = (config ?? {}) as AgentReachSourceConfig;
		const calls = cfg.calls ?? [];
		if (calls.length === 0) {
			this.lastDiagnostics = { attempted: 0, succeeded: 0, failed: 0 };
			return [];
		}

		const generic = new McpSource();
		try {
			const items = await generic.fetch({
				servers: [
					{
						name: "agent-reach",
						command: cfg.command ?? DEFAULT_COMMAND,
						args: [cfg.serverPath ?? DEFAULT_SERVER],
						calls,
					},
				],
			});
			this.lastDiagnostics = generic.fetchDiagnostics() ?? {
				attempted: calls.length,
				succeeded: calls.length,
				failed: 0,
			};
			return items;
		} catch (error) {
			this.lastDiagnostics = generic.fetchDiagnostics() ?? {
				attempted: calls.length,
				succeeded: 0,
				failed: calls.length,
			};
			throw error;
		}
	}

	fetchDiagnostics(): SourceFetchDiagnostics {
		return { ...this.lastDiagnostics };
	}
}
