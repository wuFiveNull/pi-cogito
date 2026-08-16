import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDriftContext, DriftTurnPipeline } from "../src/runtime.ts";
import { DriftStateStore } from "../src/state.ts";
import type { DriftTool } from "../src/tools.ts";

const roots: string[] = [];
const stores: DriftStateStore[] = [];

afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeFixture(): { driftDir: string; workspaceDir: string; store: DriftStateStore } {
	const root = mkdtempSync(join(tmpdir(), "drift-runtime-regression-"));
	const driftDir = join(root, "drift");
	const workspaceDir = join(root, "workspace");
	mkdirSync(join(driftDir, "skills", "skill-a"), { recursive: true });
	mkdirSync(workspaceDir, { recursive: true });
	writeFileSync(
		join(driftDir, "skills", "skill-a", "SKILL.md"),
		"---\nname: skill-a\ndescription: test skill\n---\n",
		"utf-8",
	);
	const store = new DriftStateStore({ driftDir });
	roots.push(root);
	stores.push(store);
	return { driftDir, workspaceDir, store };
}

function finishInput(): Record<string, unknown> {
	return {
		skill_used: "skill-a",
		status: "completed",
		briefing: "closed",
		self_update: { next_tendency: "next", reflection: "closed", pattern: "ordinary" },
	};
}

function driftToolResultText(m: Record<string, unknown>): string {
	const content = m.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((part) => typeof part === "object" && part !== null && "type" in part && part.type === "text")
			.map((part) => String((part as { text?: unknown }).text ?? ""))
			.join("\n");
	}
	return "";
}

function selectInput(): Record<string, unknown> {
	return { skill_name: "skill-a", decision: "explore", intention: "inspect", reason: "test" };
}

describe("Drift runtime failure and budget handling", () => {
	it("persists a paused run and releases the active lease when the LLM fails", async () => {
		const { driftDir, workspaceDir, store } = makeFixture();
		const ctx = createDriftContext(
			"local",
			new Date("2026-05-01T00:00:00.000Z"),
			"00000000-0000-4000-8000-000000000001",
		);
		const pipeline = new DriftTurnPipeline({ store, toolDeps: { driftDir, workspaceDir, store } });

		await expect(
			pipeline.run(ctx, async () => {
				throw new Error("provider unavailable");
			}),
		).rejects.toThrow("provider unavailable");

		expect(store.listActiveRuns()).toHaveLength(0);
		expect(store.getRunDiagnostics(ctx.runId)).toMatchObject({
			run: { status: "paused", briefing: "Drift 运行失败：provider unavailable" },
			active: null,
		});
	});

	it("clips large tool results before the next model request", async () => {
		const { driftDir, workspaceDir, store } = makeFixture();
		writeFileSync(join(workspaceDir, "large.txt"), "x".repeat(8_000), "utf-8");
		const messagesByCall: Array<Array<Record<string, unknown>>> = [];
		let call = 0;
		const pipeline = new DriftTurnPipeline({
			store,
			toolDeps: { driftDir, workspaceDir, store },
			maxToolResultChars: 1_000,
		});

		await pipeline.run(createDriftContext("local", new Date("2026-05-01T00:00:00.000Z")), async (messages) => {
			messagesByCall.push(messages.map((message) => ({ ...message })));
			call++;
			if (call === 1) return { id: "select", name: "select_skill", input: selectInput() };
			if (call === 2) {
				return { id: "read", name: "read_file", input: { path: "workspace/large.txt" } };
			}
			return { id: "finish", name: "finish_drift", input: finishInput() };
		});

		const toolResults = (messagesByCall[2] ?? [])
			.filter((message) => message.role === "toolResult")
			.map((message) => driftToolResultText(message));
		expect(toolResults).toHaveLength(2);
		expect(toolResults[1]).toContain("tool result truncated by Drift budget");
		expect(toolResults[1]!.length).toBeLessThanOrEqual(1_000);
	});

	it("redacts sensitive tool arguments in durable step previews", async () => {
		const { driftDir, workspaceDir, store } = makeFixture();
		let executed = false;
		const hostTool: DriftTool = {
			name: "host_action",
			description: "external action",
			parameters: { type: "object" },
			execute: async () => {
				executed = true;
				return "unexpected";
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
					authorize: ({ tool }) => (tool.name === "host_action" ? "approval required" : true),
				},
			},
		});
		let call = 0;

		await pipeline.run(
			createDriftContext("local", new Date("2026-05-01T00:00:00.000Z"), "00000000-0000-4000-8000-000000000002"),
			async () => {
				call++;
				if (call === 1) return { id: "select", name: "select_skill", input: selectInput() };
				return { id: "action", name: "host_action", input: { token: "secret-value" } };
			},
		);

		expect(executed).toBe(false);
		const diagnostics = store.getRunDiagnostics("00000000-0000-4000-8000-000000000002");
		expect(diagnostics?.steps.at(-1)?.inputPreview).toContain("[redacted]");
		expect(diagnostics?.steps.at(-1)?.inputPreview).not.toContain("secret-value");
	});
});
