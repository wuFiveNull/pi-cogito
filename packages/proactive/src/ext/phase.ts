/**
 * Phase 模块图 — 拓扑排序与依赖校验(akashic agent/lifecycle/phase.py 移植)。
 *
 * 模块契约:
 * - slot: 模块唯一标识(模块 slot 约定含 "." 且不含 ":";数据 slot 含 ":")。
 * - requires: 依赖的模块 slot 或数据 slot。
 * - produces: 产出数据 slot。
 * - collects: 按前缀收集的数据 slot 模式(如 "proactive:gate:*")。
 *
 * 拓扑排序规则:
 * - slot 重复报错。
 * - 依赖了不存在模块的模块被禁用(带 warning),而不是报错。
 * - 剩余模块循环依赖报错。
 * - 同层按「内置模块优先 + 声明顺序」稳定排序。
 */

import type { ProactiveFrame } from "./frame.ts";

/** 模块约定:类属性声明 + run(frame) 执行。start/stop 可选(生命周期 hook)。 */
export interface PhaseModule<F = ProactiveFrame> {
	readonly slot: string;
	readonly requires?: readonly string[];
	readonly produces?: readonly string[];
	readonly collects?: readonly string[];
	run(frame: F): Promise<F> | F;
	start?(): Promise<void> | void;
	stop?(): Promise<void> | void;
}

/** 数据 slot 与模块 slot 的区分:数据 slot 含 ":",模块 slot 含 "."。 */
export function isModuleSlot(slot: string): boolean {
	return slot.includes(".") && !slot.includes(":");
}

const BUILTIN_PREFIXES = [
	"before_turn.",
	"before_reasoning.",
	"prompt_render.",
	"before_step.",
	"after_step.",
	"after_reasoning.",
	"after_turn.",
];

function isBuiltinSlot(slot: string): boolean {
	return BUILTIN_PREFIXES.some((prefix) => slot.startsWith(prefix));
}

function moduleRequires<T extends { requires?: readonly string[] }>(module: T): string[] {
	return (module.requires ?? []).map(String);
}

function missingModuleRequires<T extends { slot: string; requires?: readonly string[] }>(
	module: T,
	activeSlots: Set<string>,
): string[] {
	return moduleRequires(module).filter((req) => isModuleSlot(req) && !activeSlots.has(req));
}

/** 收集前缀匹配的 slot 值(akashic collect_prefixed_slots)。 */
export function collectPrefixedSlots(
	slots: Record<string, unknown>,
	prefix: string,
	reserved: readonly string[] = [],
): Record<string, unknown> {
	const values: Record<string, unknown> = {};
	const reservedFields = new Set(reserved);
	for (const [key, value] of Object.entries(slots)) {
		if (!key.startsWith(prefix)) continue;
		const fieldName = key.slice(prefix.length);
		if (!fieldName || reservedFields.has(fieldName)) continue;
		values[fieldName] = value;
	}
	return values;
}

/** 依赖了缺失模块的模块会被禁用(循环迭代直到稳定)。 */
function activeModuleSlots<T extends { slot: string; requires?: readonly string[] }>(
	slotMap: Map<string, T>,
): Set<string> {
	const active = new Set(slotMap.keys());
	while (true) {
		const disabled = new Set<string>();
		for (const [slot, module] of slotMap) {
			if (!active.has(slot) || isBuiltinSlot(slot)) continue;
			const missing = missingModuleRequires(module, active);
			if (missing.length > 0) {
				console.error(`proactive: module disabled (missing dependency): ${slot} requires=${missing.join(", ")}`);
				disabled.add(slot);
			}
		}
		if (disabled.size === 0) return active;
		for (const slot of disabled) active.delete(slot);
	}
}

/**
 * 拓扑排序模块序列。
 * 抛错:slot 重复 / 循环依赖。
 *
 * 入参只需结构满足 { slot, requires? }(PhaseModule 或展开依赖后的
 * CompiledModule 绑定均可;akashic topo_sort_modules 同样接收编译绑定,
 * 使 collects 前缀展开的依赖边参与排序)。
 */
