/**
 * @cogito/chat — IM chat module on the host base.
 *
 * runChatModule() replaces the legacy scripts/cogito-gateway.ts glue:
 * - builds the channel SDK (channels, handoff, outbox, message store);
 * - hosts one AgentSession per conversation (ChatSessionPool);
 * - bridges inbound messages to turns (createChatMessageHandler), with
 *   optional streaming deltas to streaming-capable channels;
 * - registers chat tools (message_push, web, memory, messages, schedule);
 * - wires long-term memory injection, timed tasks, and the web dashboard.
 */

import { join, resolve } from "node:path";
import type { StreamFn, ThinkingLevel } from "@cogito/agent-core";
import type { Model } from "@cogito/ai";
import {
	ChannelAgentRuntime,
	type ChannelSdk,
	createChannelSdk,
	FileAttachmentStore,
	FileChannelSessionStore,
	FileOutboundOutbox,
	GatewayInstanceLock,
	loadGatewayConfig,
	writeGatewayReadiness,
} from "@cogito/gateway";
import {
	createSubagentAgentRunner,
	ExtensionSqlite,
	getAgentDir,
	ModelRuntime,
	SettingsManager,
	type SubagentRunner,
	type ToolDefinition,
} from "@cogito/host";
import { CHAT_SCHEDULE_TOOLS, type ChatConfig, loadChatConfig } from "./config.ts";
import { mountWebDashboard, resolveProactiveDbPath } from "./dashboard.ts";
import { ChatDelivery } from "./delivery.ts";
import { createChatResourceLoader } from "./extensions.ts";
import { ChatMemory } from "./memory.ts";
import { ChatPresenceWriter } from "./presence.ts";
import { ChatScheduler } from "./scheduler.ts";
import { ChatSessionPool, type ChatSessionScope } from "./session-pool.ts";
import { createMemoryTools } from "./tools/memory-tools.ts";
import { createMessagePushTool } from "./tools/message-push.ts";
import { createMessageHistoryTools } from "./tools/messages.ts";
import { createScheduleTools } from "./tools/schedule.ts";
import { createLoadSkillTool } from "./tools/skills.ts";
import { createWebTools } from "./tools/web.ts";
import { createChatMessageHandler, promptSession } from "./turn.ts";

export type { ChatConfig } from "./config.ts";
export { mountWebDashboard, resolveProactiveDbPath } from "./dashboard.ts";
export { ChatDelivery } from "./delivery.ts";
export { createChatResourceLoader } from "./extensions.ts";
export { ChatMemory } from "./memory.ts";
export { ChatPresenceWriter } from "./presence.ts";
export { type ChatScheduleJob, type ChatScheduleResult, ChatScheduler, parseDuration } from "./scheduler.ts";
export { type AgentSession, ChatSessionPool, type ChatSessionScope } from "./session-pool.ts";
export { createMemoryTools } from "./tools/memory-tools.ts";
export { createMessagePushTool } from "./tools/message-push.ts";
export { createMessageHistoryTools } from "./tools/messages.ts";
export { createScheduleTools } from "./tools/schedule.ts";
export { createLoadSkillTool, findSkill, listSkills } from "./tools/skills.ts";
export { createWebTools } from "./tools/web.ts";
export { createChatMessageHandler, promptSession } from "./turn.ts";

const DEFAULT_LOG_PREFIX = "[cogito-gateway]";

export interface ChatModuleOptions {
	/** Path to config.json. Default: <projectDir>/config.json or GATEWAY_CONFIG. */
	configPath?: string;
	/** Working directory. Default: COGITO_PROJECT_DIR or process.cwd(). */
	projectDir?: string;
	/** Agent config directory. Default: getAgentDir(). */
	agentDir?: string;
	/** Log sink. Default: console.error with the [cogito-gateway] prefix. */
	log?: (message: string) => void;
}

export interface ChatModule {
	readonly sdk: ChannelSdk;
	readonly pool: ChatSessionPool;
	readonly scheduler: ChatScheduler;
	readonly memory: ChatMemory | undefined;
	readonly readinessPath: string;
	stop(): Promise<void>;
}

