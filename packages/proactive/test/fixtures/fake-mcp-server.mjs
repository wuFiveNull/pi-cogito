#!/usr/bin/env node
/**
 * Fake MCP stdio server for tests: newline-delimited JSON-RPC (current MCP
 * stdio protocol) subset used by mcp-client-core (initialize,
 * notifications.initialized, tools/list, tools/call). Reads stdin, writes
 * stdout.
 */

const tools = [
	{ name: "v2ex_hot", description: "V2EX 热帖", inputSchema: { type: "object", properties: {} } },
	{ name: "github_issues", description: "GitHub issues", inputSchema: { type: "object", properties: {} } },
	{ name: "paged_feed", description: "分页 feed", inputSchema: { type: "object", properties: {} } },
];

let buffer = "";
let toolCalls = 0;


process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	// Newline-delimited JSON (current MCP stdio protocol).
	for (;;) {
		const nl = buffer.indexOf("\n");
		if (nl === -1) return;
		const line = buffer.slice(0, nl).trim();
		buffer = buffer.slice(nl + 1);
		if (!line) continue;
		try {
			handleMessage(JSON.parse(line));
		} catch {
			// ignore malformed line
		}
	}
});

function handleMessage(message) {

	if (message.method === "initialize") {
		respond(message.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } });
		return;
	}
	if (message.method === "tools/list") {
		respond(message.id, { tools });
		return;
	}
	if (message.method === "tools/call") {
		toolCalls++;
		if (message.params?.name === "v2ex_hot") {
			respond(message.id, {
				content: [
					{
						type: "text",
						text: JSON.stringify([
							{ title: "V2EX 热帖一", url: "https://v2ex.com/t/1", desc: "讨论内容", timestamp: 1700000000 },
							{ title: "V2EX 热帖二", url: "https://v2ex.com/t/2" },
						]),
					},
				],
			});
			return;
		}
		if (message.params?.name === "github_issues") {
			respond(message.id, {
				content: [
					{
						type: "text",
						text: JSON.stringify([
							{ title: "Bug: 内存泄漏", html_url: "https://github.com/x/y/issues/1" },
						]),
					},
				],
			});
			return;
		}
		if (message.params?.name === "paged_feed") {
			const offset = Number(message.params?.arguments?.offset ?? 0);
			const entries = [
				{ id: "page-1", title: "分页一" },
				{ id: "page-2", title: "分页二" },
				{ id: "page-3", title: "分页三" },
			];
			const pageSize = Number(message.params?.arguments?.limit ?? 2);
			const items = entries.slice(offset, offset + pageSize);
			respond(message.id, {
				content: [{ type: "text", text: JSON.stringify({ items, has_more: offset + items.length < entries.length }) }],
			});
			return;
		}
		if (message.params?.name === "ack_events") {
			respond(message.id, { content: [{ type: "text", text: "acknowledged" }] });
			return;
		}
		respond(message.id, { content: [{ type: "text", text: "unknown tool" }] });
		return;
	}
	// List-style methods return empty collections.
	if (message.method?.endsWith("/list") || message.method?.endsWith("/templates/list")) {
		respond(message.id, { tools: [], prompts: [], resources: [], templates: [] });
		return;
	}
	// notifications (e.g. notifications/initialized) get no reply.
}

function respond(id, result) {
	process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

process.stdout.on("error", () => process.exit(0));
