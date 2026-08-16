import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileDriftContextProvider } from "../src/context.ts";
import { createDriftContext } from "../src/runtime.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeWorkspace(): string {
	const workspace = mkdtempSync(join(tmpdir(), "drift-context-test-"));
	tempDirs.push(workspace);
	mkdirSync(join(workspace, "memory"), { recursive: true });
	return workspace;
}

describe("FileDriftContextProvider", () => {
	it("loads akashic memory files and trims the raw recent-turn tail", () => {
		const workspace = makeWorkspace();
		writeFileSync(join(workspace, "memory", "VEDA.md"), "# Veda\n\n用户维护的 persona\n", "utf-8");
		writeFileSync(join(workspace, "memory", "SELF.md"), "# Self\n助手自我认知\n", "utf-8");
		writeFileSync(join(workspace, "memory", "MEMORY.md"), "# Memory\n稳定事实\n", "utf-8");
		writeFileSync(
			join(workspace, "memory", "RECENT_CONTEXT.md"),
			"# Recent Context\n当前语境\n\n## Recent Turns\n原始回合不应重复注入\n",
			"utf-8",
		);

		const provider = new FileDriftContextProvider({ workspaceDir: workspace, requiredVeda: true });
		const snapshot = provider.load(createDriftContext("local", new Date("2026-05-01T00:00:00Z")));

		expect(snapshot.veda).toBe("# Veda\n\n用户维护的 persona");
		expect(snapshot.selfModel).toContain("助手自我认知");
		expect(snapshot.longTermMemory).toContain("稳定事实");
		expect(snapshot.recentContext).toBe("# Recent Context\n当前语境");
	});

	it("reloads VEDA on every load instead of caching it", () => {
		const workspace = makeWorkspace();
		const vedaPath = join(workspace, "memory", "VEDA.md");
		writeFileSync(vedaPath, "first", "utf-8");
		const provider = new FileDriftContextProvider({ workspaceDir: workspace });
		const ctx = createDriftContext("local", new Date());

		expect(provider.load(ctx).veda).toBe("first");
		writeFileSync(vedaPath, "second", "utf-8");
		expect(provider.load(ctx).veda).toBe("second");
	});

	it("fails loudly for missing, empty, or invalid required VEDA", () => {
		const workspace = makeWorkspace();
		const provider = new FileDriftContextProvider({ workspaceDir: workspace, requiredVeda: true });
		const ctx = createDriftContext("local", new Date());

		expect(() => provider.load(ctx)).toThrow(/file is missing/);
		const vedaPath = join(workspace, "memory", "VEDA.md");
		writeFileSync(vedaPath, "\n", "utf-8");
		expect(() => provider.load(ctx)).toThrow(/file is empty/);
		writeFileSync(vedaPath, Buffer.from([0xc3, 0x28]));
		expect(() => provider.load(ctx)).toThrow(/invalid UTF-8/);
	});

	it("allows an absent optional VEDA and other absent files", () => {
		const provider = new FileDriftContextProvider({ workspaceDir: makeWorkspace() });
		const snapshot = provider.load(createDriftContext("local", new Date()));

		expect(snapshot.veda).toBeUndefined();
		expect(snapshot.selfModel).toBeUndefined();
		expect(snapshot.longTermMemory).toBeUndefined();
		expect(snapshot.recentContext).toBeUndefined();
	});
});
