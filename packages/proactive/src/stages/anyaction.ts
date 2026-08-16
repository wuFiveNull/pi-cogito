/**
 * AnyAction 概率主动层(akashic anyaction.py port)。
 *
 * 后台主动动作的通用闸:硬配额 + 最小间隔 + 随静默时长升高的概率抽签。
 * 配额按「本地时区 + 每日重置小时」滚动窗口持久化(pi 存于 proactive.sqlite
 * 的 state 表,akashic 用独立 JSON 文件)。
 */

import { type Clock, SystemClock } from "../clock.ts";
import type { ProactiveStore } from "../store.ts";

export interface AnyActionConfig {
	/** anyaction_daily_max_actions: 每日动作上限。 */
	dailyMaxActions: number;
	/** anyaction_min_interval_seconds: 距上次动作的最小间隔。 */
	minIntervalSeconds: number;
	/** anyaction_probability_min: 静默为 0 时的动作概率。 */
	probabilityMin: number;
	/** anyaction_probability_max: 长时间静默后的动作概率上限。 */
	probabilityMax: number;
	/** anyaction_idle_scale_minutes: 静默概率爬升的时间尺度(分钟)。 */
	idleScaleMinutes: number;
	/** anyaction_reset_hour_local: 配额窗口每日重置小时(本地时区)。 */
	resetHourLocal: number;
	/** anyaction_timezone: 配额窗口所用 IANA 时区。 */
	timezone: string;
}

export interface AnyActionMeta {
	reason: string;
	usedToday: number;
	remainingToday: number;
	idleMinutes: number;
	pAct: number;
	draw: number;
}

interface QuotaState {
	windowKey: string;
	nextResetAt: string;
	used: number;
	lastActionAt: string;
}

const QUOTA_KEY = "anyaction.quota";

/** 本地时区的窗口元数据:窗口起始日 + 下一次重置时刻。 */
function windowMeta(now: Date, resetHour: number, timeZone: string): { start: Date; nextReset: Date } {
	const formatter = new Intl.DateTimeFormat("en-CA", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		hourCycle: "h23",
	});
	const parts = Object.fromEntries(formatter.formatToParts(now).map((p) => [p.type, p.value]));
	const year = Number(parts.year);
	const month = Number(parts.month) - 1;
	const day = Number(parts.day);
	const hour = Number(parts.hour);
	const localNow = new Date(Date.UTC(year, month, day, hour));
	const resetToday = new Date(Date.UTC(year, month, day, resetHour));
	if (localNow.getTime() >= resetToday.getTime()) {
		return { start: resetToday, nextReset: new Date(Date.UTC(year, month, day + 1, resetHour)) };
	}
	return { start: new Date(Date.UTC(year, month, day - 1, resetHour)), nextReset: resetToday };
}

function formatUtc(date: Date): string {
	return date.toISOString();
}

export class AnyActionGate {
	private readonly config: AnyActionConfig;
	private readonly store: ProactiveStore;
	private readonly rng: () => number;
	private readonly clock: Clock;

	constructor(
		config: AnyActionConfig,
		store: ProactiveStore,
		rng: () => number = Math.random,
		clock: Clock = SystemClock,
	) {
		this.config = config;
		this.store = store;
		this.rng = rng;
		this.clock = clock;
	}

	/** 读取配额并做窗口滚动(akashic QuotaStore.snapshot)。 */
	private quotaSnapshot(now: Date): QuotaState {
		const raw = this.store.getState(QUOTA_KEY);
		let quota: QuotaState = raw
			? (JSON.parse(raw) as QuotaState)
			: { windowKey: "", nextResetAt: "", used: 0, lastActionAt: "" };
		const { start, nextReset } = windowMeta(now, this.config.resetHourLocal, this.config.timezone);
		const windowKey = `${start.toISOString().slice(0, 10)}@${String(this.config.resetHourLocal).padStart(2, "0")}@${this.config.timezone}`;
		if (quota.windowKey !== windowKey) {
			quota = {
				windowKey,
				nextResetAt: formatUtc(nextReset),
				used: 0,
				lastActionAt: quota.lastActionAt,
			};
			this.saveQuota(quota);
		}
		return quota;
	}

	private saveQuota(quota: QuotaState): void {
		this.store.setState(QUOTA_KEY, JSON.stringify(quota));
	}

	/**
	 * 判定当前是否允许执行一个主动动作(akashic AnyActionGate.should_act):
	 * 1. 配额用尽 → 拒绝;2. 距上次动作过短 → 拒绝;
	 * 3. 否则按 idle 时长抽签:p = p_min + (p_max - p_min) * (1 - exp(-idle/scale))。
	 */
	shouldAct(now: Date, lastUserAt: number | null): { shouldAct: boolean; meta: AnyActionMeta } {
		const quota = this.quotaSnapshot(now);
		const remaining = Math.max(0, this.config.dailyMaxActions - quota.used);
		const baseMeta = { usedToday: quota.used, remainingToday: remaining };

		if (remaining <= 0) {
			return {
				shouldAct: false,
				meta: { ...baseMeta, reason: "quota_exhausted", idleMinutes: 0, pAct: 0, draw: 0 },
			};
		}
		if (quota.lastActionAt) {
			const sinceLast = (now.getTime() - Date.parse(quota.lastActionAt)) / 1000;
			if (sinceLast < this.config.minIntervalSeconds) {
				return {
					shouldAct: false,
					meta: { ...baseMeta, reason: "min_interval", idleMinutes: 0, pAct: 0, draw: 0 },
				};
			}
		}

		const idleMinutes =
			lastUserAt !== null ? Math.max(0, (now.getTime() - lastUserAt) / 60_000) : this.config.idleScaleMinutes * 2;
		const idleFactor = 1 - Math.exp(-idleMinutes / Math.max(1, this.config.idleScaleMinutes));
		const pAct = Math.min(
			1,
			Math.max(
				0,
				this.config.probabilityMin + (this.config.probabilityMax - this.config.probabilityMin) * idleFactor,
			),
		);
		const draw = this.rng();
		return { shouldAct: draw < pAct, meta: { ...baseMeta, reason: "probability", idleMinutes, pAct, draw } };
	}

	/** 动作成功后计数(akashic AnyActionGate.record_action)。 */
	recordAction(now?: Date): void {
		const quota = this.quotaSnapshot(now ?? this.clock.now());
		quota.used += 1;
		quota.lastActionAt = formatUtc(now ?? this.clock.now());
		this.saveQuota(quota);
	}
}
