import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProactiveRules } from "../src/rules.ts";
import { validateSourceBatch } from "../src/source-contract.ts";
import { ProactiveStore } from "../src/store.ts";
import type { ProactiveSource } from "../src/types.ts";
import { buildWakeRuntimeDeps } from "../src/wake/index.ts";

const tempDirs: string[] = [];
const fixedClock = {
	now: () => new Date("2026-08-13T00:00:00.000Z"),
	nowMs: () => Date.parse("2026-08-13T00:00:00.000Z"),
};

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("source contract", () => {
	it("quarantines invalid strict items while retaining valid items", () => {
		const result = validateSourceBatch(
			{ id: "feed", channels: ["content"] },
			[
				{ eventId: "valid-1", title: "valid", preprocessScore: 0.4, publishedAt: "2026-08-12T23:00:00Z" },
				{ title: "missing identity" },
				{ eventId: "bad-score", title: "bad score", preprocessScore: 2 },
			],
			fixedClock.now(),
		);

		expect(result.events).toHaveLength(1);
		expect(result.events[0]).toMatchObject({
			kind: "content",
			eventId: "valid-1",
			ackSourceId: "feed",
			preprocessScore: 0.4,
		});
		expect(result.quarantined).toHaveLength(2);
		expect(result.quarantined.map((item) => item.itemId)).toEqual(["index:1", "bad-score"]);
		expect(result.quarantined[0]?.reason).toContain("event_id/id");
		expect(result.quarantined[1]?.reason).toContain("[0,1]");
	});

	it("gives legacy sources a deterministic identity scoped to the source", () => {
		const item = { source: "feed", title: "legacy item", url: "https://example.test/1" };
		const first = validateSourceBatch({ id: "source-a" }, [item], fixedClock.now());
		const second = validateSourceBatch({ id: "source-a" }, [item], fixedClock.now());
		const otherSource = validateSourceBatch({ id: "source-b" }, [item], fixedClock.now());

		expect(first.syntheticIdentityCount).toBe(1);
		expect(first.events[0]?.eventId).toBe(second.events[0]?.eventId);
		expect(first.events[0]?.eventId).not.toBe(otherSource.events[0]?.eventId);
	});

	it("persists one bad wake item and keeps the valid batch item", async () => {
		const dir = mkdtempSync(join(tmpdir(), "proactive-source-contract-"));
		tempDirs.push(dir);
		const store = new ProactiveStore(join(dir, "proactive.sqlite"), fixedClock);
		const source: ProactiveSource = {
			id: "strict-feed",
			label: "Strict feed",
			channels: ["content"],
			fetch: async () => [{ eventId: "valid", title: "valid" }, { title: "quarantined" }],
		};
		const deps = buildWakeRuntimeDeps({
			sources: new Map([[source.id, source]]),
			sourceConfigs: {},
			dbPath: join(dir, "proactive.sqlite"),
			sessionsDir: dir,
			rules: new ProactiveRules(join(dir, "PROACTIVE_CONTEXT.md")),
			store,
			llm: { model: "test", apiBaseUrl: "http://localhost", apiKey: "test" },
			clock: fixedClock,
		});

		try {
			const channels = await deps.fetchChannels();
			expect(channels.content).toHaveLength(1);
			expect(channels.content[0]?.eventId).toBe("valid");
			// fetch 阶段写入的隔离区 commit:false 延后,随批量 ingest 事务一起落库
			// (akashic record_quarantine(commit=False) 语义)。
			expect(deps.stateStore.quarantined()).toHaveLength(0);
			deps.stateStore.ingestWithIds("content", channels.content, fixedClock.now());
			expect(deps.stateStore.quarantined()).toHaveLength(1);
			expect(JSON.parse(store.getState("health.source.strict-feed") ?? "{}")).toMatchObject({
				status: "degraded",
				received: 2,
				accepted: 1,
				quarantined: 1,
			});
		} finally {
			deps.stateStore.close();
			store.close();
		}
	});

	it("raises when every enabled source fetch fails", async () => {
		const dir = mkdtempSync(join(tmpdir(), "proactive-source-failure-"));
		tempDirs.push(dir);
		const store = new ProactiveStore(join(dir, "proactive.sqlite"), fixedClock);
		const sources: ProactiveSource[] = ["a", "b"].map((id) => ({
			id,
			label: id,
			channels: ["content"],
			fetch: async () => {
				throw new Error(`${id} unavailable`);
			},
		}));
		const deps = buildWakeRuntimeDeps({
			sources: new Map(sources.map((source) => [source.id, source])),
			sourceConfigs: {},
			dbPath: join(dir, "proactive.sqlite"),
			sessionsDir: dir,
			rules: new ProactiveRules(join(dir, "PROACTIVE_CONTEXT.md")),
			store,
			llm: { model: "test", apiBaseUrl: "http://localhost", apiKey: "test" },
			clock: fixedClock,
		});

		try {
			await expect(deps.fetchChannels()).rejects.toThrow(/all proactive sources failed/);
		} finally {
			deps.stateStore.close();
			store.close();
		}
	});

	it("accepts a context dictionary from a context source", async () => {
		const dir = mkdtempSync(join(tmpdir(), "proactive-context-source-"));
		tempDirs.push(dir);
		const store = new ProactiveStore(join(dir, "proactive.sqlite"), fixedClock);
		const source: ProactiveSource = {
			id: "context-feed",
			label: "Context feed",
			channels: ["context"],
			fetch: async () => ({ _source: "context-feed", available: true, observedAt: "2026-08-13T00:00:00Z" }),
		};
		const deps = buildWakeRuntimeDeps({
			sources: new Map([[source.id, source]]),
			sourceConfigs: {},
			dbPath: join(dir, "proactive.sqlite"),
			sessionsDir: dir,
			rules: new ProactiveRules(join(dir, "PROACTIVE_CONTEXT.md")),
			store,
			llm: { model: "test", apiBaseUrl: "http://localhost", apiKey: "test" },
			clock: fixedClock,
		});

		try {
			const channels = await deps.fetchChannels();
			expect(channels.alert).toHaveLength(0);
			expect(channels.content).toHaveLength(0);
			expect(channels.context).toMatchObject([{ kind: "context", sourceId: "context-feed" }]);
		} finally {
			deps.stateStore.close();
			store.close();
		}
	});
});
