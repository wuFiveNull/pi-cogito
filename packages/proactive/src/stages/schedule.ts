/**
 * Proactive energy — dynamic decay and proactive urge (akashic energy.py port).
 *
 * Multi-timescale exponential decay:
 *   E(t) = alpha*exp(-t/tau1) + beta*exp(-t/tau2) + gamma*exp(-t/tau3)
 *   tau1=30min (conversation warmth), tau2=240min (same-day context),
 *   tau3=2880min (48h relationship continuity).
 *
 * Contribution functions:
 *   D_energy = 1 - energy        (interaction hunger: the longer without talk, the higher)
 *   D_recent = log(1+k)/log(1+s) (context richness from recent message count)
 *
 * A higher base_score -> nextTickFromScore returns a shorter interval -> the
 * proactive loop draws the lottery more often.
 */

import { type Clock, SystemClock } from "../clock.ts";

/** Energy in [0, 1]; 0 when no user message has ever been seen. */
export function computeEnergy(
	lastUserAt: number | null,
	now: number = SystemClock.nowMs(),
	options: {
		alpha?: number;
		beta?: number;
		gamma?: number;
		tau1Min?: number;
		tau2Min?: number;
		tau3Min?: number;
	} = {},
): number {
	if (lastUserAt === null) return 0;
	const alpha = options.alpha ?? 0.5;
	const beta = options.beta ?? 0.35;
	const gamma = options.gamma ?? 0.15;
	const tau1Min = options.tau1Min ?? 30;
	const tau2Min = options.tau2Min ?? 240;
	const tau3Min = options.tau3Min ?? 2880;
	const t = Math.max(0, (now - lastUserAt) / 60_000);
	return alpha * Math.exp(-t / tau1Min) + beta * Math.exp(-t / tau2Min) + gamma * Math.exp(-t / tau3Min);
}

/** Interaction hunger: low energy (long silence) -> high contribution. */
export function dEnergy(energy: number): number {
	return 1 - Math.max(0, Math.min(1, energy));
}

/** Context richness: recent message count, log-normalized, capped at 1. */
export function dRecent(msgCount: number, scale = 10): number {
	if (msgCount <= 0) return 0;
	return Math.min(1, Math.log1p(Math.max(0, msgCount)) / Math.log1p(Math.max(scale, 1)));
}

/**
 * Next tick wait seconds driven by base_score (akashic next_tick_from_score):
 * base_score > 0.20 -> tick_s1 (~40min), otherwise tick_s0 (~80min), with
 * uniform jitter around the base.
 */
export function nextTickFromScore(
	baseScore: number,
	options: {
		tickS1?: number;
		tickS0?: number;
		tickJitter?: number;
		random?: () => number;
	} = {},
): number {
	const tickS1 = options.tickS1 ?? 2400;
	const tickS0 = options.tickS0 ?? 4800;
	const tickJitter = options.tickJitter ?? 0.3;
	const base = baseScore > 0.2 ? tickS1 : tickS0;
	if (tickJitter <= 0) return base;
	const random = options.random ?? Math.random;
	const r = 1 - tickJitter + random() * (2 * tickJitter);
	return Math.max(1, Math.trunc(base * r));
}

export interface TickSchedulerConfig {
	/** score_weight_energy: share of the energy hunger in base_score. */
	scoreWeightEnergy?: number;
	/** tick_interval_s1: base_score > 0.20 -> ~40min. */
	tickS1?: number;
	/** tick_interval_s0: base_score <= 0.20 -> ~80min. */
	tickS0?: number;
	/** tick_jitter: uniform jitter ratio around the base interval. */
	tickJitter?: number;
	/** Fallback interval when presence is unavailable (interval_seconds). */
	fallbackIntervalSeconds?: number;
	random?: () => number;
}

/** Adaptive proactive tick scheduler (akashic ProactiveScheduler). */
export class TickScheduler {
	readonly config: TickSchedulerConfig;
	private readonly clock: Clock;

	constructor(config: TickSchedulerConfig = {}, clock: Clock = SystemClock) {
		this.config = config;
		this.clock = clock;
	}

	nextInterval(baseScore: number | null, lastUserAt: number | null): number {
		const fallback = this.config.fallbackIntervalSeconds ?? 1800;
		if (lastUserAt === null) {
			// No presence: fixed fallback interval (akashic interval_seconds mode).
			return fallback;
		}
		const energy = computeEnergy(lastUserAt, this.clock.nowMs());
		// akashic STRATEGY_PARAMS(presets.py)覆盖 config 默认 0.40,有效值为 0.35。
		const score = baseScore ?? dEnergy(energy) * (this.config.scoreWeightEnergy ?? 0.35);
		return nextTickFromScore(score, {
			tickS1: this.config.tickS1,
			tickS0: this.config.tickS0,
			tickJitter: this.config.tickJitter,
			random: this.config.random,
		});
	}
}

// ------------------------------------------------------------------
// 调度策略(默认:energy 模型)
// ------------------------------------------------------------------

import type { ScheduleStrategy, SenseState } from "./types.ts";

export class EnergyScheduleStrategy implements ScheduleStrategy {
	readonly id = "energy-schedule";
	private readonly tickScheduler: TickScheduler;

	constructor(config: TickSchedulerConfig = {}, clock: Clock = SystemClock) {
		this.tickScheduler = new TickScheduler(config, clock);
	}

	nextInterval(state: SenseState): number {
		return this.tickScheduler.nextInterval(state.baseScore, state.lastUserAt);
	}

	/** 调度参数快照(akashic rate trace 的 tick_interval_s0/s1/jitter)。 */
	traceContext(): Record<string, unknown> {
		return {
			tick_interval_s0: this.tickScheduler.config.tickS0 ?? 4800,
			tick_interval_s1: this.tickScheduler.config.tickS1 ?? 2400,
			tick_jitter: this.tickScheduler.config.tickJitter ?? 0.3,
		};
	}
}
