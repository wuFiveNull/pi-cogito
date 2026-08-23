/**
 * Quiet-push gate — 静默时段主动推送积压。
 *
 * 在配置的静默时区窗口(本地小时 [start, end),支持跨天如 23→9)内,把
 * 非回复类主动推送(proactive/drift/定时任务/message_push,即不带 turnId
 * 的出站消息)持久化积压;窗口结束后按序补发。
 * 用户回合的即时回复(turnId)不受影响,直接发送。
 *
 * 队列文件为 append-only JSON(atomic rename 写),重启不丢;超过 maxAge
 * 的积压条目丢弃。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { OutboundMessage } from "./types.ts";

export interface QuietPushOptions {
	enabled?: boolean;
	/** 静默开始小时(本地时区,0-23)。 */
	start?: number;
	/** 静默结束小时(本地时区,0-23)。 */
	end?: number;
	/** 队列文件路径。 */
	queuePath: string;
	/** 实际发送实现(供失败重试/补发)。 */
	deliver: (message: OutboundMessage) => Promise<void>;
	nowFn?: () => Date;
	log?: (message: string) => void;
	/** 积压条目最大年龄(毫秒),默认 24h。 */
	maxAgeMs?: number;
	/** 惰性/定时补发检查间隔(ms),默认 60s。 */
	flushIntervalMs?: number;
}

interface QuietQueueEntry {
	channel: string;
	chatId: string;
	content: string;
	media?: string[];
	attachments?: OutboundMessage["attachments"];
	replyTo?: string;
	queuedAt: number;
}

const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function isQuietNow(now: Date, start: number, end: number): boolean {
	if (start < 0 || start > 23 || end < 0 || end > 23) return false;
	if (start === end) return false;
	const hour = now.getHours();
	if (start < end) return hour >= start && hour < end;
	return hour >= start || hour < end;
}

export class QuietPushGate {
	private readonly options: Omit<Required<QuietPushOptions>, "maxAgeMs" | "flushIntervalMs" | "log"> & {
		maxAgeMs: number;
		flushIntervalMs: number;
		log?: (message: string) => void;
	};
	private queue: QuietQueueEntry[] = [];
	private timer: NodeJS.Timeout | undefined;

	constructor(options: QuietPushOptions) {
		const nowFn = options.nowFn ?? (() => new Date());
		this.options = {
			enabled: options.enabled ?? false,
			start: options.start ?? 23,
			end: options.end ?? 9,
			queuePath: options.queuePath,
			deliver: options.deliver,
			nowFn,
			log: options.log,
			maxAgeMs: options.maxAgeMs ?? DEFAULT_MAX_AGE_MS,
			flushIntervalMs: options.flushIntervalMs ?? 60_000,
		};
		if (!this.options.enabled) return;
		this.load();
		this.timer = setInterval(() => void this.flush().catch(() => undefined), this.options.flushIntervalMs);
		this.timer.unref?.();
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}

	private isQuiet(now: Date): boolean {
		return isQuietNow(now, this.options.start, this.options.end);
	}

	/** 该出站消息应否走静默积压(仅主动推送:无 turnId、非事件消息)。 */
	shouldSuppress(message: OutboundMessage): boolean {
		if (!this.options.enabled) return false;
		if (message.turnId || message.event) return false;
		return this.isQuiet(this.options.nowFn());
	}

	/** 入队并持久化(不发送)。 */
	suppress(message: OutboundMessage): void {
		const entry: QuietQueueEntry = {
			channel: message.channel,
			chatId: message.chatId,
			content: message.content,
			...(message.media && message.media.length > 0 ? { media: message.media } : {}),
			...(message.attachments ? { attachments: message.attachments } : {}),
			...(message.replyTo ? { replyTo: message.replyTo } : {}),
			queuedAt: Date.now(),
		};
		this.queue.push(entry);
		this.persist();
		this.options.log?.(
			`quiet push queued channel=${message.channel} chat=${message.chatId} (${this.queue.length} pending)`,
		);
	}

	/** 静默期外按序补发积压;失败保留待下次。 */
	async flush(): Promise<void> {
		if (!this.options.enabled || this.queue.length === 0) return;
		if (this.isQuiet(this.options.nowFn())) return;
		const now = Date.now();
		const entries = this.queue;
		this.queue = [];
		const remaining: QuietQueueEntry[] = [];
		for (const entry of entries) {
			if (now - entry.queuedAt > this.options.maxAgeMs) continue;
			try {
				await this.options.deliver({
					channel: entry.channel,
					chatId: entry.chatId,
					content: entry.content,
					...(entry.media ? { media: entry.media } : {}),
					...(entry.attachments ? { attachments: entry.attachments } : {}),
					...(entry.replyTo ? { replyTo: entry.replyTo } : {}),
				});
				this.options.log?.(
					`quiet push delivered channel=${entry.channel} chat=${entry.chatId} (${remaining.length} left)`,
				);
			} catch (error) {
				remaining.push(entry);
				this.options.log?.(
					`quiet push delivery failed, kept: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		this.queue = remaining;
		this.persist();
	}

	/** 剩余积压条数(诊断/测试用)。 */
	pendingCount(): number {
		return this.queue.length;
	}

	private load(): void {
		try {
			if (!existsSync(this.options.queuePath)) return;
			const parsed = JSON.parse(readFileSync(this.options.queuePath, "utf-8")) as unknown;
			if (!Array.isArray(parsed)) return;
			const now = Date.now();
			this.queue = parsed.filter(
				(entry): entry is QuietQueueEntry =>
					isQuietQueueEntry(entry) && now - entry.queuedAt <= this.options.maxAgeMs,
			);
		} catch {
			this.queue = [];
		}
	}

	private persist(): void {
		try {
			mkdirSync(dirname(this.options.queuePath), { recursive: true });
			const tmpPath = `${this.options.queuePath}.tmp`;
			writeFileSync(tmpPath, JSON.stringify(this.queue, null, 2), "utf-8");
			renameSync(tmpPath, this.options.queuePath);
		} catch (error) {
			this.options.log?.(`quiet queue persist failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}

function isQuietQueueEntry(value: unknown): value is QuietQueueEntry {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.channel === "string" &&
		typeof record.chatId === "string" &&
		typeof record.content === "string" &&
		typeof record.queuedAt === "number"
	);
}
