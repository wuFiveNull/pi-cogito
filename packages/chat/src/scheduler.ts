/**
 * ChatScheduler — agent-registered timed tasks (akashic schedule tool design).
 *
 * Supports at / after / every triggers with two tiers:
 * - instant: fire the fixed prompt text to the target chat.
 * - soft:    ask the chat session to generate content, then deliver it.
 *
 * Jobs persist to a JSON file so they survive process restarts.
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export type ChatScheduleTier = "instant" | "soft";
export type ChatScheduleTrigger = "at" | "after" | "every";

export interface ChatScheduleJob {
	id: string;
	sessionKey: string;
	tier: ChatScheduleTier;
	trigger: ChatScheduleTrigger;
	when: string;
	prompt: string;
	targetChannel: string;
	targetChatId: string;
	nextFireAt: string;
	/** Present for "every" triggers (repeat interval or daily time-of-day). */
	intervalMs?: number;
	enabled: boolean;
	createdAt: string;
	lastFiredAt?: string;
	fireCount: number;
}

export interface ChatScheduleInput {
	sessionKey: string;
	tier: ChatScheduleTier;
	trigger: ChatScheduleTrigger;
	when: string;
	prompt: string;
	targetChannel: string;
	targetChatId: string;
}

export type ChatScheduleResult = { ok: true; id: string; nextFireAt: string } | { ok: false; error: string };

export interface ChatSchedulerDeps {
	/** Deliver generated/fixed content to the target chat. */
	deliver: (job: ChatScheduleJob, content: string) => Promise<void>;
	/** Generate content for soft-tier jobs. */
	generateSoft: (job: ChatScheduleJob) => Promise<string>;
	log?: (message: string) => void;
}

export interface ChatSchedulerOptions {
	/** Due-job check interval. Default 5000ms. */
	tickIntervalMs?: number;
}

const DEFAULT_TICK_INTERVAL_MS = 5_000;

export class ChatScheduler {
	private readonly jobs = new Map<string, ChatScheduleJob>();
	private readonly jobsPath: string;
	private readonly deps: ChatSchedulerDeps;
	private readonly tickIntervalMs: number;
	private timer: NodeJS.Timeout | undefined;

	constructor(jobsPath: string, deps: ChatSchedulerDeps, options: ChatSchedulerOptions = {}) {
		this.jobsPath = jobsPath;
		this.deps = deps;
		this.tickIntervalMs = Math.max(100, options.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS);
		this.load();
	}

	async schedule(input: ChatScheduleInput): Promise<ChatScheduleResult> {
		const nextFireAt = computeNextFireAt(input.trigger, input.when, Date.now());
		if (nextFireAt === undefined) {
			return { ok: false, error: `无法解析触发时间: ${input.when}` };
		}
		const job: ChatScheduleJob = {
			id: randomUUID(),
			sessionKey: input.sessionKey,
			tier: input.tier,
			trigger: input.trigger,
			when: input.when,
			prompt: input.prompt,
			targetChannel: input.targetChannel,
			targetChatId: input.targetChatId,
			nextFireAt: new Date(nextFireAt).toISOString(),
			intervalMs: input.trigger === "every" ? intervalForEvery(input.when) : undefined,
			enabled: true,
			createdAt: new Date().toISOString(),
			fireCount: 0,
		};
		this.jobs.set(job.id, job);
		this.persist();
		return { ok: true, id: job.id, nextFireAt: job.nextFireAt };
	}

	list(): ChatScheduleJob[] {
		return [...this.jobs.values()].sort((a, b) => a.nextFireAt.localeCompare(b.nextFireAt));
	}

	/** Disable a job; returns false when the id is unknown or already disabled. */
	cancel(id: string): boolean {
		const job = this.jobs.get(id);
		if (!job || !job.enabled) return false;
		job.enabled = false;
		this.persist();
		return true;
	}

	/** Remove a job entirely. */
	remove(id: string): boolean {
		const removed = this.jobs.delete(id);
		if (removed) this.persist();
		return removed;
	}

