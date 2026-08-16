/**
 * Default 生命周期模块(akashic default_proactive + proactive_flow 模块的 pi 形态)。
 *
 * 模块只做薄包装:从 frame.slots 取 run:state,调用 DefaultRuntime 对应方法,
 * 结果写回 slots。数据依赖经数据 slot 声明,由生命周期编译器展开与校验。
 */

import { type ProactiveFrame, ProactiveTickResult } from "../../ext/frame.ts";
import type { PhaseModule } from "../../ext/phase.ts";
import type { DefaultRuntime, ProactiveRunState } from "./runtime.ts";

const RUN_STATE_SLOT = "run:state";

function getRunState(frame: ProactiveFrame): ProactiveRunState {
	const state = frame.slots[RUN_STATE_SLOT];
	if (!isRunState(state)) {
		throw new Error(`default lifecycle missing run:state (slot=${RUN_STATE_SLOT})`);
	}
	return state;
}

function isRunState(value: unknown): value is ProactiveRunState {
	return typeof value === "object" && value !== null && typeof (value as ProactiveRunState).tickLogId === "number";
}

class DefaultStartModule implements PhaseModule {
	readonly slot = "proactive.run.start";
	readonly produces = [RUN_STATE_SLOT] as const;

	private readonly runtime: DefaultRuntime;

	constructor(runtime: DefaultRuntime) {
		this.runtime = runtime;
	}

	async run(frame: ProactiveFrame): Promise<ProactiveFrame> {
		frame.slots[RUN_STATE_SLOT] = await this.runtime.begin(frame.input.sessionKey);
		return frame;
	}
}

class DefaultGateModule implements PhaseModule {
	readonly slot = "proactive.admission.collect";
	readonly requires = [RUN_STATE_SLOT] as const;
	readonly produces = ["admission:result"] as const;

	private readonly runtime: DefaultRuntime;

	constructor(runtime: DefaultRuntime) {
		this.runtime = runtime;
	}

	async run(frame: ProactiveFrame): Promise<ProactiveFrame> {
		const state = getRunState(frame);
		await this.runtime.gate(state);
		frame.slots["admission:result"] = !state.finished;
		return frame;
	}
}

class DefaultSenseModule implements PhaseModule {
	readonly slot = "proactive.sense";
	readonly requires = ["admission:result"] as const;

	private readonly runtime: DefaultRuntime;

	constructor(runtime: DefaultRuntime) {
		this.runtime = runtime;
	}

	async run(frame: ProactiveFrame): Promise<ProactiveFrame> {
		const state = getRunState(frame);
		if (!state.finished) {
			await this.runtime.sense(state);
		}
		return frame;
	}
}

/** 插件状态收集(akashic ProactivePluginStateModule):收集 system_bottom 段与 effect 记录。 */
class DefaultPromptCollectModule implements PhaseModule {
	readonly slot = "proactive.prompt.collect";
	readonly requires = ["admission:result", RUN_STATE_SLOT] as const;
	readonly collects = ["proactive:prompt:system_bottom:*", "proactive:effect:*"] as const;
	readonly produces = ["prompt:sections:collected"] as const;

	private readonly runtime: DefaultRuntime;

	constructor(runtime: DefaultRuntime) {
		this.runtime = runtime;
	}

	run(frame: ProactiveFrame): ProactiveFrame {
		const state = getRunState(frame);
		this.runtime.collectPluginState(state, frame.slots);
		frame.slots["prompt:sections:collected"] = true;
		return frame;
	}
}

class DefaultRouteModule implements PhaseModule {
	readonly slot = "proactive.route";
	readonly requires = [RUN_STATE_SLOT] as const;
	readonly produces = ["route:selected"] as const;

	private readonly runtime: DefaultRuntime;

	constructor(runtime: DefaultRuntime) {
		this.runtime = runtime;
	}

	async run(frame: ProactiveFrame): Promise<ProactiveFrame> {
		const state = getRunState(frame);
		if (state.finished) {
			frame.slots["route:selected"] = "blocked";
			return frame;
		}
		await this.runtime.route(state);
		frame.slots["route:selected"] = state.finished ? "idle" : "proactive";
		return frame;
	}
}

