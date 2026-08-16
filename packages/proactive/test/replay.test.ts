import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ReplayClock } from "../src/clock.ts";
import {
	HistoricalTickReplayRunner,
	normalizeHistoricalReplayEvent,
	readHistoricalReplayEvents,
} from "../src/replay.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "proactive-replay-"));
	tempDirs.push(dir);
	return dir;
}

describe("historical proactive tick replay", () => {
	it("advances the replay clock, batches due events, and writes per-tick audit", async () => {
		const dir = makeDir();
		const clock = new ReplayClock(join(dir, "clock.json"), new Date("2026-01-01T00:00:00Z"));
		const reportPath = join(dir, "replay.jsonl");
		const events = [
			normalizeHistoricalReplayEvent({
				event_id: "b",
				source_id: "feed",
				available_at: "2026-01-01T00:02:00Z",
				title: "later",
			}),
			normalizeHistoricalReplayEvent({
				event_id: "a",
				source_id: "feed",
				available_at: "2026-01-01T00:01:00Z",
				title: "first",
			}),
			normalizeHistoricalReplayEvent({
				event_id: "c",
				source_id: "feed",
				available_at: "2026-01-01T00:02:00Z",
				title: "same tick",
			}),
		];
		const batches: string[][] = [];
		const ticks: string[] = [];
		const runner = new HistoricalTickReplayRunner({
			clock,
			events,
			reportPath,
			ingest: (batch) => {
				batches.push(batch.map((event) => event.eventId));
				return { received: batch.length, inserted: batch.length, duplicates: 0, quarantined: 0 };
			},
			executeTick: (context) => {
				ticks.push(`${context.tickIndex}:${context.now.toISOString()}`);
				return { action: context.events.length > 0 ? "send" : "none" };
			},
		});

		const report = await runner.run();
		expect(batches).toEqual([["a"], ["b", "c"]]);
		expect(ticks).toEqual(["0:2026-01-01T00:01:00.000Z", "1:2026-01-01T00:02:00.000Z"]);
		expect(report.failedTickCount).toBe(0);
		expect(report.tickCount).toBe(2);
		expect(clock.now().toISOString()).toBe("2026-01-01T00:02:00.000Z");
		expect(readFileSync(reportPath, "utf-8").trim().split("\n")).toHaveLength(2);
	});

	it("supports fixed historical ticks and keeps failures auditable", async () => {
		const dir = makeDir();
		const eventsPath = join(dir, "events.jsonl");
		writeFileSync(
			eventsPath,
			`${JSON.stringify({ event_id: "one", source_id: "feed", available_at: "2026-01-01T00:01:00Z" })}\n`,
		);
		const clock = new ReplayClock(join(dir, "clock.json"), new Date("2026-01-01T00:00:00Z"));
		const report = await new HistoricalTickReplayRunner({
			clock,
			eventsPath,
			startAt: new Date("2026-01-01T00:00:00Z"),
			endAt: new Date("2026-01-01T00:02:00Z"),
			tickEveryMs: 60_000,
			includeEmptyTicks: true,
			executeTick: (context) => {
				if (context.tickIndex === 1) throw new Error("replay tick failed");
				return undefined;
			},
		}).run();
		expect(readHistoricalReplayEvents(eventsPath)).toHaveLength(1);
		expect(report.tickCount).toBe(3);
		expect(report.failedTickCount).toBe(1);
		expect(report.ticks[1]?.error).toBe("replay tick failed");
	});
});
