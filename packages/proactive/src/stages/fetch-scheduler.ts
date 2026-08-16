/**
 * Schedulers (akashic proactive_v2 design).
 *
 * - SourceScheduler: fixed per-source fetch polling (akashic feed poller:
 *   feed_poller_interval_seconds). Individual source failures never stop the
 *   loop; backoff prevents hammering a broken upstream.
 * - ProactiveTickScheduler: adaptive tick interval driven by base_score
 *   (energy model). A higher score -> shorter interval -> more lottery draws
 *   per unit time (akashic ProactiveScheduler.next_interval).
 */

import { type Clock, SystemClock } from "../clock.ts";
import type { SourceHealthTracker } from "../runtime/source-health.ts";

export interface SchedulerSource {
	id: string;
	fetch(): Promise<unknown>;
}

export interface SchedulerConfig {
	/** Per-source interval overrides in milliseconds. */
	intervals?: Record<string, number>;
	/** Tick interval. Default 60s. */
	tickMs?: number;
	/** Backoff multiplier after consecutive failures. Default 2. */
	failureBackoff?: number;
	/** 可注入时钟。 */
	clock?: Clock;
	/** Optional durable state for restart-safe last-fetch/backoff recovery. */
	stateStore?: SchedulerStateStore;
	/** Optional durable source health and circuit breaker. */
	healthTracker?: SourceHealthTracker;
}

export interface SchedulerStateStore {
	getState(key: string): string | undefined;
	setState(key: string, value: string): void;
}

interface SourceState {
	lastFetchedAt: number;
	consecutiveFailures: number;
}

/** Fixed-interval poller for data sources (akashic feed poller). */
export class SourceScheduler {
	private states = new Map<string, SourceState>();
	private timer: NodeJS.Timeout | undefined;
	private running = false;

	private readonly sources: SchedulerSource[];
	private readonly config: SchedulerConfig;
	private readonly onFetch: (id: string) => void | Promise<void>;
	private readonly onError: (id: string, error: unknown) => void;

	constructor(
		sources: SchedulerSource[],
		config: SchedulerConfig = {},
		onFetch: (id: string) => void | Promise<void>,
		onError: (id: string, error: unknown) => void = () => {},
	) {
		this.sources = sources;
		this.config = config;
		this.onFetch = onFetch;
		this.onError = onError;
	}

	start(): void {
		if (this.running) return;
		this.running = true;
		void this.tick();
		this.timer = setInterval(() => void this.tick(), this.config.tickMs ?? 60_000);
		// 常驻进程:scheduler 是事件循环的唯一活跃句柄,不能 unref,否则进程会退出。
	}

	/** Execute one due-source pass without starting a background timer. */
	async runOnce(): Promise<void> {
		await this.tick(true);
	}

	stop(): void {
		this.running = false;
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}

	private async tick(allowStopped = false): Promise<void> {
		if (!this.running && !allowStopped) return;
		const now = this.config.clock?.nowMs() ?? SystemClock.nowMs();
		for (const source of this.sources) {
			if (!this.running && !allowStopped) return;
			const state = this.stateFor(source.id);
			const interval = this.config.intervals?.[source.id] ?? 24 * 3600_000;
			const backoff = (this.config.failureBackoff ?? 2) ** state.consecutiveFailures;
			if (now - state.lastFetchedAt < interval * backoff) continue;
			if (this.config.healthTracker && !this.config.healthTracker.tryAcquire(source.id, now)) {
				this.config.healthTracker.recordSkipped(source.id, now);
				continue;
			}

			state.lastFetchedAt = now;
			this.states.set(source.id, state);
			this.persistState(source.id, state);
			try {
				await this.onFetch(source.id);
				state.consecutiveFailures = 0;
				this.persistState(source.id, state);
			} catch (error) {
				state.consecutiveFailures++;
				this.persistState(source.id, state);
				this.config.healthTracker?.recordFailure(source.id, now, formatError(error));
				// stop() 之后不再上报(store 可能已关闭)。
				if (this.running || allowStopped) {
					try {
						this.onError(source.id, error);
					} catch (handlerError) {
						console.error(`proactive source error handler failed: ${formatError(handlerError)}`);
					}
				}
			}
		}
	}

	private stateFor(sourceId: string): SourceState {
		const existing = this.states.get(sourceId);
		if (existing) return existing;
		const state = readPersistedState(this.config.stateStore, sourceId);
		this.states.set(sourceId, state);
		return state;
	}

