/**
 * Phase 3 — drift 一次性到期采样(akashic wake _drift_timer_anchor +
 * sample_drift_delay_hours 接线)。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkDriftTimer } from "../src/daemon.ts";
import { DriftStateStore } from "../src/state.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeStore(): DriftStateStore {
	const driftDir = mkdtempSync(join(tmpdir(), "drift-timer-"));
	tempDirs.push(driftDir);
	return new DriftStateStore({ driftDir });
}

const BASE = new Date("2026-05-01T00:00:00Z");

function anchorOf(lastUserAt: Date | null, lastDriftAt: Date | null, repetition: number): string {
	return [
		lastUserAt !== null ? lastUserAt.toISOString() : "none",
		lastDriftAt !== null ? lastDriftAt.toISOString() : "none",
		repetition.toFixed(6),
	].join("|");
}

describe("drift 一次性到期采样 (checkDriftTimer)", () => {
	it("samples and persists on first sight; reuses the stored expiry on later ticks", () => {
		const store = makeStore();
		const input = {
			now: BASE,
			anchor: anchorOf(null, null, 0),
			lastUserAt: null,
			lastDriftAt: null,
			repetition: 0,
		};
		const first = checkDriftTimer(store, "local", input);
		expect(first.resampled).toBe(true);
		expect(first.nextAttemptAt.getTime()).toBeGreaterThan(BASE.getTime());
		expect(first.due).toBe(false);

		// 同一 anchor 的后续 tick:不重采样,复用持久化时刻。
		const later = new Date(BASE.getTime() + 60_000);
		const second = checkDriftTimer(store, "local", { ...input, now: later });
		expect(second.resampled).toBe(false);
		expect(second.nextAttemptAt.getTime()).toBe(first.nextAttemptAt.getTime());
		expect(second.due).toBe(false);
	});

	it("becomes due when now passes the sampled expiry", () => {
		const store = makeStore();
		const input = {
			now: BASE,
			anchor: anchorOf(null, null, 0),
			lastUserAt: null,
			lastDriftAt: null,
			repetition: 0,
		};
		const first = checkDriftTimer(store, "local", input);
		const after = new Date(first.nextAttemptAt.getTime() + 1000);
		const due = checkDriftTimer(store, "local", { ...input, now: after });
		expect(due.due).toBe(true);
	});

	it("re-samples when the activity anchor changes (user activity / drift run / repetition)", () => {
		const store = makeStore();
		const lastUserAt = new Date("2026-04-30T10:00:00Z");
		const input = {
			now: BASE,
			anchor: anchorOf(lastUserAt, null, 0),
			lastUserAt,
			lastDriftAt: null,
			repetition: 0,
		};
		const first = checkDriftTimer(store, "local", input);

		// 用户活动变化 → anchor 变化 → 重新采样。
		const newerUser = new Date("2026-04-30T12:00:00Z");
		const resampled = checkDriftTimer(store, "local", {
			now: BASE,
			anchor: anchorOf(newerUser, null, 0),
			lastUserAt: newerUser,
			lastDriftAt: null,
			repetition: 0,
		});
		expect(resampled.resampled).toBe(true);
		expect(resampled.nextAttemptAt.getTime()).not.toBe(first.nextAttemptAt.getTime());

		// 重复抑制(repetition)变化 → 重新采样。
		const repeated = checkDriftTimer(store, "local", {
			now: BASE,
			anchor: anchorOf(newerUser, null, 1),
			lastUserAt: newerUser,
			lastDriftAt: null,
			repetition: 1,
		});
		expect(repeated.resampled).toBe(true);
	});

	it("persists across store reopen (重启恢复)", () => {
		const driftDir = mkdtempSync(join(tmpdir(), "drift-timer-"));
		tempDirs.push(driftDir);
		const store = new DriftStateStore({ driftDir });
		const input = {
			now: BASE,
			anchor: anchorOf(null, null, 0),
			lastUserAt: null,
			lastDriftAt: null,
			repetition: 0,
		};
		const first = checkDriftTimer(store, "local", input);
		store.close();

		const reopened = new DriftStateStore({ driftDir });
		const second = checkDriftTimer(reopened, "local", { ...input, now: new Date(BASE.getTime() + 60_000) });
		expect(second.resampled).toBe(false);
		expect(second.nextAttemptAt.getTime()).toBe(first.nextAttemptAt.getTime());
		reopened.close();
	});
});
