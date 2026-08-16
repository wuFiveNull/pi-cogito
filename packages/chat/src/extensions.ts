/**
 * Chat extensions — per-session inline extensions and the resource loader.
 *
 * Every chat session gets its own DefaultResourceLoader (matching the legacy
 * cogito-gateway behavior) with:
 * - chat inline extensions: memory retrieval injection (context event) and the
 *   chat tool set (message_push, web, memory, messages, schedule);
 * - optional chat extension directory (registerTool / lifecycle events);
 * - optional persona appended to the system prompt.
 */

import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { AgentMessage } from "@cogito/agent-core";
import type { TextContent } from "@cogito/ai";
import {
	createSubagentExtension,
	DefaultResourceLoader,
	type ExtensionFactory,
	type InlineExtension,
	type ResourceLoader,
	type SettingsManager,
	SubagentManager,
	type SubagentRunner,
	type ToolDefinition,
} from "@cogito/host";
import type { ChatMemory } from "./memory.ts";
import type { ChatSessionScope } from "./session-pool.ts";

export interface ChatExtensionsOptions {
	projectDir: string;
	agentDir: string;
	settingsManager: SettingsManager;
	scope: ChatSessionScope;
	memory?: ChatMemory;
	chatTools: ToolDefinition[];
	extensionsDir?: string;
	persona?: string;
	/** 每轮注入 memory/*.md 稳定档案(SELF/MEMORY/RECENT_CONTEXT)。默认 true。 */
	injectMemoryProfile?: boolean;
	/**
	 * Shared sub-agent runner. When provided, each session gets its own
	 * SubagentManager (concurrency cap applies per conversation) and the
	 * spawn / spawn_manage tools are registered.
	 */
	subagentRunner?: SubagentRunner;
}

/** Build the per-session resource loader with chat inline extensions. */
export async function createChatResourceLoader(options: ChatExtensionsOptions): Promise<ResourceLoader> {
	const additionalExtensionPaths: string[] = [];
	if (options.extensionsDir) {
		const dir = isAbsolute(options.extensionsDir)
			? options.extensionsDir
			: join(options.agentDir, options.extensionsDir);
		additionalExtensionPaths.push(dir);
	}
	const extensionFactories: InlineExtension[] = [];
	if (options.memory) {
		extensionFactories.push({
			name: "chat-memory-injection",
			hidden: true,
			factory: createMemoryInjectionExtension(options.memory, options.scope, {
				agentDir: options.agentDir,
				injectProfile: options.injectMemoryProfile !== false,
			}),
		});
	}
	if (options.chatTools.length > 0) {
		extensionFactories.push({
			name: "chat-tools",
			hidden: true,
			factory: createChatToolsExtension(options.chatTools),
		});
	}
	if (options.subagentRunner) {
		extensionFactories.push(
			createSubagentExtension({
				manager: new SubagentManager({ runner: options.subagentRunner }),
			}),
		);
	}
	const loader = new DefaultResourceLoader({
		cwd: options.projectDir,
		agentDir: options.agentDir,
		settingsManager: options.settingsManager,
		additionalExtensionPaths,
		extensionFactories,
		...(options.persona ? { appendSystemPrompt: [options.persona] } : {}),
	});
	await loader.reload();
	return loader;
}

/** Register already-built chat tool definitions on the session. */
function createChatToolsExtension(tools: ToolDefinition[]): ExtensionFactory {
	return (pi) => {
		for (const tool of tools) pi.registerTool(tool);
	};
}

/**
 * Inject a scoped memory recall block before each provider request.
 *
 * The stable profile block (SELF.md → MEMORY.md → RECENT_CONTEXT.md, mirroring
 * the akashic per-turn priority: self model → long-term memory → recent
 * context) is read from agentDir/memory on every context event; missing files
 * are skipped. The vector recall block is appended after it. Retrieval runs
 * once per distinct user query (cached for the rest of the turn's tool loop);
 * the combined block is appended to the last user message, or prepended as a
 * system message during tool loops.
 */
