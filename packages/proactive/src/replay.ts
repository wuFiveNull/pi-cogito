/**
 * Historical proactive replay.
 *
 * RuntimeReplayJournal records runtime transitions. This module is the other
 * half of replay: it orders historical source events, advances ReplayClock,
 * admits every event whose available_at is due, runs a real tick executor,
 * and writes one audit record per historical tick.
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Clock, ReplayClock } from "./clock.ts";
import type { Pipeline, PipelineStats } from "./stages/fetch-pipeline.ts";
import type { TickResult } from "./stages/types.ts";
import type { ProactiveSource, ProactiveSourceStateStore, SourceFetchResult } from "./types.ts";
import type { WakeEvent } from "./wake/types.ts";

export interface HistoricalReplayEvent {
	eventId: string;
	kind: "alert" | "content" | "context";
	sourceId: string;
	sourceName: string;
	title: string;
	content: string;
	url: string;
	publishedAt: Date | null;
	firstSeenAt: Date;
	availableAt: Date;
	preprocessScore: number;
	preprocessFeatures: Record<string, unknown>;
	wakeEligible: boolean;
	payload: Record<string, unknown>;
}

export interface HistoricalReplayTickContext {
	tickIndex: number;
	sessionKey: string;
	now: Date;
	events: readonly HistoricalReplayEvent[];
	ingestStats: PipelineStats | null;
}

export interface HistoricalReplayTickAudit<TResult = unknown> {
	tickIndex: number;
	sessionKey: string;
	at: string;
	eventIds: string[];
	ingest: PipelineStats | null;
	result?: TResult;
	error?: string;
}

export interface HistoricalReplayReport<TResult = unknown> {
	sessionKey: string;
	startedAt: string | null;
	finishedAt: string | null;
	eventCount: number;
	tickCount: number;
	failedTickCount: number;
	truncated: boolean;
	ticks: HistoricalReplayTickAudit<TResult>[];
}

export interface HistoricalReplayOptions<TResult = TickResult | unknown> {
	clock: ReplayClock;
	events?: readonly HistoricalReplayEvent[];
	eventsPath?: string;
	sessionKey?: string;
	startAt?: Date;
	endAt?: Date;
	/** Run at a fixed historical interval. Without it, each available_at is a tick. */
	tickEveryMs?: number;
	/** Include ticks with no newly available events. Defaults to false for event-time replay. */
	includeEmptyTicks?: boolean;
	maxTicks?: number;
	/** Continue through failed ticks and preserve the failure in the audit. */
	continueOnError?: boolean;
	/** Admit a due batch into the real source pipeline before executing the tick. */
	ingest?(
		events: readonly HistoricalReplayEvent[],
		context: HistoricalReplayTickContext,
	): Promise<PipelineStats> | PipelineStats;
	/** Execute the real proactive tick. */
	executeTick(context: HistoricalReplayTickContext): Promise<TResult> | TResult;
	/** Optional JSONL audit path. It is replaced at the beginning of each run. */
	reportPath?: string;
}

export interface ProactiveHistoricalReplayOptions
	extends Omit<HistoricalReplayOptions<TickResult | null>, "clock" | "ingest" | "executeTick"> {
	clock: ReplayClock;
	pipeline: Pick<Pipeline, "ingest">;
	engine: { runOnce(): Promise<TickResult | null> };
	sourceId?: string;
}

/** Load and normalize Akashic-compatible JSON/JSONL historical events. */
export function readHistoricalReplayEvents(path: string): HistoricalReplayEvent[] {
	const text = readFileSync(path, "utf-8");
	const values: unknown[] = path.toLowerCase().endsWith(".jsonl")
		? text
				.split("\n")
				.filter((line) => line.trim().length > 0)
				.map((line) => JSON.parse(line) as unknown)
		: readJsonEvents(JSON.parse(text) as unknown);
	return values.map((value, index) => normalizeHistoricalReplayEvent(value, `${path}#${index + 1}`));
}

