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

import { isAbsolute, join } from "node:path";
import type { AgentMessage } from "@cogito/agent-core";
import type { TextContent } from "@cogito/ai";
import {
	DefaultResourceLoader,
	type ExtensionFactory,
	type InlineExtension,
	type ResourceLoader,
	type SettingsManager,
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
			factory: createMemoryInjectionExtension(options.memory, options.scope),
		});
	}
	if (options.chatTools.length > 0) {
		extensionFactories.push({
			name: "chat-tools",
			hidden: true,
			factory: createChatToolsExtension(options.chatTools),
		});
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
 * Retrieval runs once per distinct user query (cached for the rest of the
 * turn's tool loop); the block is appended to the last user message, or
 * prepended as a system message during tool loops.
 */
function createMemoryInjectionExtension(memory: ChatMemory, scope: ChatSessionScope): ExtensionFactory {
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
			if (cachedBlock.length === 0) return;
			const messages = event.messages;
			const targetIndex = lastUserIndex(messages);
			if (targetIndex < 0) return;
			const target = messages[targetIndex];
			if (!isUserMessage(target)) return;
			messages[targetIndex] = appendToUserMessage(target, cachedBlock);
			return { messages };
		});
	};
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
