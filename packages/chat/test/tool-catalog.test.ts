/**
 * Tool catalog acceptance for the real chat tool definitions: the chat memory
 * tools must be discoverable through the host ToolCatalog with Chinese queries.
 */

import { ToolCatalog } from "@cogito/host";
import { describe, expect, it } from "vitest";
import type { ChatMemory } from "../src/memory.ts";
import { createMemoryTools } from "../src/tools/memory-tools.ts";

const memoryStub = {
	remember: async () => "mem-1",
	forget: () => ({ affected: [], missing: [] }),
	recallBlock: async () => "",
} as unknown as ChatMemory;

function chatCatalog(): ToolCatalog {
	const catalog = new ToolCatalog();
	for (const definition of createMemoryTools(memoryStub, { channel: "test", chatId: "1" })) {
		catalog.add({
			name: definition.name,
			label: definition.label,
			description: definition.description,
			...(definition.searchHint ? { searchHint: definition.searchHint } : {}),
			source: "chat",
		});
	}
	return catalog;
}

describe("chat tool catalog", () => {
	it("finds recall_memory and memorize with a Chinese query", () => {
		const catalog = chatCatalog();
		const results = catalog.search("记忆", { limit: 8 });
		const names = results.map((result) => result.name);
		expect(names).toContain("recall_memory");
		expect(names).toContain("memorize");
		expect(names).toContain("forget_memory");
		for (const result of results) {
			expect(result.whyMatched.length).toBeGreaterThan(0);
			expect(result.source).toBe("chat");
		}
	});

	it("carries searchHint on every chat memory tool", () => {
		const definitions = createMemoryTools(memoryStub, { channel: "test", chatId: "1" });
		expect(definitions.map((definition) => definition.name)).toEqual(["memorize", "recall_memory", "forget_memory"]);
		for (const definition of definitions) {
			expect(definition.searchHint?.length).toBeGreaterThan(0);
		}
	});
});