/** Normalize one event from replay_controller.py's canonical shape. */
export function normalizeHistoricalReplayEvent(value: unknown, sourceLabel = "event"): HistoricalReplayEvent {
	const record = asRecord(value);
	if (!record) throw new Error(`${sourceLabel} must be an object`);
	const eventId = nonEmptyString(record.event_id, record.eventId);
	const sourceId = nonEmptyString(record.source_id, record.sourceId);
	if (!eventId || !sourceId) throw new Error(`${sourceLabel}: event_id and source_id are required`);
	const kindValue = nonEmptyString(record.kind) ?? "content";
	if (kindValue !== "alert" && kindValue !== "content" && kindValue !== "context") {
		throw new Error(`${sourceLabel}: unsupported kind ${kindValue}`);
	}
	const availableAt = parseReplayTime(
		record.available_at ?? record.availableAt ?? record.published_at ?? record.publishedAt,
		`${sourceLabel}.available_at`,
	);
	const firstSeenAt = parseReplayTime(
		record.first_seen_at ?? record.firstSeenAt ?? availableAt,
		`${sourceLabel}.first_seen_at`,
	);
	const rawPublishedAt = record.published_at ?? record.publishedAt;
	const publishedAt =
		rawPublishedAt === undefined || rawPublishedAt === null || rawPublishedAt === ""
			? null
			: parseReplayTime(rawPublishedAt, `${sourceLabel}.published_at`);
	const preprocessScore = Number(record.preprocess_score ?? record.preprocessScore ?? 0);
	if (!Number.isFinite(preprocessScore) || preprocessScore < 0 || preprocessScore > 1) {
		throw new Error(`${sourceLabel}: preprocess_score must be between 0 and 1`);
	}
	return {
		eventId,
		kind: kindValue,
		sourceId,
		sourceName: nonEmptyString(record.source_name, record.sourceName) ?? sourceId,
		title: String(record.title ?? ""),
		content: String(record.content ?? record.summary ?? ""),
		url: String(record.url ?? ""),
		publishedAt,
		firstSeenAt,
		availableAt,
		preprocessScore,
		preprocessFeatures: asRecord(record.preprocess_features ?? record.preprocessFeatures) ?? {},
		wakeEligible: record.wake_eligible !== false && record.wakeEligible !== false,
		payload: asRecord(record.payload) ?? {},
	};
}

/** Convert a canonical historical event to the existing source pipeline shape. */
export function historicalEventToWakeEvent(event: HistoricalReplayEvent): WakeEvent {
	return {
		...event.payload,
		kind: event.kind,
		sourceId: event.sourceId,
		source: event.sourceId,
		sourceName: event.sourceName,
		eventId: event.eventId,
		publishedAt: event.publishedAt?.toISOString(),
		firstSeenAt: event.firstSeenAt.toISOString(),
		availableAt: event.availableAt.toISOString(),
		preprocessScore: event.preprocessScore,
		title: event.title,
		url: event.url,
		summary: event.content,
		content: event.content,
		wakeEligible: event.wakeEligible,
	};
}

/** Source adapter for normal tick-driven pusher runs using a replay event file. */
export class HistoricalReplaySource implements ProactiveSource {
	readonly id = "historical-replay";
	readonly label = "Historical replay";
	readonly defaultIntervalMs = 1_000;
	private readonly events: HistoricalReplayEvent[];
	private readonly clock: Clock;
	private stateStore: ProactiveSourceStateStore | undefined;
	private cursor: number;

	constructor(events: readonly HistoricalReplayEvent[], clock: Clock) {
		this.events = [...events].sort((left, right) => left.availableAt.getTime() - right.availableAt.getTime());
		this.clock = clock;
		this.cursor = 0;
	}

	setStateStore(store: ProactiveSourceStateStore): void {
		this.stateStore = store;
		const stored = Number(store.getState("replay.historical.cursor") ?? "0");
		if (Number.isSafeInteger(stored) && stored >= 0 && stored <= this.events.length) this.cursor = stored;
	}

