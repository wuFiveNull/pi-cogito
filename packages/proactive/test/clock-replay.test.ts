import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ReplayClock, replayRandom } from "../src/clock.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("ReplayClock", () => {
	it("persists and advances simulated time", () => {
		const dir = mkdtempSync(join(tmpdir(), "proactive-clock-"));
		tempDirs.push(dir);
		const path = join(dir, "clock.json");
		const clock = new ReplayClock(path, new Date("2026-01-02T03:04:00.000Z"));
		expect(clock.now().toISOString()).toBe("2026-01-02T03:04:00.000Z");
		expect(clock.advance(30 * 60_000).toISOString()).toBe("2026-01-02T03:34:00.000Z");
		expect(new ReplayClock(path).now().toISOString()).toBe("2026-01-02T03:34:00.000Z");
	});

	it("produces a repeatable random sequence for a simulated clock", () => {
		const dir = mkdtempSync(join(tmpdir(), "proactive-clock-random-"));
		tempDirs.push(dir);
		const path = join(dir, "clock.json");
		const first = new ReplayClock(path, new Date("2026-01-02T03:04:00.000Z"));
		const second = new ReplayClock(path);
		const left = replayRandom(first, "test");
		const right = replayRandom(second, "test");
		expect([left(), left(), left()]).toEqual([right(), right(), right()]);
	});
});
