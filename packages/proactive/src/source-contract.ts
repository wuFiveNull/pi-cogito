import { createHash } from "node:crypto";
import type { ProactiveSource, WakeChannel } from "./types.ts";
import type { WakeEvent } from "./wake/types.ts";

const MAX_FUTURE_TIMESTAMP_SKEW_MS = 24 * 3600_000;

export interface SourceQuarantineItem {
	sourceId: string;
	itemId: string;
	reason: string;
	payload: unknown;
}

export interface SourceValidationResult {
	events: WakeEvent[];
	quarantined: SourceQuarantineItem[];
	syntheticIdentityCount: number;
}

export type SourceContractDefinition = Pick<ProactiveSource, "id" | "channels">;

/**
 * Validate one source batch at the source boundary.
 *
 * Sources that declare `channels` use the strict contract: alert/content
 * records need an upstream identity. Sources without that declaration are
 * treated as legacy content sources and receive a deterministic identity so
 * they remain observable while migrating.
 */
export function validateSourceBatch(
	source: SourceContractDefinition,
	rawItems: unknown,
	now: Date,
): SourceValidationResult {
	const declaredChannels = normalizeChannels(source.channels);
	const batch = normalizeSourceBatch(source, rawItems, declaredChannels);
	const strictIdentity = source.channels !== undefined;
	const events: WakeEvent[] = [];
	const quarantined: SourceQuarantineItem[] = [];
	let syntheticIdentityCount = 0;

	for (const [index, raw] of batch.entries()) {
		const itemId = sourceItemIdentity(raw, index);
		try {
			const event = normalizeSourceEvent(source, raw, declaredChannels, strictIdentity, now, index);
			events.push(event.event);
			if (event.syntheticIdentity) syntheticIdentityCount++;
		} catch (error) {
			quarantined.push({
				sourceId: source.id,
				itemId,
				reason: formatValidationError(error),
				payload: raw,
			});
		}
	}

	return { events, quarantined, syntheticIdentityCount };
}

/** Return the number of logical source items in either supported result shape. */
export function sourceResultItemCount(rawItems: unknown): number {
	return Array.isArray(rawItems) ? rawItems.length : isRecord(rawItems) ? 1 : 0;
}

function normalizeSourceBatch(
	source: SourceContractDefinition,
	rawItems: unknown,
	declaredChannels: readonly WakeChannel[],
): unknown[] {
	if (Array.isArray(rawItems)) return rawItems;
	if (isRecord(rawItems) && declaredChannels.includes("context")) {
		return [{ ...rawItems, kind: rawItems.kind ?? "context" }];
	}
	throw new Error(`source 返回值必须是 array，或声明 context channel 的 object: ${source.id}`);
}

function normalizeSourceEvent(
	source: SourceContractDefinition,
	raw: unknown,
	declaredChannels: readonly WakeChannel[],
	strictIdentity: boolean,
	now: Date,
	index: number,
): { event: WakeEvent; syntheticIdentity: boolean } {
	if (!isRecord(raw)) throw new Error("source item 必须是 object");

	const kind = normalizeKind(raw.kind, declaredChannels);
	if (!kind) throw new Error(`kind 未声明或为空: ${source.id}`);

	const eventIdValue = firstNonEmptyString(raw.eventId, raw.event_id, raw.id);
	let eventId = eventIdValue;
	let syntheticIdentity = false;
	if (!eventId && kind !== "context") {
		if (strictIdentity) throw new Error(`source item 缺少 event_id/id: ${source.id}`);
		eventId = syntheticEventId(source.id, raw);
		syntheticIdentity = true;
	}

	const sourceId =
		firstNonEmptyString(raw.sourceId, raw.source_id, raw._source, raw.source, raw.source_name) ?? source.id;
	const ackSourceId = firstNonEmptyString(raw.ackSourceId, raw.ack_source, raw.ack_server) ?? source.id;
	const event: WakeEvent = { ...raw, kind, sourceId, ackSourceId };
	if (eventId) event.eventId = eventId;

	if (kind === "alert" || kind === "content") {
		event.preprocessScore = normalizeScore(raw.preprocessScore, raw.preprocess_score, raw.rank_score);
	}

	for (const [canonical, aliases] of timestampFields()) {
		const value = firstDefined(raw[canonical], ...aliases.map((alias) => raw[alias]));
		if (value === undefined || value === null || value === "") continue;
		event[canonical] = normalizeTimestamp(value, canonical, now);
	}

	if (kind === "context" && !eventId) {
		// Context snapshots are keyed by source, not by reservoir event id.
		delete event.eventId;
	}
	if (kind !== "context" && !event.eventId) {
		throw new Error(`source item 缺少 event_id/id: ${source.id} (index=${index})`);
	}

	return { event, syntheticIdentity };
}

