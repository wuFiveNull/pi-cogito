/**
 * MCP server layer types (built on @modelcontextprotocol/sdk/server).
 *
 * Declarative server definitions: a name/version, an optional tool list and
 * the transports to serve on (stdio / streamable HTTP).
 */

import type { ZodType } from "zod";

/** One tool served by an MCP server. */
export interface McpServerTool {
	name: string;
	title?: string;
	description: string;
	/**
	 * Input schema: a zod schema (e.g. z.object({ name: z.string() }))
	 * or a plain JSON schema object. Omitted = no arguments.
	 */
	inputSchema?: ZodType | Record<string, unknown>;
	/** Tool implementation. Receives validated arguments. */
	handler(args: Record<string, unknown>): Promise<unknown> | unknown;
}

export type McpServerTransportConfig = "stdio" | { kind: "streamable-http"; path?: string };

export interface McpServerDefinition {
	name: string;
	version: string;
	/** Optional instructions exposed to clients. */
	instructions?: string;
	tools?: McpServerTool[];
	/**
	 * Transports to serve on. Defaults to ["stdio"].
	 * Multiple transports are supported (each gets its own connection).
	 */
	transports?: McpServerTransportConfig[];
}
