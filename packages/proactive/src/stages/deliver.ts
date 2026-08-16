/**
 * 投递策略(默认:sqlite deliveries 表 + 三重去重 + LLM 语义去重 + 状态记账)。
 */

import { createHash } from "node:crypto";
import {
	createProactiveProposal,
	type ProactiveEvidence,
	type ProactiveProposal,
	proposalAcknowledgements,
} from "../proposal.ts";
import { ProactiveTurnOrchestrator, type ProactiveTurnRequest } from "../runtime/orchestrator.ts";
import type { ProactiveOutboundReceipt, ProactiveRuntimePorts } from "../runtime/ports.ts";
import type { DeliveryRecord, DeliveryTargetReceipt, ProactiveStore } from "../store.ts";
import type { DedupeResult, RecentDeliveryLike } from "./dedupe.ts";
import { DEFAULT_SESSION_KEY } from "./sense.ts";
import type { DeliverStrategy, DeliveryMessage, DeliveryResult, TurnContext } from "./types.ts";

export interface SqliteDeliverOptions {
	deliveryDedupeHours: number;
	messageDedupeRecentN: number;
	/** LLM 语义去重(akashic MessageDeduper);规则去重通过后调用,返回 true 时拒绝投递。 */
	llmDedupeFn?: (newMessage: string, recent: RecentDeliveryLike[]) => Promise<DedupeResult>;
	/** 可选外部出口;提供时先写 outbox,外部发送成功后才提交 pushed 状态。 */
	outlet?: DeliveryOutlet;
	/** Host transport and post-delivery session/presence orchestration. */
	runtimePorts?: ProactiveRuntimePorts;
	orchestrator?: ProactiveTurnOrchestrator;
}

export interface DeliveryOutlet {
	// biome-ignore lint/suspicious/noConfusingVoidType: existing outlets may only signal successful completion
	send(record: DeliveryRecord): Promise<void | DeliverySendReceipt>;
	/** Start a background outlet when it owns a provider connection. */
	start?(): Promise<void>;
	/** Stop a background outlet when it owns a provider connection. */
	stop?(): Promise<void>;
	/** 外部发送失败后的持久队列重试入口。 */
	enqueue?(record: DeliveryRecord): void;
	/** 暂停后台发送但保留可恢复的 outbox 状态。 */
	pause?(): Promise<void>;
	/** 恢复暂停的后台发送。 */
	resume?(): Promise<void>;
}

export type DeliverySendStatus = "success" | "partial" | "failed" | "cancelled";

export interface DeliverySendReceipt {
	status?: DeliverySendStatus;
	providerMessageId?: string;
	canonicalMedia?: string[];
	targetReceipts?: readonly DeliveryTargetReceipt[];
	detail?: string;
}

export interface ProactiveDeliveryContext {
	sessionKey: string;
	now: Date;
}

export interface ProactiveDeliveryExecutorOptions {
	store: ProactiveStore;
	deliveryDedupeHours: number;
	messageDedupeRecentN: number;
	llmDedupeFn?: (newMessage: string, recent: RecentDeliveryLike[]) => Promise<DedupeResult>;
	outlet?: DeliveryOutlet;
	runtimePorts?: ProactiveRuntimePorts;
	orchestrator?: ProactiveTurnOrchestrator;
	/** Wake persists ACKs in its reservoir store and flushes them separately. */
	acknowledgeSources?: boolean;
	stateSummaryTag?: string;
}

/** Normalize legacy void outlets and reject invalid runtime statuses closed. */
// biome-ignore lint/suspicious/noConfusingVoidType: normalize legacy outlet return values
export function getDeliverySendStatus(receipt: void | DeliverySendReceipt): DeliverySendStatus {
	const status = receipt?.status;
	if (
		status === undefined ||
		status === "success" ||
		status === "partial" ||
		status === "failed" ||
		status === "cancelled"
	) {
		return status ?? "success";
	}
	return "failed";
}

/**
 * Execute the shared delivery transaction for default and wake proposals.
 * Source events are only acknowledged through the host boundary after the
 * outbound transport accepts the message.
 */
