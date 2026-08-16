/**
 * Drift 生命周期事件契约(共享层)。
 *
 * drift daemon 发出事件;proactive 通过 EventBus 订阅(DriftEventObserved)。
 * 类型独立于两个包,proactive/drift 都从本包引用。
 */

import type { DriftDeliveryStatus } from "./staged.ts";

export type DriftEvent =
	| {
			type: "drift_started";
			runId?: string;
			sessionKey: string;
			at: number;
			skillCount: number;
	  }
	| {
			type: "drift_delivery_committed";
			runId?: string;
			sessionKey: string;
			at: number;
			deliveryId: number;
			status: DriftDeliveryStatus;
			providerMessageId?: string;
			canonicalMedia?: readonly string[];
			detail?: string;
	  }
	| {
			type: "drift_tool_called";
			runId?: string;
			sessionKey: string;
			at: number;
			toolName: string;
			risk: string;
			source: string;
			result: "success" | "error" | "denied";
			durationMs: number;
			argsPreview: string;
			error?: string;
	  }
	| {
			type: "drift_finished";
			runId?: string;
			sessionKey: string;
			at: number;
			status: "completed" | "paused" | "failed";
			skill: string;
			messageStaged: boolean;
			messageCommitted: boolean;
			deliveryId: number | null;
			deliveryStatus: DriftDeliveryStatus | "";
			error?: string;
			/** 本轮 LLM cache usage(akashic record_llm_cache 的 run 级审计)。 */
			llmCacheReadTokens?: number;
			llmCacheWriteTokens?: number;
	  };

export interface DriftEventSink {
	emit(event: DriftEvent): void | Promise<void>;
}
