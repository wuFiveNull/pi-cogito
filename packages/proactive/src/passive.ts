/** Passive turn lifecycle bridge shared with pi-agent-core and EventBus. */

import type { AgentLifecycleFrame, AgentLifecycleModule, AgentLifecyclePhase } from "@cogito/agent-core";
import type { EventBus } from "./bus.ts";
import { type Clock, SystemClock } from "./clock.ts";

export interface PassiveTurnContext {
	sessionKey: string;
	turnIndex: number;
	startedAt: number;
	metadata?: Record<string, unknown>;
}

export class PassiveTurnStarted {
	readonly sessionKey: string;
	readonly turnIndex: number;
	readonly startedAt: number;
	readonly metadata: Record<string, unknown>;

	constructor(context: PassiveTurnContext) {
		this.sessionKey = context.sessionKey;
		this.turnIndex = context.turnIndex;
		this.startedAt = context.startedAt;
		this.metadata = { ...(context.metadata ?? {}) };
	}
}

export class PassiveBeforeReasoning {
	readonly sessionKey: string;
	readonly turnIndex: number;
	readonly startedAt: number;
	readonly metadata: Record<string, unknown>;

	constructor(context: PassiveTurnContext) {
		this.sessionKey = context.sessionKey;
		this.turnIndex = context.turnIndex;
		this.startedAt = context.startedAt;
		this.metadata = { ...(context.metadata ?? {}) };
	}
}

export class PassiveAfterReasoning {
	readonly sessionKey: string;
	readonly turnIndex: number;
	readonly startedAt: number;
	readonly finishedAt: number;
	readonly result: unknown;
	readonly error: string | null;

	constructor(context: PassiveTurnContext, finishedAt: number, result: unknown, error: string | null) {
		this.sessionKey = context.sessionKey;
		this.turnIndex = context.turnIndex;
		this.startedAt = context.startedAt;
		this.finishedAt = finishedAt;
		this.result = result;
		this.error = error;
	}
}

export class PassiveTurnFinished {
	readonly sessionKey: string;
	readonly turnIndex: number;
	readonly startedAt: number;
	readonly finishedAt: number;
	readonly success: boolean;
	readonly error: string | null;

	constructor(context: PassiveTurnContext, finishedAt: number, success: boolean, error: string | null) {
		this.sessionKey = context.sessionKey;
		this.turnIndex = context.turnIndex;
		this.startedAt = context.startedAt;
		this.finishedAt = finishedAt;
		this.success = success;
		this.error = error;
	}
}

export interface PassiveTurnLifecycleOptions {
	clock?: Clock;
}

/** Ordered before_turn → before_reasoning → after_reasoning → after_turn lifecycle. */
export class PassiveTurnLifecycle {
	private readonly eventBus: EventBus;
	private readonly clock: Clock;

	constructor(eventBus: EventBus, options: PassiveTurnLifecycleOptions = {}) {
		this.eventBus = eventBus;
		this.clock = options.clock ?? SystemClock;
	}

	async beforeTurn(context: PassiveTurnContext): Promise<void> {
		await this.eventBus.emit(new PassiveTurnStarted(context));
	}

	async beforeReasoning(context: PassiveTurnContext): Promise<void> {
		await this.eventBus.emit(new PassiveBeforeReasoning(context));
	}

	async afterReasoning(context: PassiveTurnContext, result: unknown, error: unknown = null): Promise<void> {
		await this.eventBus.emit(new PassiveAfterReasoning(context, this.clock.nowMs(), result, errorMessage(error)));
	}

	async afterTurn(context: PassiveTurnContext, success: boolean, error: unknown = null): Promise<void> {
		await this.eventBus.emit(new PassiveTurnFinished(context, this.clock.nowMs(), success, errorMessage(error)));
	}

	/** Wrap an actual passive-agent reasoning call with all four phases. */
	async run<TResult>(context: PassiveTurnContext, reason: () => Promise<TResult> | TResult): Promise<TResult> {
		await this.beforeTurn(context);
		await this.beforeReasoning(context);
		try {
			const result = await reason();
			await this.afterReasoning(context, result);
			await this.afterTurn(context, true);
			return result;
		} catch (error) {
			await this.afterReasoning(context, null, error);
			await this.afterTurn(context, false, error);
			throw error;
		}
	}
}

export interface PassiveTurnAgentBridgeOptions {
	sessionKey: string | ((frame: AgentLifecycleFrame) => string);
	clock?: Clock;
}

/** Adapt pi-agent-core's four lifecycle phases to the proactive EventBus. */
export function createPassiveTurnLifecycleModules(
	lifecycle: PassiveTurnLifecycle,
	options: PassiveTurnAgentBridgeOptions,
): AgentLifecycleModule[] {
	const clock = options.clock ?? SystemClock;
	const contextFor = (frame: AgentLifecycleFrame): PassiveTurnContext => ({
		sessionKey: typeof options.sessionKey === "string" ? options.sessionKey : options.sessionKey(frame),
		turnIndex: frame.context.turnIndex,
		startedAt: Number(frame.context.metadata["passive.startedAt"] ?? clock.nowMs()),
		metadata: frame.context.metadata,
	});
	const modules: Array<{ phase: AgentLifecyclePhase; slot: string; run(frame: AgentLifecycleFrame): Promise<void> }> =
		[
			{
				phase: "before_turn",
				slot: "passive.before_turn",
				run: async (frame) => lifecycle.beforeTurn(contextFor(frame)),
			},
			{
				phase: "before_reasoning",
				slot: "passive.before_reasoning",
				run: async (frame) => lifecycle.beforeReasoning(contextFor(frame)),
			},
			{
				phase: "after_reasoning",
				slot: "passive.after_reasoning",
				run: async (frame) =>
					lifecycle.afterReasoning(contextFor(frame), {
						assistantMessage: frame.context.assistantMessage,
						toolResults: frame.context.toolResults,
					}),
			},
			{
				phase: "after_turn",
				slot: "passive.after_turn",
				run: async (frame) =>
					lifecycle.afterTurn(contextFor(frame), !frame.context.abort, frame.context.abort?.reason),
			},
		];
	return modules;
}

function errorMessage(error: unknown): string | null {
	return error === null || error === undefined ? null : error instanceof Error ? error.message : String(error);
}
