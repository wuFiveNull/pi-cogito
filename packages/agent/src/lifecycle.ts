import type {
	AgentLifecycleContext,
	AgentLifecycleFrame,
	AgentLifecycleModule,
	AgentLifecyclePhase,
	AgentLifecycleRunner,
} from "./types.ts";

const PHASES: readonly AgentLifecyclePhase[] = ["before_turn", "before_reasoning", "after_reasoning", "after_turn"];

class LifecycleFrame implements AgentLifecycleFrame {
	readonly context: AgentLifecycleContext;
	private readonly slots = new Map<string, unknown>();

	constructor(context: AgentLifecycleContext) {
		this.context = context;
	}

	get<T = unknown>(slot: string): T | undefined {
		return this.slots.get(slot) as T | undefined;
	}

	set(slot: string, value: unknown): void {
		this.slots.set(slot, value);
	}
}

/**
 * Ordered lifecycle phases for agent turn extensions.
 *
 * Modules are topologically sorted per phase from their declared slots. A
 * module failure is deliberately propagated to the agent loop: lifecycle
 * gates must not silently continue with an unknown context state.
 */
export class AgentLifecycle implements AgentLifecycleRunner {
	private readonly modulesByPhase: ReadonlyMap<AgentLifecyclePhase, readonly AgentLifecycleModule[]>;

	constructor(modules: readonly AgentLifecycleModule[] = []) {
		const grouped = new Map<AgentLifecyclePhase, AgentLifecycleModule[]>();
		for (const phase of PHASES) grouped.set(phase, []);
		for (const module of modules) {
			grouped.get(module.phase)?.push(module);
		}
		this.modulesByPhase = new Map(
			PHASES.map((phase) => [phase, topologicallySortModules(phase, grouped.get(phase) ?? [])]),
		);
	}

	async run(context: AgentLifecycleContext): Promise<AgentLifecycleContext> {
		const frame = new LifecycleFrame(context);
		for (const module of this.modulesByPhase.get(context.phase) ?? []) {
			await module.run(frame);
		}
		return context;
	}
}

/** Create an {@link AgentLifecycle} without exposing its implementation details to callers. */
export function createAgentLifecycle(modules: readonly AgentLifecycleModule[] = []): AgentLifecycle {
	return new AgentLifecycle(modules);
}

function topologicallySortModules(
	phase: AgentLifecyclePhase,
	modules: readonly AgentLifecycleModule[],
): readonly AgentLifecycleModule[] {
	const producerBySlot = new Map<string, AgentLifecycleModule>();
	for (const module of modules) {
		if (!module.slot.trim()) throw new Error(`lifecycle module slot must not be empty: ${phase}`);
		for (const slot of producedSlots(module)) {
			if (producerBySlot.has(slot)) {
				throw new Error(`duplicate lifecycle slot "${slot}" in phase "${phase}"`);
			}
			producerBySlot.set(slot, module);
		}
	}

	for (const module of modules) {
		for (const required of module.requires ?? []) {
			if (!producerBySlot.has(required)) {
				throw new Error(
					`lifecycle module "${module.slot}" requires unknown slot "${required}" in phase "${phase}"`,
				);
			}
		}
	}

	const pending = [...modules];
	const produced = new Set<string>();
	const sorted: AgentLifecycleModule[] = [];
	while (pending.length > 0) {
		const index = pending.findIndex((module) => (module.requires ?? []).every((slot) => produced.has(slot)));
		if (index < 0) {
			const slots = pending.map((module) => module.slot).join(", ");
			throw new Error(`lifecycle dependency cycle in phase "${phase}": ${slots}`);
		}
		const [module] = pending.splice(index, 1);
		if (!module) continue;
		sorted.push(module);
		for (const slot of producedSlots(module)) produced.add(slot);
	}
	return sorted;
}

function producedSlots(module: AgentLifecycleModule): readonly string[] {
	return module.produces ?? [module.slot];
}
