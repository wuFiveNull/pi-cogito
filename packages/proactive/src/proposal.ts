/**
 * Shared proactive decision contract.
 *
 * Default and wake use different selection policies, but both must hand the
 * delivery layer the same proposal shape. Keeping this envelope explicit
 * prevents source acknowledgement and delivery dedupe from being encoded in
 * one lifecycle's private state.
 */

export type ProactiveAction = "send" | "skip" | "context_only" | "drift";

export interface ProactiveEvidence {
	id: string;
	itemId: number;
	source: string;
	title: string;
	snippet: string;
	url: string;
}

export interface ProactiveProposal {
	action: ProactiveAction;
	message: string | null;
	evidence: readonly ProactiveEvidence[];
	/** Default item ids or wake reservoir ids used for content dedupe. */
	itemIds: readonly (number | string)[];
	/** Serialized source references carried into the host delivery boundary. */
	sourceRefs: readonly Record<string, unknown>[];
	reason: string;
	/** Stable retry key. When omitted, delivery derives one from session + message. */
	deliveryKey?: string;
}

export function createProactiveProposal(input: {
	action: ProactiveAction;
	message?: string | null;
	evidence?: readonly ProactiveEvidence[];
	itemIds?: readonly (number | string)[];
	sourceRefs?: readonly Record<string, unknown>[];
	reason?: string;
	deliveryKey?: string;
}): ProactiveProposal {
	return {
		action: input.action,
		message: input.message ?? null,
		evidence: [...(input.evidence ?? [])],
		itemIds: [...(input.itemIds ?? [])],
		sourceRefs: [...(input.sourceRefs ?? [])],
		reason: input.reason ?? "",
		deliveryKey: input.deliveryKey,
	};
}

/**
 * Extract durable source ACK groups from the common source-reference shape.
 * Only explicit ACK fields are accepted; a plain item id must never be sent
 * to a source by accident.
 */
export function proposalAcknowledgements(
	sourceRefs: readonly Record<string, unknown>[],
): Readonly<Record<string, readonly string[]>> {
	const grouped = new Map<string, Set<string>>();
	for (const ref of sourceRefs) {
		const sourceId = firstString(ref.ack_source_id, ref.ackSourceId, ref.ack_server);
		const eventId = firstString(ref.source_event_id, ref.sourceEventId, ref.event_id);
		if (!sourceId || !eventId) continue;
		const eventIds = grouped.get(sourceId) ?? new Set<string>();
		eventIds.add(eventId);
		grouped.set(sourceId, eventIds);
	}
	return Object.fromEntries([...grouped].map(([sourceId, eventIds]) => [sourceId, [...eventIds]]));
}

function firstString(...values: unknown[]): string | undefined {
	for (const value of values) {
		if (typeof value !== "string" && typeof value !== "number") continue;
		const text = String(value).trim();
		if (text) return text;
	}
	return undefined;
}
