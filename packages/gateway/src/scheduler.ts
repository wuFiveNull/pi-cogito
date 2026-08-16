/**
 * TurnScheduler — per-session serialization and global concurrency limiting
 * for inbound message handlers (mirrors nanobot's agent/loop.py turn
 * scheduling: one session's messages are processed in order, distinct
 * sessions run concurrently, and a semaphore caps total concurrency).
 */

import type { InboundMessage } from "./types.ts";

export interface TurnSchedulerOptions {
	/** Process each session's messages strictly in order. Default true. */
	serializeBySession?: boolean;
	/** Maximum concurrent turns (0 = unlimited). Default 0. */
	maxConcurrentTurns?: number;
}

export class TurnScheduler {
	private readonly serialize: boolean;
	private readonly maxConcurrent: number;
	private readonly chains = new Map<string, Promise<void>>();
	private active = 0;
	private readonly waiters: Array<() => void> = [];

	constructor(options: TurnSchedulerOptions = {}) {
		this.serialize = options.serializeBySession !== false;
		this.maxConcurrent = positiveInteger(options.maxConcurrentTurns, 0);
	}

	/**
	 * Queue one inbound message for processing. Resolves when the handler
	 * finishes; rejects with the handler's error (callers feed that into the
	 * bus retry machinery). A failed handler never breaks its session chain:
	 * later messages still run.
	 */
	enqueue(message: InboundMessage, run: () => Promise<void>): Promise<void> {
		if (!this.serialize) {
			return this.runLimited(run);
		}
		const key = message.sessionKey;
		const tail = this.chains.get(key) ?? Promise.resolve();
		const task = tail.then(() => this.runLimited(run));
		const chained = task.then(
			() => undefined,
			() => undefined,
		);
		this.chains.set(key, chained);
		const cleanup = (): void => {
			if (this.chains.get(key) === chained) this.chains.delete(key);
		};
		void task.then(cleanup, cleanup);
		return task;
	}

	private runLimited(run: () => Promise<void>): Promise<void> {
		return this.acquire().then(() =>
			run().finally(() => {
				this.release();
			}),
		);
	}

	private acquire(): Promise<void> {
		if (this.maxConcurrent <= 0 || this.active < this.maxConcurrent) {
			this.active++;
			return Promise.resolve();
		}
		return new Promise<void>((resolve) => {
			this.waiters.push(resolve);
		});
	}

	private release(): void {
		this.active--;
		const next = this.waiters.shift();
		if (next) {
			this.active++;
			next();
		}
	}
}

function positiveInteger(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}
