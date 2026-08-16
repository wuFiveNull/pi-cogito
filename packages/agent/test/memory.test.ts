import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MarkdownMemoryStore } from "../src/memory/markdown-store.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeStore(): MarkdownMemoryStore {
	const dir = mkdtempSync(join(tmpdir(), "memory-store-"));
	tempDirs.push(dir);
	return new MarkdownMemoryStore(dir);
}

describe("MarkdownMemoryStore (akashic memory.py port)", () => {
	it("ensures PENDING.md exists and round-trips MEMORY/SELF", () => {
		const store = makeStore();
		expect(existsSync(store.pendingFile)).toBe(true);
		store.writeLongTerm("# 用户长期记忆\n");
		expect(store.readLongTerm()).toContain("用户长期记忆");
		store.writeSelf("# 助手自我认知\n");
		expect(store.readSelf()).toContain("助手自我认知");
		store.close();
	});

	it("snapshot → commit clears PENDING and keeps the file", () => {
		const store = makeStore();
		store.appendPending("- [identity] 用户是工程师");
		const snap = store.snapshotPending();
		expect(snap).toContain("工程师");
		store.commitPendingSnapshot();
		expect(store.readPending()).toBe("");
		expect(existsSync(store.pendingFile)).toBe(true);
		store.close();
	});

	it("snapshot → rollback merges snapshot with concurrent appends", () => {
		const store = makeStore();
		store.appendPending("- [identity] 旧事实");
		const snap = store.snapshotPending();
		expect(snap).toContain("旧事实");
		// 快照期间的新追加写入全新 PENDING.md。
		store.appendPending("- [preference] 新偏好");
		store.rollbackPendingSnapshot();
		const pending = store.readPending();
		expect(pending).toContain("旧事实");
		expect(pending).toContain("新偏好");
		// 快照已删除。
		expect(existsSync(join(store.memoryDir, "PENDING.snapshot.md"))).toBe(false);
		store.close();
	});

	it("recovers a leftover snapshot on construction (crash rollback)", () => {
		const store = makeStore();
		store.appendPending("- [identity] 崩溃前的事实");
		store.snapshotPending();
		// 模拟崩溃:直接构造新 store。
		store.close();
		const reopened = new MarkdownMemoryStore(store.memoryDir.replace(/\/memory$/, ""));
		expect(reopened.readPending()).toContain("崩溃前的事实");
		reopened.close();
	});

	it("appendPendingOnce is idempotent per source_ref and strips markers on read", () => {
		const store = makeStore();
		const first = store.appendPendingOnce("- [identity] 用户是工程师", { sourceRef: "msg-1", kind: "pending" });
		expect(first).toBe(true);
		const second = store.appendPendingOnce("- [identity] 用户是工程师", { sourceRef: "msg-1", kind: "pending" });
		expect(second).toBe(false);
		const raw = readFileSync(store.pendingFile, "utf-8");
		expect(raw).toContain("<!-- consolidation:msg-1:pending -->");
		expect(store.readPending()).toContain("工程师");
		expect(store.readPending()).not.toContain("consolidation:");
		store.close();
	});

	it("appendPendingOnce recovers file content when the index row exists", () => {
		const store = makeStore();
		store.appendPendingOnce("- [preference] 丢失前的内容", { sourceRef: "msg-2" });
		// 模拟文件段丢失(索引仍在)。
		writeFileSync(store.pendingFile, "", "utf-8");
		store.appendPendingOnce("- [preference] 丢失前的内容", { sourceRef: "msg-2" });
		expect(store.readPending()).toContain("丢失前的内容");
		store.close();
	});

	it("appendPendingOnce skips duplicates recorded in the file tail", () => {
		const store = makeStore();
		// 手动写入 marker + 内容(模拟「文件已写,索引未写」的崩溃窗口)。
		store.appendPending("- [identity] 尾部已存在");
		writeFileSync(
			store.pendingFile,
			`${readFileSync(store.pendingFile, "utf-8")}<!-- consolidation:msg-3:pending -->\n- [identity] 尾部已存在\n`,
			"utf-8",
		);
		const inserted = store.appendPendingOnce("- [identity] 尾部已存在", { sourceRef: "msg-3" });
		expect(inserted).toBe(false);
		store.close();
	});

	it("backupLongTerm writes a fixed latest backup and a timestamped history copy", () => {
		const store = makeStore();
		store.writeLongTerm("# 用户长期记忆\n- 用户事实");
		store.backupLongTerm();
		expect(readFileSync(join(store.memoryDir, "MEMORY.bak.md"), "utf-8")).toContain("用户事实");
		const backupsDir = join(store.memoryDir, "backups");
		const historyFiles = existsSync(backupsDir)
			? readdirSync(backupsDir).filter((name) => name.endsWith(".bak.md"))
			: [];
		expect(historyFiles.length).toBe(1);
		expect(readFileSync(join(backupsDir, historyFiles[0]!), "utf-8")).toContain("用户事实");
		store.close();
	});
});

describe("memory dir creation", () => {
	it("creates the memory directory under workspace", () => {
		const dir = mkdtempSync(join(tmpdir(), "memory-ws-"));
		tempDirs.push(dir);
		const store = new MarkdownMemoryStore(join(dir, "nested", "workspace"));
		expect(existsSync(join(dir, "nested", "workspace", "memory", "PENDING.md"))).toBe(true);
		store.close();
	});
});
