/**
 * ProactiveLifecycle — 生命周期规格与编译(akashic proactive_v2/lifecycle.py 移植)。
 *
 * 生命周期 = 一组模块的声明式规格:初始数据 slot + 终局 slot + 模块(可来自
 * 多个插件贡献)。编译时校验 slot 唯一性、数据依赖存在性、终局 slot 有 producer,
 * 然后拓扑排序。启动按序 start、失败逆序回滚;停止逆序 stop、错误聚合。
 */

import type { ProactiveFrame } from "./frame.ts";
import { isModuleSlot, type PhaseModule, topoSortModules } from "./phase.ts";

export class ProactiveLifecycleSpec {
	readonly id: string;
	readonly modules: readonly PhaseModule[];
	readonly initialSlots: readonly string[];
	readonly terminalSlots: readonly string[];

	constructor(
		id: string,
		modules: readonly PhaseModule[] = [],
		initialSlots: readonly string[] = [],
		terminalSlots: readonly string[] = [],
	) {
		this.id = id;
		this.modules = modules;
		this.initialSlots = initialSlots;
		this.terminalSlots = terminalSlots;
	}
}

interface CompiledModule {
	module: PhaseModule;
	slot: string;
	requires: string[];
	produces: string[];
	collects: string[];
	run(frame: ProactiveFrame): Promise<ProactiveFrame> | ProactiveFrame;
	start?(): Promise<void> | void;
	stop?(): Promise<void> | void;
}

function readCallable(module: PhaseModule, field: "start" | "stop"): (() => Promise<void> | void) | undefined {
	const value = module[field];
	if (value === undefined) return undefined;
	if (typeof value !== "function") {
		throw new Error(`proactive lifecycle hook must be callable: module=${module.slot} field=${field}`);
	}
	return value.bind(module);
}

function readSlotNames(module: PhaseModule, field: "requires" | "produces" | "collects"): string[] {
	const value = module[field];
	if (value === undefined) return [];
	if (!Array.isArray(value)) {
		throw new Error(`proactive lifecycle field must be an array: module=${module.slot} field=${field}`);
	}
	const names = value.map(String);
	if (names.some((name) => !name)) {
		throw new Error(
			`proactive lifecycle field entries must be non-empty strings: module=${module.slot} field=${field}`,
		);
	}
	return names;
}

/** 编译后的生命周期:start/stop/run。 */
export class CompiledProactiveLifecycle {
	readonly spec: ProactiveLifecycleSpec;
	private readonly modules: CompiledModule[];

	constructor(spec: ProactiveLifecycleSpec, modules: CompiledModule[]) {
		this.spec = spec;
		this.modules = modules;
	}

	/** 按拓扑顺序启动模块;失败时逆序回滚已启动模块,聚合错误。 */
	async start(signal?: AbortSignal): Promise<void> {
		const started: CompiledModule[] = [];
		const errors: unknown[] = [];
		try {
			for (const binding of this.modules) {
				started.push(binding);
				if (binding.start) {
					await binding.start();
				}
			}
		} catch (startError) {
			errors.push(startError);
			for (const binding of [...started].reverse()) {
				const stop = binding.stop;
				if (!stop) continue;
				try {
					await runShielded(() => stop(), signal, errors);
				} catch (rollbackError) {
					errors.push(rollbackError);
				}
			}
			if (errors.length === 1) throw errors[0];
			throw new AggregateError(errors, "proactive lifecycle start failed");
		}
	}

	/**
	 * 逆序停止所有模块,聚合清理错误。
	 * 取消防护(akashic lifecycle._await_cleanup 的 shield 语义):传入
	 * signal 已中止时,清理动作仍然执行到完成,取消以 AbortError 形式
	 * 聚合进结果,而不是截断后续 stopper。
	 */
	async stop(signal?: AbortSignal): Promise<void> {
		const errors: unknown[] = [];
		for (const binding of [...this.modules].reverse()) {
			const stop = binding.stop;
			if (!stop) continue;
			try {
				await runShielded(() => stop(), signal, errors);
			} catch (error) {
				errors.push(error);
			}
		}
		if (errors.length === 1) throw errors[0];
		if (errors.length > 1) throw new AggregateError(errors, "proactive lifecycle stop failed");
	}

	/** 按序运行全部模块,返回最后一帧。 */
	async run(frame: ProactiveFrame): Promise<ProactiveFrame> {
		let current = frame;
		for (const binding of this.modules) {
			current = await binding.run(current);
		}
		return current;
	}

	inspect(): string {
		return `lifecycle=${this.spec.id}\n${topoSortModules(this.modules.map((m) => m.module))
			.map((module) => `  ${module.slot}`)
			.join("\n")}`;
	}

	get moduleSlots(): string[] {
		return this.modules.map((binding) => binding.slot);
	}
}

/**
 * 取消防护的清理执行(akashic lifecycle._await_cleanup 的 shield 语义):
 * 即使 signal 已中止,也等清理动作执行完成;中止只以 AbortError 形式
 * 记入 errors 聚合,不中断清理,也不被调用方取消截断。
 */
