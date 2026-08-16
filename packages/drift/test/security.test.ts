import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDriftContext, DriftTurnPipeline } from "../src/runtime.ts";
import { DriftStateStore } from "../src/state.ts";
import { buildDriftToolRegistry, type DriftTool, DriftToolRegistry, getDriftToolMeta } from "../src/tools.ts";

const roots: string[] = [];
const stores: DriftStateStore[] = [];

afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeFixture(): { root: string; driftDir: string; workspaceDir: string; store: DriftStateStore } {
	const root = mkdtempSync(join(tmpdir(), "drift-security-"));
	const driftDir = join(root, "drift");
	const workspaceDir = join(root, "workspace");
	mkdirSync(driftDir, { recursive: true });
	mkdirSync(workspaceDir, { recursive: true });
	const store = new DriftStateStore({ driftDir });
	roots.push(root);
	stores.push(store);
	return { root, driftDir, workspaceDir, store };
}

function makeContext() {
	return createDriftContext("local", new Date("2026-05-01T00:00:00.000Z"));
}

async function closeServer(server: Server): Promise<void> {
	if (!server.listening) return;
	await new Promise<void>((resolve, reject) => {
		server.close((error) => (error ? reject(error) : resolve()));
	});
}

describe("Drift tool metadata and policy", () => {
	it("classifies built-ins, host tools, and MCP-like tools", () => {
		const readFile: DriftTool = {
			name: "read_file",
			description: "read",
			parameters: { type: "object" },
			execute: async () => "ok",
		};
		const registry = new DriftToolRegistry([readFile]);
		const hostTool: DriftTool = {
			name: "host_action",
			description: "external action",
			parameters: { type: "object" },
			execute: async () => "ok",
		};
		const mcpTool: DriftTool = {
			name: "mcp_action",
			description: "MCP action",
			parameters: { type: "object" },
			meta: { source: "mcp:server-a", risk: "external-side-effect", requiresApproval: true },
			execute: async () => "ok",
		};
		registry.register(hostTool, { source: "shared:host_action" });
		registry.register(mcpTool);

		expect(registry.metadata("read_file")).toMatchObject({ source: "builtin", risk: "read-only" });
		expect(registry.metadata("host_action")).toMatchObject({
			source: "shared:host_action",
			risk: "external-side-effect",
			requiresApproval: true,
		});
		expect(getDriftToolMeta(mcpTool)).toMatchObject({ source: "mcp:server-a", requiresApproval: true });
	});

	it("denies an external host tool before execution and records a redacted audit event", async () => {
		const { driftDir, workspaceDir, store } = makeFixture();
		mkdirSync(join(driftDir, "skills", "skill-a"), { recursive: true });
		writeFileSync(
			join(driftDir, "skills", "skill-a", "SKILL.md"),
			"---\nname: skill-a\ndescription: security test\n---\n# Skill\n",
			"utf-8",
		);
		let executed = false;
		const audit: Array<{ result: string; argsPreview: string }> = [];
		const hostTool: DriftTool = {
			name: "host_action",
			description: "external action",
			parameters: { type: "object" },
			execute: async () => {
				executed = true;
				return "should not run";
			},
		};
		const pipeline = new DriftTurnPipeline({
			store,
			toolDeps: {
				driftDir,
				workspaceDir,
				store,
				sharedTools: [hostTool],
				toolPolicy: {
					authorize: ({ meta }) => (meta.risk === "external-side-effect" ? "approval required" : true),
					onCall: (event) => {
						audit.push({ result: event.result, argsPreview: event.argsPreview });
					},
				},
			},
			maxSteps: 4,
		});
		let call = 0;
		await pipeline.run(makeContext(), async () => {
			call += 1;
			if (call === 1) {
				return {
					id: "select",
					name: "select_skill",
					input: { skill_name: "skill-a", decision: "explore", intention: "inspect", reason: "test" },
				};
			}
			return { id: "action", name: "host_action", input: { token: "secret-value" } };
		});

		expect(executed).toBe(false);
		expect(audit).toHaveLength(2);
		expect(audit.at(-1)).toMatchObject({ result: "denied" });
		expect(audit.at(-1)?.argsPreview).not.toContain("secret-value");
		expect(readFileSync(join(driftDir, "skills", "skill-a", "SKILL.md"), "utf-8")).toContain("skill-a");
	});
});

