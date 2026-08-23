import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createStandaloneBusyPort, createStandaloneSessionPort } from "../src/runtime/ports.ts";
import { appendProactiveToSessionLog, safeSessionFileName } from "../src/runtime/session-log.ts";

const tempDirs: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "proactive-session-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("safeSessionFileName", () => {
	it("keeps channel:chatId style keys and strips path separators", () => {
		expect(safeSessionFileName("feishu:chat-42")).toBe("feishu:chat-42");
		expect(safeSessionFileName("../evil")).toBe(".._evil");
		expect(safeSessionFileName("  ")).toBe("local");
	});
});

describe("appendProactiveToSessionLog", () => {
	it("appends drift-compatible assistant messages to the session jsonl", () => {
		const dir = tempDir();
		const ok = appendProactiveToSessionLog({
			sessionsDir: dir,
			sessionKey: "feishu:chat-42",
			content: "主动推送内容",
			timestamp: 1_700_000_000_000,
		});
		expect(ok).toBe(true);
		const file = join(dir, "feishu:chat-42.jsonl");
		expect(existsSync(file)).toBe(true);
		const lines = readFileSync(file, "utf-8").trim().split("\n");
		expect(lines).toHaveLength(1);
		const entry = JSON.parse(lines[0] ?? "{}") as {
			type: string;
			message: { role: string; content: string; timestamp: string; proactive?: boolean };
		};
		expect(entry.type).toBe("message");
		expect(entry.message.role).toBe("assistant");
		expect(entry.message.content).toBe("主动推送内容");
		expect(entry.message.proactive).toBe(true);
	});

	it("appends multiple pushes in order", () => {
		const dir = tempDir();
		appendProactiveToSessionLog({ sessionsDir: dir, sessionKey: "local", content: "一", timestamp: 1 });
		appendProactiveToSessionLog({ sessionsDir: dir, sessionKey: "local", content: "二", timestamp: 2 });
		const lines = readFileSync(join(dir, "local.jsonl"), "utf-8").trim().split("\n");
		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain("一");
		expect(lines[1]).toContain("二");
	});

	it("does not overwrite existing session history", () => {
		const dir = tempDir();
		writeFileSync(
			join(dir, "local.jsonl"),
			'{"type":"message","message":{"role":"user","content":"原有"}}\n',
			"utf-8",
		);
		appendProactiveToSessionLog({ sessionsDir: dir, sessionKey: "local", content: "推送", timestamp: 3 });
		const text = readFileSync(join(dir, "local.jsonl"), "utf-8");
		expect(text).toContain("原有");
		expect(text).toContain("推送");
	});
});

describe("createStandaloneSessionPort", () => {
	it("writes through the session port", () => {
		const dir = tempDir();
		const port = createStandaloneSessionPort({ sessionsDir: dir, sessionKey: "local" });
		port.appendAssistantMessage?.({
			sessionKey: "local",
			content: "端口推送",
			timestamp: 42,
			proactive: true,
		});
		const text = readFileSync(join(dir, "local.jsonl"), "utf-8");
		expect(text).toContain("端口推送");
	});
});

describe("createStandaloneBusyPort", () => {
	function makePresence(lastUserAt: number | null) {
		return { get: () => ({ lastUserAt, lastProactiveAt: null }) };
	}

	it("blocks within the busy window after a user message", () => {
		const port = createStandaloneBusyPort({ presence: makePresence(1_000_000_000), busyWindowSeconds: 120 });
		expect(port.isBusy("local", new Date(1_000_000_000 + 60_000))).toBe(true);
		expect(port.isBusy("local", new Date(1_000_000_000 + 300_000))).toBe(false);
	});

	it("never blocks without user presence", () => {
		const port = createStandaloneBusyPort({ presence: makePresence(null), busyWindowSeconds: 120 });
		expect(port.isBusy("local", new Date())).toBe(false);
	});

	it("falls back to the default window when unconfigured", () => {
		const port = createStandaloneBusyPort({ presence: makePresence(1_000_000_000) });
		expect(port.isBusy("local", new Date(1_000_000_000 + 100_000))).toBe(true);
	});
});