export async function runChatModule(options: ChatModuleOptions = {}): Promise<ChatModule> {
	const projectDir = resolve(options.projectDir ?? process.env.COGITO_PROJECT_DIR ?? process.cwd());
	const configPath = resolve(options.configPath ?? process.env.GATEWAY_CONFIG ?? `${projectDir}/config.json`);
	const agentDir = resolve(options.agentDir ?? getAgentDir());
	const log = options.log ?? ((message: string) => console.error(`${DEFAULT_LOG_PREFIX} ${message}`));
	const config = loadGatewayConfig(configPath);
	const chatConfig = loadChatConfig(configPath);
	assertManagedWebConfig(config, log);

	const enabledChannels = Object.entries(config.channels ?? {})
		.filter(([, channel]) => channel.enabled === true)
		.map(([name]) => name);
	if (enabledChannels.length === 0) {
		throw new Error(`没有启用的 channel，请检查 ${configPath}`);
	}

	const instanceLock = GatewayInstanceLock.acquire(join(agentDir, "channel-gateway.lock"));
	const readinessPath = join(agentDir, "channel-gateway-ready.json");
	const channelSessionStore = new FileChannelSessionStore(join(agentDir, "channel-sessions.json"));
	const agentSessionDir = join(agentDir, "channel-agent-sessions");
	writeGatewayReadiness(readinessPath, "starting", []);

	let sdk: ChannelSdk | undefined;
	let runtime: ChannelAgentRuntime | undefined;
	let pool: ChatSessionPool | undefined;
	let scheduler: ChatScheduler | undefined;
	let memory: ChatMemory | undefined;
	let presenceWriter: ChatPresenceWriter | undefined;
	const extensionSqlite = ExtensionSqlite.create(agentDir, () => "cogito-gateway");

	try {
		const channelSdk = createChannelSdk({
			config,
			configPath,
			defaultWeb: false,
			watchConfig: true,
			retry: { maxAttempts: 2, baseDelayMs: 500, maxDelayMs: 2000 },
			inboundRetry: { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 5000 },
			outboxCleanup: { olderThanMs: 7 * 24 * 60 * 60 * 1000, intervalMs: 60 * 60 * 1000 },
			sessionManager: channelSessionStore,
			offsetStatePath: join(agentDir, "channel-offsets.json"),
			bus: { outboundOutbox: new FileOutboundOutbox(join(agentDir, "channel-outbox.json")) },
			inboundHandoffStatePath: join(agentDir, "channel-inbound.json"),
			inboundDeadLetterStatePath: join(agentDir, "channel-inbound-dlq.json"),
			messageStatePath: join(agentDir, "channel-messages.json"),
			context: { attachmentStore: new FileAttachmentStore(join(agentDir, "channel-attachments")) },
		});
		sdk = channelSdk;

		const delivery = new ChatDelivery(channelSdk);
		// 用户活跃度心跳:写 proactive 的 presence 表(energy 调度输入)。
		const writer = new ChatPresenceWriter(resolveProactiveDbPath(projectDir, agentDir), (message) =>
			log(`presence: ${message}`),
		);
		presenceWriter = writer;
		memory = await ChatMemory.create({
			enabled: chatConfig.memory?.enabled ?? true,
			agentDir,
			dbPath: chatConfig.memory?.dbPath,
			log,
		});

		// Scheduler deps reference the pool, which is created below.
		let poolRef: ChatSessionPool | undefined;
		scheduler = new ChatScheduler(join(agentDir, "chat-schedules.json"), {
			deliver: async (job, content) => {
				await delivery.send({
					channel: job.targetChannel,
					chatId: job.targetChatId,
					content,
				});
			},
			generateSoft: async (job) => {
				const current = poolRef;
				if (!current) return "";
				const session = await current.getOrCreate({
					sessionKey: job.sessionKey,
					channel: job.targetChannel,
					chatId: job.targetChatId,
				});
				if (!session.isIdle) return "";
				return promptSession(session, `定时任务内容生成请求：${job.prompt}`);
			},
			log,
		});

		const modelRuntime = await ModelRuntime.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath: join(agentDir, "models.json"),
		});
		const model = resolveChatModel(chatConfig, modelRuntime);
		const settingsManager = SettingsManager.create(projectDir, agentDir);
		// Sub-agent delegation: one shared runner (model/credentials follow the
		// main sessions), one per-session SubagentManager mounted as an
		// inline extension by createChatResourceLoader.
		const subagentRunner: SubagentRunner | undefined = model
			? createSubagentAgentRunner({
					model,
					thinkingLevel: chatConfig.thinkingLevel as ThinkingLevel | undefined,
					cwd: projectDir,
					streamFn: buildSubagentStreamFn(modelRuntime, settingsManager),
				})
			: undefined;
		const toolAllow = chatConfig.tools?.allowed;
		const allowedToolNames = toolAllow ? toolAllow.filter((name) => !toolExcluded(name, chatConfig)) : undefined;
		const excludedToolNames = toolAllow ? undefined : chatConfig.tools?.excluded;
		const scheduleToolsEnabled =
			chatConfig.schedule?.enabled === true ||
			(toolAllow?.some((name) => (CHAT_SCHEDULE_TOOLS as readonly string[]).includes(name)) ?? false);

		pool = new ChatSessionPool({
			projectDir,
			agentDir,
			agentSessionDir,
			channelSessionStore,
			extensionSqlite,
			settingsManager,
			model,
			thinkingLevel: chatConfig.thinkingLevel as ThinkingLevel | undefined,
			allowedToolNames,
			excludedToolNames,
			createResourceLoader: (scope) =>
				createChatResourceLoader({
					projectDir,
					agentDir,
					settingsManager,
					scope,
					memory: memory ?? undefined,
					injectMemoryProfile: chatConfig.memory?.injectProfile !== false,
					chatTools: buildChatTools(
						{
							delivery,
							sdk: channelSdk,
							memory: memory ?? undefined,
							scheduler: scheduler ?? undefined,
							web: chatConfig.web,
							projectDir,
							agentDir,
							scheduleToolsEnabled,
						},
						scope,
					),
					extensionsDir: chatConfig.extensionsDir,
					persona: chatConfig.persona,
					subagentRunner,
				}),
			maxSessions: chatConfig.sessions?.maxSessions,
			maxIdleMinutes: chatConfig.sessions?.maxIdleMinutes,
			log,
		});
		poolRef = pool;

		const handleMessage = createChatMessageHandler({
			pool,
			delivery,
			streaming: chatConfig.streaming !== false,
			onUserMessage: (message) => writer.recordUserMessage(message.timestamp, "local"),
			log,
		});
		runtime = new ChannelAgentRuntime({
			sdk: channelSdk,
			handleMessage,
			onError: (message, error) => {
				log(`delivery failed channel=${message.channel} chat=${message.chatId}: ${formatError(error)}`);
			},
		});
		await runtime.start();

		mountWebDashboard(channelSdk, { projectDir, agentDir, log });

		pool.start();
		scheduler.start();

		try {
			const readyChannels = await channelSdk.waitForReadiness({ timeoutMs: readinessTimeoutMs() });
			writeGatewayReadiness(readinessPath, "ready", readyChannels);
		} catch (error) {
			log(`channel readiness pending: ${formatError(error)}`);
			writeGatewayReadiness(readinessPath, "degraded", channelSdk.status());
		}
		const readinessMonitor = setInterval(() => {
			const channels = channelSdk.status();
			const state = channels.length > 0 && channels.every((channel) => channel.ready) ? "ready" : "degraded";
			writeGatewayReadiness(readinessPath, state, channels);
		}, 5000);
		readinessMonitor.unref?.();

		log(`config=${configPath}`);
		log(
			`channels=${channelSdk
				.status()
				.map((channel) => channel.name)
				.join(",")}`,
		);

		return {
			sdk: channelSdk,
			pool,
			scheduler,
			memory,
			readinessPath,
			stop: async () => {
				clearInterval(readinessMonitor);
				await runtime?.stop().catch(() => undefined);
				scheduler?.stop();
				pool?.disposeAll();
				memory?.close();
				presenceWriter?.close();
				extensionSqlite.close();
				writeGatewayReadiness(readinessPath, "stopped", sdk?.status() ?? []);
				instanceLock.release();
			},
		};
	} catch (error) {
		await runtime?.stop().catch(() => undefined);
		pool?.disposeAll();
		scheduler?.stop();
		memory?.close();
		presenceWriter?.close();
		extensionSqlite.close();
		writeGatewayReadiness(readinessPath, "stopped", sdk?.status() ?? []);
		instanceLock.release();
		throw error;
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ChatToolBuildDeps {
	delivery: ChatDelivery;
	sdk: ChannelSdk;
	memory: ChatMemory | undefined;
	scheduler: ChatScheduler | undefined;
	web: ChatConfig["web"];
	projectDir: string;
	agentDir: string;
	scheduleToolsEnabled: boolean;
}

function buildChatTools(deps: ChatToolBuildDeps, scope: ChatSessionScope): ToolDefinition[] {
	const tools: ToolDefinition[] = [];
	tools.push(createMessagePushTool(deps.delivery));
	tools.push(
		...createWebTools({
			maxChars: deps.web?.fetch?.maxChars,
			maxRedirectHops: deps.web?.fetch?.maxRedirectHops,
			timeoutMs: deps.web?.fetch?.timeoutMs,
			searchUrl: deps.web?.search?.url,
			searchApiKey: deps.web?.search?.apiKey,
		}),
	);
	tools.push(...createMessageHistoryTools(deps.sdk));
	tools.push(createLoadSkillTool({ agentDir: deps.agentDir, projectDir: deps.projectDir }));
	if (deps.memory) {
		tools.push(...createMemoryTools(deps.memory, { channel: scope.channel, chatId: scope.chatId }));
	}
	if (deps.scheduler && deps.scheduleToolsEnabled) {
		tools.push(...createScheduleTools(deps.scheduler, scope));
	}
	return tools;
}

/**
 * Stream function for sub-agent calls, mirroring the main session wiring in
 * host's createAgentSession (provider retry settings, HTTP idle timeout).
 * Extension header hooks are intentionally omitted: sub-agents have no
 * extension runtime of their own.
 */
function buildSubagentStreamFn(modelRuntime: ModelRuntime, settingsManager: SettingsManager): StreamFn {
	return (model, context, options) => {
		const providerRetrySettings = settingsManager.getProviderRetrySettings();
		const httpIdleTimeoutMs = settingsManager.getHttpIdleTimeoutMs();
		// SDKs treat timeout=0 as 0ms (immediate timeout), not "no timeout".
		// Use max int32 to effectively disable the timeout.
		const effectiveTimeoutMs = httpIdleTimeoutMs === 0 ? 2147483647 : httpIdleTimeoutMs;
		const timeoutMs = options?.timeoutMs ?? providerRetrySettings.timeoutMs ?? effectiveTimeoutMs;
		return modelRuntime.streamSimple(model, context, {
			...options,
			timeoutMs,
			websocketConnectTimeoutMs: settingsManager.getWebSocketConnectTimeoutMs(),
			maxRetries: options?.maxRetries ?? providerRetrySettings.maxRetries,
			maxRetryDelayMs: options?.maxRetryDelayMs ?? providerRetrySettings.maxRetryDelayMs,
		});
	};
}

function resolveChatModel(chatConfig: ChatConfig, modelRuntime: ModelRuntime): Model<any> | undefined {
	const reference = chatConfig.model;
	if (!reference) return undefined;
	const slash = reference.indexOf("/");
	if (slash > 0) {
		return modelRuntime.getModel(reference.slice(0, slash), reference.slice(slash + 1));
	}
	const provider = chatConfig.provider;
	return provider ? modelRuntime.getModel(provider, reference) : undefined;
}

function toolExcluded(name: string, chatConfig: ChatConfig): boolean {
	return chatConfig.tools?.excluded?.includes(name) ?? false;
}

function assertManagedWebConfig(
	config: { channels?: Record<string, Record<string, unknown>>; web?: { host?: string } },
	log: (message: string) => void,
): void {
	const webChannel = config.channels?.web;
	if (!webChannel || webChannel.enabled !== true) {
		throw new Error("gateway requires channels.web.enabled=true for protected management endpoints");
	}
	const host = config.web?.host ?? "127.0.0.1";
	if (!isLoopbackHost(host)) {
		throw new Error(`gateway management host must be loopback: ${host}`);
	}
	const auth = isRecord(webChannel.auth) ? webChannel.auth : undefined;
	const envToken = process.env.GATEWAY_WEB_AUTH_TOKEN;
	if (typeof auth?.token === "string" && auth.token.trim().length > 0) {
		return;
	}
	if (envToken && envToken.trim().length > 0) {
		webChannel.auth = { ...auth, token: envToken.trim() };
		return;
	}
	log(
		"warning: no web auth token (GATEWAY_WEB_AUTH_TOKEN / channels.web.auth.token); management endpoints are open (loopback only)",
	);
}

function isLoopbackHost(host: string): boolean {
	const normalized = host.toLowerCase();
	return normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]" || normalized === "localhost";
}

function readinessTimeoutMs(): number {
	const value = Number(process.env.COGITO_GATEWAY_READINESS_TIMEOUT_MS);
	return Number.isFinite(value) && value > 0 ? Math.floor(value) : 10_000;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