	async fetch(_config: unknown): Promise<SourceFetchResult> {
		const due: WakeEvent[] = [];
		while (this.cursor < this.events.length) {
			const event = this.events[this.cursor];
			if (!event || event.availableAt.getTime() > this.clock.nowMs()) break;
			due.push(historicalEventToWakeEvent(event));
			this.cursor++;
		}
		this.stateStore?.setState("replay.historical.cursor", String(this.cursor));
		return due;
	}

	commitFetchState(): void {
		this.stateStore?.setState("replay.historical.cursor", String(this.cursor));
	}
}

/** Execute every historical tick in event-time or fixed-interval order. */
export class HistoricalTickReplayRunner<TResult = TickResult | unknown> {
	private readonly options: HistoricalReplayOptions<TResult>;

	constructor(options: HistoricalReplayOptions<TResult>) {
		if (!options.executeTick) throw new Error("historical replay requires executeTick");
		if (options.tickEveryMs !== undefined && (!Number.isFinite(options.tickEveryMs) || options.tickEveryMs <= 0)) {
			throw new Error("historical replay tickEveryMs must be positive");
		}
		this.options = options;
	}

	async run(): Promise<HistoricalReplayReport<TResult>> {
		const input =
			this.options.events ?? (this.options.eventsPath ? readHistoricalReplayEvents(this.options.eventsPath) : []);
		const events = [...input].sort((left, right) => {
			const time = left.availableAt.getTime() - right.availableAt.getTime();
			return time !== 0 ? time : left.eventId.localeCompare(right.eventId);
		});
		const sessionKey = this.options.sessionKey ?? "replay";
		const tickTimes = buildTickTimes(events, this.options);
		const report: HistoricalReplayReport<TResult> = {
			sessionKey,
			startedAt: tickTimes[0]?.toISOString() ?? null,
			finishedAt: null,
			eventCount: events.length,
			tickCount: 0,
			failedTickCount: 0,
			truncated: false,
			ticks: [],
		};
		if (this.options.reportPath) {
			mkdirSync(dirname(this.options.reportPath), { recursive: true });
			writeFileSync(this.options.reportPath, "", "utf-8");
		}

		let cursor = 0;
		const maxTicks =
			this.options.maxTicks === undefined
				? Number.POSITIVE_INFINITY
				: Math.max(0, Math.trunc(this.options.maxTicks));
		for (const at of tickTimes) {
			if (report.tickCount >= maxTicks) {
				report.truncated = true;
				break;
			}
			const now = this.options.clock.set(at);
			const due = events.slice(cursor).filter((event) => event.availableAt.getTime() <= now.getTime());
			cursor += due.length;
			const context: HistoricalReplayTickContext = {
				tickIndex: report.tickCount,
				sessionKey,
				now,
				events: due,
				ingestStats: null,
			};
			const audit: HistoricalReplayTickAudit<TResult> = {
				tickIndex: context.tickIndex,
				sessionKey,
				at: now.toISOString(),
				eventIds: due.map((event) => event.eventId),
				ingest: null,
			};
			try {
				if (this.options.ingest && due.length > 0) {
					context.ingestStats = await this.options.ingest(due, context);
					audit.ingest = context.ingestStats;
				}
				const result = await this.options.executeTick(context);
				audit.result = result;
			} catch (error) {
				audit.error = formatError(error);
				report.failedTickCount++;
			}
			report.ticks.push(audit);
			report.tickCount++;
			appendAudit(this.options.reportPath, audit);
			if (audit.error && this.options.continueOnError === false) throw new Error(audit.error);
		}
		report.finishedAt = this.options.clock.now().toISOString();
		return report;
	}
}

