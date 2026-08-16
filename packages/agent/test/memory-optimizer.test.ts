import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarkdownMemoryStore } from "../src/memory/markdown-store.ts";
import {
	type MemoryLlm,
	MemoryOptimizer,
	MemoryOptimizerBusy,
	MemoryOptimizerOutputError,
	validateMemoryOutput,
	validateSelfOutput,
} from "../src/memory/optimizer.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	vi.useRealTimers();
});

function makeStore(): MarkdownMemoryStore {
	const dir = mkdtempSync(join(tmpdir(), "memory-opt-"));
	tempDirs.push(dir);
	return new MarkdownMemoryStore(dir);
}

const VALID_MEMORY = `# 用户长期记忆

## 用户事实
- 用户是后端工程师

## 用户偏好
- 偏好简洁直接

## 用户明确要求长期记住的关键内容
- 周末不打扰
`;

const VALID_MEMORY_WITH_CONTEXT = `${VALID_MEMORY}
## 助手操作上下文
- 服务端口 8080
`;

const VALID_SELF = `# 助手自我认知

## 人格与形象
- 直接、温暖

## 我对当前用户的理解
- 长期协作

## 我们关系的定义
- 透明与尊重
`;

function makeLlm(script: string[]): MemoryLlm {
	return {
		chat: vi.fn(async (_system: string, _user: string, _maxTokens: number) => script.shift() ?? ""),
	};
}

describe("validateMemoryOutput (akashic _validate_memory_output)", () => {
	it("accepts a complete archive with and without the optional section", () => {
		expect(() => validateMemoryOutput(VALID_MEMORY)).not.toThrow();
		expect(() => validateMemoryOutput(VALID_MEMORY_WITH_CONTEXT)).not.toThrow();
	});

	it("rejects missing headings, empty archives and code fences", () => {
		expect(() => validateMemoryOutput("## 用户事实\n- x")).toThrow(MemoryOptimizerOutputError);
		expect(() =>
			validateMemoryOutput("# 用户长期记忆\n\n## 用户事实\n\n## 用户偏好\n\n## 用户明确要求长期记住的关键内容\n"),
		).toThrow();
		expect(() => validateMemoryOutput(`# 用户长期记忆\n\n\`\`\`\n- x\n\`\`\``)).toThrow();
	});
});

describe("validateSelfOutput (akashic _validate_self_output)", () => {
	it("accepts the three fixed sections", () => {
		expect(() => validateSelfOutput(VALID_SELF)).not.toThrow();
	});

	it("rejects extra sections and empty sections", () => {
		expect(() => validateSelfOutput(`${VALID_SELF}\n## 关系演进记录\n- x`)).toThrow(MemoryOptimizerOutputError);
		expect(() => validateSelfOutput(VALID_SELF.replace("- 直接、温暖", ""))).toThrow(MemoryOptimizerOutputError);
	});
});

describe("MemoryOptimizer (akashic memory_optimizer.py port)", () => {
	it("merges PENDING into MEMORY, commits the snapshot and updates SELF", async () => {
		const store = makeStore();
		store.writeLongTerm("# 用户长期记忆\n\n## 用户事实\n- 旧事实\n");
		store.appendPending("- [preference] 新偏好");
		const llm = makeLlm([VALID_MEMORY, VALID_SELF]);
		const optimizer = new MemoryOptimizer({ memory: store, llm, stepDelaySeconds: 0 });
		await optimizer.optimize();
		expect(store.readLongTerm()).toContain("用户是后端工程师");
		expect(store.readPending()).toBe(""); // snapshot 已提交
		expect(store.readSelf()).toContain("我们关系的定义");
		// 备份已写。
		expect(readFileSync(join(store.memoryDir, "MEMORY.bak.md"), "utf-8")).toContain("旧事实");
		expect(optimizer.isRunning).toBe(false);
		store.close();
	});

	it("rolls back the snapshot when the model output is invalid", async () => {
		const store = makeStore();
		const original = "# 用户长期记忆\n\n## 用户事实\n- 原内容\n";
		store.writeLongTerm(original);
		store.appendPending("- [identity] 新事实");
		const llm = makeLlm(["```json\n{}"]);
		const optimizer = new MemoryOptimizer({ memory: store, llm, stepDelaySeconds: 0 });
		// 校验失败 → 抛错 + 回滚(akashic except BaseException: rollback; raise)。
		await expect(optimizer.optimize()).rejects.toThrow(MemoryOptimizerOutputError);
		expect(store.readLongTerm()).toBe(original); // 原内容保留
		expect(store.readPending()).toContain("新事实"); // snapshot 已回滚,不丢数据
		store.close();
	});

	it("skips when both memory and pending are empty", async () => {
		const store = makeStore();
		const llm = makeLlm([]);
		const optimizer = new MemoryOptimizer({ memory: store, llm, stepDelaySeconds: 0 });
		await optimizer.optimize();
		expect(llm.chat).not.toHaveBeenCalled();
		expect(store.readPending()).toBe("");
		store.close();
	});

	it("rejects concurrent optimize runs with MemoryOptimizerBusy", async () => {
		const store = makeStore();
		store.writeLongTerm(VALID_MEMORY);
		store.appendPending("- [preference] x");
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let callCount = 0;
		const llm: MemoryLlm = {
			chat: vi.fn(async () => {
				await gate;
				callCount++;
				return callCount === 1 ? VALID_MEMORY : VALID_SELF;
			}),
		};
		const optimizer = new MemoryOptimizer({ memory: store, llm, stepDelaySeconds: 0 });
		const first = optimizer.optimize();
		await new Promise((resolve) => setTimeout(resolve, 10));
		await expect(optimizer.optimize()).rejects.toThrow(MemoryOptimizerBusy);
		release();
		await first;
		store.close();
	});
});
