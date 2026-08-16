import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildStableMemoryBlock, trimRecentTurns } from "../src/extensions.ts";

const tempDirs: string[] = [];

function tempAgentDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "chat-ext-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("buildStableMemoryBlock", () => {
	it("injects SELF → MEMORY → RECENT_CONTEXT in order with full file contents", () => {
		const agentDir = tempAgentDir();
		const memoryDir = join(agentDir, "memory");
		mkdirSync(memoryDir, { recursive: true });
		writeFileSync(join(memoryDir, "SELF.md"), "# 助手自我认知\n\n## 人格与形象\n- 直接、温暖。", "utf-8");
		writeFileSync(join(memoryDir, "MEMORY.md"), "# 用户长期记忆\n\n## 用户事实\n- 用户是工程师", "utf-8");
		writeFileSync(
			join(memoryDir, "RECENT_CONTEXT.md"),
			"# Recent Context\n\n## Compression\nuntil: 2026-01-01\n- 最近持续关注：A\n\n## Ongoing Threads\n- 面试准备\n\n## Recent Turns\n- [user] 你好",
			"utf-8",
		);

		const block = buildStableMemoryBlock(agentDir);

		expect(block.indexOf("## 自我认知")).toBeLessThan(block.indexOf("## 长期记忆"));
		expect(block.indexOf("## 长期记忆")).toBeLessThan(block.indexOf("## 近期语境"));
		expect(block).toContain("- 直接、温暖。");
		expect(block).toContain("- 用户是工程师");
		// RECENT_CONTEXT 只保留 Compression/Ongoing Threads,裁掉 Recent Turns。
		expect(block).toContain("## Ongoing Threads");
		expect(block).toContain("- 面试准备");
		expect(block).not.toContain("## Recent Turns");
		expect(block).not.toContain("[user] 你好");
	});

	it("skips missing files and returns an empty block when nothing exists", () => {
		const agentDir = tempAgentDir();
		expect(buildStableMemoryBlock(agentDir)).toBe("");

		const memoryDir = join(agentDir, "memory");
		mkdirSync(memoryDir, { recursive: true });
		writeFileSync(join(memoryDir, "SELF.md"), "   ", "utf-8");
		expect(buildStableMemoryBlock(agentDir)).toBe("");
	});
});

describe("trimRecentTurns", () => {
	it("cuts the Recent Turns tail and keeps the compression sections", () => {
		const text = "## Compression\n- 最近持续关注：A\n\n## Ongoing Threads\n- B\n\n## Recent Turns\n- [user] x";
		expect(trimRecentTurns(text)).toBe("## Compression\n- 最近持续关注：A\n\n## Ongoing Threads\n- B");
	});

	it("returns an empty string for missing or recent-turns-only content", () => {
		expect(trimRecentTurns(undefined)).toBe("");
		expect(trimRecentTurns("")).toBe("");
		expect(trimRecentTurns("## Recent Turns\n- [user] x")).toBe("");
	});
});
