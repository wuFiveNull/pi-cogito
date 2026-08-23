/**
 * 上下文预算闸门(akashic ContextTrimPlan 的 chat 侧等价,host 零改动)。
 *
 * 两个 handler:
 * 1. `context` 事件(每次 LLM 调用前):上下文占用 ≥ hardPercent 时从最旧起
 *    成轮删除消息(不产生悬空 tool 结果、不动最后一条 user),保留最近
 *    keepRecentMessages 条。
 * 2. `before_provider_request` 事件(每次 provider 请求前):形状守卫
 *    (OpenAI 兼容 messages 数组)通过后,按 payload 自身估算 token;
 *    仍超限时按 essentialTools 裁剪工具 schema。
 *
 * 任何异常 → 原样返回(预算闸门永不当掉请求);非 OpenAI 兼容 payload 零影响。
 */

import type { AgentMessage } from "@cogito/agent-core";
import type { ExtensionFactory } from "@cogito/host";
import { CHAT_DEFAULT_TOOLS } from "../config.ts";

export interface ContextBudgetConfig {
	/** 总开关。默认 true。 */
	enabled?: boolean;
	/** 超限阈值(占上下文窗口比例)。默认 0.95。 */
	hardPercent?: number;
	/** 消息裁剪后保留的最近条数。默认 40。 */
	keepRecentMessages?: number;
	/** 工具裁剪的保留集。默认 CHAT_DEFAULT_TOOLS。 */
	essentialTools?: string[];
}

const DEFAULT_HARD_PERCENT = 0.95;
const DEFAULT_KEEP_RECENT_MESSAGES = 40;
const ESTIMATED_IMAGE_CHARS = 4800;

export interface ContextBudgetExtensionOptions {
	config: ContextBudgetConfig;
	log?: (message: string) => void;
}

export function createContextBudgetExtension(options: ContextBudgetExtensionOptions): ExtensionFactory {
	const config = options.config;
	const log = options.log ?? (() => undefined);
	if (config.enabled === false) {
		return () => undefined;
	}
	const hardPercent = config.hardPercent ?? DEFAULT_HARD_PERCENT;
	const keepRecent = config.keepRecentMessages ?? DEFAULT_KEEP_RECENT_MESSAGES;
	const essentialTools = new Set(config.essentialTools ?? [...CHAT_DEFAULT_TOOLS]);

	return (pi) => {
		pi.on("context", async (event, ctx) => {
			if (event.type !== "context") return;
			try {
				const usage = ctx.getContextUsage?.();
				if (!usage || usage.percent === null || usage.percent < hardPercent) return;
				const trimmed = trimMessages(event.messages, keepRecent);
				if (trimmed.length === event.messages.length) return;
				log(
					`budget: context ${Math.round(usage.percent * 100)}% >= ${Math.round(hardPercent * 100)}%, trimmed messages ${event.messages.length} -> ${trimmed.length}`,
				);
				return { messages: trimmed };
			} catch (error) {
				log(`budget: context handler failed: ${error instanceof Error ? error.message : String(error)}`);
				return undefined;
			}
		});

		pi.on("before_provider_request", async (event) => {
			try {
				const payload = event.payload;
				if (!isOpenAiCompatiblePayload(payload)) return undefined;
				const contextWindow = payloadContextWindow(event.payload);
				if (contextWindow <= 0) return undefined;
				const estimated = estimatePayloadTokens(payload);
				if (estimated < hardPercent * contextWindow) return undefined;
				const tools = payload.tools ?? [];
				if (tools.length === 0) return undefined;
				const trimmedTools = trimTools(tools, essentialTools);
				if (trimmedTools.length === tools.length) return undefined;
				log(
					`budget: payload ~${estimated} tokens >= ${Math.round(hardPercent * 100)}% window, trimmed tools ${tools.length} -> ${trimmedTools.length}`,
				);
				return { ...payload, tools: trimmedTools };
			} catch (error) {
				log(
					`budget: before_provider_request handler failed: ${error instanceof Error ? error.message : String(error)}`,
				);
				return undefined;
			}
		});
	};
}

// ---------------------------------------------------------------------------
// 消息裁剪(从最旧起成轮删除)
// ---------------------------------------------------------------------------

/** 按轮删除最旧消息,保留最近 keepRecent 条;不动最后一条消息。 */
export function trimMessages(messages: AgentMessage[], keepRecent: number): AgentMessage[] {
	const target = Math.max(2, keepRecent);
	if (messages.length <= target) return messages;
	const result = [...messages];
	while (result.length > target) {
		const unit = nextRemovableUnit(result);
		if (!unit) break;
		// 永不删除最后一条消息(通常是当前 user 输入)。
		if (unit.start + unit.count >= result.length) break;
		result.splice(unit.start, unit.count);
	}
	return result;
}

