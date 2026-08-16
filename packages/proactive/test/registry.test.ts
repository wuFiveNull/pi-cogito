import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadSources } from "../src/registry.ts";

const tempDirs: string[] = [];

function makeSourcesDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "proactive-sources-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("loadSources", () => {
	it("discovers class-based sources from a directory", async () => {
		const dir = makeSourcesDir();
		writeFileSync(
			join(dir, "good-source.ts"),
			`export default class GoodSource {
  id = "good";
  label = "Good Source";
  defaultIntervalMs = 60000;
  async fetch() {
    return [{ source: "good", title: "item" }];
  }
}`,
			"utf-8",
		);

		const sources = await loadSources(dir);
		expect(sources.size).toBe(1);
		const loaded = sources.get("good")!;
		expect(loaded.source.id).toBe("good");
		expect(loaded.source.defaultIntervalMs).toBe(60000);
		expect(await loaded.source.fetch({})).toEqual([{ source: "good", title: "item" }]);
		expect(loaded.path).toContain("good-source.ts");
	});

	it("supports factory function default exports", async () => {
		const dir = makeSourcesDir();
		writeFileSync(
			join(dir, "factory.ts"),
			`export default function createFactorySource() {
  return {
    id: "factory",
    label: "Factory Source",
    async fetch() {
      return [];
    },
  };
}`,
			"utf-8",
		);

		const sources = await loadSources(dir);
		expect(sources.size).toBe(1);
		expect(sources.get("factory")?.source.id).toBe("factory");
	});

	it("skips modules without a valid source shape", async () => {
		const dir = makeSourcesDir();
		writeFileSync(join(dir, "not-a-source.ts"), `export default "just a string";`, "utf-8");
		writeFileSync(
			join(dir, "incomplete.ts"),
			`export default class Incomplete {
  id = "incomplete";
}`,
			"utf-8",
		);

		const sources = await loadSources(dir);
		expect(sources.size).toBe(0);
	});

	it("keeps loading other sources when one module throws at load time", async () => {
		const dir = makeSourcesDir();
		writeFileSync(join(dir, "broken.ts"), `throw new Error("module load failure");`, "utf-8");
		writeFileSync(
			join(dir, "fine.ts"),
			`export default class Fine {
  id = "fine";
  label = "Fine";
  async fetch() {
    return [];
  }
}`,
			"utf-8",
		);

		const sources = await loadSources(dir);
		expect(sources.size).toBe(1);
		expect(sources.get("fine")).toBeDefined();
	});

	it("returns an empty map for a missing directory", async () => {
		const sources = await loadSources(join(tmpdir(), `definitely-missing-${Date.now()}`));
		expect(sources.size).toBe(0);
	});
});
