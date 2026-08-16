/**
 * SubagentManager — bounded delegation of sub-tasks to isolated sub-agents.
 *
 * Host-side equivalent of akashic's SubagentManager
 * (agent/background/subagent_manager.py):
 * - `spawn()` creates a background sub-task and returns control to the caller
 *   immediately; the result is delivered through the `onComplete` callback
 *   (chat wiring re-injects it into the origin session as a user message).
 * - `spawnSync()` runs the sub-task inline and returns the formatted result.
 * - Admission control enforces a concurrency cap (default 3) atomically for
 *   both modes; exceeding it throws `SubagentCapacityError` (the minimal
 *   DelegationPolicy equivalent: concurrency limit + block message).
 * - Per-job timeouts abort the worker and report a `timed_out` result instead
 *   of hanging; cancellation is supported for background jobs.
 * - All per-job state (timers, registrations, admission slots) is released in
 *   `finally`, so an idle manager keeps zero timers and zero state.
 *
 * The manager only orchestrates; the actual sub-agent execution is delegated
 * to a `SubagentRunner` (see subagent-runner.ts for the in-process default).
 */

import { randomUUID } from "node:crypto";

/** Terminal outcomes of a sub-task. */
export type SubagentRunStatus = "completed" | "failed" | "timed_out" | "cancelled";

/** Input for one sub-task execution. */
export interface SubagentRunRequest {
	/** Full task description handed to the sub-agent. Required, non-empty. */
	task: string;
	/** Short display label. Defaults to the task prefix. */
	label?: string;
	/** Tool whitelist for the sub-agent. Defaults to the runner's default tool set. */
	tools?: string[];
	/** Per-job timeout in milliseconds. 0 disables. Defaults to the manager default. */
	timeoutMs?: number;
	/** Optional per-job system prompt override. */
	systemPrompt?: string;
}

/** Result of a sub-task execution. */
export interface SubagentRunResult {
	status: SubagentRunStatus;
	/** Short reason: "completed", "error", "aborted", "timeout", or the LLM error message. */
	exitReason: string;
	/** Final reply text, or an error description. */
	result: string;
}

/**
 * Executes one sub-task with an isolated context.
 * `run()` must observe `signal` and settle (returning a terminal result)
 * when it aborts, rather than hanging.
 */
export interface SubagentRunner {
	run(request: SubagentRunRequest, signal: AbortSignal): Promise<SubagentRunResult>;
	/** Release any shared resources held by the runner. */
	shutdown(): Promise<void> | void;
}

/** Snapshot of a background job for `listRunningJobs()`. */
export interface RunningSubagentJob {
	jobId: string;
	label: string;
	task: string;
	startedAt: number;
	status: "running" | SubagentRunStatus;
}

/** Thrown when the sub-agent admission slot is full. */
export class SubagentCapacityError extends Error {
	readonly active: number;
	readonly maximum: number;

	constructor(active: number, maximum: number) {
		super(`subagent capacity reached: active=${active}, max=${maximum}; current spawn rejected`);
		this.name = "SubagentCapacityError";
		this.active = active;
		this.maximum = maximum;
	}
}

export interface SubagentManagerOptions {
	/** Executes individual sub-tasks. */
	runner: SubagentRunner;
	/** Concurrency cap for background and sync sub-tasks combined. Default: 3. */
	maxConcurrent?: number;
	/** Timeout applied when a request does not specify one. 0 disables. Default: 0. */
	defaultTimeoutMs?: number;
	/**
	 * Called once per background job with its terminal result (including
	 * timed_out and cancelled). Sync jobs do not trigger it. Errors thrown by
	 * the callback are logged, never propagated.
	 */
	onComplete?: (jobId: string, result: SubagentRunResult) => void;
	/** Cap for result text in `spawnSync` output. Default: 100000 (akashic parity). */
	syncResultMaxChars?: number;
	log?: (message: string) => void;
}

export const DEFAULT_MAX_CONCURRENT_SUBAGENTS = 3;
export const DEFAULT_SUBAGENT_SYNC_RESULT_MAX_CHARS = 100_000;