	private persistState(sourceId: string, state: SourceState): void {
		this.config.stateStore?.setState(
			`sourceScheduler.${sourceId}`,
			JSON.stringify({ lastFetchedAt: state.lastFetchedAt, consecutiveFailures: state.consecutiveFailures }),
		);
		this.config.stateStore?.setState(`lastFetchedAt.${sourceId}`, String(state.lastFetchedAt));
	}
}

// ------------------------------------------------------------------
// 获取策略(默认:固定间隔轮询 + 失败退避)
// ------------------------------------------------------------------

import type { FetchStrategy } from "./types.ts";

export interface PollSourceInstance {
	id: string;
	/** 已包装的抓取函数:拉取数据源 → 入库,返回本轮统计。 */
	fetch(): Promise<{ received: number; inserted: number; duplicates: number; quarantined: number }>;
}

export class SourcePollStrategy implements FetchStrategy {
	readonly id = "source-poll";
	readonly tickDriven: boolean;
	private scheduler: SourceScheduler | undefined;
	private readonly sources: PollSourceInstance[];
	private readonly intervals: Record<string, number>;
	private readonly tickMs: number;
	private readonly clock: Clock | undefined;
	private readonly stateStore: SchedulerStateStore | undefined;
	private readonly healthTracker: SourceHealthTracker | undefined;
	private onFetched: (
		sourceId: string,
		stats: { received: number; inserted: number; duplicates: number; quarantined: number },
	) => void = () => {};
	private onError: (sourceId: string, error: unknown) => void = () => {};

	constructor(
		sources: PollSourceInstance[],
		intervals: Record<string, number>,
		tickMs = 60_000,
		clock?: Clock,
		stateStore?: SchedulerStateStore,
		tickDriven = false,
		healthTracker?: SourceHealthTracker,
	) {
		this.sources = sources;
		this.intervals = intervals;
		this.tickMs = tickMs;
		this.clock = clock;
		this.stateStore = stateStore;
		this.tickDriven = tickDriven;
		this.healthTracker = healthTracker;
	}

	start(
		onFetched: (
			sourceId: string,
			stats: { received: number; inserted: number; duplicates: number; quarantined: number },
		) => void,
		onError: (sourceId: string, error: unknown) => void,
	): void {
		this.onFetched = onFetched;
		this.onError = onError;
		if (this.tickDriven) return;
		this.scheduler = new SourceScheduler(
			this.sources,
			{
				intervals: this.intervals,
				tickMs: this.tickMs,
				clock: this.clock,
				stateStore: this.stateStore,
				healthTracker: this.healthTracker,
			},
			async (id) => {
				const entry = this.sources.find((candidate) => candidate.id === id);
				if (!entry) return;
				const stats = await entry.fetch();
				this.healthTracker?.recordSuccess(id, this.clock?.nowMs() ?? SystemClock.nowMs(), stats);
				this.onFetched(id, stats);
			},
			this.onError,
		);
		this.scheduler.start();
	}

	async runOnce(): Promise<void> {
		if (!this.scheduler) {
			this.scheduler = new SourceScheduler(
				this.sources,
				{
					intervals: this.intervals,
					tickMs: this.tickMs,
					clock: this.clock,
					stateStore: this.stateStore,
					healthTracker: this.healthTracker,
				},
				async (id) => {
					const entry = this.sources.find((candidate) => candidate.id === id);
					if (!entry) return;
					const stats = await entry.fetch();
					this.healthTracker?.recordSuccess(id, this.clock?.nowMs() ?? SystemClock.nowMs(), stats);
					this.onFetched(id, stats);
				},
				this.onError,
			);
		}
		await this.scheduler.runOnce();
	}

	stop(): void {
		this.scheduler?.stop();
		this.scheduler = undefined;
	}
}

function readPersistedState(stateStore: SchedulerStateStore | undefined, sourceId: string): SourceState {
	const raw = stateStore?.getState(`sourceScheduler.${sourceId}`);
	if (raw) {
		try {
			const parsed: unknown = JSON.parse(raw);
			if (isRecord(parsed)) {
				const lastFetchedAt = finiteNonNegative(parsed.lastFetchedAt);
				const consecutiveFailures = finiteNonNegative(parsed.consecutiveFailures);
				if (lastFetchedAt !== undefined && consecutiveFailures !== undefined) {
					return { lastFetchedAt, consecutiveFailures: Math.floor(consecutiveFailures) };
				}
			}
		} catch {
			// Corrupt scheduler state is treated as a cold start; the next fetch rewrites it.
		}
	}
	const legacyLastFetchedAt = finiteNonNegative(stateStore?.getState(`lastFetchedAt.${sourceId}`));
	return { lastFetchedAt: legacyLastFetchedAt ?? 0, consecutiveFailures: 0 };
}

function finiteNonNegative(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
