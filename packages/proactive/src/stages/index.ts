/**
 * 阶段策略:接口 + 默认实现。
 */
export { ProactiveEngine } from "../engine.ts";
export { type AnyActionConfig, AnyActionGate, type AnyActionMeta } from "./anyaction.ts";
export type { DedupeResult, RecentDeliveryLike } from "./dedupe.ts";
export { extractJsonObject, isMessageDuplicate } from "./dedupe.ts";
export type { DefaultStagesConfig, DefaultStagesDeps } from "./defaults.ts";
export { createDefaultStages } from "./defaults.ts";
export type {
	ProactiveDeliveryContext,
	ProactiveDeliveryExecutorOptions,
} from "./deliver.ts";
export {
	deliverProactiveProposal,
	getDeliverySendStatus,
	SqliteDeliverStrategy,
} from "./deliver.ts";
export type { PollSourceInstance } from "./fetch-scheduler.ts";
export { SourcePollStrategy } from "./fetch-scheduler.ts";
export { GateChain, type GateConfig, type GateContextOnlyConfig } from "./gate.ts";
export { DriftIdleStrategy } from "./idle.ts";
export { AgentTickJudgeStrategy } from "./judge-agent-tick.ts";
export { fixLineBreaks, normalizeOutboundText } from "./outbound-text.ts";
export { EvidenceFirstResolveStrategy } from "./resolve-evidence.ts";
export { EnergyScheduleStrategy } from "./schedule.ts";
export { JsonlPresenceStrategy } from "./sense.ts";
export type {
	CandidateItem,
	DeliverStrategy,
	DeliveryMessage,
	DeliveryResult,
	Evidence,
	FetchStrategy,
	GateStrategy,
	GateVerdict,
	IdleStrategy,
	JudgeStrategy,
	JudgeVerdict,
	PresenceStrategy,
	ProactiveStages,
	ResolveStrategy,
	ScheduleStrategy,
	SenseState,
	TickResult,
	TurnContext,
} from "./types.ts";
