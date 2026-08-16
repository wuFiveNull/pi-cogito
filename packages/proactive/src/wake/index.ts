/**
 * Wake 生命周期组装(akashic plugins/wake_proactive/plugin.py + ProactiveLoop 移植)。
 *
 * runWakePusher 组装:数据源(按 kind 分桶)→ WakeStateStore → WakeRuntime →
 * WakeLoop(首轮立即 tick,之后按 runtime 返回的间隔休眠)。
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Model } from "@cogito/ai";
import {
	type ChatCompletionMessage,
	type ChatCompletionTool,
	type ChatCompletionToolChoice,
	OpenAICompatibleChatClient,
} from "@cogito/ai/chat";
import { recallPreferences } from "@cogito/gate";
import type { ModelRuntime } from "@cogito/host";
import { type Clock, ReplayClock, replayRandom, SystemClock } from "../clock.ts";
import type { DriftGateWriter } from "../drift-gate.ts";
import { createHostChatFn } from "../host.ts";
import { createProactiveProposal, type ProactiveProposal } from "../proposal.ts";
import type { ProactiveRules } from "../rules.ts";
import { ProactiveTurnOrchestrator } from "../runtime/orchestrator.ts";
import type { ProactiveRuntimePorts, ProactiveSessionMessage } from "../runtime/ports.ts";
import { acknowledgeSource as routeSourceAcknowledgement } from "../runtime/source-ack.ts";
import { SourceHealthTracker } from "../runtime/source-health.ts";
import { sourceResultItemCount, validateSourceBatch } from "../source-contract.ts";
import { type DeliveryOutlet, deliverProactiveProposal } from "../stages/deliver.ts";
import { htmlToText } from "../stages/judge-agent-tick.ts";
import type { TickScheduler } from "../stages/schedule.ts";
import { Presence } from "../stages/sense.ts";
import type { ProactiveStore } from "../store.ts";
import type { ProactiveSource } from "../types.ts";
import type { WakeChannelBatch, WakeRuntimeDeps } from "./runtime.ts";
import { WakeStateStore } from "./state.ts";

export interface WakeLlmConfig {
	model: string;
	apiBaseUrl: string;
	apiKey?: string;
}

export interface WakePusherOptions {
	sources: Map<string, ProactiveSource>;
	/** per-source config,enabled=false 跳过。 */
	sourceConfigs: Record<string, { enabled?: boolean; [key: string]: unknown } | undefined>;
	dbPath: string;
	sessionsDir: string;
	rules: ProactiveRules;
	memoryDbPath?: string;
	/** 宿主 pusher 的共享 store(投递/存在感写入;关闭由宿主负责)。 */
	store: ProactiveStore;
	llm: WakeLlmConfig;
	/** pi-host 服务:提供时 wake 的 chat 走 host 的 ModelRuntime(认证+流式)。 */
	host?: { modelRuntime: ModelRuntime; model: Model<any> };
	/** 三进程模式:写 drift_gate 许可。 */
	driftGate?: DriftGateWriter;
	/** 三进程模式:「允许」许可的 TTL(小时);默认 WAKE_DRIFT_GATE_TTL_HOURS。 */
	driftGateTtlHours?: number;
	/** 可选嵌入 API(语义兴趣)。 */
	embeddingApi?: { embedBatch(texts: string[]): Promise<number[][]>; modelId?: string };
	/** 可选:默认数据源的事件合成 identity 的开关(akashic MCP 源自带 identity)。 */
	tickIntervalSeconds?: number;
	/** 可选:energy 自适应调度器(akashic energy.py)。缺省用固定 tickIntervalSeconds。 */
	tickScheduler?: TickScheduler;
	/** 目标会话 key(默认 local)。 */
	sessionKey?: string;
	/** 可注入时钟(测试用固定时间;默认系统时钟)。 */
	clock?: Clock;
	/** 可选外部投递出口;存在时 wake 先发出再确认 outbox。 */
	deliveryOutlet?: DeliveryOutlet;
	/** Shared delivery dedupe policy used by default and wake. */
	deliveryDedupeHours?: number;
	messageDedupeRecentN?: number;
	/** Host-owned session, presence, memory and delivery ports. */
	runtimePorts?: ProactiveRuntimePorts;
	sourceHealth?: SourceHealthTracker;
}