export async function deliverProactiveProposal(
	proposal: ProactiveProposal,
	ctx: ProactiveDeliveryContext,
	options: ProactiveDeliveryExecutorOptions,
): Promise<DeliveryResult> {
	if (proposal.action !== "send" || !proposal.message?.trim()) {
		return { delivered: false, reason: proposal.reason || "no_message" };
	}

	const message = proposal.message;
	const contentIds = proposal.itemIds.map(String);
	const messageHash = createHash("sha256").update(message.trim()).digest("hex");
	const recent = options.store.recentDeliveredMessages(options.messageDedupeRecentN);
	const duplicate =
		options.store.isContentDelivered(contentIds, options.deliveryDedupeHours, ctx.now.getTime()) ||
		options.store.isMessageDelivered(messageHash, options.deliveryDedupeHours, ctx.now.getTime()) ||
		recent.some((item) => item.trim() === message.trim());
	if (duplicate) return { delivered: false, reason: "duplicate" };

	if (options.llmDedupeFn) {
		const recentDeliveries = options.store.listDeliveredDeliveries(options.messageDedupeRecentN).map((row) => ({
			message: row.message,
			delivered_at: row.delivered_at,
			state_summary_tag: row.state_summary_tag,
		}));
		const result = await options.llmDedupeFn(message, recentDeliveries);
		if (result.duplicate) return { delivered: false, reason: "llm_duplicate" };
	}

	const sourceRefs = proposal.sourceRefs.map((ref) => ({ ...ref }));
	const acknowledgements = proposalAcknowledgements(sourceRefs);
	const idempotencyKey = proposal.deliveryKey ?? `proactive:${ctx.sessionKey}:${messageHash}`;
	const existing = options.store.getDeliveryByIdempotencyKey(idempotencyKey);
	if (existing?.acked === 1 && existing.delivery_status === "success") {
		return { delivered: false, reason: "duplicate" };
	}
	if (existing?.delivery_status === "pending") {
		return { delivered: false, reason: "pending" };
	}

	const record = {
		session_key: ctx.sessionKey,
		message,
		message_hash: messageHash,
		source_refs: JSON.stringify(sourceRefs),
		evidence: JSON.stringify(
			proposal.evidence.map((evidence) => ({
				id: evidence.id,
				title: evidence.title,
				snippet: evidence.snippet.slice(0, 1200),
				url: evidence.url,
			})),
		),
		action: proposal.action,
		state_summary_tag: options.stateSummaryTag ?? "none",
		delivered_at: ctx.now.getTime(),
		idempotency_key: idempotencyKey,
	};
	const deliveryId = options.store.insertDelivery(record, { notify: options.outlet === undefined });
	const delivery = options.store.getDelivery(deliveryId);
	if (!delivery) throw new Error(`delivery row not found after insert: ${deliveryId}`);

	const request: ProactiveTurnRequest = {
		sessionKey: ctx.sessionKey,
		message,
		sourceRefs,
		deliveryKey: delivery.idempotency_key,
		timestamp: ctx.now.getTime(),
		acknowledgements: options.acknowledgeSources === false ? undefined : acknowledgements,
	};
	const orchestrator = options.orchestrator ?? new ProactiveTurnOrchestrator(options.runtimePorts);
	let receipt: ProactiveOutboundReceipt;
	try {
		receipt = await orchestrator.send(request, async () => {
			if (!options.outlet) return { status: "success" };
			const sent = await options.outlet.send(delivery);
			return {
				status: getDeliverySendStatus(sent),
				providerMessageId: sent?.providerMessageId,
				targetReceipts: sent?.targetReceipts,
				detail: sent?.detail,
			};
		});
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		options.store.recordDeliveryFailure(deliveryId, "failed", detail);
		options.outlet?.enqueue?.(delivery);
		return { delivered: false, reason: "outlet_failed" };
	}

	options.store.recordDeliveryReceipt(deliveryId, {
		providerMessageId: receipt.providerMessageId,
		targetReceipts: receipt.targetReceipts,
	});
	if (receipt.status !== "success") {
		options.store.recordDeliveryFailure(deliveryId, receipt.status, receipt.detail, {
			providerMessageId: receipt.providerMessageId,
			targetReceipts: receipt.targetReceipts,
			detail: receipt.detail,
		});
		options.outlet?.enqueue?.(delivery);
		return { delivered: false, reason: `outlet_${receipt.status}` };
	}

	options.store.ackDeliveries([deliveryId], ctx.now.getTime(), { notify: false });
	for (const itemId of proposal.itemIds) {
		if (typeof itemId === "number" && Number.isSafeInteger(itemId) && itemId > 0) {
			options.store.markPushed(itemId, ctx.now.getTime());
		}
	}
	options.store.setState("lastDelivery", message.slice(0, 500));
	const sideEffects = await orchestrator.afterSuccessfulDelivery(request);
	if (sideEffects.errors.length > 0) {
		options.store.setState("lastError.hostDeliverySideEffects", sideEffects.errors.join("; ").slice(0, 2000));
	}
	return { delivered: true };
}

export class SqliteDeliverStrategy implements DeliverStrategy {
	readonly id = "sqlite-deliver";

	private readonly store: ProactiveStore;
	private readonly options: SqliteDeliverOptions;
	private readonly orchestrator: ProactiveTurnOrchestrator;

	constructor(store: ProactiveStore, options: SqliteDeliverOptions) {
		this.store = store;
		this.options = options;
		this.orchestrator = options.orchestrator ?? new ProactiveTurnOrchestrator(options.runtimePorts);
	}

	async deliver(message: DeliveryMessage, ctx: TurnContext): Promise<DeliveryResult> {
		const proposal = message.proposal
			? message.proposal.sourceRefs.length > 0
				? message.proposal
				: { ...message.proposal, sourceRefs: sourceRefsFromEvidence(this.store, message.proposal.evidence) }
			: createProactiveProposal({
					action: "send",
					message: message.message,
					evidence: message.evidence,
					itemIds: message.itemIds,
					sourceRefs: sourceRefsFromEvidence(this.store, message.evidence),
					reason: "default_judge",
				});
		return deliverProactiveProposal(
			proposal,
			{ sessionKey: ctx.sessionKey, now: ctx.now },
			{
				store: this.store,
				deliveryDedupeHours: this.options.deliveryDedupeHours,
				messageDedupeRecentN: this.options.messageDedupeRecentN,
				llmDedupeFn: this.options.llmDedupeFn,
				outlet: this.options.outlet,
				runtimePorts: this.options.runtimePorts,
				orchestrator: this.orchestrator,
			},
		);
	}
}

function sourceRefsFromEvidence(
	store: ProactiveStore,
	evidence: readonly ProactiveEvidence[],
): Record<string, unknown>[] {
	return evidence.map((itemEvidence) => {
		const item = store.getItem(itemEvidence.itemId);
		const ref: Record<string, unknown> = {
			id: itemEvidence.itemId,
			source: item?.source ?? itemEvidence.source,
			title: item?.title ?? itemEvidence.title,
			url: item?.url ?? itemEvidence.url,
		};
		if (item?.sub_source) ref.sub_source = item.sub_source;
		if (item?.source_event_id && item.ack_source_id) {
			ref.event_id = item.source_event_id;
			ref.ack_source_id = item.ack_source_id;
		}
		return ref;
	});
}

export { DEFAULT_SESSION_KEY };
