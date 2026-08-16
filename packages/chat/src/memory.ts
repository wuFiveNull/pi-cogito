/**
 * ChatMemory — long-term memory for chat conversations.
 *
 * Wraps the host MemoryEngine (agentDir/memory/memory.sqlite) and exposes
 * recall blocks for per-turn injection plus the memorize/recall/forget tools.
 * MemoryScope {channel, chatId} keeps memories isolated per conversation.
 */

import { createMemoryEngine, type MemoryEngine, type MemoryHit, type MemoryScope, type MemoryType } from "@cogito/host";

export interface ChatMemoryOptions {
	enabled?: boolean;
	agentDir: string;
	dbPath?: string;
	log?: (message: string) => void;
}

export class ChatMemory {
	readonly engine: MemoryEngine;

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

	/** Retrieve hits for a query scoped to a conversation (hard scope match). */
	async recall(query: string, scope?: MemoryScope): Promise<MemoryHit[]> {
		return this.engine.retriever.retrieve(query, scope ? { scope, requireScopeMatch: true } : {});
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
	}): Promise<string> {
		const result = await this.engine.memorizer.saveItemWithSupersede({
			summary: options.summary,
			memoryType: options.memoryType ?? "event",
			scope: options.scope,
			sourceRef: options.sourceRef,
		});
		// saveItemWithSupersede returns "new:<id>" / "reinforced:<id>" / "merged:<id>".
		const colon = result.indexOf(":");
		return colon > 0 ? result.slice(colon + 1) : result;
	}

	/** Forget (soft-delete) items by id. */
	forget(ids: readonly string[]): { affected: string[]; missing: string[] } {
		return this.engine.store.deleteItems(ids);
	}

	close(): void {
		this.engine.close();
	}
}