/**
 * 组装 wake runtime deps(惰性:选择 wake 生命周期时才调用)。
 * store 由宿主传入并负责关闭;wake 蓄水池状态库由 runtime.close() 关闭。
 */
export function buildWakeRuntimeDeps(options: WakePusherOptions): WakeRuntimeDeps {
	const { sources, sourceConfigs, dbPath, sessionsDir, rules, memoryDbPath, llm, deliveryOutlet } = options;
	const apiKey = llm.apiKey;
	const clock = options.clock ?? SystemClock;
	const store = options.store;
	const sessionKey = options.sessionKey ?? "local";
	const wakeStateStore = new WakeStateStore(join(dbPathDir(dbPath), "wake_proactive.db"), clock);
	const sourceHealth = options.sourceHealth ?? new SourceHealthTracker({ store });
	const orchestrator = new ProactiveTurnOrchestrator(options.runtimePorts);
	let replayWakeSequence = 0;
	const deliverProposal = async (proposal: ProactiveProposal): Promise<boolean> => {
		const result = await deliverProactiveProposal(
			proposal,
			{ sessionKey, now: clock.now() },
			{
				store,
				deliveryDedupeHours: options.deliveryDedupeHours ?? 24,
				messageDedupeRecentN: options.messageDedupeRecentN ?? 5,
				outlet: deliveryOutlet,
				runtimePorts: options.runtimePorts,
				orchestrator,
				acknowledgeSources: false,
				stateSummaryTag: "wake",
			},
		);
		if (result.delivered) store.updatePresence(sessionKey, { last_proactive_at: clock.nowMs() });
		return result.delivered || result.reason === "duplicate" || result.reason === "llm_duplicate";
	};

	// presence:host 端口优先;否则每 tick 增量扫描会话文件刷新 last_user_at
	// (akashic presence.py;gateway 直写 presence 表时扫描结果与其取 max)。
	const presence = new Presence(store, { sessionsDir, sessionKey }, options.runtimePorts?.presence);

	const deps: WakeRuntimeDeps = {
		sessionKey,
		stateStore: wakeStateStore,
		fetchChannels: () => fetchChannels(sources, sourceConfigs, store, wakeStateStore, clock, sourceHealth),
		acknowledge: async (sourceId, eventIds) => {
			if (options.runtimePorts?.sourceAck) {
				await options.runtimePorts.sourceAck.acknowledge(sourceId, eventIds);
				return;
			}
			await routeSourceAcknowledgement(sources, sourceConfigs, sourceId, eventIds);
		},
		nowFn: () => clock.now(),
		turnPairs: async (now) =>
			(await options.runtimePorts?.session?.turnPairs?.({ sessionKey, limit: 256, now })) ??
			sessionTurnPairs(sessionsDir, now),
		sessionSignature: async () =>
			(await options.runtimePorts?.session?.signature?.(sessionKey)) ?? sessionSignature(sessionsDir),
		chat: options.host
			? createHostChatFn({
					modelRuntime: options.host.modelRuntime,
					model: options.host.model,
					maxTokens: 2048,
				})
			: (messages, tools, toolChoice) => {
					if (!apiKey) {
						throw new Error("Wake lifecycle requires agentTick.apiKey (or host)");
					}
					return openaiChat({
						messages,
						tools,
						toolChoice,
						model: llm.model,
						baseUrl: llm.apiBaseUrl,
						apiKey,
						maxTokens: 2048,
					});
				},
		model: llm.model,
		maxTokens: 2048,
		memoryDbPath,
		lastUserAt: () => presence.refresh(),
		recentPassiveConversation: async (now) => {
			const messages = await readHostSessionMessages(options.runtimePorts, sessionKey, now, 20);
			return messages ? formatRecentPassiveConversation(messages) : readRecentPassiveConversation(sessionsDir, now);
		},
		recentProactiveMessages: async (now) => {
			const messages = await readHostSessionMessages(options.runtimePorts, sessionKey, now, 30);
			return messages ? formatRecentProactiveMessages(messages) : readRecentProactiveMessages(store, now);
		},
		readRules: () => rules.read(),
		readMemory: async (now = clock.now()) =>
			(await options.runtimePorts?.memory?.memoryText?.({ sessionKey, now })) ??
			(memoryDbPath ? readLongTermMemory(memoryDbPath) : ""),
		beforeTurn: (input) => options.runtimePorts?.memory?.beforeTurn?.(input),
		driftGate: options.driftGate,
		driftGateTtlHours: options.driftGateTtlHours,
		deliver: async (message, sourceRefs) =>
			await deliverProposal(
				createProactiveProposal({
					action: "send",
					message,
					itemIds: sourceRefs.map((ref) => String(ref.id ?? ref.event_id ?? "")),
					sourceRefs,
					reason: "wake_legacy_delivery",
				}),
			),
		deliverProposal,
		embeddingApi: options.embeddingApi,
		webFetchFn: async (url, maxChars) => {
			try {
				const controller = new AbortController();
				const timeout = setTimeout(() => controller.abort(), 60_000);
				try {
					const response = await fetch(url, { signal: controller.signal });
					if (!response.ok) return { error: `http ${response.status}`, url };
					const text = await response.text();
					const plain = htmlToText(text);
					return { text: plain.slice(0, maxChars), truncated: plain.length > maxChars };
				} finally {
					clearTimeout(timeout);
				}
			} catch (error) {
				return { error: error instanceof Error ? error.message : String(error), url };
			}
		},
		rng: clock instanceof ReplayClock ? replayRandom(clock, "wake") : Math.random,
		wakeIdFn:
			clock instanceof ReplayClock
				? () => `replay-${clock.nowMs().toString(36)}-${(replayWakeSequence++).toString(36)}`
				: undefined,
		tickIntervalSeconds: options.tickIntervalSeconds ?? (clock instanceof ReplayClock ? 1 : 300),
		tickScheduler: options.tickScheduler,
	};

	return deps;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ------------------------------------------------------------------
// 通道拉取
// ------------------------------------------------------------------

async function fetchChannels(
	sources: Map<string, ProactiveSource>,
	sourceConfigs: Record<string, { enabled?: boolean; [key: string]: unknown } | undefined>,
	store: ProactiveStore,
	wakeStateStore: WakeStateStore,
	clock: Clock,
	sourceHealth: SourceHealthTracker,
): Promise<WakeChannelBatch> {
	const channels: WakeChannelBatch = {
		alert: [],
		content: [],
		context: [],
	};
	const pendingCommits: Array<() => void> = [];
	const enabledSources = [...sources.entries()].filter(([id]) => sourceConfigs[id]?.enabled !== false);
	const dueSources = enabledSources.filter(([id]) => sourceHealth.tryAcquire(id, clock.nowMs()));
	for (const [id] of enabledSources) {
		if (!dueSources.some(([dueId]) => dueId === id)) sourceHealth.recordSkipped(id, clock.nowMs());
	}
	let succeeded = 0;
	const failures: string[] = [];
	const results = await Promise.allSettled(
		dueSources.map(async ([id, source]) => {
			const items = await source.fetch(sourceConfigs[id] ?? {});
			return { id, source, items, validation: validateSourceBatch(source, items, clock.now()) };
		}),
	);
	for (const [index, result] of results.entries()) {
		const [id, source] = dueSources[index]!;
		if (result.status === "rejected") {
			failures.push(id);
			// 单源失败不丢弃其他源,但保留可诊断错误。
			const message = formatError(result.reason);
			const diagnostics = source.fetchDiagnostics?.();
			const health = sourceHealth.recordFailure(id, clock.nowMs(), message);
			store.recordSourceFailure({ sourceId: id, error: message, diagnostics, now: clock.nowMs() });
			store.setState(`health.source.${id}`, JSON.stringify({ ...health, diagnostics }));
			store.setState(`lastError.${id}`, message);
			console.error(`proactive wake source failed source=${id}: ${message}`);
			continue;
		}
		const { items, validation } = result.value;
		const diagnostics = source.fetchDiagnostics?.();
		const health = sourceHealth.recordSuccess(id, clock.nowMs(), {
			received: sourceResultItemCount(items),
			accepted: validation.events.length,
			quarantined: validation.quarantined.length,
		});
		succeeded++;
		pendingCommits.push(() => source.commitFetchState?.());
		for (const item of validation.quarantined) {
			wakeStateStore.recordQuarantine({
				sourceId: item.sourceId,
				itemId: item.itemId,
				reason: item.reason,
				payload: item.payload,
				commit: false,
			});
		}
		store.setState(
			`health.source.${id}`,
			JSON.stringify({ ...health, syntheticIdentity: validation.syntheticIdentityCount, diagnostics }),
		);
		for (const item of validation.events) {
			const kind = item.kind ?? "content";
			channels[kind].push(item);
		}
	}
	if (dueSources.length > 0 && succeeded === 0) {
		throw new Error(`all proactive sources failed: ${failures.join(",")}`);
	}
	channels.commit = () => {
		for (const commit of pendingCommits) commit();
	};
	return channels;
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

// ------------------------------------------------------------------
// 近期对话 / 主动消息 / 长期记忆
// ------------------------------------------------------------------

async function readHostSessionMessages(
	runtimePorts: ProactiveRuntimePorts | undefined,
	sessionKey: string,
	now: Date,
	limit: number,
): Promise<readonly ProactiveSessionMessage[] | undefined> {
	const reader = runtimePorts?.session?.recentMessages;
	if (!reader) return undefined;
	return await reader({ sessionKey, limit, now });
}

function formatRecentPassiveConversation(messages: readonly ProactiveSessionMessage[]): string {
	return messages
		.filter((message) => message.role === "user" || message.role === "assistant")
		.slice(-20)
		.map((message) => `${message.role}: ${message.content.slice(0, 300)}`)
		.join("\n")
		.slice(0, 3000);
}

function formatRecentProactiveMessages(messages: readonly ProactiveSessionMessage[]): string {
	return messages
		.filter((message) => message.role === "assistant" && message.proactive === true)
		.slice(-30)
		.map((message) => message.content.slice(0, 500))
		.join("\n")
		.slice(0, 8000);
}

function readRecentPassiveConversation(sessionsDir: string, _now: Date): string {
	const lines: string[] = [];
	collectSessionMessages(sessionsDir, (role, content) => {
		if (lines.length < 20) lines.push(`${role}: ${content.slice(0, 300)}`);
	});
	return lines.slice(-20).join("\n").slice(0, 3000);
}

function listSessionFiles(sessionsDir: string): string[] {
	const files: string[] = [];
	try {
		for (const name of readdirSync(sessionsDir)) {
			const full = join(sessionsDir, name);
			if (name.endsWith(".jsonl")) files.push(full);
			else if (statSync(full).isDirectory()) {
				for (const inner of readdirSync(full)) {
					if (inner.endsWith(".jsonl")) files.push(join(full, inner));
				}
			}
		}
	} catch {
		return [];
	}
	return files;
}

/** 最近会话的 user→assistant 消息对(同文件内配对,按时间全局排序)。 */
function sessionTurnPairs(sessionsDir: string, _now: Date): Array<{ user: string; assistant: string }> {
	const pairs: Array<{ user: string; assistant: string; ts: number }> = [];
	for (const file of listSessionFiles(sessionsDir)) {
		let text: string;
		try {
			text = readFileSync(file, "utf-8");
		} catch {
			continue;
		}
		let pendingUser: { content: string; ts: number } | null = null;
		for (const line of text.split("\n")) {
			if (!line.trim()) continue;
			try {
				const entry = JSON.parse(line) as {
					type?: string;
					message?: { role?: string; content?: unknown; timestamp?: string };
				};
				const message = entry.message;
				if (entry.type !== "message" || !message) continue;
				const role = message.role;
				const content = extractText(message.content);
				if (!content) continue;
				const parsed = Date.parse(String(message.timestamp ?? ""));
				const ts = Number.isFinite(parsed) ? parsed : 0;
				if (role === "user") {
					pendingUser = { content, ts };
				} else if (role === "assistant" && pendingUser !== null) {
					pairs.push({ user: pendingUser.content, assistant: content, ts: pendingUser.ts });
					pendingUser = null;
				}
			} catch {
				// 坏行跳过。
			}
		}
	}
	pairs.sort((a, b) => a.ts - b.ts);
	// 文本截断,控制单批嵌入开销(bge-m3 单条 8192 token 上限)。
	return pairs.map((pair) => ({ user: pair.user.slice(0, 1500), assistant: pair.assistant.slice(0, 1500) }));
}

/** 会话变更签名(原型向量缓存失效用):文件数 + 最大 mtime。 */
function sessionSignature(sessionsDir: string): string {
	let latest = 0;
	let count = 0;
	for (const file of listSessionFiles(sessionsDir)) {
		try {
			const stat = statSync(file);
			latest = Math.max(latest, stat.mtimeMs);
			count++;
		} catch {
			// 文件被删,跳过。
		}
	}
	return `${count}:${Math.round(latest)}`;
}

function collectSessionMessages(sessionsDir: string, onMessage: (role: string, content: string) => void): void {
	const files = listSessionFiles(sessionsDir);
	for (const file of files) {
		let text: string;
		try {
			text = readFileSync(file, "utf-8");
		} catch {
			continue;
		}
		for (const line of text.split("\n")) {
			if (!line.trim()) continue;
			try {
				const entry = JSON.parse(line) as {
					type?: string;
					message?: { role?: string; content?: unknown; timestamp?: string };
				};
				const message = entry.message;
				if (entry.type !== "message" || !message) continue;
				const role = message.role;
				if (role !== "user" && role !== "assistant") continue;
				const content = extractText(message.content);
				if (!content) continue;
				onMessage(role, content);
			} catch {
				// 坏行跳过。
			}
		}
	}
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (Array.isArray(content)) {
		return content
			.filter((part): part is { type: string; text?: string } => typeof part === "object" && part !== null)
			.map((part) => (part.type === "text" ? (part.text ?? "") : ""))
			.join(" ")
			.trim();
	}
	return "";
}

function readRecentProactiveMessages(store: ProactiveStore, now: Date): string {
	const cutoff = now.getTime() - 7 * 86_400_000;
	const rows = store.listDeliveries(30).filter((row) => row.delivered_at >= cutoff);
	const selected: string[] = [];
	let usedChars = 0;
	for (const row of rows) {
		const line = `${new Date(row.delivered_at).toISOString()} | session=${row.session_key} | assistant(proactive): ${row.message.slice(0, 500)}`;
		const remaining = 8000 - usedChars;
		if (remaining <= 0) break;
		if (line.length > remaining) {
			if (selected.length > 0) break;
			selected.push(line.slice(0, remaining));
			break;
		}
		selected.push(line);
		usedChars += line.length + 1;
	}
	return selected.reverse().join("\n");
}

function readLongTermMemory(memoryDbPath: string): string {
	try {
		const records = recallPreferences(memoryDbPath);
		return records.map((record) => `- ${record.summary}`).join("\n");
	} catch {
		return "";
	}
}

// ------------------------------------------------------------------
// OpenAI-compatible chat
// ------------------------------------------------------------------

export interface ChatMessageLike {
	role: string;
	content: string;
}

export interface ChatToolLike {
	type: "function";
	function: { name: string; description: string; parameters: Record<string, unknown> };
}

async function openaiChat(options: {
	messages: ChatMessageLike[];
	tools: ChatToolLike[];
	toolChoice: "required" | "auto" | { type: "function"; function: { name: string } };
	model: string;
	baseUrl: string;
	apiKey: string;
	maxTokens: number;
	requestTimeoutMs?: number;
}): Promise<{
	content: string | null;
	toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>;
}> {
	const client = new OpenAICompatibleChatClient({
		model: options.model,
		baseUrl: options.baseUrl,
		apiKey: options.apiKey,
		requestTimeoutMs: options.requestTimeoutMs,
	});
	const response = await client.complete({
		messages: options.messages.map(toChatMessage),
		tools: options.tools.map(toChatTool),
		toolChoice: toChatToolChoice(options.toolChoice),
		maxTokens: options.maxTokens,
		temperature: 0,
	});
	return {
		content: response.content || null,
		toolCalls: response.toolCalls
			.map((call) => ({ name: call.name, arguments: parseToolArguments(call.arguments) }))
			.filter((call) => call.name),
	};
}

function toChatMessage(message: ChatMessageLike): ChatCompletionMessage {
	if (message.role === "system" || message.role === "user") {
		return { role: message.role, content: message.content };
	}
	return { role: "user", content: message.content };
}

function toChatTool(tool: ChatToolLike): ChatCompletionTool {
	return {
		name: tool.function.name,
		description: tool.function.description,
		parameters: tool.function.parameters,
	};
}

function toChatToolChoice(
	choice: "required" | "auto" | { type: "function"; function: { name: string } },
): ChatCompletionToolChoice {
	return choice;
}

function parseToolArguments(value: string | Record<string, unknown>): Record<string, unknown> {
	if (typeof value !== "string") return value;
	try {
		const parsed = JSON.parse(value) as unknown;
		return isRecord(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

function dbPathDir(dbPath: string): string {
	const lastSlash = Math.max(dbPath.lastIndexOf("/"), dbPath.lastIndexOf("\\"));
	return lastSlash >= 0 ? dbPath.slice(0, lastSlash) : ".";
}
