/**
 * ProactiveFrame — 一次 tick 的输入/槽位/输出容器(akashic proactive_v2/frame.py 移植)。
 *
 * 模块间不直接互相调用,只通过 frame.slots 读写数据;终局结果放 output。
 */

import { SystemClock } from "../clock.ts";

export class ProactiveTickInput {
	readonly sessionKey: string;
	readonly startedAt: Date;

	constructor(sessionKey: string, startedAt: Date) {
		this.sessionKey = sessionKey;
		this.startedAt = startedAt;
	}
}

export class ProactiveTickResult {
	baseScore: number | null;
	nextIntervalSeconds: number | null;

	constructor(baseScore: number | null = null, nextIntervalSeconds: number | null = null) {
		this.baseScore = baseScore;
		this.nextIntervalSeconds = nextIntervalSeconds;
	}
}

export class ProactiveFrame {
	readonly input: ProactiveTickInput;
	readonly slots: Record<string, unknown>;
	output: ProactiveTickResult | null;

	constructor(input: ProactiveTickInput, slots: Record<string, unknown> | null = null) {
		this.input = input;
		this.slots = { ...(slots ?? {}) };
		this.output = null;
	}
}

/** 新建一帧(akashic new_proactive_frame)。 */
export function newProactiveFrame(
	sessionKey: string,
	slots: Record<string, unknown> | null = null,
	startedAt: Date = SystemClock.now(),
): ProactiveFrame {
	return new ProactiveFrame(new ProactiveTickInput(sessionKey, startedAt), slots);
}
