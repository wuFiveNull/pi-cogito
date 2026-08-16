/**
 * Pusher 热重载 supervisor(akashic runtime snapshot 热换的 pi 形态)。
 *
 * akashic 在插件重载时用 snapshot lease 停旧 kernel、起新 kernel(失败回滚);
 * pi 的 proactive 没有插件运行时,数据源是目录里的 .ts 文件、配置是 json,
 * 所以等价物是:watch 源目录与配置文件,变更后重建整个 pusher。
 *
 * 重建策略:支持 pause/resume 的实例通过 snapshot lease 先 quiesce 旧实例,
 * 再构建并 start 候选,commit 后 drain 旧实例;start 或构建失败保留旧实例继续运行。
 * 只有无法重新启动的 stop-only 实例才保留兼容路径;带 start/stop 的旧插件会
 * 自动适配为幂等 pause/resume,不再绕过 snapshot lease。
 */

import { type FSWatcher, watch } from "node:fs";
import { RuntimeReplayJournal, RuntimeSnapshotStore } from "./ext/snapshot.ts";

/** 可热换的实例:start 为可选校验步骤(失败则放弃新实例)。 */
export interface ReloadableInstance {
	/** 启动新实例(校验)。失败抛错 → 新实例被 abort,旧实例继续运行。 */
	start?(): Promise<void>;
	stop(): Promise<void>;
	/** Stop admitting new work while retaining resources for resume. */
	pause?(): Promise<void>;
	/** Resume a paused instance after candidate validation fails. */
	resume?(): Promise<void>;
}

export interface ReloadableOptions {
	/** watch 的路径(文件或目录);任一变更触发重建。 */
	watchPaths: string[];
	/** 构建新实例(不启动)。 */
	build(): Promise<ReloadableInstance>;
	/** 重建成功回调。 */
	onReload?(reason: string): void;
	/** 重建失败回调(旧实例继续运行)。 */
	onError?(error: unknown): void;
	/** 变更去抖毫秒数。 */
	debounceMs?: number;
	/** Optional durable snapshot journal. */
	snapshotJournalPath?: string;
}

export interface ReloadableHandle {
	stop(): Promise<void>;
	/** 构建次数(测试用)。 */
	buildCount(): number;
}

/**
 * Adapt a pre-snapshot plugin that exposes start/stop but no pause/resume.
 * A stop-only plugin cannot be safely rolled back and therefore remains on the
 * explicit compatibility path in runReloadable.
 */
export function adaptLegacyReloadableInstance(instance: ReloadableInstance): ReloadableInstance {
	if (typeof instance.pause === "function" && typeof instance.resume === "function") return instance;
	if (typeof instance.start !== "function") return instance;
	const rawStart = instance.start.bind(instance);
	const rawStop = instance.stop.bind(instance);
	const rawPause = instance.pause?.bind(instance);
	const rawResume = instance.resume?.bind(instance);
	let running = false;
	let startAttempted = false;
	let stopped = false;
	let paused = false;
	return {
		start: async () => {
			if (stopped || running) return;
			startAttempted = true;
			await rawStart();
			running = true;
			paused = false;
		},
		pause: async () => {
			if (stopped || paused || !running) return;
			running = false;
			paused = true;
			if (rawPause) await rawPause();
			else await rawStop();
		},
		resume: async () => {
			if (stopped || !paused) return;
			if (rawResume) await rawResume();
			else await rawStart();
			running = true;
			paused = false;
		},
		stop: async () => {
			if (stopped) return;
			stopped = true;
			if (running || startAttempted) await rawStop();
			running = false;
			paused = false;
		},
	};
}

