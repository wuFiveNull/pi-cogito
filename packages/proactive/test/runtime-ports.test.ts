import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mergeRuntimePorts, StandaloneRuntimeAdapter } from "../src/runtime/ports.ts";
import { ProactiveStore } from "../src/store.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("runtime ports", () => {
	it("provides a standalone presence adapter backed by proactive state", () => {
		const dir = mkdtempSync(join(tmpdir(), "proactive-ports-"));
		tempDirs.push(dir);
		const store = new ProactiveStore(join(dir, "proactive.sqlite"));
		const adapter = new StandaloneRuntimeAdapter({ store });

		adapter.ports.presence?.recordUserMessage?.({ sessionKey: "local", timestamp: 100 });
		adapter.ports.presence?.recordProactiveSent?.({ sessionKey: "local", timestamp: 200 });

		expect(adapter.ports.presence?.get?.("local")).toEqual({ lastUserAt: 100, lastProactiveAt: 200 });
		store.close();
	});

	it("merges host ports without dropping standalone defaults", () => {
		const dir = mkdtempSync(join(tmpdir(), "proactive-ports-"));
		tempDirs.push(dir);
		const store = new ProactiveStore(join(dir, "proactive.sqlite"));
		const adapter = new StandaloneRuntimeAdapter({ store });
		const merged = mergeRuntimePorts(adapter.ports, {
			busy: { isBusy: () => true },
			memory: { preferenceBlock: () => "host memory" },
		});

		expect(merged.busy?.isBusy("local", new Date())).toBe(true);
		expect(merged.memory?.preferenceBlock?.({ sessionKey: "local", now: new Date() })).toBe("host memory");
		expect(merged.presence?.get?.("local")).toEqual({ lastUserAt: null, lastProactiveAt: null });
		store.close();
	});
});