	start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => {
			void this.fireDue().catch((error) => {
				this.deps.log?.(`scheduler tick failed: ${error instanceof Error ? error.message : String(error)}`);
			});
		}, this.tickIntervalMs);
		this.timer.unref?.();
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		this.persist();
	}

	private async fireDue(): Promise<void> {
		const now = Date.now();
		for (const job of this.jobs.values()) {
			if (!job.enabled) continue;
			const fireAt = Date.parse(job.nextFireAt);
			if (!Number.isFinite(fireAt) || fireAt > now) continue;
			await this.fire(job, now);
		}
	}

	private async fire(job: ChatScheduleJob, now: number): Promise<void> {
		// 占用下一次触发槽位,防止生成/投递耗时期间(soft 生成可达数十秒)
		// 后续 tick 重复触发同一到期的任务。
		if (job.intervalMs !== undefined) {
			job.nextFireAt = new Date(now + job.intervalMs).toISOString();
		} else {
			job.enabled = false;
		}
		try {
			const content = job.tier === "soft" ? await this.deps.generateSoft(job).catch(() => "") : job.prompt;
			if (content.length > 0) {
				await this.deps.deliver(job, content);
			}
			job.fireCount += 1;
			job.lastFiredAt = new Date(now).toISOString();
		} catch (error) {
			this.deps.log?.(`scheduled job ${job.id} failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		this.persist();
	}

	private load(): void {
		try {
			if (!existsSync(this.jobsPath)) return;
			const parsed = JSON.parse(readFileSync(this.jobsPath, "utf-8")) as unknown;
			if (!Array.isArray(parsed)) return;
			for (const entry of parsed) {
				if (!isJob(entry)) continue;
				if (!entry.enabled) continue;
				if (entry.nextFireAt === undefined) continue;
				this.jobs.set(entry.id, entry);
			}
		} catch {
			// Corrupt state file: start with an empty job list.
		}
	}

	private persist(): void {
		try {
			const data = JSON.stringify([...this.jobs.values()], null, 2);
			const tmpPath = `${this.jobsPath}.tmp`;
			writeFileSync(tmpPath, data, "utf-8");
			renameSync(tmpPath, this.jobsPath);
		} catch {
			// Persistence must never break scheduling.
		}
	}
}

function isJob(value: unknown): value is ChatScheduleJob {
	if (typeof value !== "object" || value === null) return false;
	const job = value as Record<string, unknown>;
	return (
		typeof job.id === "string" &&
		typeof job.sessionKey === "string" &&
		typeof job.prompt === "string" &&
		typeof job.targetChannel === "string" &&
		typeof job.targetChatId === "string" &&
		typeof job.nextFireAt === "string" &&
		(job.tier === "instant" || job.tier === "soft") &&
		(job.trigger === "at" || job.trigger === "after" || job.trigger === "every")
	);
}

// ---------------------------------------------------------------------------
// Trigger parsing
// ---------------------------------------------------------------------------

export function parseDuration(value: string): number | undefined {
	const match = /^(\d+)\s*(s|m|h|d)$/.exec(value.trim().toLowerCase());
	if (!match) return undefined;
	const amount = Number(match[1]);
	const unit = match[2];
	if (!Number.isFinite(amount) || amount <= 0) return undefined;
	const perUnit: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
	return amount * perUnit[unit];
}

/** "HH:MM" (local time, repeats daily for "every") or ISO timestamp. */
export function parseAtTime(value: string): Date | undefined {
	const trimmed = value.trim();
	const timeMatch = /^(\d{1,2}):(\d{2})$/.exec(trimmed);
	if (timeMatch) {
		const hours = Number(timeMatch[1]);
		const minutes = Number(timeMatch[2]);
		if (hours > 23 || minutes > 59) return undefined;
		const date = new Date();
		date.setHours(hours, minutes, 0, 0);
		return date;
	}
	const parsed = Date.parse(trimmed);
	return Number.isFinite(parsed) ? new Date(parsed) : undefined;
}

function computeNextFireAt(trigger: ChatScheduleTrigger, when: string, now: number): number | undefined {
	if (trigger === "after") {
		const delayMs = parseDuration(when);
		return delayMs === undefined ? undefined : now + delayMs;
	}
	if (trigger === "every") {
		const delayMs = parseDuration(when);
		if (delayMs !== undefined) return now + delayMs;
		const daily = parseAtTime(when);
		if (!daily) return undefined;
		const today = new Date(now);
		daily.setFullYear(today.getFullYear(), today.getMonth(), today.getDate());
		return daily.getTime() <= now ? daily.getTime() + 86_400_000 : daily.getTime();
	}
	// "at"
	const at = parseAtTime(when);
	if (!at) return undefined;
	if (/^\d{1,2}:\d{2}$/.test(when.trim())) {
		const today = new Date(now);
		at.setFullYear(today.getFullYear(), today.getMonth(), today.getDate());
		return at.getTime() <= now ? at.getTime() + 86_400_000 : at.getTime();
	}
	return at.getTime();
}

function intervalForEvery(when: string): number | undefined {
	const delayMs = parseDuration(when);
	if (delayMs !== undefined) return delayMs;
	return /^\d{1,2}:\d{2}$/.test(when.trim()) ? 86_400_000 : undefined;
}
