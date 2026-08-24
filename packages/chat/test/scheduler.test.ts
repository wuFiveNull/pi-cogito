import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ChatScheduler, parseAtTime, parseDuration } from "../src/scheduler.ts";

const tempDirs: string[] = [];

function tempJobsPath(): string {
	const dir = mkdtempSync(join(tmpdir(), "chat-scheduler-"));
	tempDirs.push(dir);
	return join(dir, "schedules.json");
}

afterEach(() => {
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
	tempDirs.length = 0;
});

function createScheduler(jobsPath: string, delivered: string[] = [], generated: string[] = []) {
	return new ChatScheduler(
		jobsPath,
		{
			deliver: async (_job, content) => {
				delivered.push(content);
			},
			generateSoft: async (job) => {
				generated.push(job.prompt);
				return `generated:${job.prompt}`;
			},
		},
		{ tickIntervalMs: 100 },
	);
}

describe("parseDuration", () => {
	it("parses s/m/h/d durations", () => {
		expect(parseDuration("30s")).toBe(30_000);
		expect(parseDuration("5m")).toBe(300_000);
		expect(parseDuration("2h")).toBe(7_200_000);
		expect(parseDuration("1d")).toBe(86_400_000);
	});

	it("rejects invalid durations", () => {
		expect(parseDuration("10x")).toBeUndefined();
		expect(parseDuration("abc")).toBeUndefined();
		expect(parseDuration("-5m")).toBeUndefined();
	});
});

describe("parseAtTime", () => {
	it("parses HH:MM as today", () => {
		const date = parseAtTime("14:30");
		expect(date).toBeInstanceOf(Date);
		expect(date!.getHours()).toBe(14);
		expect(date!.getMinutes()).toBe(30);
	});

	it("parses ISO timestamps", () => {
		const date = parseAtTime("2026-01-02T03:04:05");
		expect(date).toBeInstanceOf(Date);
		expect(date!.getUTCFullYear()).toBe(2026);
	});

	it("rejects invalid times", () => {
		expect(parseAtTime("99:99")).toBeUndefined();
		expect(parseAtTime("not-a-time")).toBeUndefined();
	});
});

