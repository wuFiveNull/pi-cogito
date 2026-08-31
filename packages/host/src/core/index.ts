/**
 * Core modules shared between all run modes.
 */

export {
	AgentSession,
	type AgentSessionConfig,
	type AgentSessionEvent,
	type AgentSessionEventListener,
	type ModelCycleResult,
	type PromptOptions,
	type SessionStats,
} from "./agent-session.ts";
export {
	AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	type CreateAgentSessionRuntimeResult,
	createAgentSessionRuntime,
} from "./agent-session-runtime.ts";
export {
	type AgentSessionRuntimeDiagnostic,
	type AgentSessionServices,
	type CreateAgentSessionFromServicesOptions,
	type CreateAgentSessionServicesOptions,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "./agent-session-services.ts";
// Approval (AI review)
export {
	type ApprovalCompleteFn,
	type ApprovalJudge,
	type ApprovalJudgeSettings,
	type ApprovalKind,
	type ApprovalModelSource,
	type ApprovalRequest,
	type ApprovalVerdict,
	createLlmApprovalJudge,
	parseVerdict,
} from "./approval/index.ts";
export { type BashExecutorOptions, type BashResult, executeBashWithOperations } from "./bash-executor.ts";
export type { CompactionResult } from "./compaction/index.ts";
export { createEventBus, type EventBus, type EventBusController } from "./event-bus.ts";
export { areExperimentalFeaturesEnabled } from "./experimental.ts";
// Extensions system
export {
	type AgentEndEvent,
	type AgentSettledEvent,
	type AgentStartEvent,
	type AgentToolResult,
	type AgentToolUpdateCallback,
	type BeforeAgentStartEvent,
	type BeforeAgentStartEventResult,
	type BuildSystemPromptOptions,
	type ContextEvent,
	defineTool,
	discoverAndLoadExtensions,
	type ExecOptions,
	type ExecResult,
	type Extension,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type ExtensionError,
	type ExtensionEvent,
	type ExtensionFactory,
	type ExtensionFlag,
	type ExtensionHandler,
	ExtensionRunner,
	type ExtensionShortcut,
	type ExtensionUIContext,
	type InlineExtension,
	type LoadExtensionsResult,
	type MessageRenderer,
	type RegisteredCommand,
	type SessionBeforeCompactEvent,
	type SessionBeforeForkEvent,
	type SessionBeforeSwitchEvent,
	type SessionBeforeTreeEvent,
	type SessionCompactEvent,
	type SessionShutdownEvent,
	type SessionStartEvent,
	type SessionTreeEvent,
	type ToolCallEvent,
	type ToolCallEventResult,
	type ToolDefinition,
	type ToolRenderResultOptions,
	type ToolResultEvent,
	type TurnEndEvent,
	type TurnStartEvent,
	type WorkingIndicatorOptions,
} from "./extensions/index.ts";
// Sandbox
export {
	DEFAULT_CONFIG as DEFAULT_SANDBOX_CONFIG,
	type SandboxApprovalConfig,
	type SandboxConfig,
	type SandboxConfigFile,
} from "./sandbox/config.ts";
export type { SessionAllowances as SandboxSessionAllowances } from "./sandbox/runtime.ts";
export { createSandboxExtension } from "./sandbox/sandbox-extension.ts";
export { createSyntheticSourceInfo } from "./source-info.ts";
export { type CreateSubagentExtensionOptions, createSubagentExtension } from "./subagent-extension.ts";
export {
	DEFAULT_MAX_CONCURRENT_SUBAGENTS,
	type RunningSubagentJob,
	SubagentCapacityError,
	SubagentManager,
	type SubagentManagerOptions,
	type SubagentRunner,
	type SubagentRunRequest,
	type SubagentRunResult,
	type SubagentRunStatus,
} from "./subagent-manager.ts";
export {
	createSubagentAgentRunner,
	DEFAULT_SUBAGENT_MAX_ITERATIONS,
	DEFAULT_SUBAGENT_TOOLS,
	type SubagentAgentRunnerOptions,
} from "./subagent-runner.ts";
export {
	createSpawnManageTool,
	createSpawnTool,
	createSubagentTools,
	DEFAULT_SUBAGENT_BACKGROUND_RESULT_MAX_CHARS,
	formatSubagentCompletion,
	type SpawnToolOptions,
} from "./subagent-tools.ts";
