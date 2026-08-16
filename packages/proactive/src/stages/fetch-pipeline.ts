/**
 * Pipeline — fetch → normalize → dedupe → store (akashic feed stage).
 *
 * Judgment no longer happens here: candidates are only deduped and inserted;
 * the LLM agent tick (tick.ts) runs during the proactive loop and decides
 * what is worth pushing, with evidence.
 */

import { createHash } from "node:crypto";
import { type Clock, SystemClock } from "../clock.ts";
import { type SourceContractDefinition, validateSourceBatch } from "../source-contract.ts";
import type { ProactiveStore } from "../store.ts";
import type { RawItem, WakeEvent } from "../types.ts";

export interface PipelineConfig {
	/** Max candidates kept per fetch round. */
	maxItemsPerRound?: number;
	/** 可注入时钟。 */
	clock?: Clock;
}

export interface PipelineStats {
	received: number;
	inserted: number;
	duplicates: number;
	quarantined: number;
}

export class Pipeline {
	private readonly store: ProactiveStore;
	private readonly config: PipelineConfig;

	constructor(store: ProactiveStore, config: PipelineConfig = {}) {
		this.store = store;
		this.config = config;
	}

	/**
	 * Process one source's raw items: dedupe, keep a bounded ranked set,
	 * insert. Never throws.
	 */
	async ingest(
		source: string,
		items: WakeEvent[],
		sourceDefinition?: SourceContractDefinition,
	): Promise<PipelineStats> {
		const maxItems = this.config.maxItemsPerRound ?? 50;
		const definition = sourceDefinition ?? { id: source };
		const validation = validateSourceBatch(definition, items, this.config.clock?.now() ?? SystemClock.now());
		const stats: PipelineStats = {
			received: items.length,
			inserted: 0,
			duplicates: 0,
			quarantined: validation.quarantined.length,
		};
		for (const item of validation.quarantined) {
			this.store.recordSourceQuarantine(item);
		}

		for (const item of validation.events.slice(0, maxItems)) {
			const raw = item as unknown as RawItem;
			const kindRaw = String(item.kind ?? raw.kind ?? "content").trim();
			const kind: "alert" | "content" | "context" =
				kindRaw === "alert" || kindRaw === "context" ? kindRaw : "content";
			const inserted = this.store.insertItem({
				scope: "",
				kind,
				source,
				sub_source: raw.source ?? String(item.sourceId ?? source),
				source_event_id: item.eventId ? String(item.eventId) : null,
				ack_source_id: item.ackSourceId ? String(item.ackSourceId) : source,
				title: raw.title ?? "",
				url: raw.url ?? null,
				summary: raw.summary ?? null,
				recommendation: null,
				verdict: null,
				verdict_reason: null,
				title_hash: hashItem(source, item),
				interest_score: null,
				fetched_at: raw.publishedAt ?? this.config.clock?.nowMs() ?? SystemClock.nowMs(),
			});
			if (inserted) {
				stats.inserted++;
			} else {
				stats.duplicates++;
			}
		}
		return stats;
	}
}

/** Stable source/event identity used as the dedup key. */
function hashItem(source: string, item: WakeEvent): string {
	const eventId = String(item.eventId ?? item.id ?? "").trim();
	const identity = eventId
		? `${source}:event:${eventId}`
		: `${source}:content:${String(item.title ?? "")
				.trim()
				.toLowerCase()}|${String(item.url ?? "").trim()}`;
	return createHash("sha256").update(identity, "utf-8").digest("hex");
}
