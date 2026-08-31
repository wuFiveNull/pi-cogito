/**
 * Real-model sandbox approval e2e. Opt in with TEST_REAL_MODEL=1 — requires
 * cogito auth (~/.cogito/agent/auth.json) for the provider, plus socat/bwrap
 * on Linux for the OS sandbox part. Skipped in the normal test run.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxManager } from "@carderne/sandbox-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { createLlmApprovalJudge } from "../src/core/approval/judge.ts";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "../src/core/extensions/index.ts";
import { createSandboxExtension } from "../src/core/sandbox/sandbox-extension.ts";

const runReal = process.env.TEST_REAL_MODEL === "1";
const REAL_MODEL = process.env.TEST_REAL_MODEL_ID ?? "opencode-go/deepseek-v4-flash";

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown>;

function createFakePi() {
	const handlers = new Map<string, Handler[]>();
	const auditEntries: Array<{ customType: string; data: unknown }> = [];
	const pi = {
		registerTool: (_tool: ToolDefinition) => undefined,
		on: (event: string, handler: Handler) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerCommand: () => undefined,
		appendEntry: (customType: string, data?: unknown) => {
			auditEntries.push({ customType, data });
		},
	} as unknown as ExtensionAPI;
	return { pi, handlers, auditEntries };
}

function createContext(cwd: string): ExtensionContext {
	return {
		cwd,
		hasUI: false,
		sessionManager: {
			getSessionId: () => "real-model-test",
			getSessionFile: () => undefined,
		},
		ui: { notify: () => undefined, setStatus: () => undefined },
	} as unknown as ExtensionContext;
}

describe.runIf(runReal)("sandbox real-model approval", () => {
	let workDir: string;

	afterEach(() => {
		if (workDir) rmSync(workDir, { recursive: true, force: true });
		return SandboxManager.reset().catch(() => undefined);
	});

	it("gets a parsed verdict from the configured model", async () => {
		const judge = createLlmApprovalJudge();
		const verdict = await judge.judge(
			{
				kind: "bash-domain",
				target: "images.example-cdn.dev",
				context: {
					command: "curl -sS https://images.example-cdn.dev/photo.jpg -o /tmp/photo.jpg",
					cwd: process.cwd(),
				},
			},
			{ model: REAL_MODEL, timeoutSeconds: 120 },
		);

		console.log("[real-model] verdict:", JSON.stringify(verdict));
		expect(verdict).toBeDefined();
		expect(["allow", "deny"]).toContain(verdict?.decision);
		expect(verdict?.rule.length ?? 0).toBeGreaterThan(0);
		expect(verdict?.reason.length ?? 0).toBeGreaterThan(0);
	}, 180_000);

	it("runs the sandboxed approval flow end to end", async () => {
		workDir = mkdtempSync(join(tmpdir(), "cogito-sandbox-real-"));
		mkdirSync(join(workDir, ".cogito"), { recursive: true });
		writeFileSync(
			join(workDir, ".cogito", "sandbox.json"),
			JSON.stringify({
				enabled: true,
				network: { allowedDomains: ["example.com"] },
				approval: { model: REAL_MODEL, timeoutSeconds: 120, maxPerSession: 5 },
			}),
		);

		const { pi, handlers, auditEntries } = createFakePi();
		const extension = createSandboxExtension();
		if (typeof extension === "function") throw new Error("expected named inline extension");
		await extension.factory(pi);
		const ctx = createContext(workDir);

		const emit = async (event: string, payload: unknown) => {
			let result: unknown;
			for (const handler of handlers.get(event) ?? []) result = await handler(payload, ctx);
			return result;
		};

		await emit("session_start", { type: "session_start" });
		expect(SandboxManager.isSandboxingEnabled()).toBe(true);

		const result = await emit("tool_call", {
			type: "tool_call",
			toolCallId: "real-1",
			toolName: "bash",
			input: { command: "curl -sS https://unlisted-host-abc123.invalid/tarball -o /tmp/tarball" },
		});
		console.log("[real-model] tool_call result:", JSON.stringify(result));

		const sandboxAudits = auditEntries.filter((entry) => entry.customType === "sandbox-approval");
		console.log("[real-model] audit:", JSON.stringify(sandboxAudits));
		expect(sandboxAudits.length).toBeGreaterThan(0);

		if (result && typeof result === "object" && "block" in result) {
			expect((result as { block: boolean }).block).toBe(true);
			expect((result as { reason?: string }).reason?.length ?? 0).toBeGreaterThan(0);
		}
		const record = sandboxAudits[0]?.data as { decision?: string; reason?: string; rule?: string };
		expect(["allow", "deny", "fail-closed"]).toContain(record?.decision);
		expect(record?.reason?.length ?? 0).toBeGreaterThan(0);

		await emit("session_shutdown", { type: "session_shutdown", reason: "test" });
	}, 300_000);
});