describe("ChatScheduler.schedule", () => {
	it("schedules an after job in the future", async () => {
		const scheduler = createScheduler(tempJobsPath());
		const before = Date.now();
		const result = await scheduler.schedule({
			sessionKey: "telegram:1",
			tier: "instant",
			trigger: "after",
			when: "5m",
			prompt: "喝水提醒",
			targetChannel: "telegram",
			targetChatId: "1",
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const fireAt = Date.parse(result.nextFireAt);
		expect(fireAt).toBeGreaterThanOrEqual(before + 300_000 - 1000);
		expect(fireAt).toBeLessThanOrEqual(before + 300_000 + 1000);
	});

	it("rejects unparsable triggers", async () => {
		const scheduler = createScheduler(tempJobsPath());
		const result = await scheduler.schedule({
			sessionKey: "telegram:1",
			tier: "instant",
			trigger: "at",
			when: "not-a-time",
			prompt: "x",
			targetChannel: "telegram",
			targetChatId: "1",
		});
		expect(result.ok).toBe(false);
	});

	it("lists and cancels jobs", async () => {
		const scheduler = createScheduler(tempJobsPath());
		const result = await scheduler.schedule({
			sessionKey: "telegram:1",
			tier: "instant",
			trigger: "after",
			when: "10m",
			prompt: "x",
			targetChannel: "telegram",
			targetChatId: "1",
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(scheduler.list()).toHaveLength(1);
		expect(scheduler.cancel(result.id)).toBe(true);
		expect(scheduler.cancel(result.id)).toBe(false);
		const job = scheduler.list()[0];
		expect(job.enabled).toBe(false);
	});
});

describe("ChatScheduler firing", () => {
	it("fires instant jobs with the fixed prompt", async () => {
		const jobsPath = tempJobsPath();
		const delivered: string[] = [];
		const scheduler = createScheduler(jobsPath, delivered);
		const result = await scheduler.schedule({
			sessionKey: "telegram:1",
			tier: "instant",
			trigger: "after",
			when: "1s",
			prompt: "到点消息",
			targetChannel: "telegram",
			targetChatId: "1",
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		scheduler.start();
		await new Promise((resolve) => setTimeout(resolve, 1100));
		scheduler.stop();
		expect(delivered).toEqual(["到点消息"]);
		// one-shot jobs disable themselves after firing
		const job = scheduler.list()[0];
		expect(job.fireCount).toBe(1);
		expect(job.enabled).toBe(false);
	});

	it("fires soft jobs through generateSoft", async () => {
		const jobsPath = tempJobsPath();
		const delivered: string[] = [];
		const generated: string[] = [];
		const scheduler = createScheduler(jobsPath, delivered, generated);
		const result = await scheduler.schedule({
			sessionKey: "telegram:1",
			tier: "soft",
			trigger: "after",
			when: "1s",
			prompt: "生成今日天气",
			targetChannel: "telegram",
			targetChatId: "1",
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		scheduler.start();
		await new Promise((resolve) => setTimeout(resolve, 1100));
		scheduler.stop();
		expect(generated).toEqual(["生成今日天气"]);
		expect(delivered).toEqual(["generated:生成今日天气"]);
	});

	it("repeats every jobs on their interval", async () => {
		const jobsPath = tempJobsPath();
		const delivered: string[] = [];
		const scheduler = createScheduler(jobsPath, delivered);
		const result = await scheduler.schedule({
			sessionKey: "telegram:1",
			tier: "instant",
			trigger: "every",
			when: "1s",
			prompt: "tick",
			targetChannel: "telegram",
			targetChatId: "1",
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		scheduler.start();
		await new Promise((resolve) => setTimeout(resolve, 2300));
		scheduler.stop();
		expect(delivered.length).toBeGreaterThanOrEqual(2);
		const job = scheduler.list()[0];
		expect(job.enabled).toBe(true);
	});

	it("re-anchors daily every jobs to the fixed time after a late fire", async () => {
		// 模拟"每天 09:00"任务在网关恢复后才补触发(如当晚 21 点):
		// 下次触发必须回到明天的 09:00,而不是"补触发时刻 +24h"。
		const jobsPath = tempJobsPath();
		const delivered: string[] = [];
		const todayAtNine = new Date();
		todayAtNine.setHours(9, 0, 0, 0);
		const dueJob = {
			id: "daily-1",
			sessionKey: "qq:user:2908173675",
			tier: "instant",
			trigger: "every",
			when: "09:00",
			prompt: "到点内容",
			targetChannel: "qq",
			targetChatId: "user:2908173675",
			nextFireAt: new Date(todayAtNine.getTime() - 86_400_000).toISOString(),
			intervalMs: 86_400_000,
			enabled: true,
			createdAt: new Date().toISOString(),
			fireCount: 0,
		};
		writeFileSync(jobsPath, JSON.stringify([dueJob]), "utf-8");
		const scheduler = createScheduler(jobsPath, delivered);
		scheduler.start();
		await new Promise((resolve) => setTimeout(resolve, 300));
		scheduler.stop();
		expect(delivered).toEqual(["到点内容"]);
		const job = scheduler.list()[0];
		expect(job.fireCount).toBe(1);
		expect(job.enabled).toBe(true);
		const expectedAtNine = new Date();
		expectedAtNine.setHours(9, 0, 0, 0);
		const expected =
			expectedAtNine.getTime() > Date.now() ? expectedAtNine.getTime() : expectedAtNine.getTime() + 86_400_000;
		expect(Date.parse(job.nextFireAt)).toBe(expected);
	});

	it("persists jobs across restarts", async () => {
		const jobsPath = tempJobsPath();
		const first = createScheduler(jobsPath);
		const result = await first.schedule({
			sessionKey: "telegram:1",
			tier: "instant",
			trigger: "after",
			when: "30m",
			prompt: "x",
			targetChannel: "telegram",
			targetChatId: "1",
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		first.stop();
		const second = createScheduler(jobsPath);
		const jobs = second.list();
		expect(jobs).toHaveLength(1);
		expect(jobs[0].id).toBe(result.id);
		expect(jobs[0].prompt).toBe("x");
	});
});

describe("ChatScheduler corrupted state", () => {
	it("ignores a corrupt jobs file on load", () => {
		const jobsPath = tempJobsPath();
		writeFileSync(jobsPath, "not json", "utf-8");
		const scheduler = createScheduler(jobsPath);
		expect(scheduler.list()).toHaveLength(0);
	});
});
