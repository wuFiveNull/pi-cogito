/**
 * OpenAI 兼容的 MemoryLlm 实现(记忆优化/提取共用)。
 */

import { type ChatCompletionClient, OpenAICompatibleChatClient } from "@cogito/ai/chat";
import type { MemoryLlm } from "./optimizer.ts";

export interface OpenaiTextLlmOptions {
	model: string;
	baseUrl: string;
	apiKey?: string;
	requestTimeoutMs?: number;
	maxRetries?: number;
	/** Optional shared runtime role client, including fallback policy. */
	client?: ChatCompletionClient;
}

/** 单轮文本补全(非流式)。失败抛错,由调用方决定降级策略。 */
export function openaiTextLlm(options: OpenaiTextLlmOptions): MemoryLlm {
	const client =
		options.client ??
		new OpenAICompatibleChatClient({
			model: options.model,
			baseUrl: options.baseUrl,
			apiKey: options.apiKey,
			requestTimeoutMs: options.requestTimeoutMs,
			maxRetries: options.maxRetries,
		});
	return {
		chat: async (system, user, maxTokens) => {
			const response = await client.complete({
				messages: [
					{ role: "system", content: system },
					{ role: "user", content: user },
				],
				maxTokens,
				temperature: 0,
			});
			if (!response.content) throw new Error("chat empty response");
			return response.content;
		},
	};
}