/** 启动 supervisor:初始构建 + start,之后路径变更(去抖)重建。 */
export async function runReloadable(options: ReloadableOptions): Promise<ReloadableHandle> {
	let current = adaptLegacyReloadableInstance(await options.build());
	await startInstance(current);
	const snapshotStore =
		typeof current.pause === "function" && typeof current.resume === "function"
			? new RuntimeSnapshotStore<ReloadableInstance>({
					journal: options.snapshotJournalPath ? new RuntimeReplayJournal(options.snapshotJournalPath) : undefined,
					onDrainError: (snapshot, error) =>
						options.onError?.(toAggregateError([error], `snapshot drain failed: ${snapshot.snapshotId}`)),
				})
			: undefined;
	snapshotStore?.install(current, "snapshot-1");
	let buildCount = 1;
	const watchers: FSWatcher[] = [];
	let stopping = false;
	let timer: NodeJS.Timeout | undefined;
	let rebuildPromise: Promise<void> | undefined;
	let rebuildQueue = Promise.resolve();
	const debounceMs = options.debounceMs ?? 1000;

	const buildStarted = async (): Promise<ReloadableInstance> => {
		const next = adaptLegacyReloadableInstance(await options.build());
		await startInstance(next);
		return next;
	};

	const swap = async (next: ReloadableInstance, reason: string): Promise<void> => {
		const previous = current;
		try {
			await previous.stop();
		} catch (error) {
			try {
				await previous.start?.();
			} catch (restoreError) {
				throw toAggregateError([error, restoreError], "proactive reload old instance restore failed");
			}
			throw error;
		}
		current = next;
		buildCount++;
		options.onReload?.(reason);
	};

	const rebuild = async (reason: string): Promise<void> => {
		if (stopping) return;
		timer = undefined;
		if (snapshotStore) {
			const previousSnapshot = snapshotStore.current;
			let next: ReloadableInstance | undefined;
			let transaction: ReturnType<typeof snapshotStore.beginPublish> | undefined;
			let committed = false;
			try {
				await snapshotStore.quiesceCurrent();
				next = await buildStarted();
				if (stopping) {
					await stopQuietly(next);
					await snapshotStore.resume(previousSnapshot);
					return;
				}
				transaction = snapshotStore.beginPublish(next, `snapshot-${buildCount + 1}`);
				await snapshotStore.commit(transaction);
				committed = true;
				current = next;
				buildCount++;
				options.onReload?.(reason);
			} catch (error) {
				let reloadError: unknown = error;
				if (transaction && !committed) {
					try {
						await snapshotStore.abort(transaction);
					} catch (abortError) {
						reloadError = toAggregateError([reloadError, abortError], "proactive reload snapshot abort failed");
					}
				} else if (next && !committed) {
					await stopQuietly(next);
				}
				try {
					await snapshotStore.resume(previousSnapshot);
				} catch (restoreError) {
					reloadError = toAggregateError([reloadError, restoreError], "proactive reload snapshot resume failed");
				}
				options.onError?.(reloadError);
			}
			return;
		}
		let next: ReloadableInstance;
		try {
			next = await buildStarted();
		} catch (error) {
			// 端口冲突(monitor 固定端口):先停旧实例释放端口,再重试一次。
			if (isAddressInUse(error)) {
				const previous = current;
				try {
					await previous.stop();
				} catch (stopError) {
					const errors: unknown[] = [error, stopError];
					try {
						await previous.start?.();
					} catch (restoreError) {
						errors.push(restoreError);
					}
					options.onError?.(toAggregateError(errors, "proactive reload old instance stop failed"));
					return;
				}
				try {
					next = await buildStarted();
					if (stopping) {
						await stopQuietly(next);
						return;
					}
					current = next;
					buildCount++;
					options.onReload?.(`${reason} (port retry)`);
					return;
				} catch (retryError) {
					// 重试仍失败:恢复旧实例(akashic 候选 kernel 失败回滚旧 kernel 的等价物)。
					const errors: unknown[] = [retryError];
					try {
						await previous.start?.();
					} catch (restoreError) {
						errors.push(restoreError);
					}
					options.onError?.(toAggregateError(errors, "proactive reload rollback failed"));
					return;
				}
			}
			options.onError?.(error);
			return;
		}
		if (stopping) {
			await stopQuietly(next);
			return;
		}
		try {
			await swap(next, reason);
		} catch (error) {
			await stopQuietly(next);
			options.onError?.(error);
		}
	};

	const schedule = (reason: string): void => {
		if (stopping) return;
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => {
			timer = undefined;
			const queued = rebuildQueue.then(
				() => rebuild(reason),
				() => rebuild(reason),
			);
			rebuildQueue = queued.catch((error: unknown) => options.onError?.(error));
			rebuildPromise = rebuildQueue;
		}, debounceMs);
	};

	for (const path of options.watchPaths) {
		try {
			// 优先递归 watch;平台不支持时退回非递归。
			try {
				watchers.push(watch(path, { recursive: true }, () => schedule(path)));
			} catch {
				watchers.push(watch(path, () => schedule(path)));
			}
		} catch {
			// 路径不存在:跳过。
		}
	}

	return {
		stop: async () => {
			stopping = true;
			if (timer) clearTimeout(timer);
			for (const watcher of watchers) watcher.close();
			await rebuildPromise;
			if (snapshotStore) await snapshotStore.close();
			else await current.stop();
		},
		buildCount: () => buildCount,
	};
}

async function startInstance(instance: ReloadableInstance): Promise<void> {
	try {
		await instance.start?.();
	} catch (error) {
		try {
			await instance.stop();
		} catch (cleanupError) {
			throw toAggregateError([error, cleanupError], "proactive reload candidate cleanup failed");
		}
		throw error;
	}
}

async function stopQuietly(instance: ReloadableInstance): Promise<void> {
	try {
		await instance.stop();
	} catch {
		// Preserve the original reload failure; cleanup is best effort.
	}
}

function toAggregateError(errors: readonly unknown[], message: string): unknown {
	if (errors.length === 1) return errors[0];
	return new AggregateError(errors, message);
}

function isAddressInUse(error: unknown): boolean {
	if (typeof error !== "object" || error === null) return false;
	const code = (error as { code?: unknown }).code;
	if (code === "EADDRINUSE") return true;
	return String((error as { message?: unknown }).message ?? "").includes("address already in use");
}