describe("Drift tool security boundaries", () => {
	it("uses host-owned memory text and enforces a context budget", async () => {
		const { driftDir, workspaceDir, store } = makeFixture();
		mkdirSync(join(driftDir, "skills", "context"), { recursive: true });
		writeFileSync(
			join(driftDir, "skills", "context", "SKILL.md"),
			"---\nname: context\ndescription: context test\n---\n# Context\n",
			"utf-8",
		);
		const ctx = makeContext();
		let contextFrame = "";
		const pipeline = new DriftTurnPipeline({
			store,
			toolDeps: { driftDir, workspaceDir, store },
			memoryTextFn: async () => `host-memory\n${"x".repeat(20_000)}`,
			maxContextChars: 4_000,
		});
		await pipeline.run(ctx, async (_messages, _schemas, _toolChoice, systemPrompt) => {
			contextFrame = systemPrompt ?? "";
			return { id: "idle", name: "idle_drift", input: { reason: "test boundary" } };
		});

		// 合并后的 systemPrompt = base prompt + context frame;预算作用于 frame 段。
		const frameStart = contextFrame.indexOf("## drift_self_state");
		const frame = frameStart >= 0 ? contextFrame.slice(frameStart) : contextFrame;
		expect(frame.length).toBeLessThanOrEqual(4_000);
		expect(frame).toContain("host-memory");
		expect(frame).toContain("context truncated");
	});

	it("keeps file reads/writes and shell cwd inside configured roots", async () => {
		const { root, driftDir, workspaceDir, store } = makeFixture();
		const outsideFile = join(root, "outside.txt");
		writeFileSync(outsideFile, "outside", "utf-8");
		const ctx = makeContext();
		const tools = buildDriftToolRegistry(ctx, { driftDir, workspaceDir, store });
		const read = tools.find((tool) => tool.name === "read_file");
		const write = tools.find((tool) => tool.name === "write_file");
		const list = tools.find((tool) => tool.name === "list_dir");
		const shell = tools.find((tool) => tool.name === "shell");
		expect(read).toBeDefined();
		expect(write).toBeDefined();
		expect(list).toBeDefined();
		expect(shell).toBeDefined();

		expect(await read!.execute({ path: outsideFile }, ctx)).toContain("file not found");
		expect(await list!.execute({ path: root }, ctx)).toContain("directory not found");
		expect(await write!.execute({ path: outsideFile, content: "overwrite" }, ctx)).toContain("outside allowed");
		expect(await shell!.execute({ command: "pwd", cwd: root }, ctx)).toContain("outside allowed");
		expect(readFileSync(outsideFile, "utf-8")).toBe("outside");
	});

	it("blocks local web destinations before invoking a host fetcher", async () => {
		const { driftDir, workspaceDir, store } = makeFixture();
		let called = false;
		const ctx = makeContext();
		const tools = buildDriftToolRegistry(ctx, {
			driftDir,
			workspaceDir,
			store,
			webFetchFn: async () => {
				called = true;
				return { text: "unsafe" };
			},
		});
		const fetchTool = tools.find((tool) => tool.name === "web_fetch");
		const result = JSON.parse(await fetchTool!.execute({ url: "http://127.0.0.1:8080/secret" }, ctx)) as {
			error?: string;
		};
		expect(result.error).toContain("private or local");
		expect(called).toBe(false);
	});

	it("blocks DNS-resolved private addresses before invoking a host fetcher", async () => {
		const { driftDir, workspaceDir, store } = makeFixture();
		let called = false;
		let resolvedHost = "";
		const ctx = makeContext();
		const tools = buildDriftToolRegistry(ctx, {
			driftDir,
			workspaceDir,
			store,
			webFetchFn: async () => {
				called = true;
				return { text: "unsafe" };
			},
			webDnsLookupFn: async (hostname) => {
				resolvedHost = hostname;
				return [{ address: "127.0.0.1", family: 4 }];
			},
		});
		const fetchTool = tools.find((tool) => tool.name === "web_fetch");
		const result = JSON.parse(await fetchTool!.execute({ url: "https://public.example.test/secret" }, ctx)) as {
			error?: string;
		};
		expect(result.error).toContain("private or local web address");
		expect(resolvedHost).toBe("public.example.test");
		expect(called).toBe(false);
	});

	it("enforces the native redirect hop budget", async () => {
		const { driftDir, workspaceDir, store } = makeFixture();
		const server = createServer((request, response) => {
			if (request.url === "/start") {
				response.writeHead(302, { Location: "/final" });
				response.end();
				return;
			}
			response.end("<p>safe redirect target</p>");
		});
		await new Promise<void>((resolvePromise, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", () => resolvePromise());
		});
		try {
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("test server has no address");
			const url = `http://127.0.0.1:${address.port}/start`;
			const blockedTools = buildDriftToolRegistry(makeContext(), {
				driftDir,
				workspaceDir,
				store,
				webPolicy: { allowPrivateNetwork: true, maxRedirectHops: 0 },
			});
			const blockedFetch = blockedTools.find((tool) => tool.name === "web_fetch");
			const blocked = JSON.parse(await blockedFetch!.execute({ url }, makeContext())) as { error?: string };
			expect(blocked.error).toContain("redirect blocked");

			const allowedTools = buildDriftToolRegistry(makeContext(), {
				driftDir,
				workspaceDir,
				store,
				webPolicy: { allowPrivateNetwork: true, maxRedirectHops: 1 },
			});
			const allowedFetch = allowedTools.find((tool) => tool.name === "web_fetch");
			const allowed = JSON.parse(await allowedFetch!.execute({ url }, makeContext())) as { text?: string };
			expect(allowed.text).toContain("safe redirect target");
		} finally {
			await closeServer(server);
		}
	});
});
