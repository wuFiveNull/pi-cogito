/**
 * recent-chat 收集(akashic Sensor.collect_recent 移植)测试。
 */

import { describe, expect, it } from "vitest";
import type { ProactiveSessionMessage } from "../src/runtime/ports.ts";
import { collectRecent, isContextFrameContent } from "../src/stages/recent-chat.ts";

function message(role: ProactiveSessionMessage["role"], content: string): ProactiveSessionMessage {
	return { role, content };
}

describe("isContextFrameContent (akashic is_context_frame)", () => {
	it("detects <system-reminder> frames and the legacy marker", () => {
		expect(isContextFrameContent("<system-reminder>rules</system-reminder>")).toBe(true);
		expect(isContextFrameContent("  <system-reminder>leading spaces</system-reminder>")).toBe(true);
		expect(isContextFrameContent("[SYSTEM_CONTEXT_FRAME] old style")).toBe(true);
	});

	it("passes ordinary messages", () => {
		expect(isContextFrameContent("今天天气怎么样")).toBe(false);
		expect(isContextFrameContent("system-reminder without angle brackets")).toBe(false);
	});
});

describe("collectRecent (akashic Sensor.collect_recent)", () => {
	it("keeps user/assistant only, filters context frames, truncates to 200 chars", () => {
		const rows = [
			message("system", "system prompt"),
			message("user", "普通问题"),
			message("assistant", "普通回答"),
			message("user", "<system-reminder>context frame 不应进入最近对话</system-reminder>"),
			message("user", "x".repeat(500)),
		];
		const text = collectRecent(rows);
		expect(text).not.toContain("system prompt");
		expect(text).not.toContain("context frame");
		expect(text).toContain("user: 普通问题");
		expect(text).toContain("assistant: 普通回答");
		// 500 字符消息截断到 200。
		expect(text).toContain(`user: ${"x".repeat(200)}`);
		expect(text).not.toContain("x".repeat(201));
	});

	it("limits the number of messages (recent_chat_messages)", () => {
		const rows = Array.from({ length: 30 }, (_, index) => message("user", `m${index}`));
		const text = collectRecent(rows, { limit: 20 });
		expect(text.split("\n")).toHaveLength(20);
		expect(text).toContain("m0");
		expect(text).not.toContain("m20");
	});

	it("skips empty content", () => {
		expect(collectRecent([message("user", "")])).toBe("");
	});
});