export function topoSortModules<T extends { slot: string; requires?: readonly string[] }>(modules: readonly T[]): T[] {
	const slotMap = new Map<string, T>();
	const slotOrder = new Map<string, number>();
	modules.forEach((module, index) => {
		const slot = module.slot;
		if (typeof slot !== "string" || !slot) {
			throw new Error(
				`proactive module missing slot: ${(module as { constructor?: { name?: string } }).constructor?.name}`,
			);
		}
		if (slotMap.has(slot)) {
			throw new Error(`proactive module slot duplicated: ${slot}`);
		}
		slotMap.set(slot, module);
		slotOrder.set(slot, index);
	});

	const active = activeModuleSlots(slotMap);
	const liveMap = new Map([...slotMap].filter(([slot]) => active.has(slot)));

	const inDegree = new Map<string, number>();
	const dependents = new Map<string, string[]>();
	for (const slot of liveMap.keys()) {
		inDegree.set(slot, 0);
		dependents.set(slot, []);
	}
	for (const [slot, module] of liveMap) {
		for (const req of moduleRequires(module)) {
			if (!liveMap.has(req)) continue;
			inDegree.set(slot, (inDegree.get(slot) ?? 0) + 1);
			dependents.get(req)?.push(slot);
		}
	}

	const queue = [...liveMap.keys()].filter((slot) => (inDegree.get(slot) ?? 0) === 0);
	const sorted: T[] = [];
	while (queue.length > 0) {
		queue.sort((a, b) => {
			const builtinDiff = Number(isBuiltinSlot(a)) - Number(isBuiltinSlot(b));
			if (builtinDiff !== 0) return -builtinDiff;
			return (slotOrder.get(a) ?? 0) - (slotOrder.get(b) ?? 0);
		});
		const slot = queue.shift()!;
		sorted.push(liveMap.get(slot)!);
		for (const dependent of dependents.get(slot) ?? []) {
			inDegree.set(dependent, (inDegree.get(dependent) ?? 0) - 1);
			if ((inDegree.get(dependent) ?? 0) === 0) queue.push(dependent);
		}
	}

	if (sorted.length !== liveMap.size) {
		const unresolved = [...liveMap.keys()].filter((slot) => (inDegree.get(slot) ?? 0) > 0).sort();
		throw new Error(`proactive module cycle detected: ${unresolved.join(", ")}`);
	}
	return sorted;
}

/** 执行顺序 + 依赖树文本(调试/启动日志用)。 */
export function inspectPhase(modules: readonly PhaseModule[]): string {
	const sorted = topoSortModules(modules);
	const chain = sorted.map((module, index) => `  ${String(index).padStart(2, " ")}. ${module.slot}`).join("\n");

	const children = new Map<string, string[]>();
	const inDegree = new Map<string, number>();
	for (const module of sorted) {
		children.set(module.slot, []);
		inDegree.set(module.slot, 0);
	}
	for (const module of sorted) {
		for (const req of moduleRequires(module)) {
			if (!children.has(req)) continue;
			children.get(req)?.push(module.slot);
			inDegree.set(module.slot, (inDegree.get(module.slot) ?? 0) + 1);
		}
	}
	const roots = [...inDegree.keys()].filter((slot) => (inDegree.get(slot) ?? 0) === 0);
	const lines: string[] = ["执行顺序:", chain, "", "依赖树:"];
	const visited = new Set<string>();
	const renderNode = (slot: string, prefix: string, isLast: boolean): void => {
		if (visited.has(slot)) return;
		visited.add(slot);
		const connector = isLast ? "└── " : "├── ";
		const module = sorted.find((m) => m.slot === slot);
		const tag = module && isBuiltinSlot(slot) ? "[B]" : "[P]";
		lines.push(`${prefix}${connector}${tag} ${slot}`);
		const childPrefix = prefix + (isLast ? "    " : "│   ");
		const kids = children.get(slot) ?? [];
		kids.forEach((child, index) => {
			renderNode(child, childPrefix, index === kids.length - 1);
		});
	};
	roots.forEach((root, index) => {
		renderNode(root, "", index === roots.length - 1);
	});
	return lines.join("\n");
}
