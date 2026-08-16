import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DriftRunAlreadyActiveError, DriftStateStore } from "../src/state.ts";

const tempDirs: string[] = [];
const stores: DriftStateStore[] = [];

afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeStore(): { dir: string; store: DriftStateStore } {
	const dir = mkdtempSync(join(tmpdir(), "drift-reliability-"));
	mkdirSync(join(dir, "skills", "skill-a"), { recursive: true });
	writeFileSync(
		join(dir, "skills", "skill-a", "SKILL.md"),
		"---\nname: skill-a\ndescription: test skill\n---\n",
		"utf-8",
	);
	tempDirs.push(dir);
	const store = new DriftStateStore({ driftDir: dir });
	stores.push(store);
	return { dir, store };
}

describe("Drift durable run lifecycle", () => {
	it("allows only one active run per session", () => {
		const { store } = makeStore();
		const now = new Date("2026-05-01T00:00:00.000Z");
		store.startRun({ runId: "run-1", sessionKey: "local", nowUtc: now });

		expect(() => store.startRun({ runId: "run-2", sessionKey: "local", nowUtc: now })).toThrow(
			DriftRunAlreadyActiveError,
		);

		store.saveFinish({
			runId: "run-1",
			sessionKey: "local",
			skillUsed: "skill-a",
			status: "completed",
			briefing: "closed",
			messageResult: "silent",
			nowUtc: now,
			selfUpdate: { next_tendency: "next" },
		});
		store.startRun({ runId: "run-2", sessionKey: "local", nowUtc: new Date(now.getTime() + 1) });
	});

	it("recovers an abandoned staged run with its delivery payload", () => {
		const { store } = makeStore();
		const startedAt = new Date("2026-05-01T00:00:00.000Z");
		store.startRun({ runId: "run-crashed", sessionKey: "local", nowUtc: startedAt });
		store.updateRunProgress({
			runId: "run-crashed",
			stage: "message_staged",
			nowUtc: startedAt,
			skillName: "skill-a",
			messageHash: "hash-1",
			message: "recover me",
			media: ["/tmp/a.png"],
			targetChannel: "feishu",
			targetChatId: "chat-1",
		});

		const recovered = store.recoverAbandonedRuns({
			nowUtc: new Date("2026-05-01T02:00:00.000Z"),
			staleAfterMs: 60_000,
		});
		expect(recovered).toBe(1);
		expect(store.listStagedDeliveries()).toMatchObject([
			{
				runId: "run-crashed",
				sessionKey: "local",
				skillName: "skill-a",
				message: "recover me",
				messageHash: "hash-1",
				media: ["/tmp/a.png"],
				targetChannel: "feishu",
				targetChatId: "chat-1",
			},
		]);
		expect(store.loadSkillContinuum("skill-a").lastStatus).toBe("paused");
	});

	it("makes finish idempotent for a durable run id", () => {
		const { store } = makeStore();
		const now = new Date("2026-05-01T00:00:00.000Z");
		store.startRun({ runId: "run-once", sessionKey: "local", nowUtc: now });
		const finish = {
			runId: "run-once",
			sessionKey: "local",
			skillUsed: "skill-a",
			status: "completed",
			briefing: "staged",
			messageResult: "staged",
			nowUtc: now,
			messageHash: "hash-once",
			message: "once",
			selfUpdate: { next_tendency: "next" },
		};
		store.saveFinish(finish);
		store.saveFinish(finish);

		expect(store.loadSkillContinuum("skill-a").runCount).toBe(1);
		expect(store.listStagedDeliveries()).toHaveLength(1);
	});

	it("exposes active and historical run diagnostics with step audit", () => {
		const { store } = makeStore();
		const now = new Date("2026-05-01T00:00:00.000Z");
		store.startRun({ runId: "run-diagnostics", sessionKey: "local", nowUtc: now });
		store.updateRunProgress({
			runId: "run-diagnostics",
			stage: "executing",
			nowUtc: now,
			skillName: "skill-a",
		});
		store.appendStep({
			runId: "run-diagnostics",
			stepIndex: 1,
			toolName: "read_file",
			inputPreview: "{}",
			outputPreview: "ok",
			nowUtc: now,
		});

		expect(store.listActiveRuns()).toMatchObject([{ runId: "run-diagnostics", stage: "executing" }]);
		expect(store.getRunDiagnostics("run-diagnostics")).toMatchObject({
			active: { runId: "run-diagnostics", skillName: "skill-a" },
			steps: [{ toolName: "read_file", runKey: "run-diagnostics" }],
		});

		store.saveFinish({
			runId: "run-diagnostics",
			sessionKey: "local",
			skillUsed: "skill-a",
			status: "completed",
			briefing: "closed",
			messageResult: "silent",
			nowUtc: now,
			selfUpdate: { next_tendency: "next" },
		});
		expect(store.getRunDiagnostics("run-diagnostics")).toMatchObject({
			run: { run_id: "run-diagnostics" },
			active: null,
			steps: [{ runId: expect.any(Number), runKey: "run-diagnostics" }],
		});
	});
});
