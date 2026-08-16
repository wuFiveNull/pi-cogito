import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CredentialStore } from "@cogito/ai";
import { createNodeSqliteFactory } from "@cogito/storage-sqlite-node";
import { getLoadablePath } from "sqlite-vec";
import { afterEach, describe, expect, it } from "vitest";
import { JsonlSessionIndexer, type TextEmbedder } from "../src/core/session-index/jsonl-indexer.ts";
import { createSessionIndexer, SessionIndexSearcher } from "../src/core/session-index/setup.ts";

function fakeCredentials(): CredentialStore {
	return {
		read: async () => ({ type: "api_key", key: "fake-key" }),
		list: async () => [],
		modify: async (_providerId, fn) => fn({ type: "api_key", key: "fake-key" }),
		delete: async () => {},
	};
}

const tempDirs: string[] = [];

function createAgentDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-session-index-setup-"));
	tempDirs.push(dir);
	mkdirSync(join(dir, "sessions"), { recursive: true });
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("createSessionIndexer", () => {
	it("wires the built-in embedding model when models.json has none", async () => {
		const agentDir = createAgentDir();
		const { indexer, searcher, embeddingModel } = await createSessionIndexer({
			agentDir,
			credentials: fakeCredentials(),
		});
		await using _ = indexer;

		expect(embeddingModel).toMatchObject({ id: "BAAI/bge-m3", provider: "siliconflow", dimensions: 1024 });
		expect(searcher).toBeInstanceOf(SessionIndexSearcher);
	});

	it("prefers custom embedding models from models.json", async () => {
		const agentDir = createAgentDir();
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					siliconflow: {
						embeddingModels: [{ id: "custom/bge-m3", dimensions: 512 }],
					},
				},
			}),
			"utf-8",
		);
		const { indexer, embeddingModel } = await createSessionIndexer({
			agentDir,
			credentials: fakeCredentials(),
		});
		await using _ = indexer;

		expect(embeddingModel).toMatchObject({ id: "custom/bge-m3", provider: "siliconflow", dimensions: 512 });
	});

	it("searchHits returns entry-level results", async () => {
		const agentDir = createAgentDir();
		writeFileSync(
			join(agentDir, "sessions", "a.jsonl"),
			`${JSON.stringify({
				type: "session",
				version: 3,
				id: "s1",
				timestamp: "2024-01-01T00:00:00.000Z",
				cwd: agentDir,
			})}\n${JSON.stringify({
				type: "message",
				id: "m1",
				parentId: null,
				timestamp: "2024-01-01T00:00:00.000Z",
				message: { role: "user", content: "searchable entry text", timestamp: Date.now() },
			})}\n`,
			"utf-8",
		);
		const { indexer } = await createSessionIndexer({
			agentDir,
			credentials: fakeCredentials(),
		});
		await using _ = indexer;
		const searcher = new SessionIndexSearcher(indexer);

		const hits = await searcher.searchHits("searchable entry", { limit: 10 });
		expect(hits.length).toBe(1);
		expect(hits[0]).toMatchObject({ sessionId: "s1", entryId: "m1", type: "message" });
		expect(hits[0]!.score).toBeTypeOf("number");
	});

	it("runs keyword search through the searcher", async () => {
		const agentDir = createAgentDir();
		writeFileSync(
			join(agentDir, "sessions", "a.jsonl"),
			`${JSON.stringify({
				type: "session",
				version: 3,
				id: "s1",
				timestamp: "2024-01-01T00:00:00.000Z",
				cwd: agentDir,
			})}\n${JSON.stringify({
				type: "message",
				id: "m1",
				parentId: null,
				timestamp: "2024-01-01T00:00:00.000Z",
				message: { role: "user", content: "deploy the search index to production" },
			})}\n`,
			"utf-8",
		);
		// Keyword-only indexer (no vector): searcher aggregates scores per session.
		const embedder: TextEmbedder = { embed: async () => [] };
		const indexer = new JsonlSessionIndexer({
			sqlite: createNodeSqliteFactory(),
			databasePath: join(agentDir, "sessions-index", "sessions.sqlite"),
			sessionsDir: join(agentDir, "sessions"),
			vector: { embedder, dimensions: 3, extensionPath: getLoadablePath() },
			fs: {
				absolutePath: async (path) => path,
				createDir: async (path) => {
					mkdirSync(path, { recursive: true });
				},
				listDir: async (path) => readdirSync(path),
				readTextFile: async (path) => readFileSync(path, "utf-8"),
				stat: async (path) => {
					const stat = statSync(path);
					return { mtimeMs: stat.mtimeMs, size: stat.size };
				},
			},
		});
		await using __ = indexer;
		const searcher = new SessionIndexSearcher(indexer);

		const scores = await searcher.search("search index");
		expect(scores).toBeDefined();
		expect(scores!.get("s1")).toBeTypeOf("number");
		expect(await searcher.search("zzz-no-match")).toEqual(new Map());
	});
});
