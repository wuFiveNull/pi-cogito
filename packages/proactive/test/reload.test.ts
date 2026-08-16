import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { adaptLegacyReloadableInstance, runReloadable } from "../src/reload.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "reload-"));
	tempDirs.push(dir);
	return dir;
}

/** 轮询等待条件(真实计时器下等 fs.watch 事件)。 */
async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
	const start = Date.now();
	while (!condition()) {
		if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

describe("runReloadable (akashic snapshot hot-swap 的 pi 形态)", () => {
	it("adapts start/stop legacy instances into snapshot pause/resume", async () => {
		const starts: string[] = [];
		const stops: string[] = [];
		const legacy = {
			start: async () => {
				starts.push("start");
			},
			stop: async () => {
				stops.push("stop");
			},
		};
		const adapted = adaptLegacyReloadableInstance(legacy);
		await adapted.start?.();
		await adapted.pause?.();
		await adapted.resume?.();
		await adapted.stop();
		expect(starts).toEqual(["start", "start"]);
		expect(stops).toEqual(["stop", "stop"]);
	});

	it("quiesces and drains snapshot-capable instances around a reload", async () => {
		const dir = makeDir();
		writeFileSync(join(dir, "source.ts"), "x");
		const instances: Array<{
			start: ReturnType<typeof vi.fn>;
			pause: ReturnType<typeof vi.fn>;
			resume: ReturnType<typeof vi.fn>;
			stop: ReturnType<typeof vi.fn>;
		}> = [];
		const build = vi.fn(async () => {
			const instance = {
				start: vi.fn(async () => {}),
				pause: vi.fn(async () => {}),
				resume: vi.fn(async () => {}),
				stop: vi.fn(async () => {}),
			};
			instances.push(instance);
			return instance;
		});
		const handle = await runReloadable({ watchPaths: [dir], build, debounceMs: 25 });
		writeFileSync(join(dir, "source.ts"), "changed");
		await waitFor(() => handle.buildCount() === 2);

		expect(instances[0]?.pause).toHaveBeenCalledTimes(1);
		expect(instances[0]?.stop).toHaveBeenCalledTimes(1);
		expect(instances[1]?.start).toHaveBeenCalledTimes(1);
		expect(instances[1]?.resume).not.toHaveBeenCalled();

		await handle.stop();
		expect(instances[1]?.pause).toHaveBeenCalledTimes(1);
		expect(instances[1]?.stop).toHaveBeenCalledTimes(1);
	});

	it("rebuilds after a watched path changes (debounced)", async () => {
		const dir = makeDir();
		writeFileSync(join(dir, "source.ts"), "export default class A { id = 'a' }");
		const stops: Array<() => Promise<void>> = [];
		const build = vi.fn(async () => {
			const stop = vi.fn(async () => {});
			stops.push(stop);
			return { stop };
		});
		const onReload = vi.fn();
		const handle = await runReloadable({
			watchPaths: [dir],
			build,
			onReload,
			debounceMs: 50,
		});
		expect(handle.buildCount()).toBe(1);

		writeFileSync(join(dir, "source.ts"), "export default class A { id = 'a' }\n// changed");
		await waitFor(() => handle.buildCount() === 2);
		expect(onReload).toHaveBeenCalledTimes(1);
		// 旧实例已停止。
		expect(stops[0]).toHaveBeenCalled();

		// 去抖:连续多次变更只触发一次重建。
		writeFileSync(join(dir, "source.ts"), "// 1");
		writeFileSync(join(dir, "source.ts"), "// 2");
		await waitFor(() => handle.buildCount() === 3);
		expect(onReload).toHaveBeenCalledTimes(2);
		expect(stops.length).toBe(3);

		await handle.stop();
		expect(stops[stops.length - 1]).toHaveBeenCalled();
	});

	it("keeps the old instance running when a rebuild fails", async () => {
		const dir = makeDir();
		writeFileSync(join(dir, "a.ts"), "x");
		const stops: Array<() => Promise<void>> = [];
		let failing = false;
		const build = vi.fn(async () => {
			if (failing) throw new Error("build boom");
			const stop = vi.fn(async () => {});
			stops.push(stop);
			return { stop };
		});
		const onError = vi.fn();
		const handle = await runReloadable({
			watchPaths: [dir],
			build,
			onError,
			debounceMs: 50,
		});

		failing = true;
		writeFileSync(join(dir, "a.ts"), "y");
		await waitFor(() => onError.mock.calls.length === 1);
		expect(handle.buildCount()).toBe(1); // 旧实例保留
		expect(stops).toHaveLength(1); // 旧实例未被 stop

		failing = false;
		writeFileSync(join(dir, "a.ts"), "z");
		await waitFor(() => handle.buildCount() === 2);
		expect(stops).toHaveLength(2);
		await handle.stop();
	});

	it("keeps the old instance running when the candidate start fails", async () => {
		const dir = makeDir();
		writeFileSync(join(dir, "a.ts"), "x");
		const stops: Array<() => Promise<void>> = [];
		let failStart = false;
		const build = vi.fn(async () => {
			const stop = vi.fn(async () => {});
			stops.push(stop);
			return {
				start: async () => {
					if (failStart) throw new Error("start boom");
				},
				stop,
			};
		});
		const onError = vi.fn();
		const handle = await runReloadable({
			watchPaths: [dir],
			build,
			onError,
			debounceMs: 50,
		});

		failStart = true;
		writeFileSync(join(dir, "a.ts"), "y");
		await waitFor(() => onError.mock.calls.length === 1);
		// 候选 start 失败 → 新实例被清理,旧实例保留且未被 stop。
		expect(handle.buildCount()).toBe(1);
		expect(stops).toHaveLength(2);
		expect(stops[1]).toHaveBeenCalled();

		failStart = false;
		writeFileSync(join(dir, "a.ts"), "z");
		await waitFor(() => handle.buildCount() === 2);
		await handle.stop();
	});

	it("restores the old instance when swapping it fails to stop", async () => {
		const dir = makeDir();
		writeFileSync(join(dir, "a.ts"), "x");
		let failOldStop = true;
		const starts: Array<() => Promise<void>> = [];
		const stops: Array<() => Promise<void>> = [];
		const build = vi.fn(async () => {
			const start = vi.fn(async () => {});
			const stop = vi.fn(async () => {
				if (failOldStop && starts[0] === start) {
					failOldStop = false;
					throw new Error("old stop boom");
				}
			});
			starts.push(start);
			stops.push(stop);
			return { start, stop };
		});
		const onError = vi.fn();
		const handle = await runReloadable({ watchPaths: [dir], build, onError, debounceMs: 50 });

		writeFileSync(join(dir, "a.ts"), "y");
		await waitFor(() => onError.mock.calls.length === 1);
		expect(handle.buildCount()).toBe(1);
		expect(starts[0]).toHaveBeenCalledTimes(2); // initial start + rollback start
		expect(stops).toHaveLength(1); // pause failed before a candidate was built

		await handle.stop();
	});

	it("serializes rebuilds triggered while a previous build is in flight", async () => {
		const dir = makeDir();
		writeFileSync(join(dir, "a.ts"), "x");
		let releaseFirstBuild: (() => void) | undefined;
		let firstBuildStarted: (() => void) | undefined;
		const firstBuildReady = new Promise<void>((resolve) => {
			firstBuildStarted = resolve;
		});
		const firstBuildRelease = new Promise<void>((resolve) => {
			releaseFirstBuild = resolve;
		});
		let activeBuilds = 0;
		let maxActiveBuilds = 0;
		let buildCalls = 0;
		const build = vi.fn(async () => {
			buildCalls++;
			activeBuilds++;
			maxActiveBuilds = Math.max(maxActiveBuilds, activeBuilds);
			try {
				if (buildCalls === 2) {
					firstBuildStarted?.();
					await firstBuildRelease;
				}
				return { stop: vi.fn(async () => {}) };
			} finally {
				activeBuilds--;
			}
		});
		const handle = await runReloadable({ watchPaths: [dir], build, debounceMs: 25 });

		writeFileSync(join(dir, "a.ts"), "y");
		await firstBuildReady;
		writeFileSync(join(dir, "a.ts"), "z");
		releaseFirstBuild?.();
		await waitFor(() => handle.buildCount() === 3);
		expect(buildCalls).toBe(3);
		expect(maxActiveBuilds).toBe(1);
		await handle.stop();
	});

	it("retries once with stop-first on address-in-use", async () => {
		const dir = makeDir();
		writeFileSync(join(dir, "a.ts"), "x");
		const stops: Array<() => Promise<void>> = [];
		let conflictNext = false;
		const build = vi.fn(async () => {
			if (conflictNext) {
				conflictNext = false;
				const error = new Error("listen EADDRINUSE: address already in use");
				(error as Error & { code?: string }).code = "EADDRINUSE";
				throw error;
			}
			const stop = vi.fn(async () => {});
			stops.push(stop);
			return { stop };
		});
		const onError = vi.fn();
		const onReload = vi.fn();
		const handle = await runReloadable({
			watchPaths: [dir],
			build,
			onError,
			onReload,
			debounceMs: 50,
		});

		// 重建时端口冲突 → 停旧实例后重试成功。
		conflictNext = true;
		writeFileSync(join(dir, "a.ts"), "y");
		await waitFor(() => handle.buildCount() === 2);
		expect(onError).not.toHaveBeenCalled(); // 重试成功,不报错
		expect(onReload).toHaveBeenCalledWith(expect.stringContaining("port retry"));
		await handle.stop();
	});

	it("restores the old instance when the address-in-use retry also fails", async () => {
		const dir = makeDir();
		writeFileSync(join(dir, "a.ts"), "x");
		const stops: Array<() => Promise<void>> = [];
		const starts: Array<() => Promise<void>> = [];
		let conflict = false;
		const build = vi.fn(async () => {
			const stop = vi.fn(async () => {});
			stops.push(stop);
			const instance = {
				start: async () => {
					starts.push(vi.fn(async () => {}));
					if (conflict) {
						const error = new Error("listen EADDRINUSE: address already in use");
						(error as Error & { code?: string }).code = "EADDRINUSE";
						throw error;
					}
				},
				stop,
			};
			return instance;
		});
		const onError = vi.fn();
		const handle = await runReloadable({
			watchPaths: [dir],
			build,
			onError,
			debounceMs: 50,
		});

		// 重建候选与重试都 EADDRINUSE → 旧实例重新 start(akashic 回滚旧 kernel)。
		conflict = true;
		writeFileSync(join(dir, "a.ts"), "y");
		await waitFor(() => onError.mock.calls.length === 1);
		expect(handle.buildCount()).toBe(1); // 未换新实例
		expect(starts.length).toBe(3); // 初始 start + 候选 start 失败 + 恢复旧实例 start
		expect(stops).toHaveLength(2); // 旧实例 pause + 候选 cleanup
		expect(stops[0]).toHaveBeenCalled(); // 旧实例被 stop 过(且已重新 start)
		expect(stops[1]).toHaveBeenCalled(); // 第一个候选实例启动失败后被清理

		conflict = false;
		writeFileSync(join(dir, "a.ts"), "z");
		await waitFor(() => handle.buildCount() === 2);
		await handle.stop();
	});

	it("ignores missing watch paths", async () => {
		const build = vi.fn(async () => ({ stop: vi.fn(async () => {}) }));
		const handle = await runReloadable({
			watchPaths: [join(makeDir(), "does-not-exist")],
			build,
			debounceMs: 50,
		});
		expect(handle.buildCount()).toBe(1);
		await handle.stop();
	});
});
