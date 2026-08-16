import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Pipeline } from "../src/stages/fetch-pipeline.ts";
import { ProactiveStore } from "../src/store.ts";

const tempDirs: string[] = [];
const stores: ProactiveStore[] = [];

function makeStore(): ProactiveStore {
	const dir = mkdtempSync(join(tmpdir(), "proactive-store-"));
	tempDirs.push(dir);
	const store = new ProactiveStore(join(dir, "proactive.sqlite"));
	stores.push(store);
	return store;
}

afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Pipeline", () => {
	it("ingests items and dedupes by title", async () => {
		const store = makeStore();
		const pipeline = new Pipeline(store);

		const stats = await pipeline.ingest("dailyhot", [
			{ source: "weibo", title: "记忆系统新方案", url: "https://a/1" },
			{ source: "weibo", title: "记忆系统新方案", url: "https://a/1" }, // duplicate
			{ source: "zhihu", title: "普通话题", url: "https://a/2" },
		]);

		expect(stats).toEqual({ received: 3, inserted: 2, duplicates: 1, quarantined: 0 });
		const items = store.listNew();
		expect(items.length).toBe(2);
		const titles = items.map((item) => item.title).sort();
		expect(titles).toEqual(["普通话题", "记忆系统新方案"]);
		expect(items.every((item) => item.status === "new")).toBe(true);
	});

	it("marks items pushed and prunes old ones", async () => {
		const store = makeStore();
		const pipeline = new Pipeline(store);

		await pipeline.ingest("rss", [{ source: "feed", title: "文章一" }]);
		const [item] = store.listNew();
		store.markPushed(item!.id, Date.now() - 40 * 24 * 60 * 60 * 1000);
		expect(store.listNew()).toEqual([]);

		expect(store.prune(30)).toBe(1);
		expect(store.listNew()).toEqual([]);
	});

	it("caps items per round and persists state", async () => {
		const store = makeStore();
		const pipeline = new Pipeline(store, { maxItemsPerRound: 2 });
		const items = [1, 2, 3, 4].map((n) => ({ source: "github", title: `issue ${n}` }));
		await pipeline.ingest("agent-reach", items);
		expect(store.listNew(10).length).toBe(2);

		store.setState("lastFetchedAt.dailyhot", "12345");
		expect(store.getState("lastFetchedAt.dailyhot")).toBe("12345");
	});

	it("quarantines invalid items from a strict source before storing candidates", async () => {
		const store = makeStore();
		const pipeline = new Pipeline(store);

		const stats = await pipeline.ingest("strict-feed", [{ eventId: "valid", title: "valid" }, { title: "bad" }], {
			id: "strict-feed",
			channels: ["content"],
		});

		expect(stats).toMatchObject({ received: 2, inserted: 1, duplicates: 0, quarantined: 1 });
		expect(store.listNew().map((item) => item.title)).toEqual(["valid"]);
		expect(store.listSourceQuarantine()).toHaveLength(1);
	});
});
