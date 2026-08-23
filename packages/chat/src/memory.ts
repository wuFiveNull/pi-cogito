/**
 * ChatMemory — long-term memory for chat conversations.
 *
 * Wraps the host MemoryEngine (agentDir/memory/memory.sqlite) and exposes
 * recall blocks for per-turn injection plus the memorize/recall/forget tools.
 * MemoryScope {channel, chatId} keeps memories isolated per conversation.
 */

import { EventEmitter } from "node:events";

import {
	createMemoryEngine,
	type MemoryEngine,
	type MemoryHit,
	type MemoryQueryIntent,
	type MemoryScope,
	type MemoryType,
	type PostResponseLlm,
} from "@cogito/host";

export interface ChatMemoryOptions {
	enabled?: boolean;
	agentDir: string;
	dbPath?: string;
	log?: (message: string) => void;
}

/** 记忆写入事件(akashic MemoryWritten 的 chat 内形态):驱动 recall 缓存失效。 */
export interface MemoryWrittenEvent {
	scope: MemoryScope | undefined;
	ids: string[];
	action: "remember" | "forget";
}

export class ChatMemory {
	readonly engine: MemoryEngine;

	private readonly events = new EventEmitter();

	private constructor(engine: MemoryEngine) {
		this.engine = engine;
	}

	/** Create the engine; returns undefined when disabled or unavailable (keyword-only fallback). */
	static async create(options: ChatMemoryOptions): Promise<ChatMemory | undefined> {
		if (options.enabled === false) return undefined;
		try {
			const engine = await createMemoryEngine({
				agentDir: options.agentDir,
				dbPath: options.dbPath,
			});
			return new ChatMemory(engine);
		} catch (error) {
			options.log?.(`memory engine unavailable: ${error instanceof Error ? error.message : String(error)}`);
			return undefined;
		}
	}

	/** Subscribe to memory writes; returns an unsubscribe function. */
	onMemoryWritten(listener: (event: MemoryWrittenEvent) => void): () => void {
		this.events.on("memory_written", listener);
		return () => {
			this.events.off("memory_written", listener);
		};
	}

	/** Retrieve hits for a query scoped to a conversation (hard scope match). */
	async recall(
		query: string,
		scope?: MemoryScope,
		options?: { intent?: MemoryQueryIntent; hypothesisLlm?: PostResponseLlm },
	): Promise<MemoryHit[]> {
		return this.engine.retriever.retrieve(query, {
			...(scope ? { scope, requireScopeMatch: true } : {}),
			intent: options?.intent,
			hypothesisLlm: options?.hypothesisLlm,
		});
	}

	/** Retrieve and format the per-turn injection block. */
	async recallBlock(query: string, scope?: MemoryScope): Promise<string> {
		const hits = await this.recall(query, scope);
		if (hits.length === 0) return "";
		return this.engine.retriever.buildInjectionBlock(hits).text;
	}

	/** Remember an item (with supersede/merge semantics); returns the raw item id. */
	async remember(options: {
		summary: string;
		memoryType?: MemoryType;
		scope?: MemoryScope;
		sourceRef?: string;
		extra?: Record<string, unknown>;
		happenedAt?: string;
	}): Promise<string> {
		const result = await this.engine.memorizer.saveItemWithSupersede({
			summary: options.summary,
			memoryType: options.memoryType ?? "event",
			scope: options.scope,
			sourceRef: options.sourceRef,
			extra: options.extra,
			happenedAt: options.happenedAt,
		});
		// saveItemWithSupersede returns "new:<id>" / "reinforced:<id>" / "merged:<id>".
		const colon = result.indexOf(":");
		const id = colon > 0 ? result.slice(colon + 1) : result;
		this.events.emit("memory_written", {
			scope: options.scope,
			ids: [id],
			action: "remember",
		} satisfies MemoryWrittenEvent);
		return id;
	}

	/** Forget (soft-delete) items by id. */
	forget(ids: readonly string[]): { affected: string[]; missing: string[] } {
		const result = this.engine.store.deleteItems(ids);
		if (result.affected.length > 0) {
			this.events.emit("memory_written", {
				scope: undefined,
				ids: result.affected,
				action: "forget",
			} satisfies MemoryWrittenEvent);
		}
		return result;
	}

	/**
	 * 过程记忆匹配(akashic keyword_match_procedures 的 chat 侧近似):
	 * 按工具名+参数检索 procedure,命中 extra.trigger_tags 的条目返回。
	 * 供工具执行拦截器使用;未命中返回 undefined(原样执行)。
	 */
	async matchProcedure(
		scope: MemoryScope | undefined,
		toolName: string,
		args: unknown,
	): Promise<MemoryHit | undefined> {
		const query = `${toolName} ${summarizeArgs(args)}`.trim().slice(0, 200);
		if (!query) return undefined;
		const hits = await this.recall(query, scope, { intent: "procedure" });
		if (hits.length === 0) return undefined;
		const normalizedQuery = query.toLowerCase().replace(/\s+/g, "");
		for (const hit of hits) {
			const tags = hit.extra?.trigger_tags;
			if (!Array.isArray(tags)) continue;
			for (const tag of tags) {
				if (typeof tag !== "string" || tag.trim().length === 0) continue;
				if (normalizedQuery.includes(normalizeTag(tag))) return hit;
			}
		}
		return undefined;
	}

	close(): void {
		this.events.removeAllListeners();
		this.engine.close();
	}
}

/** 参数摘要:字符串值拼接,用于检索查询与 trigger 匹配。 */
function summarizeArgs(args: unknown): string {
	if (args === undefined || args === null) return "";
	if (typeof args === "string") return args.slice(0, 200);
	if (typeof args === "number" || typeof args === "boolean") return String(args);
	if (Array.isArray(args)) {
		return args
			.map((item) => summarizeArgs(item))
			.filter(Boolean)
			.join(" ")
			.slice(0, 200);
	}
	if (typeof args === "object") {
		return Object.values(args as Record<string, unknown>)
			.map((value) => summarizeArgs(value))
			.filter(Boolean)
			.join(" ")
			.slice(0, 200);
	}
	return "";
}

function normalizeTag(tag: string): string {
	return tag.trim().toLowerCase().replace(/\s+/g, "");
}
