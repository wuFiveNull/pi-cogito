/**
 * Phase 2 — 插件注册表与目录插件加载(ext/plugin.ts + registry.ts)。
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProactiveLifecycleSpec } from "../src/ext/lifecycle.ts";
import { isProactivePlugin, PluginRegistry, sourceAsPlugin } from "../src/ext/plugin.ts";
import { loadPlugins, loadSources } from "../src/registry.ts";
import type { ProactiveSource } from "../src/types.ts";

const tempDirs: string[] = [];

function makeDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "proactive-plugins-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeSource(id: string): ProactiveSource {
	return {
		id,
		label: id,
		async fetch() {
			return [];
		},
	};
}

describe("PluginRegistry", () => {
	it("registers plugins and collects contributions", () => {
		const registry = new PluginRegistry();
		registry.register({
			name: "p1",
			proactiveSources: () => [makeSource("a")],
			proactiveLifecycles: () => [new ProactiveLifecycleSpec("default")],
		});
		registry.register({
			name: "p2",
			proactiveSources: () => [makeSource("b")],
		});
		expect(registry.list()).toHaveLength(2);
		expect(registry.collectSources().map((s) => s.id)).toEqual(["a", "b"]);
		expect(registry.collectLifecycles().map((l) => l.id)).toEqual(["default"]);
	});

	it("collects and deduplicates Drift skill roots", () => {
		const registry = new PluginRegistry();
		registry.register({ name: "p1", proactiveDriftSkillRoots: () => ["/tmp/skills-a", "/tmp/skills-b"] });
		registry.register({ name: "p2", proactiveDriftSkillRoots: () => ["/tmp/skills-b", "/tmp/skills-c"] });
		expect(registry.collectDriftSkillRoots()).toEqual(["/tmp/skills-a", "/tmp/skills-b", "/tmp/skills-c"]);
	});

	it("deduplicates by name and by contribution id (first wins)", () => {
		const registry = new PluginRegistry();
		registry.register({ name: "same", proactiveSources: () => [makeSource("a")] });
		registry.register({ name: "same", proactiveSources: () => [makeSource("b")] });
		registry.register({ name: "p2", proactiveSources: () => [makeSource("a")] });
		expect(registry.list()).toHaveLength(2);
		expect(registry.collectSources().map((s) => s.id)).toEqual(["a"]);
	});

	it("keeps duplicate local source ids distinct in plugin registrations", () => {
		const registry = new PluginRegistry();
		registry.register({ name: "p1", proactiveSources: () => [makeSource("feed")] });
		registry.register({ name: "p2", proactiveSources: () => [makeSource("feed")] });

		expect(registry.collectSourceRegistrations().map((entry) => entry.sourceKey)).toEqual(["p1:feed", "p2:feed"]);
	});

	it("sourceAsPlugin wraps a legacy source", () => {
		const plugin = sourceAsPlugin(makeSource("legacy"));
		expect(isProactivePlugin(plugin)).toBe(true);
		expect(plugin.proactiveSources?.().map((s) => s.id)).toEqual(["legacy"]);
	});
});

describe("loadPlugins", () => {
	it("loads a plugin from a named `plugin` export", async () => {
		const dir = makeDir();
		writeFileSync(
			join(dir, "my-plugin.ts"),
			`export const plugin = {
  name: "my-plugin",
  proactiveSources: () => [
    { id: "from-plugin", label: "From Plugin", fetch: async () => [{ source: "x", title: "t" }] },
  ],
};`,
			"utf-8",
		);
		const loaded = await loadPlugins(dir);
		expect(loaded).toHaveLength(1);
		expect(loaded[0].plugin.name).toBe("my-plugin");
		expect(loaded[0].path).toContain("my-plugin.ts");
		expect(loaded[0].plugin.proactiveSources?.().map((s) => s.id)).toEqual(["from-plugin"]);
	});

	it("loads a plugin class from the default export", async () => {
		const dir = makeDir();
		writeFileSync(
			join(dir, "class-plugin.ts"),
			`export default class MyPlugin {
  name = "class-plugin";
  proactiveSources() {
    return [{ id: "class-src", label: "Class", fetch: async () => [] }];
  }
}`,
			"utf-8",
		);
		const loaded = await loadPlugins(dir);
		expect(loaded).toHaveLength(1);
		expect(loaded[0].plugin.name).toBe("class-plugin");
	});

	it("loadSources collects sources contributed by plugins", async () => {
		const dir = makeDir();
		writeFileSync(
			join(dir, "multi.ts"),
			`export default {
  name: "multi",
  proactiveSources: () => [
    { id: "one", label: "One", fetch: async () => [] },
    { id: "two", label: "Two", fetch: async () => [] },
  ],
};`,
			"utf-8",
		);
		const sources = await loadSources(dir);
		expect(sources.size).toBe(2);
		expect([...sources.keys()].sort()).toEqual(["one", "two"]);
	});

	it("keeps loading other plugins when one module throws", async () => {
		const dir = makeDir();
		writeFileSync(join(dir, "broken.ts"), `throw new Error("boom");`, "utf-8");
		writeFileSync(
			join(dir, "fine.ts"),
			`export const plugin = {
  name: "fine",
  proactiveSources: () => [{ id: "fine", label: "Fine", fetch: async () => [] }],
};`,
			"utf-8",
		);
		const loaded = await loadPlugins(dir);
		expect(loaded).toHaveLength(1);
		expect(loaded[0].plugin.name).toBe("fine");
	});
});
