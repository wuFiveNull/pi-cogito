/**
 * Proactive 预设配置(akashic proactive_v2/presets.py 移植)。
 *
 * 预设提供 trigger/anyaction/safety/context 的默认值,显式配置逐字段覆盖。
 * preset 字段命名与 akashic 保持一致(下划线),映射到 PusherConfig 时转驼峰。
 */

export interface TriggerPreset {
	tick_interval_s0: number;
	tick_interval_s1: number;
	tick_jitter: number;
}

export interface GatePreset {
	/** judge_send_threshold: 判题发送置信度下限(akashic 只放进配置,judge 不消费;保留对齐)。 */
	judge_send_threshold: number;
}

export interface AnyActionPreset {
	anyaction_enabled: boolean;
	anyaction_daily_max_actions: number;
	anyaction_min_interval_seconds: number;
	anyaction_probability_min: number;
	anyaction_probability_max: number;
	anyaction_idle_scale_minutes: number;
	anyaction_reset_hour_local: number;
	anyaction_timezone: string;
}

export interface SafetyPreset {
	delivery_dedupe_hours: number;
	message_dedupe_recent_n: number;
}

export interface ContextPreset {
	context_only_daily_max: number;
	context_only_min_interval_hours: number;
}

export interface PresetConfig {
	trigger: TriggerPreset;
	gate: GatePreset;
	anyaction: AnyActionPreset;
	safety: SafetyPreset;
	context: ContextPreset;
}

export const PRESETS: Record<string, PresetConfig> = {
	daily: {
		trigger: {
			tick_interval_s0: 480, // 8 分钟
			tick_interval_s1: 240, // 4 分钟
			tick_jitter: 0.2,
		},
		gate: {
			judge_send_threshold: 0.6,
		},
		anyaction: {
			anyaction_enabled: true,
			anyaction_daily_max_actions: 48,
			anyaction_min_interval_seconds: 180,
			anyaction_probability_min: 0.2,
			anyaction_probability_max: 0.82,
			anyaction_idle_scale_minutes: 30,
			anyaction_reset_hour_local: 12,
			anyaction_timezone: "Asia/Shanghai",
		},
		safety: {
			delivery_dedupe_hours: 10,
			message_dedupe_recent_n: 5,
		},
		context: {
			context_only_daily_max: 1,
			context_only_min_interval_hours: 12,
		},
	},
	dev_verify: {
		// 改完代码后 2-5 分钟内可见效果。
		trigger: {
			tick_interval_s0: 60, // 1 分钟
			tick_interval_s1: 30, // 30 秒
			tick_jitter: 0,
		},
		gate: {
			judge_send_threshold: 0.28,
		},
		anyaction: {
			anyaction_enabled: true,
			anyaction_daily_max_actions: 999,
			anyaction_min_interval_seconds: 20,
			anyaction_probability_min: 0.75,
			anyaction_probability_max: 0.98,
			anyaction_idle_scale_minutes: 15,
			anyaction_reset_hour_local: 12,
			anyaction_timezone: "Asia/Shanghai",
		},
		safety: {
			delivery_dedupe_hours: 1,
			message_dedupe_recent_n: 5,
		},
		context: {
			context_only_daily_max: 20,
			context_only_min_interval_hours: 1,
		},
	},
	quiet: {
		// 低打扰模式,比 daily 慢 3-4 倍。
		trigger: {
			tick_interval_s0: 1800, // 30 分钟
			tick_interval_s1: 900, // 15 分钟
			tick_jitter: 0.3,
		},
		gate: {
			judge_send_threshold: 0.75,
		},
		anyaction: {
			anyaction_enabled: true,
			anyaction_daily_max_actions: 12,
			anyaction_min_interval_seconds: 600,
			anyaction_probability_min: 0.05,
			anyaction_probability_max: 0.3,
			anyaction_idle_scale_minutes: 120,
			anyaction_reset_hour_local: 12,
			anyaction_timezone: "Asia/Shanghai",
		},
		safety: {
			delivery_dedupe_hours: 24,
			message_dedupe_recent_n: 8,
		},
		context: {
			context_only_daily_max: 1,
			context_only_min_interval_hours: 24,
		},
	},
};

export type PresetName = keyof typeof PRESETS;

/** preset 字段 → PusherConfig 字段的映射(akashic override 白名单的 pi 形态)。 */
export function applyPreset<P extends { tick?: unknown; gate?: unknown; safety?: unknown }>(config: P): P {
	const name = (config as { preset?: string }).preset;
	if (!name || !(name in PRESETS)) return config;
	const preset = PRESETS[name]!;
	const gate = (config.gate ?? {}) as Record<string, unknown>;
	const anyaction = (gate.anyaction ?? {}) as Record<string, unknown>;
	const contextOnly = (gate.contextOnly ?? {}) as Record<string, unknown>;
	const safety = (config.safety ?? {}) as Record<string, unknown>;
	return {
		...config,
		tick: {
			tickS0: preset.trigger.tick_interval_s0,
			tickS1: preset.trigger.tick_interval_s1,
			tickJitter: preset.trigger.tick_jitter,
			...(config.tick as Record<string, unknown> | undefined),
		},
		gate: {
			...gate,
			judgeSendThreshold: (gate.judgeSendThreshold as number | undefined) ?? preset.gate.judge_send_threshold,
			anyaction: {
				enabled: preset.anyaction.anyaction_enabled,
				dailyMaxActions: preset.anyaction.anyaction_daily_max_actions,
				minIntervalSeconds: preset.anyaction.anyaction_min_interval_seconds,
				probabilityMin: preset.anyaction.anyaction_probability_min,
				probabilityMax: preset.anyaction.anyaction_probability_max,
				idleScaleMinutes: preset.anyaction.anyaction_idle_scale_minutes,
				resetHourLocal: preset.anyaction.anyaction_reset_hour_local,
				timezone: preset.anyaction.anyaction_timezone,
				...anyaction,
			},
			contextOnly: {
				minIntervalHours: preset.context.context_only_min_interval_hours,
				dailyMax: preset.context.context_only_daily_max,
				...contextOnly,
			},
		},
		safety: {
			deliveryDedupeHours: preset.safety.delivery_dedupe_hours,
			messageDedupeRecentN: preset.safety.message_dedupe_recent_n,
			...safety,
		},
	} as P;
}