function normalizeChannels(channels: readonly WakeChannel[] | undefined): readonly WakeChannel[] {
	if (!channels || channels.length === 0) return ["content"];
	return [...new Set(channels)];
}

function normalizeKind(value: unknown, declaredChannels: readonly WakeChannel[]): WakeChannel | undefined {
	const kind = typeof value === "string" ? value.trim() : "";
	if (!kind && declaredChannels.length === 1) return declaredChannels[0];
	return isWakeChannel(kind) && declaredChannels.includes(kind) ? kind : undefined;
}

function normalizeScore(...values: unknown[]): number {
	const value = firstDefined(...values) ?? 0;
	const score = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(score) || score < 0 || score > 1) {
		throw new Error("score 超出 [0,1] 或非 finite");
	}
	return score;
}

function normalizeTimestamp(value: unknown, field: string, now: Date): string | number {
	let normalized: string | number;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error(`${field} 不是有效 timestamp`);
		normalized = Math.abs(value) < 100_000_000_000 ? value * 1000 : value;
	} else if (typeof value === "string") {
		const trimmed = value.trim();
		if (!trimmed || (trimmed.includes("T") && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(trimmed))) {
			throw new Error(`${field} 必须带 timezone 的 ISO timestamp`);
		}
		normalized = trimmed;
	} else {
		throw new Error(`${field} 不是 ISO timestamp 或 number`);
	}

	const parsed = new Date(normalized).getTime();
	if (!Number.isFinite(parsed)) throw new Error(`${field} 不是有效 timestamp`);
	if (parsed > now.getTime() + MAX_FUTURE_TIMESTAMP_SKEW_MS) {
		throw new Error(`${field} 超过 future skew`);
	}
	return normalized;
}

function timestampFields(): Array<[string, string[]]> {
	return [
		["publishedAt", ["published_at"]],
		["triggeredAt", ["triggered_at"]],
		["firstSeenAt", ["first_seen_at"]],
	];
}

function syntheticEventId(sourceId: string, raw: Record<string, unknown>): string {
	const identity = JSON.stringify({
		title: raw.title ?? raw.name ?? raw.subject ?? "",
		url: raw.url ?? raw.link ?? raw.html_url ?? "",
		summary: raw.summary ?? raw.description ?? "",
		source: raw.source ?? raw.sourceId ?? "",
	});
	return `legacy-${createHash("sha256").update(`${sourceId}:${identity}`).digest("hex").slice(0, 24)}`;
}

function sourceItemIdentity(raw: unknown, index: number): string {
	if (isRecord(raw)) {
		const identity = firstNonEmptyString(raw.eventId, raw.event_id, raw.id);
		if (identity) return identity;
	}
	return `index:${index}`;
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
	for (const value of values) {
		if (typeof value === "string" && value.trim()) return value.trim();
		if (typeof value === "number" && Number.isFinite(value)) return String(value);
	}
	return undefined;
}

function firstDefined(...values: unknown[]): unknown {
	return values.find((value) => value !== undefined);
}

function isWakeChannel(value: string): value is WakeChannel {
	return value === "alert" || value === "content" || value === "context";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatValidationError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
