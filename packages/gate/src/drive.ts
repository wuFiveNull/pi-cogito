/**
 * Wake drift 驱动(akashic plugins/wake_proactive/drift_drive.py port)。
 *
 * 空闲 hazard 累积(半衰期 12h)+ 一次性到期时间采样:
 * 把「空闲驱动的累计 hazard」反演成下一次 drift 尝试的到期时刻,
 * 避免周期轮询积累(单调二分求解)。
 */

export type DriftDecision = "attempt" | "idle";

const HAZARD_HALF_LIFE_HOURS = 12.0;

export interface DriftDriveResult {
	decision: DriftDecision;
	hazardBefore: number;
	hazardAfter: number;
	threshold: number;
	rate: number;
	idleHours: number;
	idleDrive: number;
	contentSuppression: number;
	recentDriftSuppression: number;
	repetitionSuppression: number;
	reasons: string[];
}

function bounded(value: number): number {
	return Math.min(1, Math.max(0, value));
}

export function advanceDriftDrive(options: {
	now: Date;
	hazard: number;
	threshold: number;
	updatedAt: Date | null;
	lastUserAt: Date | null;
	lastDriftAt: Date | null;
	contentEvidence: number;
	repetition?: number;
	maxRatePerHour?: number;
}): DriftDriveResult {
	const {
		now,
		hazard,
		threshold,
		updatedAt,
		lastUserAt,
		lastDriftAt,
		contentEvidence,
		repetition = 0,
		maxRatePerHour = 0.3,
	} = options;
	const content = bounded(contentEvidence);
	const repetitionScore = bounded(repetition);
	const idleHours = lastUserAt !== null ? Math.max(0, (now.getTime() - lastUserAt.getTime()) / 3600_000) : 0;
	const idleDrive = 1 - Math.exp(-idleHours / 4);
	const contentSuppression = content;
	const recentDriftSuppression =
		lastDriftAt !== null ? Math.exp(-Math.max(0, (now.getTime() - lastDriftAt.getTime()) / 1000) / (6 * 3600)) : 0;
	const repetitionSuppression = repetitionScore;
	const rate =
		maxRatePerHour *
		idleDrive *
		(1 - 0.95 * contentSuppression) *
		(1 - 0.9 * recentDriftSuppression) *
		(1 - 0.9 * repetitionSuppression);
	const elapsedHours = updatedAt !== null ? Math.max(0, (now.getTime() - updatedAt.getTime()) / 3600_000) : 5 / 60;
	const before = Math.max(0, hazard);
	const timeConstant = HAZARD_HALF_LIFE_HOURS / Math.log(2);
	const retention = Math.exp(-elapsedHours / timeConstant);
	const after = before * retention + Math.max(0, rate) * timeConstant * (1 - retention);
	const attempt = after >= threshold;
	return {
		decision: attempt ? "attempt" : "idle",
		hazardBefore: before,
		hazardAfter: after,
		threshold,
		rate,
		idleHours,
		idleDrive,
		contentSuppression,
		recentDriftSuppression,
		repetitionSuppression,
		reasons: reasons({ content, recentDrift: recentDriftSuppression, repetition: repetitionScore, attempt }),
	};
}

function reasons(options: { content: number; recentDrift: number; repetition: number; attempt: boolean }): string[] {
	const reasonsList: string[] = [];
	if (options.content >= 0.5) reasonsList.push("content_evidence");
	if (options.recentDrift >= 0.5) reasonsList.push("recent_drift");
	if (options.repetition >= 0.5) reasonsList.push("repetition");
	if (options.attempt) reasonsList.push("leisure_ready");
	return reasonsList;
}

/** 单调求解剩余累计 hazard,返回距下一次 drift 尝试的小时数(akashic sample_drift_delay_hours)。 */
export function sampleDriftDelayHours(options: {
	randomDraw: number;
	idleHours: number;
	recentDriftSuppression: number;
	repetitionSuppression: number;
	maxRatePerHour?: number;
}): number {
	const { randomDraw, idleHours, recentDriftSuppression, repetitionSuppression, maxRatePerHour = 0.08 } = options;
	const scale =
		maxRatePerHour * (1 - 0.9 * bounded(recentDriftSuppression)) * (1 - 0.9 * bounded(repetitionSuppression));
	const target = -Math.log1p(-Math.min(1 - 1e-12, Math.max(0, randomDraw)));
	const startMass = integratedIdleDrive(Math.max(0, idleHours), scale);

	let low = Math.max(0, idleHours);
	let high = low + 1;
	while (integratedIdleDrive(high, scale) - startMass < target) {
		high = low + 2 * (high - low);
	}
	for (let i = 0; i < 64; i++) {
		const middle = (low + high) / 2;
		if (integratedIdleDrive(middle, scale) - startMass < target) low = middle;
		else high = middle;
	}
	return high - Math.max(0, idleHours);
}

function integratedIdleDrive(idleHours: number, scale: number): number {
	return scale * (idleHours - 4 * (1 - Math.exp(-idleHours / 4)));
}
