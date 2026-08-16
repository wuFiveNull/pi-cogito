import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import conflictA from "../examples/extensions/conflict-a.ts";
import conflictB from "../examples/extensions/conflict-b.ts";
import type { ExtensionAPI, ExtensionCommandContext } from "../src/core/extensions/index.ts";
import { ExtensionSqlite } from "../src/core/extensions/sqlite.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type CommandHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;

/** Fake ExtensionAPI collecting registered command handlers. */
function collectHandlers(extension: (pi: ExtensionAPI) => void): Map<string, CommandHandler> {
	const handlers = new Map<string, CommandHandler>();
	const api = {
		registerCommand: (name: string, options: { handler: CommandHandler }) => {
			handlers.set(name, options.handler);
		},
		on: () => {},
		setLabel: () => {},
		setSessionName: () => {},
		getSessionName: () => undefined,
		appendEntry: () => {},
		appendCustomMessageEntry: () => {},
		sendMessage: () => {},
		sendUserMessage: () => {},
		registerTool: () => {},
		registerShortcut: () => {},
	} as unknown as ExtensionAPI;
	extension(api);
	return handlers;
}

function createCommandContext(sqlite: ExtensionSqlite): ExtensionCommandContext {
	const ctx = {
		ui: { notify: () => {} } as unknown as ExtensionCommandContext["ui"],
		mode: "print",
		hasUI: false,
		cwd: process.cwd(),
		sessionManager: {} as ExtensionCommandContext["sessionManager"],
		modelRegistry: {} as ExtensionCommandContext["modelRegistry"],
		sqlite: sqlite.db,
		indexDb: sqlite.indexDbView,
		searchSessions: async () => [],
		model: undefined,
		scopedModels: [],
		isIdle: () => true,
		isProjectTrusted: () => true,
		signal: undefined,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		getContextUsage: () => ({ tokens: 0, contextWindow: 100_000, percent: 0 }),
		compact: () => {},
		getSystemPrompt: () => "",
		args: "",
	} as unknown as ExtensionCommandContext;
	return ctx;
}

describe("shared sqlite conflict between two extensions", () => {
	it("interleaved atomic upserts never lose updates and audit logs distinguish extensions", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-ext-conflict-"));
		tempDirs.push(agentDir);
		const sqlite = ExtensionSqlite.create(agentDir, () => "unknown");
		try {
			const handlersA = collectHandlers(conflictA);
			const handlersB = collectHandlers(conflictB);
			const handlerA = handlersA.get("conflict-a")!;
			const handlerB = handlersB.get("conflict-b")!;
			const ctx = createCommandContext(sqlite);

			// Simulate two extensions interleaving on the shared connection.
			for (let round = 0; round < 3; round++) {
				await handlerA("", ctx);
				await handlerB("", ctx);
			}

			const row = sqlite.db.get("SELECT value FROM test WHERE k = 'shared'");
			expect(row).toEqual({ value: 150 }); // 3 rounds x 2 extensions x 25 increments

			// Audit log: exec (CREATE TABLE) x2 + 150 run entries, with correct ids.
			const counts = sqlite.db.query(
				"SELECT extension_id, op, COUNT(*) AS n FROM _oplog GROUP BY extension_id, op ORDER BY extension_id, op",
			);
			expect(counts).toEqual([
				{ extension_id: "unknown", op: "exec", n: 6 }, // CREATE TABLE per handler invocation
				{ extension_id: "unknown", op: "run", n: 150 },
			]);

			// No error entries were recorded.
			expect(sqlite.db.query("SELECT COUNT(*) AS n FROM _oplog WHERE error IS NOT NULL")).toEqual([{ n: 0 }]);
		} finally {
			sqlite.close();
		}
	});

	it("extensions see each other's committed writes (shared state)", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-ext-conflict-"));
		tempDirs.push(agentDir);
		const sqlite = ExtensionSqlite.create(agentDir);
		try {
			const handlerA = collectHandlers(conflictA).get("conflict-a")!;
			const handlerB = collectHandlers(conflictB).get("conflict-b")!;
			const ctx = createCommandContext(sqlite);

			await handlerA("", ctx);
			const afterA = sqlite.db.get("SELECT value FROM test WHERE k = 'shared'");
			await handlerB("", ctx);
			const afterB = sqlite.db.get("SELECT value FROM test WHERE k = 'shared'");

			expect(afterA).toEqual({ value: 25 });
			expect(afterB).toEqual({ value: 50 });
		} finally {
			sqlite.close();
		}
	});
});
