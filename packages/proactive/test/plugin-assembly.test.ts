/**
 * 插件装配端到端测试(runPusher 经 PluginRegistry 装配生命周期)。
 *
 * 自定义插件文件贡献:数据源 + lifecycle spec + runtime factory + module
 * factory;runPusher({ lifecycle: "custom" }) 应完整装配并在首轮 tick 执行
 * 自定义模块(写入 marker 文件)。
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { runPusher } from "../src/index.ts";

const tempDirs: string[] = [];
const originalCwd = process.cwd();

function makeWorkDir(): { workDir: string; sourcesDir: string; dbPath: string; sessionsDir: string } {
	const workDir = mkdtempSync(join(tmpdir(), "plugin-assembly-"));
	tempDirs.push(workDir);
	// 挂载目录唯一:临时 cwd 下的 .cogito/extensions/proactive。
	const sourcesDir = join(workDir, ".cogito", "extensions", "proactive");
	const dbPath = join(workDir, "proactive.sqlite");
	const sessionsDir = join(workDir, "sessions");
	mkdirSync(sourcesDir, { recursive: true });
	mkdirSync(sessionsDir, { recursive: true });
	// 挂载目录按 cwd 解析:每个测试 chdir 到临时工作区。
	process.chdir(workDir);
	return { workDir, sourcesDir, dbPath, sessionsDir };
}

/** 轮询等待条件。 */
async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
	const start = Date.now();
	while (!condition()) {
		if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

afterEach(() => {
	process.chdir(originalCwd);
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("runPusher plugin assembly", () => {
	it("assembles a custom lifecycle from a directory plugin and runs its modules", async () => {
		const { workDir, sourcesDir, dbPath, sessionsDir } = makeWorkDir();
		const marker = join(workDir, "custom-tick.marker");
		const directMarker = join(workDir, "direct-tick.marker");
		writeFileSync(
			join(sourcesDir, "custom-plugin.ts"),
			`import { appendFileSync } from "node:fs";
const MARKER = ${JSON.stringify(marker)};
const DIRECT_MARKER = ${JSON.stringify(directMarker)};
export const plugin = {
  name: "custom-plugin",
  proactiveSources: () => [
    { id: "custom-src", label: "Custom", defaultIntervalMs: 60000, async fetch() { return []; } },
  ],
  proactiveLifecycles: () => [
    { id: "custom", modules: [], initialSlots: [], terminalSlots: ["run:next_wakeup"] },
  ],
  proactiveModules: () => [
    {
      slot: "custom.direct",
      produces: ["custom:direct"],
      run(frame) {
        appendFileSync(DIRECT_MARKER, "direct\\n");
        return frame;
      },
    },
  ],
  proactiveRuntimeFactories: () => [
    { lifecycleId: "custom", create() { return { closed: false }; } },
  ],
  proactiveModuleFactories: () => [
    {
      lifecycleId: "custom",
      create(runtime) {
        return [
          {
            slot: "custom.tick",
            produces: ["run:next_wakeup"],
            run(frame) {
              runtime.closed = false;
              appendFileSync(MARKER, "tick\\n");
              frame.output = { baseScore: 0.5, nextIntervalSeconds: 3600 };
              return frame;
            },
          },
        ];
      },
    },
  ],
};`,
			"utf-8",
		);

		const { stop } = await runPusher({
			dbPath,
			sessionsDir,
			lifecycle: "custom",
			tick: { fallbackIntervalSeconds: 3600 },
		});
		try {
			// 通用循环首轮立即 tick:自定义模块写入 marker。
			let found = false;
			for (let i = 0; i < 40; i++) {
				await new Promise((resolve) => setTimeout(resolve, 50));
				if (existsSync(marker)) {
					found = true;
					break;
				}
			}
			expect(found).toBe(true);
		} finally {
			await stop();
		}
		expect(existsSync(directMarker)).toBe(true);
	});

	it("falls back to the default lifecycle when none is configured", async () => {
		const { sourcesDir, dbPath, sessionsDir } = makeWorkDir();
		writeFileSync(
			join(sourcesDir, "src.ts"),
			`export default class Src {
  id = "src";
  label = "Src";
  defaultIntervalMs = 60000;
  async fetch() {
    return [{ source: "src", title: "item" }];
  }
}`,
			"utf-8",
		);
		// default 生命周期会写入 tick_log:等待第一条出现。
		const { stop } = await runPusher({
			dbPath,
			sessionsDir,
			tick: { fallbackIntervalSeconds: 3600 },
			gate: { busyFn: () => true },
		});
		try {
			await waitFor(() => {
				const db = new DatabaseSync(dbPath, { readOnly: true });
				try {
					const row = db.prepare("SELECT COUNT(*) AS c FROM tick_log").get() as { c: number };
					return row.c > 0;
				} finally {
					db.close();
				}
			});
		} finally {
			await stop();
		}
	});

	it("rejects an unknown lifecycle", async () => {
		const { sourcesDir, dbPath, sessionsDir } = makeWorkDir();
		writeFileSync(
			join(sourcesDir, "src.ts"),
			`export default class Src {
  id = "src";
  label = "Src";
  async fetch() { return []; }
}`,
			"utf-8",
		);
		await expect(runPusher({ dbPath, sessionsDir, lifecycle: "nope" })).rejects.toThrow(/lifecycle not found: nope/);
	});

	it("rejects duplicate runtime providers instead of choosing the first", async () => {
		const { sourcesDir, dbPath, sessionsDir } = makeWorkDir();
		writeFileSync(
			join(sourcesDir, "duplicate-plugin.ts"),
			`export const plugin = {
  name: "duplicate-plugin",
  proactiveSources: () => [{ id: "duplicate-src", label: "Duplicate", fetch: async () => [] }],
  proactiveLifecycles: () => [{ id: "duplicate", modules: [], initialSlots: [], terminalSlots: ["run:next_wakeup"] }],
  proactiveRuntimeFactories: () => [
    { lifecycleId: "duplicate", create() { return {}; } },
    { lifecycleId: "duplicate", create() { return {}; } },
  ],
  proactiveModuleFactories: () => [{
    lifecycleId: "duplicate",
    create() {
      return [{ slot: "duplicate.tick", produces: ["run:next_wakeup"], run(frame) { return frame; } }];
    },
  }],
};`,
			"utf-8",
		);

		await expect(runPusher({ dbPath, sessionsDir, lifecycle: "duplicate" })).rejects.toThrow(
			/runtime factory duplicate duplicated/,
		);
	});
});
