/**
 * Clock — 可注入时钟(akashic core/clock.py 的移植)。
 *
 * 编排层与策略层统一通过 Clock 取时间。生产使用 SystemClock；回放使用
 * ReplayClock，将模拟时间原子持久化到文件，进程重启后仍能继续推进。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface Clock {
	now(): Date;
	nowMs(): number;
}

/** 生产时钟:直接读系统时间。 */
export const SystemClock: Clock = {
	now: () => new Date(),
	nowMs: () => Date.now(),
};

/** 可持久化的模拟时钟，供 proactive 回放和确定性测试使用。 */
export class ReplayClock implements Clock {
	readonly isReplay: boolean;
	readonly statePath: string;

	constructor(statePath: string, initial?: Date) {
		this.statePath = statePath;
		this.isReplay = true;
		if (!existsSync(statePath)) this.set(initial ?? new Date());
	}

	now(): Date {
		return new Date(this.nowMs());
	}

	nowMs(): number {
		const raw = JSON.parse(readFileSync(this.statePath, "utf-8")) as { current_time?: unknown };
		const current = new Date(String(raw.current_time ?? ""));
		if (!Number.isFinite(current.getTime())) throw new Error(`invalid replay clock state: ${this.statePath}`);
		return current.getTime();
	}

	set(value: Date): Date {
		const currentMs = value.getTime();
		if (!Number.isFinite(currentMs)) throw new Error("replay clock value must be a valid date");
		const current = new Date(currentMs);
		mkdirSync(dirname(this.statePath), { recursive: true });
		const temporary = `${this.statePath}.tmp`;
		writeFileSync(
			temporary,
			`${JSON.stringify({ current_time: current.toISOString(), updated_at: new Date().toISOString() }, null, 2)}\n`,
			"utf-8",
		);
		renameSync(temporary, this.statePath);
		return current;
	}

	advance(deltaMs: number): Date {
		if (!Number.isFinite(deltaMs)) throw new Error("replay clock delta must be finite");
		return this.set(new Date(this.nowMs() + deltaMs));
	}
}

/** 从环境变量选择回放时钟；未配置时返回生产时钟。 */
export function clockFromEnv(
	path = process.env.PI_PROACTIVE_REPLAY_CLOCK_FILE ?? process.env.AKASHIC_REPLAY_CLOCK_FILE,
): Clock {
	if (!path?.trim()) return SystemClock;
	const replayPath = path.trim();
	if (!existsSync(replayPath)) return new ReplayClock(replayPath, new Date());
	return new ReplayClock(replayPath);
}

/** 为回放提供基于 scope + 当前模拟时间的稳定随机序列。 */
export function replayRandom(clock: Clock, scope: string): () => number {
	let sequence = 0;
	return () => {
		const input = `${scope}:${clock.nowMs()}:${sequence++}`;
		let hash = 2_166_136_261;
		for (let index = 0; index < input.length; index++) {
			hash ^= input.charCodeAt(index);
			hash = Math.imul(hash, 16_777_619);
		}
		return (hash >>> 0) / 4_294_967_296;
	};
}