function nextRemovableUnit(messages: AgentMessage[]): { start: number; count: number } | undefined {
	for (let i = 0; i < messages.length; i++) {
		const message = messages[i];
		if (message.role === "user") {
			// 整轮:user + 其后所有非 user 消息(直到下一条 user)。
			let count = 1;
			while (i + count < messages.length && messages[i + count]?.role !== "user") count++;
			return { start: i, count };
		}
		if (message.role === "assistant") {
			const hasToolCalls =
				Array.isArray(message.content) && message.content.some((part) => part.type === "toolCall");
			if (!hasToolCalls) return { start: i, count: 1 };
			// assistant + 紧随的 toolResult 整批,不产生悬空 tool 结果。
			let count = 1;
			while (i + count < messages.length && messages[i + count]?.role === "toolResult") count++;
			return { start: i, count };
		}
		// 悬空的 toolResult(理论异常态):单独移除。
		if (message.role === "toolResult") return { start: i, count: 1 };
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// payload 形状守卫与 token 估算(before_provider_request)
// ---------------------------------------------------------------------------

interface OpenAiCompatiblePayload {
	model?: unknown;
	messages: unknown[];
	tools?: Array<Record<string, unknown>>;
}

function isOpenAiCompatiblePayload(payload: unknown): payload is OpenAiCompatiblePayload {
	if (typeof payload !== "object" || payload === null) return false;
	const record = payload as Record<string, unknown>;
	return Array.isArray(record.messages) && (record.tools === undefined || Array.isArray(record.tools));
}

function payloadContextWindow(payload: unknown): number {
	const record = payload as Record<string, unknown> | undefined;
	if (!record || typeof record !== "object") return 0;
	const value = record.contextWindow;
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** 估算 payload 总 token:systemPrompt + 消息 + 工具 schema(字符/4,图片按 4800)。 */
export function estimatePayloadTokens(payload: OpenAiCompatiblePayload): number {
	let chars = 0;
	const record = payload as unknown as Record<string, unknown>;
	if (typeof record.systemPrompt === "string") chars += record.systemPrompt.length;
	for (const message of payload.messages) {
		if (typeof message !== "object" || message === null) continue;
		const recordMessage = message as Record<string, unknown>;
		const content = recordMessage.content;
		chars += contentChars(content);
	}
	for (const tool of payload.tools ?? []) {
		chars += toolChars(tool);
	}
	return Math.ceil(chars / 4);
}

function contentChars(content: unknown): number {
	if (typeof content === "string") return content.length;
	if (!Array.isArray(content)) return 0;
	let chars = 0;
	for (const part of content) {
		if (typeof part !== "object" || part === null) continue;
		const record = part as Record<string, unknown>;
		if (record.type === "text" && typeof record.text === "string") chars += record.text.length;
		else if (record.type === "image") chars += ESTIMATED_IMAGE_CHARS;
	}
	return chars;
}

function toolFunction(tool: Record<string, unknown>): Record<string, unknown> | undefined {
	const fn = tool.function;
	return typeof fn === "object" && fn !== null && !Array.isArray(fn) ? (fn as Record<string, unknown>) : undefined;
}

function toolChars(tool: Record<string, unknown>): number {
	let chars = 0;
	const fn = toolFunction(tool);
	const name = typeof tool.name === "string" ? tool.name : fn?.name;
	if (typeof name === "string") chars += name.length;
	const description = typeof tool.description === "string" ? tool.description : fn?.description;
	if (typeof description === "string") chars += description.length;
	const parameters =
		typeof tool.parameters === "object" && tool.parameters !== null ? tool.parameters : fn?.parameters;
	if (typeof parameters === "string") chars += parameters.length;
	else if (typeof parameters === "object" && parameters !== null) {
		try {
			chars += JSON.stringify(parameters).length;
		} catch {
			// 不可序列化时忽略。
		}
	}
	return chars;
}

/** 工具裁剪:只保留 essentialTools 内的工具名(兼容 {name} 与 {function:{name}} 两种形状)。 */
export function trimTools(
	tools: Array<Record<string, unknown>>,
	essential: ReadonlySet<string>,
): Array<Record<string, unknown>> {
	const kept: Array<Record<string, unknown>> = [];
	for (const tool of tools) {
		const fn = toolFunction(tool);
		const name = typeof tool.name === "string" ? tool.name : fn?.name;
		if (typeof name === "string" && essential.has(name)) kept.push(tool);
	}
	return kept;
}
