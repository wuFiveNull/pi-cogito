/**
 * @cogito/gate — 三进程共享状态层。
 *
 * proactive 与 drift 都只依赖本包,互相零引用:
 * - gate.ts:drift_gate 许可读写(proactive 写,drift daemon 读)
 * - drive.ts:空闲 drift 调度(advanceDriftDrive / sampleDriftDelayHours)
 * - model-pick.ts:daemon 模型选择(settings.json enabledModels)
 * - memory.ts:用户偏好召回(recallPreferences / formatPreferenceBlock)
 * - outbound.ts:出站消息哈希与附件类型
 */

export type { DriftDecision, DriftDriveResult } from "./drive.ts";
export { advanceDriftDrive, sampleDriftDelayHours } from "./drive.ts";
export type { DriftEvent, DriftEventSink } from "./events.ts";
export type { DriftGate, DriftGateStoreOptions, DriftGateWriter } from "./gate.ts";
export { DriftGateStore, WAKE_DRIFT_GATE_TTL_HOURS } from "./gate.ts";
export type { RecallEmbeddingFn, RecalledPreference } from "./memory.ts";
export { formatPreferenceBlock, recallPreferences, recallPreferencesRanked } from "./memory.ts";
export { pickDaemonModel } from "./model-pick.ts";
export type { DriftAttachmentKind, DriftOutboundAttachment } from "./outbound.ts";
export { hashMessage, hashOutboundMessage } from "./outbound.ts";
export type {
	DriftDeliveryReceipt,
	DriftDeliveryRecord,
	DriftDeliverySink,
	DriftDeliveryStatus,
	DriftStagedDelivery,
	DriftStagedDeliveryStoreOptions,
} from "./staged.ts";
export { DriftStagedDeliveryStore } from "./staged.ts";
export type {
	DriftWebDnsLookupFn,
	DriftWebFetchFn,
	DriftWebFetchResult,
	DriftWebPolicy,
	DriftWebResolvedAddress,
	DriftWebSearchFn,
	DriftWebSearchItem,
} from "./web.ts";
export {
	boundedNumber,
	DEFAULT_WEB_MAX_CHARS,
	DEFAULT_WEB_MAX_RESULTS,
	DEFAULT_WEB_TIMEOUT_MS,
	fetchWebPage,
	isHttpUrl,
	matchesHostPattern,
	parseIpv4,
	requestWebResponse,
	searchWebPage,
	validateResolvedWebUrl,
	validateWebUrl,
	webHtmlToText,
} from "./web.ts";
