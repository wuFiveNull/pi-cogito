/** Durable source acknowledgement routing shared by default and Wake. */

import { type Clock, SystemClock } from "../clock.ts";
import type { PendingSourceAcknowledgement, ProactiveStore } from "../store.ts";
import type { ProactiveSource } from "../types.ts";
import type { ProactiveSourceAckPort } from "./ports.ts";

export type SourceRuntimeConfig = { enabled?: boolean; [key: string]: unknown } | undefined;

export interface SourceAckCoordinatorOptions {
	store: ProactiveStore;
	sources: ReadonlyMap<string, ProactiveSource>;
	sourceConfigs?: Record<string, SourceRuntimeConfig>;
	clock?: Clock;
	/** First retry delay after an ACK failure. Default 1 second. */
	retryBaseDelayMs?: number;
	/** Maximum retry delay. Default 5 minutes. */
	retryMaxDelayMs?: number;
}

export interface SourceAckFlushOptions {
	/** Bypass the retry schedule for an operator-triggered flush. */
	force?: boolean;
	now?: number;
}

export class SourceAckCoordinator implements ProactiveSourceAckPort {
	private readonly store: ProactiveStore;
	private readonly sources: ReadonlyMap<string, ProactiveSource>;
	private readonly sourceConfigs: Record<string, SourceRuntimeConfig>;
	private readonly clock: Clock | undefined;
	private readonly retryBaseDelayMs: number;
	private readonly retryMaxDelayMs: number;

	constructor(options: SourceAckCoordinatorOptions) {
		this.store = options.store;
		this.sources = options.sources;
		this.sourceConfigs = options.sourceConfigs ?? {};
		this.clock = options.clock;
		this.retryBaseDelayMs = Math.max(0, Math.floor(options.retryBaseDelayMs ?? 1000));
		this.retryMaxDelayMs = Math.max(this.retryBaseDelayMs, Math.floor(options.retryMaxDelayMs ?? 5 * 60 * 1000));
	}

	async acknowledge(sourceId: string, eventIds: readonly string[]): Promise<void> {
		this.store.queueSourceAcknowledgements(sourceId, eventIds, this.clock?.nowMs());
		await this.flush();
	}

	async flush(limit = 1000, options: SourceAckFlushOptions = {}): Promise<void> {
		const now = options.now ?? this.clock?.nowMs() ?? SystemClock.nowMs();
		const grouped = new Map<string, PendingSourceAcknowledgement[]>();
		const pending = options.force
			? this.store.listPendingSourceAcknowledgements(limit)
			: this.store.listDueSourceAcknowledgements(now, limit);
		for (const item of pending) {
			const rows = grouped.get(item.source_id) ?? [];
			rows.push(item);
			grouped.set(item.source_id, rows);
		}

		const errors: unknown[] = [];
		for (const [sourceId, rows] of grouped) {
			const eventIds = rows.map((row) => row.event_id);
			try {
				await acknowledgeSource(this.sources, this.sourceConfigs, sourceId, eventIds);
				this.store.markSourceAcknowledgements(sourceId, eventIds);
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error);
				for (const row of rows) {
					this.store.recordSourceAcknowledgementFailure(
						sourceId,
						[row.event_id],
						detail,
						now,
						now + this.retryDelayMs(row.attempts + 1),
					);
				}
				errors.push(error);
			}
		}
		if (errors.length === 1) throw errors[0];
		if (errors.length > 1) throw new AggregateError(errors, "source acknowledgement flush failed");
	}

	private retryDelayMs(attempt: number): number {
		const exponent = Math.max(0, Math.min(30, Math.floor(attempt) - 1));
		return Math.min(this.retryMaxDelayMs, this.retryBaseDelayMs * 2 ** exponent);
	}
}

export async function acknowledgeSource(
	sources: ReadonlyMap<string, ProactiveSource>,
	sourceConfigs: Record<string, SourceRuntimeConfig>,
	sourceId: string,
	eventIds: readonly string[],
): Promise<void> {
	const candidates = [...sources.entries()].filter(([moduleId, source]) => {
		if (moduleId === sourceId || source.ackSourceIds?.includes(sourceId)) return true;
		const ack = sourceConfigs[moduleId]?.ack;
		return (
			isRecord(ack) &&
			Array.isArray(ack.sourceIds) &&
			ack.sourceIds.some((candidate) => typeof candidate === "string" && candidate === sourceId)
		);
	});
	const ackCapable = [...sources.entries()].filter(([, source]) => typeof source.ack === "function");
	const selected =
		candidates.length === 1
			? candidates[0]
			: candidates.length === 0 && ackCapable.length === 1
				? ackCapable[0]
				: undefined;
	if (!selected) {
		if (candidates.length > 1) throw new Error(`proactive source ack is ambiguous: ${sourceId}`);
		throw new Error(`proactive source ack source not found: ${sourceId}`);
	}
	const [moduleId, source] = selected;
	if (!source.ack) throw new Error(`proactive source does not support ack: ${moduleId}`);
	await source.ack(sourceConfigs[moduleId] ?? {}, [...eventIds]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