interface JobEntry {
	jobId: string;
	label: string;
	task: string;
	startedAt: number;
	status: "running" | SubagentRunStatus;
	controller: AbortController;
	promise?: Promise<void>;
}

interface JobControl {
	controller: AbortController;
	timeoutTimer: NodeJS.Timeout | undefined;
	timedOut: boolean;
}

export class SubagentManager {
	private readonly _runner: SubagentRunner;
	private readonly _maxConcurrent: number;
	private readonly _defaultTimeoutMs: number;
	private _onComplete: ((jobId: string, result: SubagentRunResult) => void) | undefined;
	private readonly _syncResultMaxChars: number;
	private readonly _log: ((message: string) => void) | undefined;
	private readonly _jobs = new Map<string, JobEntry>();
	private _activeCount = 0;

	constructor(options: SubagentManagerOptions) {
		this._runner = options.runner;
		this._maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT_SUBAGENTS;
		if (this._maxConcurrent < 1) {
			throw new Error("subagent maxConcurrent must be positive");
		}
		this._defaultTimeoutMs = options.defaultTimeoutMs ?? 0;
		this._onComplete = options.onComplete;
		this._syncResultMaxChars = options.syncResultMaxChars ?? DEFAULT_SUBAGENT_SYNC_RESULT_MAX_CHARS;
		this._log = options.log;
	}

	/** Number of currently running sub-tasks (background + sync). */
	getRunningCount(): number {
		return this._activeCount;
	}

	/**
	 * Replace the background-completion handler.
	 * Extension mounting uses this to bind delivery into the origin session
	 * (e.g. sendUserMessage) at extension-load time, when `pi` is available.
	 */
	setCompletionHandler(handler: ((jobId: string, result: SubagentRunResult) => void) | undefined): void {
		this._onComplete = handler;
	}

	/** Snapshot of background jobs still in flight or completing. */
	listRunningJobs(): RunningSubagentJob[] {
		return [...this._jobs.values()].map((entry) => ({
			jobId: entry.jobId,
			label: entry.label,
			task: entry.task,
			startedAt: entry.startedAt,
			status: entry.status,
		}));
	}

	/**
	 * Create a background sub-task and return control immediately.
	 *
	 * Returns an acknowledgement string for the caller to relay to the main
	 * agent. The terminal result is delivered via the `onComplete` callback.
	 *
	 * @throws SubagentCapacityError when the admission slot is full.
	 * @throws Error when the task text is empty.
	 */
	spawn(request: SubagentRunRequest): string {
		const task = request.task.trim();
		if (task.length === 0) {
			throw new Error("subagent task must not be empty");
		}
		this._acquireAdmission();
		const jobId = randomUUID().slice(0, 8);
		const label = this._normalizeLabel(request.label, task, jobId);
		const control = this._createControl(request);
		const entry: JobEntry = {
			jobId,
			label,
			task,
			startedAt: Date.now(),
			status: "running",
			controller: control.controller,
		};
		this._jobs.set(jobId, entry);
		entry.promise = this._runJob(entry, request, control);
		this._log?.(`[subagent] spawned job_id=${jobId} label=${label}`);
		return (
			`已创建后台子任务「${label}」(job_id=${jobId})。` +
			"不要等待其完成；请直接向用户说明你已开始处理，完成后结果会带回当前会话继续处理。"
		);
	}

	/**
	 * Run a sub-task synchronously and return the formatted result text.
	 *
	 * `signal` is optional and aborts the sub-task when the caller's run is
	 * cancelled (reported as `cancelled`, distinct from a timeout).
	 *
	 * @throws SubagentCapacityError when the admission slot is full.
	 * @throws Error when the task text is empty.
	 */
	async spawnSync(request: SubagentRunRequest, signal?: AbortSignal): Promise<string> {
		const task = request.task.trim();
		if (task.length === 0) {
			throw new Error("subagent task must not be empty");
		}
		this._acquireAdmission();
		const label = this._normalizeLabel(request.label, task, "sync");
		const control = this._createControl(request);
		const onExternalAbort = (): void => control.controller.abort();
		signal?.addEventListener("abort", onExternalAbort, { once: true });
		try {
			let result: SubagentRunResult;
			try {
				result = await this._runner.run(request, control.controller.signal);
			} catch (error) {
				result = {
					status: "failed",
					exitReason: "error",
					result: error instanceof Error ? error.message : String(error),
				};
			}
			if (control.controller.signal.aborted) {
				result = {
					status: control.timedOut ? "timed_out" : "cancelled",
					exitReason: "aborted",
					result: result.result || (control.timedOut ? "子任务超时。" : "子任务已取消。"),
				};
			}
			return this._formatSyncResult(label, result);
		} finally {
			signal?.removeEventListener("abort", onExternalAbort);
			this._releaseControl(control);
			this._activeCount--;
		}
	}

