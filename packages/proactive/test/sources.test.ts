import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import AgentReachSource from "../src/sources/agent-reach.ts";
import DailyhotSource from "../src/sources/dailyhot.ts";
import McpSource, { mcpCursorStateKey } from "../src/sources/mcp.ts";

const tempDirs: string[] = [];
const openMcpSources: McpSource[] = [];

afterEach(async () => {
	await Promise.all(openMcpSources.splice(0).map((source) => source.close()));
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeMcpSource(): McpSource {
	const source = new McpSource();
	openMcpSources.push(source);
	return source;
}

const FAKE_SERVER = join(__dirname, "fixtures", "fake-mcp-server.mjs");

describe("DailyhotSource", () => {
	it("normalizes route results into RawItem[]", async () => {
		const routesDir = mkdtempSync(join(tmpdir(), "dailyhot-routes-"));
		tempDirs.push(routesDir);
		writeFileSync(
			join(routesDir, "weibo.ts"),
			`export const handleRoute = async () => ({
  name: "weibo",
  data: [
    { title: "热搜一", url: "https://weibo.com/1", desc: "描述", timestamp: 1700000000 },
    { title: "热搜二", url: "https://weibo.com/2" }
  ]
});`,
			"utf-8",
		);

		const source = new DailyhotSource();
		const items = await source.fetch({ platforms: ["weibo"], routesDir });
		expect(items.length).toBe(2);
		expect(items[0]).toMatchObject({ source: "weibo", title: "热搜一", url: "https://weibo.com/1" });
	});

	it("skips missing platforms without failing the batch", async () => {
		const routesDir = mkdtempSync(join(tmpdir(), "dailyhot-routes-"));
		tempDirs.push(routesDir);
		writeFileSync(
			join(routesDir, "zhihu.ts"),
			`export const handleRoute = async () => ({ name: "zhihu", data: [{ title: "知乎一" }] });`,
			"utf-8",
		);

		const source = new DailyhotSource();
		const items = await source.fetch({ platforms: ["missing", "zhihu"], routesDir });
		expect(items.map((item) => item.title)).toEqual(["知乎一"]);
		expect(source.fetchDiagnostics()).toEqual({ attempted: 2, succeeded: 1, failed: 1 });
	});
});

describe("AgentReachSource", () => {
	it("drives configured tool calls over MCP and normalizes results", async () => {
		const source = new AgentReachSource();
		const items = await source.fetch({
			command: process.execPath,
			serverPath: FAKE_SERVER,
			calls: [
				{ tool: "v2ex_hot", args: { limit: 20 } },
				{ tool: "github_issues", args: { repo: "x/y", limit: 10 } },
			],
		});

		expect(items.length).toBe(3);
		expect(items[0]).toMatchObject({ source: "v2ex_hot", title: "V2EX 热帖一", url: "https://v2ex.com/t/1" });
		expect(items[1]).toMatchObject({ source: "v2ex_hot", title: "V2EX 热帖二" });
		expect(items[2]).toMatchObject({ source: "github_issues", title: "Bug: 内存泄漏" });
	});

	it("returns empty for no configured calls", async () => {
		const source = new AgentReachSource();
		expect(await source.fetch({})).toEqual([]);
	});
});

describe("McpSource (generic)", () => {
	it("drives multiple servers and tools over MCP", async () => {
		const source = makeMcpSource();
		const items = await source.fetch({
			servers: [
				{
					name: "s1",
					command: process.execPath,
					args: [FAKE_SERVER],
					calls: [{ tool: "v2ex_hot", args: { limit: 20 } }],
				},
				{
					name: "s2",
					command: process.execPath,
					args: [FAKE_SERVER],
					calls: [{ tool: "github_issues", args: { repo: "x/y" } }],
				},
			],
		});

		expect(items.length).toBe(3);
		expect(items[0]).toMatchObject({ source: "v2ex_hot", title: "V2EX 热帖一" });
		expect(items[2]).toMatchObject({ source: "github_issues", title: "Bug: 内存泄漏" });
	});

	it("keeps going when one server fails", async () => {
		const source = makeMcpSource();
		const items = await source.fetch({
			servers: [
				{ name: "broken", command: "definitely-missing-binary", args: [], calls: [{ tool: "x" }] },
				{
					name: "fine",
					command: process.execPath,
					args: [FAKE_SERVER],
					calls: [{ tool: "v2ex_hot", args: {} }],
				},
			],
		});

		expect(items.map((item) => item.title)).toEqual(["V2EX 热帖一", "V2EX 热帖二"]);
		expect(source.fetchDiagnostics()).toEqual({ attempted: 2, succeeded: 1, failed: 1 });
	});

	it("returns empty for no servers", async () => {
		expect(await makeMcpSource().fetch({})).toEqual([]);
	});

	it("acknowledges events through the configured MCP tool", async () => {
		const source = makeMcpSource();
		await expect(
			source.ack(
				{
					servers: [{ name: "s1", command: process.execPath, args: [FAKE_SERVER], calls: [] }],
					ack: { server: "s1", tool: "ack_events", args: { source: "feed" } },
				},
				["event-1", "event-2"],
			),
		).resolves.toBeUndefined();
	});

	it("resumes offset pagination from the committed cursor", async () => {
		const source = makeMcpSource();
		const values = new Map<string, string>();
		source.setStateStore({
			getState: (key) => values.get(key),
			setState: (key, value) => values.set(key, value),
		});
		const config = {
			servers: [
				{
					name: "paged",
					command: process.execPath,
					args: [FAKE_SERVER],
					calls: [{ tool: "paged_feed", pagination: { pageSize: 2 } }],
				},
			],
		};

		const first = await source.fetch(config);
		expect(first.map((item) => item.eventId)).toEqual(["page-1", "page-2", "page-3"]);
		const key = mcpCursorStateKey("paged", "paged_feed", 0);
		const pending = JSON.parse(values.get(key) ?? "{}") as { committedOffset?: number; pendingOffset?: number };
		expect(pending.committedOffset).toBeUndefined();
		expect(pending.pendingOffset).toBe(3);
		source.commitFetchState();
		expect(JSON.parse(values.get(key) ?? "{}")).toMatchObject({ committedOffset: 3 });

		const second = await source.fetch(config);
		expect(second).toEqual([]);
	});
});
