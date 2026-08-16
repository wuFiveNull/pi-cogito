import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	getCurrentRuntimeSnapshot,
	RuntimeReplayJournal,
	RuntimeSnapshotFenceError,
	RuntimeSnapshotStore,
	withRuntimeSnapshot,
} from "../src/ext/snapshot.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "proactive-snapshot-"));
	tempDirs.push(dir);
	return dir;
}

describe("RuntimeSnapshotStore", () => {
	it("binds the leased snapshot and drains the retired resource after release", async () => {
		const stopped: string[] = [];
		const store = new RuntimeSnapshotStore<{ id: string; stop(): void }>();
		const first = store.install({ id: "v1", stop: () => stopped.push("v1") });
		const lease = await store.acquire();

		await withRuntimeSnapshot(lease, async () => {
			expect(getCurrentRuntimeSnapshot()?.snapshotId).toBe(first.snapshotId);
			const transaction = store.beginPublish({ id: "v2", stop: () => stopped.push("v2") }, "v2");
			await store.commit(transaction);
			expect(store.current?.snapshotId).toBe("v2");
			expect(stopped).toEqual([]);
			await expect(store.acquire(first.snapshotId)).rejects.toThrow(RuntimeSnapshotFenceError);
		});

		await lease.release();
		await store.waitForDrain(first);
		expect(stopped).toEqual(["v1"]);
		await store.close();
		expect(stopped).toEqual(["v1", "v2"]);
	});

	it("aborts a candidate and fences released leases", async () => {
		const stopped: string[] = [];
		const store = new RuntimeSnapshotStore<{ id: string; stop(): void }>();
		store.install({ id: "v1", stop: () => stopped.push("v1") });
		const transaction = store.beginPublish({ id: "candidate", stop: () => stopped.push("candidate") }, "candidate");
		await store.abort(transaction);
		expect(transaction.candidate.state).toBe("aborted");
		expect(stopped).toEqual(["candidate"]);

		const lease = store.lease();
		await lease.release();
		expect(() => lease.assertActive()).toThrow(RuntimeSnapshotFenceError);
		await store.close();
	});

	it("persists a replay journal for publication and lease transitions", async () => {
		const journalPath = join(makeDir(), "runtime.jsonl");
		const journal = new RuntimeReplayJournal(journalPath);
		const store = new RuntimeSnapshotStore<{ stop(): void }>({ journal });
		store.install({ stop: () => {} });
		const lease = store.lease();
		await lease.release();
		await store.close();

		const events = journal.list(100).map((event) => event.type);
		expect(events).toEqual([
			"snapshot_installed",
			"lease_acquired",
			"lease_released",
			"snapshot_paused",
			"snapshot_drained",
		]);
	});
});
