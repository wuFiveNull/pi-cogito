import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createMemoryEngine,
	listMemoryEngineFactories,
	type MemoryEngine,
	registerMemoryEngineFactory,
} from "../src/core/memory/index.ts";

const tempDirs: string[] = [];
const registeredNames: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	for (const name of registeredNames.splice(0)) {
		// 注册表是模块级单例;测试用唯一名字避免互相干扰,不提供反注册 API。
		void name;
	}
});

function tempAgentDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "mem-engine-"));
	tempDirs.push(dir);
	return dir;
}

describe("memory engine factory registry (akashic [memory].engine)", () => {
	it("creates the default engine without registration", async () => {
		const engine = await createMemoryEngine({ agentDir: tempAgentDir() });
		expect(engine.store).toBeDefined();
		expect(engine.retriever).toBeDefined();
		expect(engine.memorizer).toBeDefined();
		engine.close();
	});

	it("selects a registered engine by name", async () => {
		const name = `fake-${Date.now()}`;
		registeredNames.push(name);
		registerMemoryEngineFactory(name, async (options) => {
			const engine: MemoryEngine = {
				store: {} as MemoryEngine["store"],
				retriever: {} as MemoryEngine["retriever"],
				memorizer: {} as MemoryEngine["memorizer"],
				embedder: undefined,
				close: () => {},
			};
			void options;
			return engine;
		});
		expect(listMemoryEngineFactories()).toContain(name);
		const engine = await createMemoryEngine({ agentDir: tempAgentDir(), engine: name });
		expect(engine.memorizer).toBeDefined();
		engine.close();
	});

	it("falls back to the default engine for unknown names", async () => {
		const engine = await createMemoryEngine({ agentDir: tempAgentDir(), engine: "does-not-exist" });
		expect(engine.store).toBeDefined();
		engine.close();
	});

	it("rejects registering the reserved default name", () => {
		expect(() =>
			registerMemoryEngineFactory("default", async () => {
				throw new Error("unreachable");
			}),
		).toThrow("default");
	});
});
