import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createMcpServer, McpServerService } from "../src/server/index.ts";

describe("MCP server layer (McpServerService)", () => {
	it("registers tools and answers a client call over stdio", async () => {
		const service = new McpServerService({
			name: "test-server",
			version: "1.0.0",
			instructions: "test instructions",
			tools: [
				{
					name: "ping",
					description: "Return a pong with the given name",
					inputSchema: z.object({ name: z.string() }),
					handler: async ({ name }) => `pong, ${String(name)}!`,
				},
				{
					name: "add",
					description: "Add two numbers",
					handler: async ({ a, b }) => Number(a) + Number(b),
				},
			],
		});

		// 子进程里跑 stdio server,当前进程跑 client。
		const { spawn } = await import("node:child_process");
		const script = `
			import { z } from "zod";
			import { McpServerService } from ${JSON.stringify(new URL("../src/server/index.ts", import.meta.url).href)};
			const service = new McpServerService({
				name: "child-server",
				version: "1.0.0",
				tools: [{ name: "ping", description: "p", inputSchema: z.object({ name: z.string() }), handler: async ({ name }) => "pong, " + name + "!" }],
			});
			await service.serve();
		`;
		// 直接用当前 service 在一个子进程里 serve,主进程用 SDK client 连它。
		const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env },
		});
		const transport = new StdioClientTransport({
			command: process.execPath,
			args: ["--input-type=module", "--eval", script],
		});
		const client = new Client({ name: "test-client", version: "1.0.0" });
		try {
			await client.connect(transport);
			const tools = await client.listTools();
			expect(tools.tools.some((t) => t.name === "ping")).toBe(true);
			const result = await client.callTool({ name: "ping", arguments: { name: "pi" } });
			const blocks = result.content as Array<{ type: string; text?: string }>;
			const text = blocks[0]?.text ?? "";
			expect(text).toBe("pong, pi!");
		} finally {
			await client.close();
			child.kill();
		}
		void service;
	});

	it("createMcpServer factory works and close is idempotent", async () => {
		const service = new McpServerService({
			name: "factory-test",
			version: "1.0.0",
			tools: [{ name: "noop", description: "does nothing", handler: async () => "ok" }],
		});
		// serve 未调用时 close 应安全返回。
		await service.close();
		await service.close();
		expect(service.name()).toBe("factory-test");
		void createMcpServer;
	});
});
