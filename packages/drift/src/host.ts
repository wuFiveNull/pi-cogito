/**
 * pi-host adapters for drift.
 *
 * Builds the drift LLM seam and session-context readers from pi-host services
 * (ModelRuntime auth + streaming, SessionManager reads), so drift runs on the
 * host agent runtime instead of its own endpoint configuration.
 */

import type { Message, Model, Tool } from "@cogito/ai";
import type { ModelRuntime, SessionManager, SessionMessageEntry } from "@cogito/host";
import type { DriftLlmFn } from "./runtime.ts";

/** Options for {@link createHostDriftLlmFn}. */
export interface HostDriftLlmOptions {
	modelRuntime: ModelRuntime;
	model: Model<any>;
	/** Max tokens per call. Default: 2048. */
	maxTokens?: number;
}

function schemaToTool(schema: Record<string, unknown>): Tool {
	const fn = (schema as { function?: { name?: string; description?: string; parameters?: unknown } }).function;
	return {
		name: typeof fn?.name === "string" ? fn.name : "unknown",
		description: typeof fn?.description === "string" ? fn.description : "",
		parameters: (fn?.parameters ?? { type: "object", properties: {} }) as Tool["parameters"],
	};
}

/**
 * DriftLlmFn built on pi-host's ModelRuntime: auth resolution and streaming
 * are handled by the host (streamSimple), replacing the config-based
 * OpenAI-compatible endpoint.
 */
export function createHostDriftLlmFn(options: HostDriftLlmOptions): DriftLlmFn {
	const { modelRuntime, model, maxTokens = 2048 } = options;
	return async (messages, schemas, _toolChoice, systemPrompt) => {
		const response = await modelRuntime.streamSimple(
			model,
			{
				systemPrompt,
				messages: messages as unknown as Message[],
				tools: schemas.map(schemaToTool),
			},
			{ maxTokens, temperature: 0 },
		);
		const message = await response.result();
		const call = message.content.find((part) => part.type === "toolCall");
		if (!call) return null;
		return { id: call.id, name: call.name, input: call.arguments as Record<string, unknown> };
	};
}

/** Options for {@link createHostRecentChatFn}. */
export interface HostRecentChatOptions {
	sessionManager: SessionManager;
	/** Maximum number of recent chat rows. Default: 5. */
	limit?: number;
}

/**
 * recentChatFn built on pi-host's SessionManager: reads the current session
 * branch and renders the last rows for the drift runtime context frame.
 */
export function createHostRecentChatFn(
	options: HostRecentChatOptions,
): () => Promise<Array<{ role: string; content: string; proactive?: boolean }>> {
	const { sessionManager, limit = 5 } = options;
	return async () => {
		try {
			// Raw branch walk: compaction entries are filtered out below, so the
			// headless host only needs getBranch() (no runtime pi-host import).
			const branch = sessionManager.getBranch();
			const rows: Array<{ role: string; content: string; proactive?: boolean }> = [];
			for (const entry of branch) {
				if (entry.type !== "message") continue;
				const message = (entry as SessionMessageEntry).message as unknown as {
					role?: string;
					content?: unknown;
				};
				const parts = Array.isArray(message.content) ? message.content : [];
				const content = parts
					.filter((part) => typeof part === "object" && part !== null && "type" in part && part.type === "text")
					.map((part) => String((part as { text?: unknown }).text ?? ""))
					.join("");
				if (!content) continue;
				rows.push({
					role: message.role === "assistant" ? "assistant" : "user",
					content,
				});
			}
			return rows.slice(-limit);
		} catch {
			return [];
		}
	};
}
