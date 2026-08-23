/**
 * 会话记忆提取循环(akashic 主 agent 对话流程的轮询形态)。
 *
 * akashic 的 consolidation 由对话事件驱动(逐页提交 + 绝对游标);
 * pi 无对话事件钩子,以对齐整点轮询 session 目录等价实现:
 * 每个周期扫描 jsonl 会话文件,对每个有新增消息的会话执行 consolidateSession。
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
	type ConsolidatedPayload,
	type ConsolidationConfig,
	consolidateSession,
	type SessionCursorStore,
} from "./extract.ts";
import { secondsUntilAlignedInterval } from "./loop.ts";
import type { MarkdownMemoryStore } from "./markdown-store.ts";
import type { MemoryLlm } from "./optimizer.ts";

const DEFAULT_INTERVAL_SECONDS = 900; // 15 分钟

export interface ConsolidationLoopOptions {
	store: MarkdownMemoryStore;
	llm: MemoryLlm;
	sessionsDir: string;
	cursorStore: SessionCursorStore;
	intervalSeconds?: number;
	config?: ConsolidationConfig;
	/** 向量层桥接回调:consolidation 写 markdown 后、推进游标前调用。 */
	onConsolidated?: (payload: ConsolidatedPayload) => Promise<void> | void;
	/** 每轮 consolidation 后刷新 RECENT_CONTEXT.md(周期路径默认开启)。 */
	writeRecentContext?: boolean;
	nowFn?: () => Date;
}

export class ConsolidationLoop {
	private readonly store: MarkdownMemoryStore;
	private readonly llm: MemoryLlm;
	private readonly sessionsDir: string;
	private readonly cursorStore: SessionCursorStore;
	private readonly interval: number;
	private readonly config: ConsolidationConfig;
	private readonly onConsolidated: ((payload: ConsolidatedPayload) => Promise<void> | void) | undefined;
	private readonly writeRecentContext: boolean;
	private readonly nowFn: () => Date;
	private running = false;
	private wakeSleep: (() => void) | undefined;
	private consolidationPromise: Promise<number> | undefined;

	constructor(options: ConsolidationLoopOptions) {
		this.store = options.store;
		this.llm = options.llm;
		this.sessionsDir = options.sessionsDir;
		this.cursorStore = options.cursorStore;
		this.interval = Math.max(60, options.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS);
		this.config = options.config ?? {};
		this.onConsolidated = options.onConsolidated;
		this.writeRecentContext = options.writeRecentContext ?? true;
		this.nowFn = options.nowFn ?? (() => new Date());
	}

	async run(): Promise<void> {
		this.running = true;
		while (this.running) {
			const seconds = secondsUntilAlignedInterval(this.nowFn(), this.interval);
			await this.sleep(seconds * 1000);
			if (!this.running) break;
			await this.consolidateAll();
		}
	}

	stop(): void {
		this.running = false;
		this.wakeSleep?.();
	}

	/** 扫描全部会话文件并 consolidation(单文件失败不影响其他)。 */
	async consolidateAll(): Promise<number> {
		if (this.consolidationPromise) return this.consolidationPromise;
		const running = this.consolidateAllInner();
		this.consolidationPromise = running;
		try {
			return await running;
		} finally {
			if (this.consolidationPromise === running) this.consolidationPromise = undefined;
		}
	}

	private async consolidateAllInner(): Promise<number> {
		let touched = 0;
		for (const file of listSessionFiles(this.sessionsDir)) {
			try {
				const result = await consolidateSession({
					store: this.store,
					llm: this.llm,
					sessionFile: file,
					cursorStore: this.cursorStore,
					config: this.config,
					onConsolidated: this.onConsolidated,
					writeRecentContext: this.writeRecentContext,
				});
				if (result.consolidated > 0) touched++;
			} catch {
				// 单会话提取失败(网络/解析)跳过,游标不推进,下轮重试。
			}
		}
		return touched;
	}

	private sleep(ms: number): Promise<void> {
		return new Promise<void>((resolve) => {
			this.wakeSleep = resolve;
			setTimeout(() => {
				this.wakeSleep = undefined;
				resolve();
			}, ms);
		});
	}
}

export function listSessionFiles(sessionsDir: string): string[] {
	const files: string[] = [];
	try {
		for (const name of readdirSync(sessionsDir)) {
			const full = join(sessionsDir, name);
			if (name.endsWith(".jsonl")) files.push(full);
			else if (statSync(full).isDirectory()) {
				for (const inner of readdirSync(full)) {
					if (inner.endsWith(".jsonl")) files.push(join(full, inner));
				}
			}
		}
	} catch {
		return [];
	}
	return files;
}
