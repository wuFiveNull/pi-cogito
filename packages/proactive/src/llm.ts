/**
 * Shared LLM endpoint resolution for proactive LLM calls (agent tick,
 * message writing, profile distillation).
 *
 * API key resolution order: explicit config key > OPENCODE_API_KEY env >
 * ~/.cogito/agent/auth.json (opencode-go).
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface LlmEndpointConfig {
	model?: string;
	apiBaseUrl?: string;
	apiKey?: string;
}
export function resolveApiKey(config?: { apiKey?: string }): string | undefined {
	if (config?.apiKey) return config.apiKey;
	if (process.env.OPENCODE_API_KEY) return process.env.OPENCODE_API_KEY;
	try {
		const authPath = join(homedir(), ".cogito", "agent", "auth.json");
		if (!existsSync(authPath)) return undefined;
		const auth = JSON.parse(readFileSync(authPath, "utf-8")) as Record<string, unknown>;
		const entry = auth["opencode-go"] as { key?: string } | undefined;
		return entry?.key;
	} catch {
		return undefined;
	}
}
