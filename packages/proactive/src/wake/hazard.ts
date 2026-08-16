/**
 * Wake hazard 模型(akashic plugins/wake_proactive/hazard.py port)。
 *
 * 内容压力推进全池概率抽签:新鲜度半衰期 36h、新事件 kick、池质量放大、
 * 2h 不应期,最终 probability = 1 - exp(-3 * event_drive)。
 */

const FRESHNESS_HALF_LIFE_HOURS = 36.0;
const MISSING_PUBLICATION_CONFIDENCE = 0.03;
const INELIGIBLE_CONFIDENCE_MULTIPLIER = 0.01;
const SOURCE_DIVERSITY_DECAY = 0.5;
export const WAKE_ADMISSION_FLOOR = 0.02;
const NEW_MASS_SCALE = 0.35;
const POOL_MASS_SCALE = 1.5;
const CONTENT_TRIGGER_GAIN = 3.0;
const REFRACTORY_HOURS = 2.0;

export interface HazardResult {
	shouldWake: boolean;
	hazardBefore: number;
	hazardAfter: number;
	threshold: number;
	evidence: number;
	refractory: number;
	rate: number;
	preferencePressure: number;
	driverItemId: string;
}

function parseTime(value: unknown, fallback: Date): Date {
	if (typeof value === "string" && value) {
		const parsed = new Date(value);
		if (!Number.isNaN(parsed.getTime())) return parsed;
	}
	return fallback;
}

function asFloat(value: unknown): number {
	if (typeof value === "number") return value;
	if (typeof value === "string") {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : 0;
	}
	return 0;
}

export function advanceHazard(
	events: Array<Record<string, unknown>>,
	options: {
		now: Date;
		newItemIds: Set<string>;
		randomDraw: number;
		lastWakeAt: Date | null;
		poolMass?: number | null;
	},
): HazardResult {
	const { now, newItemIds, randomDraw, lastWakeAt, poolMass } = options;
	if (events.length === 0 || newItemIds.size === 0) {
		return {
			shouldWake: false,
			hazardBefore: 0,
			hazardAfter: 0,
			threshold: randomDraw,
			evidence: 0,
			refractory: 0,
			rate: 0,
			preferencePressure: 0,
			driverItemId: "",
		};
	}

	const ranked = rankEvents(events, now);
	const contributions: Array<[string, number]> = [];
	let preferencePressure = 0.0;
	let newMass = 0.0;
	for (const event of ranked) {
		const features = event._wake_rank_features as Record<string, number>;
		const probability = Number(features.interest);
		const semanticInterest = Number(features.semantic_interest);
		const freshness = Number(features.freshness);
		const confidence = Number(features.publication_confidence);
		preferencePressure = Math.max(preferencePressure, semanticInterest * probability * freshness * confidence);
		const itemId = String(event.id ?? "");
		const contribution = Math.max(0, Number(event._wake_rank_score) - WAKE_ADMISSION_FLOOR);
		contributions.push([itemId, contribution]);
		if (newItemIds.has(itemId)) newMass += contribution;
	}

	if (contributions.length === 0) {
		return {
			shouldWake: false,
			hazardBefore: 0,
			hazardAfter: 0,
			threshold: randomDraw,
			evidence: 0,
			refractory: 0,
			rate: 0,
			preferencePressure: 0,
			driverItemId: "",
		};
	}

	const materialMass = contributions.reduce((sum, [, value]) => sum + value, 0);
	const evidence = Math.max(materialMass, Math.max(0, poolMass ?? 0));
	const refractory =
		lastWakeAt !== null
			? 1 - Math.exp(-Math.max(0, (now.getTime() - lastWakeAt.getTime()) / 1000) / (REFRACTORY_HOURS * 3600))
			: 1;
	const newSignal = 1 - Math.exp(-newMass / NEW_MASS_SCALE);
	const poolSignal = 1 - Math.exp(-evidence / POOL_MASS_SCALE);
	const eventDrive = newSignal * (0.25 + 0.75 * poolSignal) * refractory;
	const probability = 1 - Math.exp(-CONTENT_TRIGGER_GAIN * eventDrive);
	const driver = contributions.reduce(
		(best, current) => (current[1] > best[1] ? current : best),
		contributions[0]!,
	)[0];

	return {
		shouldWake: randomDraw < probability,
		hazardBefore: newMass,
		hazardAfter: probability,
		threshold: randomDraw,
		evidence,
		refractory,
		rate: probability,
		preferencePressure,
		driverItemId: driver,
	};
}

export function rankEvents(events: Array<Record<string, unknown>>, now: Date): Array<Record<string, unknown>> {
	const scored: Array<Record<string, unknown>> = [];
	for (const event of events) {
		const rawProbability = event._wake_interest_score ?? event.preprocess_score;
		const probability = Math.min(0.999, Math.max(0, asFloat(rawProbability)));
		const semanticInterest = Math.min(0.999, Math.max(0, asFloat(event._wake_semantic_interest)));
		const rawPublishedAt = event.published_at;
		const rawFirstSeenAt = event.first_seen_at;
		const referenceTime = parseTime(
			typeof rawPublishedAt === "string" && rawPublishedAt ? rawPublishedAt : rawFirstSeenAt,
			now,
		);
		const ageHours = Math.max(0, (now.getTime() - referenceTime.getTime()) / 3600_000);
		const freshness = Math.exp((-Math.log(2) * ageHours) / FRESHNESS_HALF_LIFE_HOURS);
		let publicationConfidence = rawPublishedAt ? 1 : MISSING_PUBLICATION_CONFIDENCE;
		if (event.wake_eligible === false) publicationConfidence *= INELIGIBLE_CONFIDENCE_MULTIPLIER;
		const evidence = -Math.log1p(-probability) * freshness * publicationConfidence;
		const copied = { ...event };
		copied._wake_rank_score = evidence;
		copied._wake_rank_features = {
			interest: probability,
			semantic_interest: semanticInterest,
			freshness,
			age_hours: ageHours,
			publication_confidence: publicationConfidence,
			admission_mass: evidence,
			source_diversity: 1,
		};
		scored.push(copied);
	}

	scored.sort((a, b) => rankKey(b, a));
	const sourceCounts: Record<string, number> = {};
	for (const event of scored) {
		const sourceId = String(event._reservoir_original_source_id ?? event.source_id ?? event.source ?? "unknown");
		const position = sourceCounts[sourceId] ?? 0;
		const multiplier = SOURCE_DIVERSITY_DECAY ** position;
		sourceCounts[sourceId] = position + 1;
		event._wake_rank_score = Number(event._wake_rank_score) * multiplier;
		(event._wake_rank_features as Record<string, number>).source_diversity = multiplier;
	}
	return scored.sort((a, b) => rankKey(b, a));
}

function rankKey(a: Record<string, unknown>, b: Record<string, unknown>): number {
	const scoreDiff = Number(a._wake_rank_score) - Number(b._wake_rank_score);
	if (scoreDiff !== 0) return scoreDiff;
	const aTime = String(a.published_at ?? a.first_seen_at ?? "");
	const bTime = String(b.published_at ?? b.first_seen_at ?? "");
	return aTime.localeCompare(bTime);
}
