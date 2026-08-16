import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DriftStateStore } from "../src/state.ts";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeStore(): DriftStateStore {
	const root = mkdtempSync(join(tmpdir(), "drift-retention-"));
	roots.push(root);
	return new DriftStateStore({ driftDir: root });
}

function saveRun(store: DriftStateStore, runId: string, at: string, messageResult: string): void {
	const nowUtc = new Date(at);
	store.appendStep({
		runId,
		stepIndex: 1,
		toolName: "read_file",
		inputPreview: "{}",
		outputPreview: "ok",
		nowUtc,
	});
	store.saveFinish({
		runId,
		sessionKey: "local",
		skillUsed: "skill-a",
		status: "completed",
		briefing: runId,
		messageResult,
		messageHash: messageResult === "staged" ? `hash:${runId}` : undefined,
		message: messageResult === "staged" ? "pending" : "",
		journalAppend: [{ entry_type: "fact", key: runId, payload: { runId } }],
		nowUtc,
	});
}

describe("Drift history retention", () => {
	it("removes old terminal runs while preserving staged deliveries", () => {
		const store = makeStore();
		try {
			saveRun(store, "old", "2026-05-01T00:00:00.000Z", "silent");
			saveRun(store, "recent", "2026-05-10T00:00:00.000Z", "silent");
			saveRun(store, "staged", "2026-05-01T00:00:00.000Z", "staged");

			const result = store.pruneHistory({
				maxAgeDays: 7,
				nowUtc: new Date("2026-05-11T00:00:00.000Z"),
			});
			expect(result).toMatchObject({ runsDeleted: 1, runStepsDeleted: 1, journalEntriesDeleted: 1 });
			expect(store.getRunDiagnostics("old")).toBeNull();
			expect(store.getRunDiagnostics("recent")).toMatchObject({ run: { run_id: "recent" } });
			expect(store.listStagedDeliveries()).toMatchObject([{ runId: "staged" }]);
		} finally {
			store.close();
		}
	});

	it("keeps only the newest terminal runs for a count policy", () => {
		const store = makeStore();
		try {
			saveRun(store, "first", "2026-05-01T00:00:00.000Z", "silent");
			saveRun(store, "second", "2026-05-02T00:00:00.000Z", "silent");
			saveRun(store, "staged", "2026-05-03T00:00:00.000Z", "staged");

			const result = store.pruneHistory({ maxRuns: 1, nowUtc: new Date("2026-05-04T00:00:00.000Z") });
			expect(result.runsDeleted).toBe(1);
			expect(store.getRunDiagnostics("first")).toBeNull();
			expect(store.getRunDiagnostics("second")).toMatchObject({ run: { run_id: "second" } });
			expect(store.listStagedDeliveries()).toHaveLength(1);
		} finally {
			store.close();
		}
	});
});