/** 判题前准备(akashic proactive.flow.prepare):并行预取候选正文缓存。 */
class DefaultPrepareModule implements PhaseModule {
	readonly slot = "proactive.prepare";
	readonly requires = ["route:selected", RUN_STATE_SLOT] as const;
	readonly produces = ["candidate:batch"] as const;

	private readonly runtime: DefaultRuntime;

	constructor(runtime: DefaultRuntime) {
		this.runtime = runtime;
	}

	async run(frame: ProactiveFrame): Promise<ProactiveFrame> {
		const state = getRunState(frame);
		if (!state.finished) {
			await this.runtime.prepare(state);
		}
		frame.slots["candidate:batch"] = state.candidates;
		return frame;
	}
}

class DefaultJudgeModule implements PhaseModule {
	readonly slot = "proactive.judge";
	readonly requires = ["route:selected", "candidate:batch", "run:state", "prompt:sections:collected"] as const;
	readonly produces = ["proposal:proactive"] as const;

	private readonly runtime: DefaultRuntime;

	constructor(runtime: DefaultRuntime) {
		this.runtime = runtime;
	}

	async run(frame: ProactiveFrame): Promise<ProactiveFrame> {
		const state = getRunState(frame);
		if (!state.finished) {
			await this.runtime.judge(state);
			frame.slots["proposal:proactive"] = state.verdict?.action ?? "skip";
		}
		return frame;
	}
}

class DefaultResolveModule implements PhaseModule {
	readonly slot = "proactive.resolve";
	readonly requires = ["proposal:proactive", "run:state"] as const;
	readonly produces = ["run:proposal"] as const;

	private readonly runtime: DefaultRuntime;

	constructor(runtime: DefaultRuntime) {
		this.runtime = runtime;
	}

	async run(frame: ProactiveFrame): Promise<ProactiveFrame> {
		const state = getRunState(frame);
		if (!state.finished) {
			await this.runtime.resolve(state);
			frame.slots["run:proposal"] = state.verdict?.action ?? "skip";
		}
		return frame;
	}
}

class DefaultCommitModule implements PhaseModule {
	readonly slot = "proactive.commit";
	readonly requires = ["run:proposal", "run:state"] as const;
	readonly produces = ["run:result"] as const;

	private readonly runtime: DefaultRuntime;

	constructor(runtime: DefaultRuntime) {
		this.runtime = runtime;
	}

	async run(frame: ProactiveFrame): Promise<ProactiveFrame> {
		const state = getRunState(frame);
		if (!state.finished) {
			await this.runtime.commit(state);
		}
		frame.slots["run:result"] = state.action;
		return frame;
	}
}

class DefaultScheduleModule implements PhaseModule {
	readonly slot = "proactive.schedule";
	readonly requires = ["run:result"] as const;
	readonly produces = ["run:next_wakeup"] as const;

	private readonly runtime: DefaultRuntime;

	constructor(runtime: DefaultRuntime) {
		this.runtime = runtime;
	}

	run(frame: ProactiveFrame): ProactiveFrame {
		const state = getRunState(frame);
		const interval = this.runtime.schedule(state);
		frame.output = new ProactiveTickResult(state.baseScore, interval);
		frame.slots["run:next_wakeup"] = interval;
		return frame;
	}
}

/** 组装 default 生命周期模块序列。 */
export function buildDefaultModules(runtime: DefaultRuntime): PhaseModule[] {
	return [
		new DefaultStartModule(runtime),
		new DefaultGateModule(runtime),
		new DefaultSenseModule(runtime),
		new DefaultPromptCollectModule(runtime),
		new DefaultRouteModule(runtime),
		new DefaultPrepareModule(runtime),
		new DefaultJudgeModule(runtime),
		new DefaultResolveModule(runtime),
		new DefaultCommitModule(runtime),
		new DefaultScheduleModule(runtime),
	];
}
