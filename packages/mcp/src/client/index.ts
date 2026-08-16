/**
 * @cogito/mcp-client — shared MCP client library.
 *
 * Extracted from the pi-mcp-adapter extension (now at /home/wu/projects/pi-mcp-adapter).
 * Provides a production-grade MCP client (official SDK based): stdio/SSE/
 * streamable-HTTP/unix-socket transports, OAuth, tool/resource/prompt listing,
 * sampling, tracing, probe, npx resolution and JSON-schema validation.
 *
 * Consumers: proactive-pusher (MCP data sources) and future IM/web modules.
 */

export * from "./abort.ts";
export * from "./agent-dir.ts";
export * from "./elicitation-handler.ts";
export * from "./json-schema-validator.ts";
export * from "./logger.ts";
export * from "./mcp-auth.ts";
export * from "./mcp-auth-flow.ts";
export * from "./mcp-callback-server.ts";
export * from "./mcp-oauth-provider.ts";
export * from "./mcp-probe.ts";
export type {
	McpTraceDirection,
	McpTraceEvent,
	McpTraceMessageKind,
	McpTraceObserver,
	McpTraceTransport,
	McpTraceWriterOptions,
} from "./mcp-trace.ts";
// mcp-trace 与 types.ts 都定义了 McpTraceSettings;统一从 types.ts 导出,
// 其余符号在此显式导出。
export {
	createMcpTraceEvent,
	createMcpTraceWriter,
	DEFAULT_MCP_TRACE_MAX_BYTES,
	DEFAULT_MCP_TRACE_MAX_EVENTS,
	isMcpTraceEnabled,
	MCP_TRACE_SCHEMA_VERSION,
	McpTraceWriter,
	redactTraceText,
	traceTransportKind,
	wrapTransportWithMcpTrace,
} from "./mcp-trace.ts";
export * from "./npx-resolver.ts";
export * from "./runtime-owner.ts";
export * from "./sampling-handler.ts";
export * from "./server-manager.ts";
export type { McpTraceSettings } from "./types.ts";
export * from "./types.ts";
export * from "./ui-stream-types.ts";
export * from "./ui-tool-visibility.ts";
export * from "./unix-socket-transport.ts";
export * from "./utils.ts";
