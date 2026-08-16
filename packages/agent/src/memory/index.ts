/**
 * 记忆优化器组装(akashic bootstrap.build_memory_optimizer_task 移植)。
 */

import { ConsolidationLoop } from "./consolidation-loop.ts";
import { FileCursorStore } from "./extract.ts";
import { MemoryOptimizerLoop } from "./loop.ts";
import { MarkdownMemoryStore } from "./markdown-store.ts";
import { type MemoryLlm, MemoryOptimizer } from "./optimizer.ts";

export * from "./before-turn.ts";
export * from "./consolidation-loop.ts";
export * from "./extract.ts";
export * from "./llm.ts";
export * from "./loop.ts";
export * from "./markdown-store.ts";
export * from "./optimizer.ts";

export interface MemoryOptimizerTaskOptions {
	workspaceDir: string;
	llm: MemoryLlm;
	intervalSeconds?: number;
	/** 复用同一个 store(默认按 workspaceDir 新建)。 */
	memory?: MarkdownMemoryStore;
}

/** 构建优化器后台任务(akashic build_memory_optimizer_task):返回 { stop }。 */
export function startMemoryOptimizerTask(options: MemoryOptimizerTaskOptions): {
	stop: () => Promise<void>;
	optimizeNow: () => Promise<void>;
	optimizer: MemoryOptimizer;
	loop: MemoryOptimizerLoop;
	store: MarkdownMemoryStore;
} {
	const store = options.memory ?? new MarkdownMemoryStore(options.workspaceDir);
	const optimizer = new MemoryOptimizer({ memory: store, llm: options.llm });
	const loop = new MemoryOptimizerLoop({
		optimizer,
		intervalSeconds: options.intervalSeconds,
	});
	const running = loop.run();
	let stopPromise: Promise<void> | undefined;
	return {
		stop: () => {
			if (stopPromise) return stopPromise;
			stopPromise = (async () => {
				loop.stop();
				await running;
				store.close();
			})();
			return stopPromise;
		},
		optimizeNow: () => loop.optimizeNow(),
		optimizer,
		loop,
		store,
	};
}

export { DEFAULT_SELF_MD } from "./markdown-store.ts";

export interface MemoryTasksOptions {
	workspaceDir: string;
	sessionsDir: string;
	llm: MemoryLlm;
	/** 优化器循环间隔(秒);缺省 18h 对齐整点。 */
	optimizerIntervalSeconds?: number;
	/** 会话提取循环间隔(秒);缺省 15min 对齐整点。 */
	consolidateIntervalSeconds?: number;
	/** 提取窗口 keepCount / minNewMessages / maxConversationChars。 */
	consolidateConfig?: import("./extract.ts").ConsolidationConfig;
	/** 复用同一个 store(默认按 workspaceDir 新建)。 */
	memory?: MarkdownMemoryStore;
}

export interface MemoryTasksHandle {
	stop(): Promise<void>;
	optimizeNow(): Promise<void>;
	consolidateNow(): Promise<number>;
	store: MarkdownMemoryStore;
	optimizer: MemoryOptimizer;
	optimizerLoop: MemoryOptimizerLoop;
	consolidationLoop: ConsolidationLoop;
}

/**
 * 宿主接线(akashic bootstrap 的 build_memory_optimizer_task + 对话 consolidation):
 * 一个后台任务同时跑记忆优化循环与会话提取循环。
 */
export function startMemoryTasks(options: MemoryTasksOptions): MemoryTasksHandle {
	const store = options.memory ?? new MarkdownMemoryStore(options.workspaceDir);
	const optimizer = new MemoryOptimizer({ memory: store, llm: options.llm });
	const optimizerLoop = new MemoryOptimizerLoop({
		optimizer,
		intervalSeconds: options.optimizerIntervalSeconds,
	});
	const consolidationLoop = new ConsolidationLoop({
		store,
		llm: options.llm,
		sessionsDir: options.sessionsDir,
		cursorStore: new FileCursorStore(store.memoryDir),
		intervalSeconds: options.consolidateIntervalSeconds,
		config: options.consolidateConfig,
	});
	const tasks = Promise.allSettled([optimizerLoop.run(), consolidationLoop.run()]);
	let stopPromise: Promise<void> | undefined;
	return {
		stop: () => {
			if (stopPromise) return stopPromise;
			stopPromise = (async () => {
				optimizerLoop.stop();
				consolidationLoop.stop();
				await tasks;
				store.close();
			})();
			return stopPromise;
		},
		optimizeNow: () => optimizerLoop.optimizeNow(),
		consolidateNow: () => consolidationLoop.consolidateAll(),
		store,
		optimizer,
		optimizerLoop,
		consolidationLoop,
	};
}
