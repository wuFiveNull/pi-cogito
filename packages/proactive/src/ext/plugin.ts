/**
 * Proactive 插件约定与注册表(akashic agent/plugins/base.py + registry.py 移植)。
 *
 * 插件是命名空间对象,可贡献:
 * - proactiveSources(): 数据源(替代旧的「目录文件即 source」格式)
 * - proactiveLifecycles(): 生命周期规格
 * - proactiveModules(): 直接挂入所有生命周期的模块(如判题模块)
 * - proactiveModuleFactories(): 按 lifecycleId 提供模块(运行时工厂产出)
 * - proactiveRuntimeFactories(): 按 lifecycleId 提供 runtime 实现
 * - proactiveDriftSkillRoots(): Drift skill 根目录(建议返回绝对路径)
 *
 * 目录加载见 registry.ts:一个 .ts 文件可导出 `plugin` 命名导出、default 导出
 * 插件对象,或 default 导出插件类(实例化)。旧格式(default 导出 source 类/工厂)
 * 仍然兼容,自动包装为单源插件。
 */

import type { ProactiveSource } from "../types.ts";
import type { ProactiveLifecycleSpec } from "./lifecycle.ts";
import type { PhaseModule } from "./phase.ts";

/** 按 lifecycleId 构建 runtime 的工厂(akashic proactive_runtime_factories)。 */
export interface ProactiveRuntimeFactory {
	readonly lifecycleId: string;
	create(scope?: unknown): unknown;
}

/** 按 lifecycleId 构建模块序列的工厂(akashic proactive_module_factories)。 */
export interface ProactiveModuleFactory {
	readonly lifecycleId: string;
	create(runtime: unknown): PhaseModule[];
}

export interface ProactivePlugin {
	readonly name: string;
	proactiveSources?(): readonly ProactiveSource[];
	proactiveLifecycles?(): readonly ProactiveLifecycleSpec[];
	proactiveModules?(): readonly PhaseModule[];
	proactiveModuleFactories?(): readonly ProactiveModuleFactory[];
	proactiveRuntimeFactories?(): readonly ProactiveRuntimeFactory[];
	proactiveDriftSkillRoots?(): readonly string[];
}

export interface RegisteredProactiveSource {
	pluginName: string;
	sourceId: string;
	sourceKey: string;
	source: ProactiveSource;
}

/** 运行时形状检查(不要求实现全部贡献方法)。 */
export function isProactivePlugin(value: unknown): value is ProactivePlugin {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<ProactivePlugin>;
	if (typeof candidate.name !== "string" || !candidate.name) return false;
	const contributions = [
		candidate.proactiveSources,
		candidate.proactiveLifecycles,
		candidate.proactiveModules,
		candidate.proactiveModuleFactories,
		candidate.proactiveRuntimeFactories,
		candidate.proactiveDriftSkillRoots,
	];
	return (
		contributions.some((contribution) => contribution !== undefined) &&
		contributions.every((contribution) => contribution === undefined || typeof contribution === "function")
	);
}

/** 把单个数据源包装成插件(旧格式目录文件的兼容路径)。 */
export function sourceAsPlugin(source: ProactiveSource): ProactivePlugin {
	return {
		name: `source:${source.id}`,
		proactiveSources: () => [source],
	};
}

export class PluginRegistry {
	private readonly plugins: ProactivePlugin[] = [];

	register(plugin: ProactivePlugin): void {
		if (this.plugins.some((existing) => existing.name === plugin.name)) return;
		this.plugins.push(plugin);
	}

	registerMany(plugins: readonly ProactivePlugin[]): void {
		for (const plugin of plugins) this.register(plugin);
	}

	list(): readonly ProactivePlugin[] {
		return [...this.plugins];
	}

	clear(): void {
		this.plugins.length = 0;
	}

	// ------------------------------------------------------------------
	// 按类别收集贡献(source id 仍按先注册者优先;生命周期和工厂由装配方校验冲突)
	// ------------------------------------------------------------------

	collectSources(): ProactiveSource[] {
		const seen = new Set<string>();
		const sources: ProactiveSource[] = [];
		for (const plugin of this.plugins) {
			for (const source of plugin.proactiveSources?.() ?? []) {
				if (seen.has(source.id)) continue;
				seen.add(source.id);
				sources.push(source);
			}
		}
		return sources;
	}

	/**
	 * Collect all source contributions with stable collision namespaces. Unique
	 * source ids retain their legacy key; when two plugins expose the same id,
	 * both become `plugin:source` keys instead of one silently hiding the other.
	 */
	collectSourceRegistrations(): RegisteredProactiveSource[] {
		const contributions = this.plugins.flatMap((plugin) =>
			(plugin.proactiveSources?.() ?? []).map((source) => ({ plugin, source })),
		);
		const idCounts = new Map<string, number>();
		for (const { source } of contributions) idCounts.set(source.id, (idCounts.get(source.id) ?? 0) + 1);
		const seen = new Set<string>();
		const registrations: RegisteredProactiveSource[] = [];
		for (const { plugin, source } of contributions) {
			const sourceKey = idCounts.get(source.id) === 1 ? source.id : `${plugin.name}:${source.id}`;
			if (seen.has(sourceKey)) {
				throw new Error(`proactive source duplicated: ${sourceKey}`);
			}
			seen.add(sourceKey);
			registrations.push({ pluginName: plugin.name, sourceId: source.id, sourceKey, source });
		}
		return registrations;
	}

	collectDriftSkillRoots(): string[] {
		const seen = new Set<string>();
		const roots: string[] = [];
		for (const plugin of this.plugins) {
			for (const root of plugin.proactiveDriftSkillRoots?.() ?? []) {
				const normalized = String(root ?? "").trim();
				if (!normalized || seen.has(normalized)) continue;
				seen.add(normalized);
				roots.push(normalized);
			}
		}
		return roots;
	}

	collectLifecycles(): ProactiveLifecycleSpec[] {
		const lifecycles: ProactiveLifecycleSpec[] = [];
		for (const plugin of this.plugins) {
			for (const lifecycle of plugin.proactiveLifecycles?.() ?? []) {
				lifecycles.push(lifecycle);
			}
		}
		return lifecycles;
	}

	collectModules(): PhaseModule[] {
		const modules: PhaseModule[] = [];
		for (const plugin of this.plugins) {
			modules.push(...(plugin.proactiveModules?.() ?? []));
		}
		return modules;
	}

	collectRuntimeFactories(): ProactiveRuntimeFactory[] {
		const factories: ProactiveRuntimeFactory[] = [];
		for (const plugin of this.plugins) {
			factories.push(...(plugin.proactiveRuntimeFactories?.() ?? []));
		}
		return factories;
	}

	collectModuleFactories(): ProactiveModuleFactory[] {
		const factories: ProactiveModuleFactory[] = [];
		for (const plugin of this.plugins) {
			factories.push(...(plugin.proactiveModuleFactories?.() ?? []));
		}
		return factories;
	}
}
