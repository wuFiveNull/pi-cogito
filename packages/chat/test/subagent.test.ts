/**
 * Chat wiring tests: the subagent extension is mounted per session by
 * createChatResourceLoader when a subagentRunner is provided.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsManager } from "@cogito/host";
import { afterEach, describe, expect, it } from "vitest";
import { createChatResourceLoader } from "../src/extensions.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
	tempDirs.length = 0;
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "chat-subagent-"));
	tempDirs.push(dir);
	return dir;
}

const stubRunner = {
	run: async () => ({ status: "completed" as const, exitReason: "completed", result: "ok" }),
	shutdown: async () => {},
};

describe("chat subagent wiring", () => {
	it("mounts spawn / spawn_manage tools when a subagentRunner is provided", async () => {
		const dir = tempDir();
		const loader = await createChatResourceLoader({
			projectDir: dir,
			agentDir: dir,
			settingsManager: SettingsManager.create(dir, dir),
			scope: { sessionKey: "k1", channel: "test", chatId: "c1" },
			chatTools: [],
			subagentRunner: stubRunner,
		});
		const names = loader.getExtensions().extensions.flatMap((extension) => [...extension.tools.keys()]);
		expect(names).toContain("spawn");
		expect(names).toContain("spawn_manage");
	});

	it("leaves the spawn tools out without a runner (zero overhead)", async () => {
		const dir = tempDir();
		const loader = await createChatResourceLoader({
			projectDir: dir,
			agentDir: dir,
			settingsManager: SettingsManager.create(dir, dir),
			scope: { sessionKey: "k1", channel: "test", chatId: "c1" },
			chatTools: [],
		});
		const names = loader.getExtensions().extensions.flatMap((extension) => [...extension.tools.keys()]);
		expect(names).not.toContain("spawn");
		expect(names).not.toContain("spawn_manage");
	});
});
