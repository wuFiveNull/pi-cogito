import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReplayClock } from "../src/clock.ts";
import { ProactiveRules } from "../src/rules.ts";
import { ProactiveStore } from "../src/store.ts";
import { buildWakeRuntimeDeps } from "../src/wake/index.ts";
import { WakeRuntime } from "../src/wake/runtime.ts";
import type { WakeStateStore } from "../src/wake/state.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Wake host runtime ports", () => {
	it("uses host session and memory context providers", async () => {
		const dir = mkdtempSync(join(tmpdir(), "wake-host-ports-"));
		tempDirs.push(dir);
		const store = new ProactiveStore(join(dir, "proactive.sqlite"));
		const beforeTurn = vi.fn();
		const acknowledge = vi.fn(async () => {});
		const deps = buildWakeRuntimeDeps({
			sources: new Map(),
			sourceConfigs: {},
			dbPath: join(dir, "proactive.sqlite"),
			sessionsDir: join(dir, "sessions"),
			rules: new ProactiveRules(join(dir, "PROACTIVE_CONTEXT.md")),
			memoryDbPath: join(dir, "memory.sqlite"),
			store,
			llm: { model: "test", apiBaseUrl: "http://localhost", apiKey: "test" },
			runtimePorts: {
				session: {
					recentMessages: () => [
						{ role: "user", content: "用户刚才说的话" },
						{ role: "assistant", content: "主动消息", proactive: true },
					],
					turnPairs: () => [{ user: "用户兴趣", assistant: "助手回复" }],
					signature: () => "session-signature",
				},
				memory: { memoryText: () => "共享长期记忆", beforeTurn },
				sourceAck: { acknowledge },
			},
		});

		expect(await deps.recentPassiveConversation(new Date())).toContain("用户刚才说的话");
		expect(await deps.recentProactiveMessages(new Date())).toBe("主动消息");
		expect(await deps.readMemory(new Date())).toBe("共享长期记忆");
		expect(await deps.turnPairs?.(new Date())).toEqual([{ user: "用户兴趣", assistant: "助手回复" }]);
		expect(await deps.sessionSignature?.()).toBe("session-signature");
		await deps.beforeTurn?.({ sessionKey: "local", now: new Date() });
		expect(beforeTurn).toHaveBeenCalledTimes(1);
		await deps.acknowledge?.("host-feed", ["event-1"]);
		expect(acknowledge).toHaveBeenCalledWith("host-feed", ["event-1"]);

		const state = deps.stateStore as WakeStateStore;
		state.close();
		store.close();
	});

	it("uses a short default interval for replay clocks", () => {
		const dir = mkdtempSync(join(tmpdir(), "wake-replay-interval-"));
		tempDirs.push(dir);
		const store = new ProactiveStore(join(dir, "proactive.sqlite"));
		const clock = new ReplayClock(join(dir, "clock.json"), new Date("2026-01-01T00:00:00Z"));
		const deps = buildWakeRuntimeDeps({
			sources: new Map(),
			sourceConfigs: {},
			dbPath: join(dir, "proactive.sqlite"),
			sessionsDir: join(dir, "sessions"),
			rules: new ProactiveRules(join(dir, "PROACTIVE_CONTEXT.md")),
			store,
			llm: { model: "test", apiBaseUrl: "http://localhost", apiKey: "test" },
			clock,
		});
		const runtime = new WakeRuntime(deps);
		expect(runtime.begin().nextIntervalSeconds).toBe(1);
		runtime.close();
		store.close();
	});
});
