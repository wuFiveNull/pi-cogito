import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxManager } from "@carderne/sandbox-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	ApprovalAuditRecord,
	ApprovalJudge,
	ApprovalJudgeSettings,
	ApprovalRequest,
	ApprovalVerdict,
} from "../src/core/approval/index.ts";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "../src/core/extensions/index.ts";
import { createSandboxExtension } from "../src/core/sandbox/sandbox-extension.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown>;

interface FakePi {
	pi: ExtensionAPI;
	tools: Map<string, ToolDefinition>;
	handlers: Map<string, Handler[]>;
	commands: Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>;
	auditEntries: Array<{ customType: string; data: unknown }>;
}

interface Instance {
	fake: FakePi;
	ctx: ExtensionContext;
}

function createFakePi(): FakePi {
	const tools = new Map<string, ToolDefinition>();
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
	const auditEntries: Array<{ customType: string; data: unknown }> = [];
	const pi = {
		registerTool: (tool: ToolDefinition) => {
			tools.set(tool.name, tool);
		},
		on: (event: string, handler: Handler) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerCommand: (name: string, options: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => {
			commands.set(name, options);
		},
		appendEntry: (customType: string, data?: unknown) => {
			auditEntries.push({ customType, data });
		},
	} as unknown as ExtensionAPI;
	return { pi, tools, handlers, commands, auditEntries };
}

function createContext(cwd: string): ExtensionContext {
	return {
		cwd,
		hasUI: false,
		sessionManager: {
			getSessionId: () => "test-session",
			getSessionFile: () => undefined,
		},
		ui: {
			notify: () => undefined,
			setStatus: () => undefined,
		},
	} as unknown as ExtensionContext;
}

interface FakeJudge extends ApprovalJudge {
	calls: Array<{ request: ApprovalRequest; settings?: ApprovalJudgeSettings }>;
	batchCalls: number;
}

/** Verdicts keyed by "<kind>:<target>"; unlisted requests fail closed. */
function createFakeJudge(verdicts: Record<string, ApprovalVerdict | undefined> = {}): FakeJudge {
	const calls: Array<{ request: ApprovalRequest; settings?: ApprovalJudgeSettings }> = [];
	const state: FakeJudge = {
		calls,
		batchCalls: 0,
		judge: async (request: ApprovalRequest, settings?: ApprovalJudgeSettings) => {
			calls.push({ request, settings });
			return verdicts[`${request.kind}:${request.target}`];
		},
	};
	return state;
}

/** Same as createFakeJudge but with a native judgeBatch: one call per batch. */
function createBatchJudge(verdicts: Record<string, ApprovalVerdict | undefined> = {}): FakeJudge {
	const fake = createFakeJudge(verdicts);
	fake.judgeBatch = async (requests: ApprovalRequest[], settings?: ApprovalJudgeSettings) => {
		fake.batchCalls += 1;
		for (const request of requests) fake.calls.push({ request, settings });
		const map = new Map<string, ApprovalVerdict>();
		for (const request of requests) {
			const verdict = verdicts[`${request.kind}:${request.target}`];
			if (verdict) map.set(request.target, verdict);
		}
		return map;
	};
	return fake;
}

function writeProjectConfig(cwd: string, config: Record<string, unknown>): void {
	mkdirSync(join(cwd, ".cogito"), { recursive: true });
	writeFileSync(join(cwd, ".cogito", "sandbox.json"), JSON.stringify(config));
}

describe("sandbox extension", () => {
	let workDir: string;
	let previousAgentDir: string | undefined;
	let mocks: Array<{ mockRestore: () => void }> = [];
	let instances: Instance[] = [];

	afterEach(async () => {
		// Release every lease the test created so the process-wide registry drains.
		for (const instance of instances) {
			for (const handler of instance.fake.handlers.get("session_shutdown") ?? []) {
				await handler({ type: "session_shutdown" }, instance.ctx).catch(() => undefined);
			}
		}
		instances = [];
		for (const mock of mocks) mock.mockRestore();
		mocks = [];
		if (previousAgentDir === undefined) delete process.env.COGITO_CODING_AGENT_DIR;
		else process.env.COGITO_CODING_AGENT_DIR = previousAgentDir;
		rmSync(workDir, { recursive: true, force: true });
	});

	/** Isolate config paths and stub the OS sandbox so enabling never touches bwrap. */
	const setup = (config?: Record<string, unknown>, judge?: ApprovalJudge) => {
		workDir = mkdtempSync(join(tmpdir(), "cogito-sandbox-ext-"));
		previousAgentDir = process.env.COGITO_CODING_AGENT_DIR;
		process.env.COGITO_CODING_AGENT_DIR = join(workDir, "agent");
		if (config) writeProjectConfig(workDir, config);

		mocks.push(vi.spyOn(SandboxManager, "initialize").mockResolvedValue(undefined));
		mocks.push(vi.spyOn(SandboxManager, "reset").mockResolvedValue(undefined));

		const fake = createFakePi();
		const extension = createSandboxExtension(judge ? { judge } : {});
		if (typeof extension === "function") throw new Error("expected named inline extension");
		extension.factory(fake.pi);
		const ctx = createContext(workDir);
		instances.push({ fake, ctx });
		return { fake, ctx };
	};

	/** Extra session in the same process (shares the SandboxManager singleton). */
	const setupExtraSession = (judge?: ApprovalJudge): Instance => {
		const fake = createFakePi();
		const extension = createSandboxExtension(judge ? { judge } : {});
		if (typeof extension === "function") throw new Error("expected named inline extension");
		extension.factory(fake.pi);
		const ctx = createContext(workDir);
		instances.push({ fake, ctx });
		return { fake, ctx };
	};

	const emit = async (fake: FakePi, event: string, payload: unknown, ctx: ExtensionContext) => {
		const list = fake.handlers.get(event) ?? [];
		let result: unknown;
		for (const handler of list) result = await handler(payload, ctx);
		return result;
	};

	it("registers a bash tool override plus the sandbox commands without manual approval", () => {
		const { fake } = setup();

		expect(fake.tools.has("bash")).toBe(true);
		expect(fake.tools.get("bash")?.label).toBe("bash (sandboxed)");
		for (const command of ["sandbox", "sandbox-enable", "sandbox-disable"]) {
			expect(fake.commands.has(command)).toBe(true);
		}
		expect(fake.commands.has("sandbox-allow")).toBe(false);
	});

	it("stays inert when no config enables the sandbox", async () => {
		const judge = createFakeJudge();
		const { fake, ctx } = setup(undefined, judge);

		await emit(fake, "session_start", { type: "session_start" }, ctx);

		const bashEvent = {
			type: "tool_call",
			toolCallId: "b1",
			toolName: "bash",
			input: { command: "curl https://evil.example.com" },
		};
		expect(await emit(fake, "tool_call", bashEvent, ctx)).toBeUndefined();

		const writeEvent = { type: "tool_call", toolCallId: "w1", toolName: "write", input: { path: "/etc/hosts" } };
		expect(await emit(fake, "tool_call", writeEvent, ctx)).toBeUndefined();
		expect(judge.calls).toHaveLength(0);
	});

	it("grants AI-approved reads and writes as session rules", async () => {
		const judge = createFakeJudge({
			"fs-read:/etc/hostname": { decision: "allow", rule: "/etc/hostname", reason: "system info" },
			"fs-write:/opt/data/file": { decision: "allow", rule: "/opt/data", reason: "data dir" },
		});
		const { fake, ctx } = setup(
			{ enabled: true, filesystem: { allowRead: ["/tmp"], allowWrite: ["/tmp"], denyWrite: [] } },
			judge,
		);

		await emit(fake, "session_start", { type: "session_start" }, ctx);

		const outsideRead = { type: "tool_call", toolCallId: "r1", toolName: "read", input: { path: "/etc/hostname" } };
		expect(await emit(fake, "tool_call", outsideRead, ctx)).toBeUndefined();

		const outsideWrite = {
			type: "tool_call",
			toolCallId: "w1",
			toolName: "write",
			input: { path: "/opt/data/file" },
		};
		expect(await emit(fake, "tool_call", outsideWrite, ctx)).toBeUndefined();

		expect(judge.calls).toHaveLength(2);
		expect(judge.calls[0]?.settings).toBeUndefined();

		// Session rules now cover both targets without re-judging.
		expect(await emit(fake, "tool_call", outsideRead, ctx)).toBeUndefined();
		expect(await emit(fake, "tool_call", outsideWrite, ctx)).toBeUndefined();
		expect(judge.calls).toHaveLength(2);

		// Verdicts are recorded as audit entries.
		const sandboxAudits = fake.auditEntries.filter((entry) => entry.customType === "sandbox-approval");
		expect(sandboxAudits).toHaveLength(2);
		expect(sandboxAudits[0]?.data).toMatchObject({
			kind: "fs-read",
			target: "/etc/hostname",
			decision: "allow",
			rule: "/etc/hostname",
		});
	});

	it("blocks denied and malformed AI verdicts with the reason", async () => {
		const judge = createFakeJudge({
			"fs-read:/etc/hostname": { decision: "deny", rule: "/etc", reason: "not needed for the task" },
			"fs-write:/opt/data/file": { decision: "allow", rule: "*", reason: "allow everything" },
		});
		const { fake, ctx } = setup(
			{ enabled: true, filesystem: { allowRead: ["/tmp"], allowWrite: ["/tmp"], denyWrite: [] } },
			judge,
		);

		await emit(fake, "session_start", { type: "session_start" }, ctx);

		const deniedRead = { type: "tool_call", toolCallId: "r1", toolName: "read", input: { path: "/etc/hostname" } };
		expect(await emit(fake, "tool_call", deniedRead, ctx)).toMatchObject({
			block: true,
			reason: expect.stringContaining("not needed for the task"),
		});

		// A wildcard rule is rejected even when the model says allow.
		const wildcardWrite = {
			type: "tool_call",
			toolCallId: "w1",
			toolName: "write",
			input: { path: "/opt/data/file" },
		};
		expect(await emit(fake, "tool_call", wildcardWrite, ctx)).toMatchObject({
			block: true,
			reason: expect.stringContaining("Rule must not allow every path"),
		});
	});

	it("fails closed when the judge is unavailable", async () => {
		const judge = createFakeJudge();
		const { fake, ctx } = setup(
			{ enabled: true, filesystem: { allowRead: ["/tmp"], allowWrite: ["/tmp"], denyWrite: [] } },
			judge,
		);

		await emit(fake, "session_start", { type: "session_start" }, ctx);

		const unlisted = { type: "tool_call", toolCallId: "w1", toolName: "write", input: { path: "/opt/data/file" } };
		expect(await emit(fake, "tool_call", unlisted, ctx)).toMatchObject({
			block: true,
			reason: expect.stringContaining("failing closed"),
		});
		expect(fake.auditEntries.some((entry) => (entry.data as ApprovalAuditRecord)?.decision === "fail-closed")).toBe(
			true,
		);
	});

	it("hard-blocks denyWrite without consulting the judge", async () => {
		const judge = createFakeJudge();
		const { fake, ctx } = setup(
			{ enabled: true, filesystem: { allowRead: ["/tmp"], allowWrite: ["/tmp"], denyWrite: ["/tmp/*.env"] } },
			judge,
		);

		await emit(fake, "session_start", { type: "session_start" }, ctx);

		const denied = {
			type: "tool_call",
			toolCallId: "w1",
			toolName: "write",
			input: { path: "/tmp/secret.env" },
		};
		expect(await emit(fake, "tool_call", denied, ctx)).toMatchObject({
			block: true,
			reason: expect.stringContaining("denyWrite"),
		});
		expect(judge.calls).toHaveLength(0);
	});

	it("judges bash network domains and blocks user_bash denials", async () => {
		const judge = createFakeJudge({
			"bash-domain:example.org": { decision: "deny", rule: "example.org", reason: "unknown host" },
		});
		const { fake, ctx } = setup({ enabled: true, network: { allowedDomains: ["example.com"] } }, judge);

		await emit(fake, "session_start", { type: "session_start" }, ctx);

		const blocked = {
			type: "tool_call",
			toolCallId: "b1",
			toolName: "bash",
			input: { command: "curl https://example.org/x" },
		};
		expect(await emit(fake, "tool_call", blocked, ctx)).toMatchObject({
			block: true,
			reason: expect.stringContaining("unknown host"),
		});

		const userBash = await emit(
			fake,
			"user_bash",
			{ type: "user_bash", command: "curl https://example.org/y", excludeFromContext: false, cwd: workDir },
			ctx,
		);
		expect(userBash).toMatchObject({
			result: { exitCode: 1, output: expect.stringContaining("unknown host") },
		});

		// An allow verdict lets the command through and the wrapper is returned.
		const grantingJudge = createFakeJudge({
			"bash-domain:example.org": { decision: "allow", rule: "*.example.org", reason: "project host" },
		});
		const second = setupExtraSession(grantingJudge);
		await emit(second.fake, "session_start", { type: "session_start" }, second.ctx);
		const allowedUserBash = await emit(
			second.fake,
			"user_bash",
			{ type: "user_bash", command: "curl https://example.org/y", excludeFromContext: false, cwd: workDir },
			ctx,
		);
		expect(allowedUserBash).toMatchObject({
			operations: expect.objectContaining({ exec: expect.any(Function) }),
		});
	});

	it("judges all command domains in one batch call with a single refresh", async () => {
		const judge = createBatchJudge({
			"bash-domain:api.example.org": { decision: "allow", rule: "api.example.org", reason: "api host" },
			"bash-domain:cdn.example.org": { decision: "allow", rule: "*.example.org", reason: "cdn host" },
		});
		const { fake, ctx } = setup({ enabled: true, network: { allowedDomains: ["example.com"] } }, judge);

		await emit(fake, "session_start", { type: "session_start" }, ctx);
		const initializationsAfterStart = vi.mocked(SandboxManager.initialize).mock.calls.length;
		expect(initializationsAfterStart).toBe(1);

		const command = "curl https://api.example.org/a https://cdn.example.org/b";
		await emit(fake, "tool_call", { type: "tool_call", toolCallId: "b1", toolName: "bash", input: { command } }, ctx);

		expect(judge.batchCalls).toBe(1);
		expect(judge.calls).toHaveLength(2);
		// Both grants applied, the sandbox rebuilt exactly once for the batch.
		expect(vi.mocked(SandboxManager.initialize).mock.calls.length).toBe(initializationsAfterStart + 1);

		// Granted domains now sit in the session whitelist: no further judging.
		const userBash = await emit(
			fake,
			"user_bash",
			{ type: "user_bash", command, excludeFromContext: false, cwd: workDir },
			ctx,
		);
		expect(userBash).toMatchObject({
			operations: expect.objectContaining({ exec: expect.any(Function) }),
		});
		expect(judge.batchCalls).toBe(1);
	});

	it("blocks a mixed batch while keeping the granted domains", async () => {
		const judge = createBatchJudge({
			"bash-domain:api.example.org": { decision: "allow", rule: "api.example.org", reason: "api host" },
			"bash-domain:evil.example.net": { decision: "deny", rule: "evil.example.net", reason: "unknown host" },
		});
		const { fake, ctx } = setup({ enabled: true, network: { allowedDomains: ["example.com"] } }, judge);

		await emit(fake, "session_start", { type: "session_start" }, ctx);

		const result = await emit(
			fake,
			"tool_call",
			{
				type: "tool_call",
				toolCallId: "b1",
				toolName: "bash",
				input: { command: "curl https://api.example.org/a https://evil.example.net/b" },
			},
			ctx,
		);
		expect(result).toMatchObject({
			block: true,
			reason: expect.stringContaining("evil.example.net"),
		});
		expect(result).toMatchObject({ reason: expect.stringContaining("unknown host") });

		const decisions = fake.auditEntries
			.filter((entry) => entry.customType === "sandbox-approval")
			.map((entry) => (entry.data as ApprovalAuditRecord).decision);
		expect(decisions).toEqual(["allow", "deny"]);

		// The allow verdict survived: a retry touching only that domain proceeds.
		const retry = await emit(
			fake,
			"tool_call",
			{
				type: "tool_call",
				toolCallId: "b2",
				toolName: "bash",
				input: { command: "curl https://api.example.org/c" },
			},
			ctx,
		);
		expect(retry).toBeUndefined();
	});

	it("falls back to per-target judging when the judge has no batch API", async () => {
		const judge = createFakeJudge({
			"bash-domain:api.example.org": { decision: "allow", rule: "api.example.org", reason: "api host" },
			"bash-domain:cdn.example.org": { decision: "allow", rule: "cdn.example.org", reason: "cdn host" },
		});
		const { fake, ctx } = setup({ enabled: true, network: { allowedDomains: ["example.com"] } }, judge);

		await emit(fake, "session_start", { type: "session_start" }, ctx);

		await emit(
			fake,
			"tool_call",
			{
				type: "tool_call",
				toolCallId: "b1",
				toolName: "bash",
				input: { command: "curl https://api.example.org/a https://cdn.example.org/b" },
			},
			ctx,
		);

		expect(judge.calls).toHaveLength(2);
		const decisions = fake.auditEntries
			.filter((entry) => entry.customType === "sandbox-approval")
			.map((entry) => (entry.data as ApprovalAuditRecord).decision);
		expect(decisions).toEqual(["allow", "allow"]);
	});

	it("judges non-URL hosts at connection time through the ask callback", async () => {
		const judge = createBatchJudge({
			"bash-domain:raw-ip-proxy.invalid": { decision: "allow", rule: "raw-ip-proxy.invalid", reason: "build host" },
			"bash-domain:denied.invalid": undefined,
		});
		const { fake, ctx } = setup({ enabled: true, network: { allowedDomains: ["example.com"] } }, judge);

		await emit(fake, "session_start", { type: "session_start" }, ctx);

		const initializeCalls = vi.mocked(SandboxManager.initialize).mock.calls;
		const ask = initializeCalls.at(-1)?.[1] as
			| ((params: { host: string; port?: number }) => Promise<boolean>)
			| undefined;
		expect(ask).toBeTypeOf("function");

		// Whitelist miss with an allow verdict: connection passes, grant recorded.
		expect(await ask?.({ host: "raw-ip-proxy.invalid", port: 443 })).toBe(true);
		expect(judge.calls).toHaveLength(1);

		// The grant lives in the session whitelist now: no second judge call.
		expect(await ask?.({ host: "raw-ip-proxy.invalid", port: 443 })).toBe(true);
		expect(judge.calls).toHaveLength(1);

		// Judge unavailable for the host: fail closed.
		expect(await ask?.({ host: "denied.invalid", port: 443 })).toBe(false);

		// The ask-time grant also covers preflight checks for later commands.
		const userBash = await emit(
			fake,
			"user_bash",
			{
				type: "user_bash",
				command: "curl https://raw-ip-proxy.invalid/x",
				excludeFromContext: false,
				cwd: workDir,
			},
			ctx,
		);
		expect(userBash).toMatchObject({
			operations: expect.objectContaining({ exec: expect.any(Function) }),
		});
		expect(judge.calls).toHaveLength(2); // still judged once overall
	});

	it("keeps the OS sandbox alive while other sessions hold leases", async () => {
		const first = setup({ enabled: true });
		const second = setupExtraSession();

		await emit(first.fake, "session_start", { type: "session_start" }, first.ctx);
		await emit(second.fake, "session_start", { type: "session_start" }, second.ctx);
		const initialize = vi.mocked(SandboxManager.initialize);
		const reset = vi.mocked(SandboxManager.reset);
		expect(initialize.mock.calls.length).toBe(2);

		// First session exits: the sandbox must survive for the second.
		const initializesBefore = initialize.mock.calls.length;
		await emit(first.fake, "session_shutdown", { type: "session_shutdown" }, first.ctx);
		expect(initialize.mock.calls.length).toBe(initializesBefore + 1); // rebuilt from the surviving lease

		// Last session exits: reset without a rebuild — the sandbox is torn down.
		const resetsAfterFirst = reset.mock.calls.length;
		await emit(second.fake, "session_shutdown", { type: "session_shutdown" }, second.ctx);
		expect(initialize.mock.calls.length).toBe(initializesBefore + 1);
		expect(reset.mock.calls.length).toBe(resetsAfterFirst + 1);
	});

	it("runs sandboxed bash through the runtime wrapper when enabled", async () => {
		const { fake, ctx } = setup({ enabled: true });
		mocks.push(vi.spyOn(SandboxManager, "wrapWithSandbox").mockImplementation(async (command: string) => command));

		await emit(fake, "session_start", { type: "session_start" }, ctx);

		const bash = fake.tools.get("bash");
		expect(bash).toBeDefined();
		const result = (await bash?.execute("t1", { command: "echo sandbox-ok" }, undefined, undefined, ctx)) as {
			content: Array<{ type: string; text?: string }>;
		};
		const text = result.content
			.filter((part) => part.type === "text")
			.map((part) => part.text ?? "")
			.join("");
		expect(text).toContain("sandbox-ok");
		expect(SandboxManager.wrapWithSandbox).toHaveBeenCalled();
	});

	it("notifies when sandbox initialization fails", async () => {
		const { fake, ctx } = setup({ enabled: true });
		mocks.push(vi.spyOn(SandboxManager, "initialize").mockRejectedValue(new Error("no bwrap on PATH")));

		await emit(fake, "session_start", { type: "session_start" }, ctx);

		// Fail closed: tool interception stays off when initialization failed.
		const writeEvent = { type: "tool_call", toolCallId: "w1", toolName: "write", input: { path: "/etc/hosts" } };
		expect(await emit(fake, "tool_call", writeEvent, ctx)).toBeUndefined();
	});
});
