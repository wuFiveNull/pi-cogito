# @cogito/mcp

Shared MCP (Model Context Protocol) client + server library, extracted from the
pi-mcp-adapter's client directory.

Provides a production-grade MCP client (and a declarative server layer) built on the official
`@modelcontextprotocol/sdk`:

- Transports: stdio, SSE, streamable HTTP, unix socket
- OAuth (authorization flow, callback server, credential storage)
- Tool / resource / prompt listing with JSON-schema validation
- Sampling and elicitation handlers
- Protocol tracing (JSONL), endpoint probe, npx binary resolution
- Runtime ownership and UI fencing helpers

Consumers: `apps/proactive-pusher` (MCP data sources) and future pi
modules. The pi-mcp-adapter extension (now living outside this repo at
/home/wu/projects/pi-mcp-adapter) re-exports this package.

## Layout

- `src/client/` — MCP client (McpServerManager, transports, OAuth, tracing, ...)
- `src/server/` — MCP server (`McpServerService`, `createMcpServer`, stdio/HTTP)

## Server example

```ts
import { createMcpServer } from "@cogito/mcp";

await createMcpServer({
  name: "my-server",
  version: "1.0.0",
  tools: [
    {
      name: "ping",
      description: "Return a pong",
      handler: async ({ name }) => `pong, ${name}!`,
    },
  ],
  transports: ["stdio"],
});
```
