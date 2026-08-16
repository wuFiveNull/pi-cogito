/**
 * Wake 生命周期装配(akashic plugins/wake_proactive/modules.py + plugin.py 移植)。
 *
 * 模块序列:wake.start → wake.ingest → wake.content.decide → wake.drift.decide
 * → wake.schedule,状态经 frame.slots["run:state"] 传递(WakeRunState)。
 * WakeRuntimeFactory 用惰性 deps builder:选择 wake 生命周期时才创建 runtime,
 * apiKey 等校验延迟到 create(与 akashic 启动时校验一致)。
 */

import { type ProactiveFrame, ProactiveTickResult } from "../ext/frame.ts";
import { ProactiveLifecycleSpec } from "../ext/lifecycle.ts";
import type { PhaseModule } from "../ext/phase.ts";
import type { ProactiveModuleFactory, ProactivePlugin, ProactiveRuntimeFactory } from "../ext/plugin.ts";
import { type WakeRunState, WakeRuntime, type WakeRuntimeDeps } from "./runtime.ts";

const RUN_STATE_SLOT = "run:state";

function getRunState(frame: ProactiveFrame): WakeRunState {
	const state = frame.slots[RUN_STATE_SLOT];
	if (!isWakeRunState(state)) {
		throw new Error(`wake lifecycle missing run:state (slot=${RUN_STATE_SLOT})`);
	}
	return state;
}

function isWakeRunState(value: unknown): value is WakeRunState {
	return (
		typeof value === "object" && value !== null && typeof (value as WakeRunState).nextIntervalSeconds === "number"
	);
}

export const wakeLifecycleSpec = new ProactiveLifecycleSpec(
	"wake",
	[],
	["proactive:cfg", "proactive:session_key", "proactive:started_at", "proactive:last_user_at"],
	["run:next_wakeup"],
);

class WakeStartModule implements PhaseModule {
	readonly slot = "wake.start";
	readonly produces = [RUN_STATE_SLOT] as const;

	private readonly runtime: WakeRuntime;

	constructor(runtime: WakeRuntime) {
		this.runtime = runtime;
	}

	run(frame: ProactiveFrame): ProactiveFrame {
		frame.slots[RUN_STATE_SLOT] = this.runtime.begin();
		return frame;
	}
}

class WakeIngestModule implements PhaseModule {
	readonly slot = "wake.ingest";
	readonly requires = [RUN_STATE_SLOT] as const;
	readonly produces = ["wake:reservoir"] as const;

	private readonly runtime: WakeRuntime;

	constructor(runtime: WakeRuntime) {
		this.runtime = runtime;
	}

	async run(frame: ProactiveFrame): Promise<ProactiveFrame> {
		const state = getRunState(frame);
		await this.runtime.ingest(state);
		frame.slots["wake:reservoir"] = true;
		return frame;
	}
}

class WakeContentDecisionModule implements PhaseModule {
	readonly slot = "wake.content.decide";
	readonly requires = ["wake:reservoir"] as const;
	readonly produces = ["wake:content_result"] as const;

	private readonly runtime: WakeRuntime;

	constructor(runtime: WakeRuntime) {
		this.runtime = runtime;
	}

	async run(frame: ProactiveFrame): Promise<ProactiveFrame> {
		const state = getRunState(frame);
		const contentCompleted = await this.runtime.decideContent(state);
		frame.slots["wake:content_result"] = contentCompleted;
		return frame;
	}
}

class WakeDriftDecisionModule implements PhaseModule {
	readonly slot = "wake.drift.decide";
	readonly requires = ["wake:content_result"] as const;
	readonly produces = ["wake:result"] as const;

	private readonly runtime: WakeRuntime;

	constructor(runtime: WakeRuntime) {
		this.runtime = runtime;
	}

	async run(frame: ProactiveFrame): Promise<ProactiveFrame> {
		const state = getRunState(frame);
		if (frame.slots["wake:content_result"] !== true) {
			await this.runtime.decideDrift(state);
		}
		frame.slots["wake:result"] = true;
		return frame;
	}
}

class WakeScheduleModule implements PhaseModule {
	readonly slot = "wake.schedule";
	readonly requires = ["wake:result"] as const;
	readonly produces = ["run:next_wakeup"] as const;

	private readonly runtime: WakeRuntime;

	constructor(runtime: WakeRuntime) {
		this.runtime = runtime;
	}

	run(frame: ProactiveFrame): ProactiveFrame {
		const state = getRunState(frame);
		const result = new ProactiveTickResult(state.baseScore, state.nextIntervalSeconds);
		this.runtime.finish(state, {
			nextIntervalSeconds: state.nextIntervalSeconds,
			baseScore: state.baseScore,
		});
		frame.output = result;
		frame.slots["run:next_wakeup"] = state.nextIntervalSeconds;
		return frame;
	}
}

/** 组装 wake 生命周期模块序列。 */
export function buildWakeModules(runtime: WakeRuntime): PhaseModule[] {
	return [
		new WakeStartModule(runtime),
		new WakeIngestModule(runtime),
		new WakeContentDecisionModule(runtime),
		new WakeDriftDecisionModule(runtime),
		new WakeScheduleModule(runtime),
	];
}

/** wake runtime 工厂:惰性组装 deps,create 时才校验(如 agentTick.apiKey)。 */
export class WakeRuntimeFactory implements ProactiveRuntimeFactory {
	readonly lifecycleId = "wake";

	private readonly depsBuilder: () => WakeRuntimeDeps;

	constructor(depsBuilder: () => WakeRuntimeDeps) {
		this.depsBuilder = depsBuilder;
	}

	create(): unknown {
		return new WakeRuntime(this.depsBuilder());
	}
}

export class WakeModuleFactory implements ProactiveModuleFactory {
	readonly lifecycleId = "wake";

	create(runtime: unknown): PhaseModule[] {
		return buildWakeModules(runtime as WakeRuntime);
	}
}

/** 内置 wake 生命周期插件:经 PluginRegistry 装配。 */
export class WakeProactivePlugin implements ProactivePlugin {
	readonly name = "wake_proactive";

	private readonly depsBuilder: () => WakeRuntimeDeps;

	constructor(depsBuilder: () => WakeRuntimeDeps) {
		this.depsBuilder = depsBuilder;
	}

	proactiveLifecycles = (): readonly ProactiveLifecycleSpec[] => [wakeLifecycleSpec];

	proactiveRuntimeFactories = (): readonly ProactiveRuntimeFactory[] => [new WakeRuntimeFactory(this.depsBuilder)];

	proactiveModuleFactories = (): readonly ProactiveModuleFactory[] => [new WakeModuleFactory()];
}
