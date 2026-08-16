import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CHAT_DEFAULT_TOOLS, CHAT_SCHEDULE_TOOLS, loadChatConfig } from "../src/config.ts";

const tempDirs: string[] = [];

function tempConfig(chat: unknown): string {
	const dir = mkdtempSync(join(tmpdir(), "chat-config-"));
	tempDirs.push(dir);
	const path = join(dir, "config.json");
	writeFileSync(path, JSON.stringify({ channels: { web: { enabled: true } }, chat }), "utf-8");
	return path;
}

afterEach(() => {
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
	tempDirs.length = 0;
});

describe("loadChatConfig", () => {
	it("returns defaults when the chat section is absent", () => {
		const config = loadChatConfig(tempConfig(undefined));
		expect(config.model).toBeUndefined();
		expect(config.streaming).toBe(true);
		expect(config.memory?.enabled).toBe(true);
		expect(config.memory?.injectProfile).toBe(true);
		expect(config.web?.enabled).toBe(true);
		expect(config.sessions?.maxIdleMinutes).toBe(30);
		expect(config.sessions?.maxSessions).toBe(50);
		expect(config.schedule?.enabled).toBe(false);
	});

	it("parses the chat section", () => {
		const config = loadChatConfig(
			tempConfig({
				model: "deepseek-v4-flash",
				thinkingLevel: "high",
				streaming: false,
				tools: { allowed: ["read", "schedule"], excluded: ["bash"] },
				memory: { enabled: false, dbPath: "/tmp/mem.sqlite", injectProfile: false },
				web: {
					enabled: false,
					fetch: { maxChars: 4000, maxRedirectHops: 2 },
					search: { url: "https://x/?q={query}" },
				},
				sessions: { maxIdleMinutes: 10, maxSessions: 3 },
				schedule: { enabled: true },
				extensionsDir: "chat/ext",
				persona: "你是助手",
			}),
		);
		expect(config.model).toBe("deepseek-v4-flash");
		expect(config.thinkingLevel).toBe("high");
		expect(config.streaming).toBe(false);
		expect(config.tools?.allowed).toEqual(["read", "schedule"]);
		expect(config.tools?.excluded).toEqual(["bash"]);
		expect(config.memory?.enabled).toBe(false);
		expect(config.memory?.dbPath).toBe("/tmp/mem.sqlite");
		expect(config.memory?.injectProfile).toBe(false);
		expect(config.web?.enabled).toBe(false);
		expect(config.web?.fetch?.maxChars).toBe(4000);
		expect(config.web?.fetch?.maxRedirectHops).toBe(2);
		expect(config.web?.search?.url).toBe("https://x/?q={query}");
		expect(config.sessions?.maxIdleMinutes).toBe(10);
		expect(config.sessions?.maxSessions).toBe(3);
		expect(config.schedule?.enabled).toBe(true);
		expect(config.extensionsDir).toBe("chat/ext");
		expect(config.persona).toBe("你是助手");
	});

	it("ignores invalid types", () => {
		const config = loadChatConfig(
			tempConfig({ model: 42, streaming: "yes", sessions: { maxIdleMinutes: -1, maxSessions: "many" } }),
		);
		expect(config.model).toBeUndefined();
		expect(config.streaming).toBe(true);
		expect(config.sessions?.maxIdleMinutes).toBe(30);
		expect(config.sessions?.maxSessions).toBe(50);
	});

	it("treats a missing config file as empty", () => {
		const config = loadChatConfig("/nonexistent/config.json");
		expect(config.streaming).toBe(true);
		expect(config.memory?.enabled).toBe(true);
	});

	it("exposes default tool sets", () => {
		expect(CHAT_DEFAULT_TOOLS).toContain("message_push");
		expect(CHAT_DEFAULT_TOOLS).toContain("web_fetch");
		expect(CHAT_DEFAULT_TOOLS).toContain("memorize");
		expect(CHAT_DEFAULT_TOOLS).toContain("fetch_messages");
		expect(CHAT_SCHEDULE_TOOLS).toEqual(["schedule", "list_schedules", "cancel_schedule"]);
	});
});
