/**
 * Default 生命周期装配:spec + runtime 工厂 + 模块工厂 + 内置插件
 * (akashic default_proactive plugin 的 pi 形态)。
 */

import { ProactiveLifecycleSpec } from "../../ext/lifecycle.ts";
import type { PhaseModule } from "../../ext/phase.ts";
import type { ProactiveModuleFactory, ProactivePlugin, ProactiveRuntimeFactory } from "../../ext/plugin.ts";
import { buildDefaultModules } from "./modules.ts";
import { DefaultRuntime, type DefaultRuntimeDeps } from "./runtime.ts";

export const defaultLifecycleSpec = new ProactiveLifecycleSpec(
	"default",
	[],
	["proactive:cfg", "proactive:session_key", "proactive:started_at", "proactive:last_user_at"],
	["run:next_wakeup"],
);

export class DefaultRuntimeFactory implements ProactiveRuntimeFactory {
	readonly lifecycleId = "default";

	private readonly deps: DefaultRuntimeDeps;

	constructor(deps: DefaultRuntimeDeps) {
		this.deps = deps;
	}

	create(): unknown {
		return new DefaultRuntime(this.deps);
	}
}

export class DefaultModuleFactory implements ProactiveModuleFactory {
	readonly lifecycleId = "default";

	create(runtime: unknown): PhaseModule[] {
		if (!(runtime instanceof DefaultRuntime)) {
			throw new Error("default lifecycle 收到未知 Runtime");
		}
		return buildDefaultModules(runtime);
	}
}

/** 内置 default 生命周期插件:经 PluginRegistry 装配。 */
export class DefaultProactivePlugin implements ProactivePlugin {
	readonly name = "default_proactive";

	private readonly deps: DefaultRuntimeDeps;

	constructor(deps: DefaultRuntimeDeps) {
		this.deps = deps;
	}

	proactiveLifecycles = (): readonly ProactiveLifecycleSpec[] => [defaultLifecycleSpec];

	proactiveRuntimeFactories = (): readonly ProactiveRuntimeFactory[] => [new DefaultRuntimeFactory(this.deps)];

	proactiveModuleFactories = (): readonly ProactiveModuleFactory[] => [new DefaultModuleFactory()];
}