	/** Cancel a background job. Returns false when the job is unknown or finished. */
	cancel(jobId: string): boolean {
		const entry = this._jobs.get(jobId);
		if (!entry || entry.status !== "running") {
			return false;
		}
		entry.controller.abort();
		this._log?.(`[subagent] cancel requested job_id=${jobId}`);
		return true;
	}

	/** Cancel all background jobs and release runner resources. */
	async shutdown(): Promise<void> {
		const entries = [...this._jobs.values()];
		for (const entry of entries) {
			entry.controller.abort();
		}
		await Promise.allSettled(entries.map((entry) => entry.promise ?? Promise.resolve()));
		await this._runner.shutdown();
	}

	private _acquireAdmission(): void {
		if (this._activeCount >= this._maxConcurrent) {
			throw new SubagentCapacityError(this._activeCount, this._maxConcurrent);
		}
		this._activeCount++;
	}

	private _normalizeLabel(label: string | undefined, task: string, fallback: string): string {
		const normalized = (label ?? task.slice(0, 30)).trim();
		return normalized.length > 0 ? normalized : fallback;
	}

	private _createControl(request: SubagentRunRequest): JobControl {
		const control: JobControl = {
			controller: new AbortController(),
			timeoutTimer: undefined,
			timedOut: false,
		};
		const timeoutMs = request.timeoutMs ?? this._defaultTimeoutMs;
		if (timeoutMs > 0) {
			control.timeoutTimer = setTimeout(() => {
				control.timedOut = true;
				control.controller.abort();
			}, timeoutMs);
			control.timeoutTimer.unref?.();
		}
		return control;
	}

	private _releaseControl(control: JobControl): void {
		if (control.timeoutTimer) {
			clearTimeout(control.timeoutTimer);
			control.timeoutTimer = undefined;
		}
	}

	private async _runJob(entry: JobEntry, request: SubagentRunRequest, control: JobControl): Promise<void> {
		try {
			let result: SubagentRunResult;
			try {
				result = await this._runner.run(request, control.controller.signal);
			} catch (error) {
				result = {
					status: "failed",
					exitReason: "error",
					result: error instanceof Error ? error.message : String(error),
				};
			}
			if (control.controller.signal.aborted) {
				result = {
					status: control.timedOut ? "timed_out" : "cancelled",
					exitReason: "aborted",
					result: result.result || (control.timedOut ? "子任务超时。" : "子任务已取消。"),
				};
			}
			entry.status = result.status;
			this._log?.(`[subagent] completed job_id=${entry.jobId} status=${result.status}`);
			try {
				this._onComplete?.(entry.jobId, result);
			} catch (error) {
				this._log?.(`[subagent] onComplete failed job_id=${entry.jobId} err=${String(error)}`);
			}
		} finally {
			this._releaseControl(control);
			this._jobs.delete(entry.jobId);
			this._activeCount--;
		}
	}

	private _formatSyncResult(label: string, result: SubagentRunResult): string {
		let text = result.result;
		if (text.length > this._syncResultMaxChars) {
			const originalLength = text.length;
			text = `${text.slice(0, this._syncResultMaxChars)}\n...[结果已截断,原始长度 ${originalLength}]`;
		}
		return `[子任务「${label}」结果]\n状态: ${result.status}\n退出原因: ${result.exitReason}\n\n${text}`;
	}
}