/** Run replay against the real Pipeline and ProactiveEngine implementations. */
export async function runHistoricalReplay(
	options: ProactiveHistoricalReplayOptions,
): Promise<HistoricalReplayReport<TickResult | null>> {
	const sourceId = options.sourceId ?? "historical-replay";
	return await new HistoricalTickReplayRunner<TickResult | null>({
		...options,
		ingest: async (events) => await options.pipeline.ingest(sourceId, events.map(historicalEventToWakeEvent)),
		executeTick: async () => await options.engine.runOnce(),
	}).run();
}

/** Read an audit JSONL report for the monitor without opening the write-side DB. */
export function readHistoricalReplayAudit(path: string, limit = 100): HistoricalReplayTickAudit[] {
	try {
		const lines = readFileSync(path, "utf-8").split("\n");
		const records: HistoricalReplayTickAudit[] = [];
		for (const line of lines) {
			if (!line.trim()) continue;
			const value = JSON.parse(line) as unknown;
			if (isAuditRecord(value)) records.push(value);
		}
		return records.slice(Math.max(0, records.length - Math.max(1, Math.trunc(limit))));
	} catch {
		return [];
	}
}

function buildTickTimes(
	events: readonly HistoricalReplayEvent[],
	options: Pick<HistoricalReplayOptions, "startAt" | "endAt" | "tickEveryMs" | "includeEmptyTicks">,
): Date[] {
	const firstEvent = events[0]?.availableAt.getTime();
	const lastEvent = events[events.length - 1]?.availableAt.getTime();
	const start = options.startAt?.getTime() ?? firstEvent;
	if (start === undefined) return [];
	const end = Math.max(start, options.endAt?.getTime() ?? lastEvent ?? start);
	if (options.tickEveryMs !== undefined) {
		const times: Date[] = [];
		for (let at = start; at <= end; at += options.tickEveryMs) times.push(new Date(at));
		if (times[times.length - 1]?.getTime() !== end && options.endAt) times.push(new Date(end));
		return times;
	}
	const eventTimes = [
		...new Set(events.map((event) => event.availableAt.getTime()).filter((at) => at >= start && at <= end)),
	];
	if (options.includeEmptyTicks && eventTimes[0] !== start) eventTimes.unshift(start);
	return eventTimes.map((at) => new Date(at));
}

function appendAudit(path: string | undefined, audit: HistoricalReplayTickAudit): void {
	if (!path) return;
	appendFileSync(path, `${JSON.stringify(audit)}\n`, "utf-8");
}

function readJsonEvents(value: unknown): unknown[] {
	if (Array.isArray(value)) return value;
	const record = asRecord(value);
	if (record && Array.isArray(record.events)) return record.events;
	throw new Error("historical replay input must be a JSON array or an object with events[]");
}

function parseReplayTime(value: unknown, field: string): Date {
	if (value instanceof Date) {
		if (Number.isFinite(value.getTime())) return new Date(value.getTime());
		throw new Error(`${field} is invalid`);
	}
	if (typeof value === "number") {
		const milliseconds = Math.abs(value) < 100_000_000_000 ? value * 1000 : value;
		const date = new Date(milliseconds);
		if (Number.isFinite(date.getTime())) return date;
	}
	if (typeof value === "string") {
		const raw = value.trim();
		if (!raw || !/[zZ]|[+-]\d{2}:?\d{2}$/.test(raw)) throw new Error(`${field} must include a timezone`);
		const date = new Date(raw);
		if (Number.isFinite(date.getTime())) return date;
	}
	throw new Error(`${field} is invalid`);
}

function nonEmptyString(...values: unknown[]): string | undefined {
	for (const value of values) {
		if (typeof value === "string" && value.trim()) return value.trim();
		if (typeof value === "number" && Number.isFinite(value)) return String(value);
	}
	return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function isAuditRecord(value: unknown): value is HistoricalReplayTickAudit {
	const record = asRecord(value);
	return (
		record !== undefined &&
		typeof record.tickIndex === "number" &&
		typeof record.sessionKey === "string" &&
		typeof record.at === "string" &&
		Array.isArray(record.eventIds)
	);
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
