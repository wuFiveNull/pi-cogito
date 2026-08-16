/**
 * @cogito/mcp — shared MCP client + server library.
 *
 * client/: production-grade MCP client (official SDK based) — stdio/SSE/
 *   streamable-HTTP/unix-socket transports, OAuth, tool/resource/prompt
 *   listing, sampling, tracing, probe, npx resolution, JSON-schema
 *   validation, McpServerManager.
 *
 * server/: declarative MCP server layer — McpServerService with
 *   stdio/streamable-HTTP transports, tool registration and graceful
 *   shutdown, plus the createMcpServer convenience factory.
 *
 * Consumers: proactive-pusher (MCP data sources) and future IM/web
 * modules on either side.
 */

export * from "./client/index.ts";
export * from "./server/index.ts";