async function runShielded(
	action: () => Promise<void> | void,
	signal: AbortSignal | undefined,
	errors: unknown[],
): Promise<void> {
	await action();
	if (signal?.aborted) {
		errors.push(new DOMException("proactive lifecycle cancelled while cleaning up", "AbortError"));
	}
}

export class ProactiveLifecycleBuilder {
	build(spec: ProactiveLifecycleSpec, contributions: readonly PhaseModule[] = []): CompiledProactiveLifecycle {
		const modules = [...spec.modules, ...contributions];
		const bindings = this.bindModules(modules);
		const expanded = this.expandDependencies(bindings, spec.initialSlots);
		this.validateTerminalSlots(spec, expanded);
		// 用展开后的 bindings 排序(akashic topo_sort_modules(bindings)):
		// requires 数据 slot 与 collects 前缀展开的依赖边必须参与拓扑。
		const ordered = topoSortModules(expanded);
		const orderMap = new Map(ordered.map((binding, index) => [binding.slot, index]));
		const sorted = [...expanded].sort((a, b) => (orderMap.get(a.slot) ?? 0) - (orderMap.get(b.slot) ?? 0));
		return new CompiledProactiveLifecycle(spec, sorted);
	}

	private bindModules(modules: readonly PhaseModule[]): CompiledModule[] {
		const slots = new Set<string>();
		const bindings: CompiledModule[] = [];
		for (const module of modules) {
			const binding = this.compileModule(module);
			if (slots.has(binding.slot)) {
				throw new Error(`proactive lifecycle slot duplicated: ${binding.slot}`);
			}
			slots.add(binding.slot);
			bindings.push(binding);
		}
		return bindings;
	}

	private compileModule(module: PhaseModule): CompiledModule {
		if (typeof module.slot !== "string" || !module.slot) {
			throw new Error(`proactive lifecycle module missing slot: ${module.constructor.name}`);
		}
		if (typeof module.run !== "function") {
			throw new Error(`proactive lifecycle module missing run: ${module.slot}`);
		}
		return {
			module,
			slot: module.slot,
			requires: [...new Set(readSlotNames(module, "requires"))],
			produces: readSlotNames(module, "produces"),
			collects: readSlotNames(module, "collects"),
			run: (frame) => module.run(frame),
			start: readCallable(module, "start"),
			stop: readCallable(module, "stop"),
		};
	}

	/** 数据 slot 依赖展开:requires 中的数据 slot 找 producer 模块;collects 前缀展开。 */
	private expandDependencies(bindings: CompiledModule[], initialSlots: readonly string[]): CompiledModule[] {
		const moduleSlots = new Set(bindings.map((b) => b.slot));
		const producers = this.dataProducers(bindings);
		const expanded: CompiledModule[] = [];
		for (const binding of bindings) {
			const requires = [...binding.requires];
			for (const required of binding.requires) {
				const producer = producers.get(required);
				if (!moduleSlots.has(required) && producer !== undefined) {
					requires.push(producer.slot);
				}
			}
			for (const pattern of binding.collects) {
				const prefix = pattern.endsWith("*") ? pattern.slice(0, -1) : pattern;
				for (const [slot, producer] of [...producers].sort()) {
					if (slot.startsWith(prefix) && producer.slot !== binding.slot) {
						requires.push(producer.slot);
					}
				}
			}
			expanded.push({
				...binding,
				requires: [...new Set(requires)],
			});
		}
		this.validateRequiredData(expanded, producers, initialSlots, moduleSlots);
		return expanded;
	}

	private dataProducers(bindings: CompiledModule[]): Map<string, CompiledModule> {
		const producers = new Map<string, CompiledModule>();
		for (const binding of bindings) {
			for (const slot of binding.produces) {
				if (producers.has(slot)) {
					throw new Error(`proactive lifecycle data slot has multiple producers: ${slot}`);
				}
				producers.set(slot, binding);
			}
		}
		return producers;
	}

	private validateRequiredData(
		bindings: CompiledModule[],
		producers: Map<string, CompiledModule>,
		initialSlots: readonly string[],
		moduleSlots: Set<string>,
	): void {
		const available = new Set([...initialSlots, ...producers.keys()]);
		for (const binding of bindings) {
			for (const required of binding.requires) {
				if (!moduleSlots.has(required) && isModuleSlot(required)) continue;
				if (!moduleSlots.has(required) && required.includes(":") && !available.has(required)) {
					throw new Error(
						`proactive lifecycle data dependency missing: module=${binding.slot} requires=${required}`,
					);
				}
			}
		}
	}

	private validateTerminalSlots(spec: ProactiveLifecycleSpec, bindings: CompiledModule[]): void {
		const produced = new Set<string>();
		for (const binding of bindings) {
			for (const slot of binding.produces) produced.add(slot);
		}
		const missing = spec.terminalSlots.filter((slot) => !produced.has(slot) && !spec.initialSlots.includes(slot));
		if (missing.length > 0) {
			throw new Error(`proactive lifecycle terminal slot has no producer: ${missing.join(", ")}`);
		}
	}
}