function createMemoryInjectionExtension(
	memory: ChatMemory,
	scope: ChatSessionScope,
	options: { agentDir: string; injectProfile: boolean },
): ExtensionFactory {
	return (pi) => {
		let lastQuery = "";
		let cachedBlock = "";
		pi.on("context", async (event) => {
			if (event.type !== "context") return;
			const query = lastUserText(event.messages);
			if (query.length === 0) return;
			if (query !== lastQuery) {
				lastQuery = query;
				try {
					cachedBlock = await memory.recallBlock(query, scope);
				} catch {
					cachedBlock = "";
				}
			}
			const stableBlock = options.injectProfile ? buildStableMemoryBlock(options.agentDir) : "";
			const fullBlock = [stableBlock, cachedBlock].filter((part) => part.trim().length > 0).join("\n\n");
			if (fullBlock.length === 0) return;
			const messages = event.messages;
			const targetIndex = lastUserIndex(messages);
			if (targetIndex < 0) return;
			const target = messages[targetIndex];
			if (!isUserMessage(target)) return;
			messages[targetIndex] = appendToUserMessage(target, fullBlock);
			return { messages };
		});
	};
}

/**
 * Build the stable memory profile block from agentDir/memory/*.md.
 *
 * Order matches akashic prompt-block priority: SELF.md (full) → MEMORY.md
 * (full; maintained by the 18h optimizer so it is naturally stable) →
 * RECENT_CONTEXT.md (Compression + Ongoing Threads only, Recent Turns is
 * trimmed because it duplicates the sliding window).
 */
export function buildStableMemoryBlock(agentDir: string): string {
	const parts: string[] = [];
	const self = readOptionalText(join(agentDir, "memory", "SELF.md"));
	if (self) parts.push(`## 自我认知\n\n${self}`);
	const memory = readOptionalText(join(agentDir, "memory", "MEMORY.md"));
	if (memory) parts.push(`## 长期记忆\n\n${memory}`);
	const recent = trimRecentTurns(readOptionalText(join(agentDir, "memory", "RECENT_CONTEXT.md")));
	if (recent) parts.push(`## 近期语境\n\n${recent}`);
	return parts.join("\n\n");
}

/** Remove the "## Recent Turns" tail (duplicates the live sliding window). */
export function trimRecentTurns(text: string | undefined): string {
	if (!text) return "";
	const marker = "\n## Recent Turns";
	let cut = text.indexOf(marker);
	if (cut < 0 && text.trimStart().startsWith("## Recent Turns")) cut = 0;
	return cut >= 0 ? text.slice(0, cut).trim() : text.trim();
}

function readOptionalText(path: string): string | undefined {
	try {
		const text = readFileSync(path, "utf-8").trim();
		return text.length > 0 ? text : undefined;
	} catch {
		return undefined;
	}
}

function lastUserText(messages: AgentMessage[]): string {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== "user") continue;
		const content = message.content;
		if (typeof content === "string") return content.slice(0, 500);
		if (Array.isArray(content)) {
			const text = content
				.filter((part): part is TextContent => part.type === "text")
				.map((part) => part.text)
				.join(" ")
				.trim();
			if (text.length > 0) return text.slice(0, 500);
		}
	}
	return "";
}

type UserAgentMessage = Extract<AgentMessage, { role: "user" }>;

function isUserMessage(message: AgentMessage): message is UserAgentMessage {
	return message.role === "user";
}

function lastUserIndex(messages: AgentMessage[]): number {
	for (let index = messages.length - 1; index >= 0; index--) {
		if (messages[index].role === "user") return index;
	}
	return -1;
}

function appendToUserMessage(message: UserAgentMessage, block: string): UserAgentMessage {
	const content = message.content;
	if (typeof content === "string") {
		return { ...message, content: `${content}\n\n${block}` };
	}
	if (Array.isArray(content)) {
		return { ...message, content: [...content, { type: "text", text: block }] };
	}
	return { ...message, content: block };
}
