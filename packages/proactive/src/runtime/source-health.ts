import type { ProactiveStore } from "../store.ts";

export type SourceCircuitState = "closed" | "open" | "half_open";

export interface SourceHealthMetrics {
	received?: number;
	accepted?: number;
	quarantined?: number;
}

export interface SourceHealthRecord {
	sourceId: string;
	status: "ok" | "empty" | "degraded" | "error" | "circuit_open" | "half_open";
	circuitState: SourceCircuitState;
	consecutiveFailures: number;
	fetchAttempts: number;
	fetchSuccesses: number;
	fetchFailures: number;
	received: number;
	accepted: number;
	quarantined: number;
	checkedAt: number;
	lastSuccessAt: number | null;
	lastFailureAt: number | null;
	nextProbeAt: number | null;
	lastError: string | null;
	diagnostics?: unknown;
}

export interface SourceHealthTrackerOptions {
	store: ProactiveStore;
	failureThreshold?: number;
	cooldownMs?: number;
}

/** Durable source metrics and a restart-safe circuit breaker. */
export class SourceHealthTracker {
	private readonly store: ProactiveStore;
	private readonly failureThreshold: number;
	private readonly cooldownMs: number;
	private readonly inFlight = new Set<string>();

	constructor(options: SourceHealthTrackerOptions) {
		this.store = options.store;
		this.failureThreshold = Math.max(1, Math.floor(options.failureThreshold ?? 3));
		this.cooldownMs = Math.max(1, Math.floor(options.cooldownMs ?? 5 * 60 * 1000));
	}

	tryAcquire(sourceId: string, now: number): boolean {
		if (this.inFlight.has(sourceId)) return false;
		const current = this.read(sourceId);
		if (current?.circuitState === "open") {
			if (current.nextProbeAt !== null && current.nextProbeAt > now) return false;
			this.persist({
				...current,
				status: "half_open",
				circuitState: "half_open",
				checkedAt: now,
				nextProbeAt: null,
			});
		}
		this.inFlight.add(sourceId);
		return true;
	}

	recordSuccess(sourceId: string, now: number, metrics: SourceHealthMetrics = {}): SourceHealthRecord {
		this.inFlight.delete(sourceId);
		const previous = this.read(sourceId);
		const record: SourceHealthRecord = {
			sourceId,
			status: (metrics.quarantined ?? 0) > 0 ? "degraded" : (metrics.received ?? 0) > 0 ? "ok" : "empty",
			circuitState: "closed",
			consecutiveFailures: 0,
			fetchAttempts: (previous?.fetchAttempts ?? 0) + 1,
			fetchSuccesses: (previous?.fetchSuccesses ?? 0) + 1,
			fetchFailures: previous?.fetchFailures ?? 0,
			received: metrics.received ?? 0,
			accepted: metrics.accepted ?? 0,
			quarantined: metrics.quarantined ?? 0,
			checkedAt: now,
			lastSuccessAt: now,
			lastFailureAt: previous?.lastFailureAt ?? null,
			nextProbeAt: null,
			lastError: null,
			diagnostics: previous?.diagnostics,
		};
		this.persist(record);
		return record;
	}

	recordFailure(sourceId: string, now: number, error: string): SourceHealthRecord {
		this.inFlight.delete(sourceId);
		const previous = this.read(sourceId);
		const consecutiveFailures = (previous?.consecutiveFailures ?? 0) + 1;
		const open = consecutiveFailures >= this.failureThreshold;
		const record: SourceHealthRecord = {
			sourceId,
			status: open ? "circuit_open" : "error",
			circuitState: open ? "open" : "closed",
			consecutiveFailures,
			fetchAttempts: (previous?.fetchAttempts ?? 0) + 1,
			fetchSuccesses: previous?.fetchSuccesses ?? 0,
			fetchFailures: (previous?.fetchFailures ?? 0) + 1,
			received: previous?.received ?? 0,
			accepted: previous?.accepted ?? 0,
			quarantined: previous?.quarantined ?? 0,
			checkedAt: now,
			lastSuccessAt: previous?.lastSuccessAt ?? null,
			lastFailureAt: now,
			nextProbeAt: open ? now + this.cooldownMs : null,
			lastError: error.slice(0, 2000),
			diagnostics: previous?.diagnostics,
		};
		this.persist(record);
		return record;
	}

	recordSkipped(sourceId: string, now: number): SourceHealthRecord | undefined {
		const current = this.read(sourceId);
		if (!current) return undefined;
		const record = { ...current, status: "circuit_open" as const, checkedAt: now };
		this.persist(record);
		return record;
	}

	read(sourceId: string): SourceHealthRecord | undefined {
		const raw = this.store.getState(`health.source.${sourceId}`);
		if (!raw) return undefined;
		try {
			const parsed: unknown = JSON.parse(raw);
			if (!isRecord(parsed)) return undefined;
			return decodeRecord(sourceId, parsed);
		} catch {
			return undefined;
		}
	}

	private persist(record: SourceHealthRecord): void {
		this.store.setState(`health.source.${record.sourceId}`, JSON.stringify(toJson(record)));
	}
}

function decodeRecord(sourceId: string, value: Record<string, unknown>): SourceHealthRecord {
	const circuitState =
		value.circuitState === "open" || value.circuitState === "half_open" ? value.circuitState : "closed";
	const status =
		value.status === "ok" ||
		value.status === "empty" ||
		value.status === "degraded" ||
		value.status === "error" ||
		value.status === "circuit_open" ||
		value.status === "half_open"
			? value.status
			: circuitState === "open"
				? "circuit_open"
				: "error";
	return {
		sourceId,
		status,
		circuitState,
		consecutiveFailures: nonNegativeInt(value.consecutiveFailures),
		fetchAttempts: nonNegativeInt(value.fetchAttempts),
		fetchSuccesses: nonNegativeInt(value.fetchSuccesses),
		fetchFailures: nonNegativeInt(value.fetchFailures),
		received: nonNegativeInt(value.received),
		accepted: nonNegativeInt(value.accepted),
		quarantined: nonNegativeInt(value.quarantined),
		checkedAt: finiteNumber(value.checkedAt) ?? 0,
		lastSuccessAt: nullableNumber(value.lastSuccessAt),
		lastFailureAt: nullableNumber(value.lastFailureAt),
		nextProbeAt: nullableNumber(value.nextProbeAt),
		lastError: typeof value.lastError === "string" ? value.lastError : null,
		diagnostics: value.diagnostics,
	};
}

function toJson(record: SourceHealthRecord): Record<string, unknown> {
	return { ...record, sourceId: record.sourceId };
}

function nonNegativeInt(value: unknown): number {
	const number = finiteNumber(value);
	return number === undefined ? 0 : Math.max(0, Math.floor(number));
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nullableNumber(value: unknown): number | null {
	return value === null ? null : (finiteNumber(value) ?? null);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
