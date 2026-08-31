/**
 * MCP server service — one logical MCP server with declarative tool
 * registration and configurable transports (stdio / streamable HTTP),
 * built on @modelcontextprotocol/sdk/server.
 *
 * Mirrors the client-side McpServerManager: consumers define tools and
 * transports declaratively and call serve() to start.
 */

import { createServer, type Server } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpServerDefinition, McpServerTool, McpServerTransportConfig } from "./types.ts";

export class McpServerService {
	private readonly server: McpServer;
	private readonly serverName: string;
	private readonly transports: McpServerTransportConfig[];
	private readonly connections: Array<{ transport: Transport; close: () => Promise<void> }> = [];
	private readonly httpServer: Server | undefined;
	private serving = false;

	constructor(def: McpServerDefinition) {
		this.serverName = def.name;
		this.server = new McpServer({
			name: def.name,
			version: def.version,
			...(def.instructions ? { instructions: def.instructions } : {}),
		});
		this.transports = def.transports ?? ["stdio"];
		for (const tool of def.tools ?? []) {
			this.registerTool(tool);
		}
		if (this.transports.some((t) => t !== "stdio" && t.kind === "streamable-http")) {
			this.httpServer = createServer();
		}
	}

	name(): string {
		return this.serverName;
	}

	/** Register one tool. Safe to call before serve(); throws on duplicate names. */
	registerTool(tool: McpServerTool): void {
		const schema = tool.inputSchema;
		// SDK 类型使用其内置 zod 实例的 schema 类型;zod4 与 SDK 的 zod 类型不重叠,
		// 运行时经 SDK 的 parseWithCompat(JSON-schema 兼容层)处理,类型层走签名推导断言。
		const config = {
			...(tool.title ? { title: tool.title } : {}),
			description: tool.description,
			...(schema !== undefined ? { inputSchema: schema } : {}),
		} as unknown as Parameters<typeof this.server.registerTool>[1];
		this.server.registerTool(tool.name, config, async (args: unknown) => {
			const result = await tool.handler((args ?? {}) as Record<string, unknown>);
			return formatToolResult(result);
		});
	}

	/**
	 * Connect all configured transports and start serving.
	 * For "stdio" this resolves immediately and keeps the process alive via
	 * the stdin/stdout transport; for streamable-http it starts an HTTP
	 * server on the configured port (default 3000).
	 */
	async serve(options: { port?: number } = {}): Promise<void> {
		if (this.serving) return;
		this.serving = true;
		for (const config of this.transports) {
			if (config === "stdio") {
				const transport = new StdioServerTransport();
				await this.server.connect(transport);
				this.connections.push({ transport, close: () => this.server.close() });
			} else if (config.kind === "streamable-http") {
				const port = options.port ?? 3000;
				const path = config.path ?? "/mcp";
				const httpTransport = new StreamableHTTPServerTransport({
					sessionIdGenerator: undefined,
					enableJsonResponse: true,
				});
				this.httpServer!.on("request", (request, response) => {
					const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
					if (url.pathname !== path) {
						response.writeHead(404).end("Not found");
						return;
					}
					void httpTransport.handleRequest(request, response, request.headers);
				});
				await this.server.connect(httpTransport);
				this.connections.push({ transport: httpTransport, close: () => this.server.close() });
				await new Promise<void>((resolve, reject) => {
					this.httpServer!.once("error", reject);
					this.httpServer!.listen(port, resolve);
				});
			}
		}
	}

	/** Gracefully close all connections and the HTTP server. */
	async close(): Promise<void> {
		if (!this.serving) return;
		this.serving = false;
		for (const connection of this.connections.reverse()) {
			try {
				await connection.close();
			} catch {
				// Transport already closed.
			}
		}
		this.connections.length = 0;
		const httpServer = this.httpServer;
		if (httpServer) {
			await new Promise<void>((resolve) => httpServer.close(() => resolve()));
		}
	}
}

/** Normalize any tool result into the MCP content block format. */
function formatToolResult(result: unknown): { content: Array<{ type: "text"; text: string }> } {
	if (
		result !== null &&
		typeof result === "object" &&
		!Array.isArray(result) &&
		"content" in result &&
		Array.isArray((result as { content: unknown }).content)
	) {
		return result as { content: Array<{ type: "text"; text: string }> };
	}
	const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
	return { content: [{ type: "text", text }] };
}

/** Convenience factory: build, register tools and serve a definition. */
export async function createMcpServer(
	def: McpServerDefinition,
	options: { port?: number } = {},
): Promise<McpServerService> {
	const service = new McpServerService(def);
	await service.serve(options);
	return service;
}
