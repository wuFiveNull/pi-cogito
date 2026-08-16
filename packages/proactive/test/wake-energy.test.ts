import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Clock } from "../src/clock.ts";
import { TickScheduler } from "../src/stages/schedule.ts";
import { WakeRuntime, type WakeRuntimeDeps } from "../src/wake/runtime.ts";
import { WakeStateStore } from "../src/wake/state.ts";

const FIXED_NOW_MS = Date.parse("2026-01-01T01:00:00Z");

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeState(): WakeStateStore {
	const dir = mkdtempSync(join(tmpdir(), "wake-energy-"));
	tempDirs.push(dir);
	return new WakeStateStore(join(dir, "wake_proactive.db"));
}

function makeDeps(overrides: Partial<WakeRuntimeDeps> = {}): WakeRuntimeDeps {
	return {
		sessionKey: "local",
		stateStore: makeState(),
		fetchChannels: async () => ({ alert: [], content: [], context: [] }),
		chat: vi.fn(async () => ({ content: null, toolCalls: [] })),
		model: "m",
		maxTokens: 1024,
		lastUserAt: () => null,
		recentPassiveConversation: () => "",
		recentProactiveMessages: () => "",
		readRules: () => "",
		readMemory: () => "",
		deliver: vi.fn(async () => true),
		webFetchFn: async () => ({ text: "x" }),
		rng: () => 0.001,
		tickIntervalSeconds: 300,
		nowFn: () => new Date(FIXED_NOW_MS),
		...overrides,
	};
}

function scheduler(overrides: Record<string, unknown> = {}) {
	return new TickScheduler(
		{
			tickS1: 30,
			tickS0: 4800,
			tickJitter: 0,
			scoreWeightEnergy: 0.35,
			fallbackIntervalSeconds: 90,
			...overrides,
		},
		{ nowMs: () => FIXED_NOW_MS } as Clock,
	);
}

describe("WakeRuntime energy scheduling (akashic energy.py)", () => {
	it("falls back to the fixed interval without a tickScheduler", async () => {
		const runtime = new WakeRuntime(makeDeps({ tickIntervalSeconds: 300 }));
		const result = await runtime.runTick();
		expect(result.nextIntervalSeconds).toBe(300);
		runtime.close();
	});

	it("uses fallbackIntervalSeconds when presence is unknown", async () => {
		const runtime = new WakeRuntime(makeDeps({ tickScheduler: scheduler() }));
		const result = await runtime.runTick();
		expect(result.nextIntervalSeconds).toBe(90);
		runtime.close();
	});

	it("waits long (tickS0) right after a user interaction (high energy)", async () => {
		const runtime = new WakeRuntime(
			makeDeps({
				tickScheduler: scheduler(),
				lastUserAt: () => FIXED_NOW_MS,
			}),
		);
		const result = await runtime.runTick();
		expect(result.nextIntervalSeconds).toBe(4800);
		runtime.close();
	});

	it("ticks eagerly (tickS1) after long silence (energy decayed)", async () => {
		const lastUserAt = FIXED_NOW_MS - 3 * 24 * 3600_000;
		const runtime = new WakeRuntime(
			makeDeps({
				tickScheduler: scheduler(),
				lastUserAt: () => lastUserAt,
			}),
		);
		const result = await runtime.runTick();
		expect(result.nextIntervalSeconds).toBe(30);
		runtime.close();
	});

	it("keeps 1s interval while multiple alerts are pending", async () => {
		const state = makeState();
		const runtime = new WakeRuntime(
			makeDeps({
				stateStore: state,
				tickScheduler: scheduler(),
				chat: vi.fn(async () => ({
					content: null,
					toolCalls: [{ name: "send_event", arguments: { message: "alert!" } }],
				})),
				fetchChannels: async () => ({
					alert: [
						{
							kind: "alert",
							sourceId: "a",
							source: "a",
							ackSourceId: "a",
							eventId: "1",
							id: "a:1",
							item_id: "a:1",
							publishedAt: "2026-01-01T00:00:00Z",
							preprocessScore: 1,
							title: "A1",
							url: "https://x/1",
						},
						{
							kind: "alert",
							sourceId: "a",
							source: "a",
							ackSourceId: "a",
							eventId: "2",
							id: "a:2",
							item_id: "a:2",
							publishedAt: "2026-01-01T00:00:00Z",
							preprocessScore: 1,
							title: "A2",
							url: "https://x/2",
						},
					],
					content: [],
					context: [],
				}),
			}),
		);
		const result = await runtime.runTick();
		expect(result.nextIntervalSeconds).toBe(1);
		runtime.close();
	});
});
