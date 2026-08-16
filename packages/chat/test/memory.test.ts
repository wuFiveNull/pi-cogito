import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ChatMemory } from "../src/memory.ts";

const tempDirs: string[] = [];

function tempAgentDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "chat-memory-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
	tempDirs.length = 0;
});

describe("ChatMemory", () => {
	it("returns undefined when disabled", async () => {
		const memory = await ChatMemory.create({ enabled: false, agentDir: tempAgentDir() });
		expect(memory).toBeUndefined();
	});

	it("remembers, recalls, and forgets items (keyword-only engine)", async () => {
		const agentDir = tempAgentDir();
		const memory = await ChatMemory.create({ enabled: true, agentDir });
		expect(memory).toBeDefined();
		if (!memory) return;

		const id = await memory.remember({
			summary: "用户喜欢喝美式咖啡,每天两杯",
			memoryType: "preference",
			scope: { channel: "telegram", chatId: "42" },
			sourceRef: "chat",
		});
		expect(id.length).toBeGreaterThan(0);

		const block = await memory.recallBlock("美式咖啡口味", { channel: "telegram", chatId: "42" });
		expect(block).toContain("美式咖啡");

		// Scope isolation: another chat must not see it.
		const otherBlock = await memory.recallBlock("美式咖啡口味", { channel: "telegram", chatId: "43" });
		expect(otherBlock).not.toContain("美式咖啡");

		const result = memory.forget([id]);
		expect(result.affected).toEqual([id]);
		const after = await memory.recallBlock("美式咖啡口味", { channel: "telegram", chatId: "42" });
		expect(after).not.toContain("美式咖啡");

		memory.close();
	});
});
