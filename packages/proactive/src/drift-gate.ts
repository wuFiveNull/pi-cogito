/**
 * Drift gate 写出契约(三进程门控)。
 *
 * proactive 进程在每个 tick 后把「判题结果」写入 drift.db 的 drift_gate 表
 * (经 drift 的 DriftStateStore.writeDriftGate);drift daemon 读取该许可
 * (带 TTL 过期)后自行决定是否执行一轮 Drift。
 */

/** 写入 drift 许可的回调(由宿主注入;生产实现 = DriftStateStore.writeDriftGate)。 */
export type DriftGateWriter = (gate: {
	sessionKey: string;
	verdict: "allowed" | "suppressed";
	reason?: string;
	/** 写入方预取的上下文事件文本(供 drift 的 driftCurrentContext 使用)。 */
	context?: string;
	grantedAt: Date;
	ttlHours: number;
}) => void | Promise<void>;

/** Wake 空闲时写「允许」许可的默认 TTL(小时);proactive 每 tick 刷新。 */
export const WAKE_DRIFT_GATE_TTL_HOURS = 1;
