import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { FileDriftContextProvider } from "../src/context.ts";
import { createDriftContext, type DriftLlmFn, DriftTurnPipeline } from "../src/runtime.ts";
import { DriftStateStore } from "../src/state.ts";
import { buildDriftToolRegistry, type DriftTool, type DriftToolDeps, ShellTool } from "../src/tools.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeDriftDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "drift-test-"));
	tempDirs.push(dir);
	return dir;
}

function writeSkill(
	driftDir: string,
	name: string,
	description: string,
	body = "## 单次闭环\n1. 读取必要上下文。\n2. 执行一个最小动作。\n3. 调用 finish_drift 保存状态。",
): void {
	const dir = join(driftDir, "skills", name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "SKILL.md"),
		`---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${body}`,
		"utf-8",
	);
}

function makeStore(driftDir: string): DriftStateStore {
	return new DriftStateStore({ driftDir });
}

function makeDeps(driftDir: string, store: DriftStateStore): DriftToolDeps {
	return {
		driftDir,
		store,
		workspaceDir: driftDir,
	};
}

type Step =
	| { tool: "select_skill"; args: Record<string, unknown> }
	| { tool: "finish_drift"; args: Record<string, unknown> }
	| { tool: string; args: Record<string, unknown> };

/** Scripted LLM adapter: replays tool calls in order, then returns null. */
function scriptedLlm(steps: Step[]): DriftLlmFn {
	let index = 0;
	return async (_messages, schemas, _toolChoice) => {
		const step = steps[index++];
		if (!step) return null;
		// 阶段约束验证:schemas 必须包含 step.tool。
		const names = schemas.map((schema) => (schema.function as { name: string }).name);
		if (!names.includes(step.tool)) {
			throw new Error(`scripted llm: tool ${step.tool} not in allowed schemas ${names.join(",")}`);
		}
		return { id: `call-${index}`, name: step.tool, input: step.args };
	};
}

/** Extract text from a tool-result message (pi-agent-core content blocks). */
function driftToolResultText(m: Record<string, unknown>): string {
	const content = m.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((part) => typeof part === "object" && part !== null && "type" in part && part.type === "text")
			.map((part) => String((part as { text?: unknown }).text ?? ""))
			.join("\n");
	}
	return "";
}

describe("DriftStateStore (akashic state.py)", () => {
	it("scans skills, skips invalid dirs and sorts by last run", () => {
		const driftDir = makeDriftDir();
		writeSkill(driftDir, "skill-a", "A 活动");
		writeSkill(driftDir, "skill-b", "B 活动");
		mkdirSync(join(driftDir, "skills", "no-frontmatter"), { recursive: true });
		writeFileSync(join(driftDir, "skills", "no-frontmatter", "SKILL.md"), "# 无 frontmatter", "utf-8");
		mkdirSync(join(driftDir, "skills", "mismatch"), { recursive: true });
		writeFileSync(
			join(driftDir, "skills", "mismatch", "SKILL.md"),
			"---\nname: other\ndescription: 名称不匹配目录\n---",
			"utf-8",
		);

		const store = makeStore(driftDir);
		const skills = store.scanSkills();
		expect(skills.map((s) => s.name).sort()).toEqual(["skill-a", "skill-b"]);
	});

	it("parses YAML frontmatter arrays and block descriptions", () => {
		const driftDir = makeDriftDir();
		const skillDir = join(driftDir, "skills", "yaml-skill");
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(
			join(skillDir, "SKILL.md"),
			"---\nname: yaml-skill\ndescription: |\n  多行描述的第一行。\n  第二行说明适用时机。\nrequires_mcp:\n  - server-a\n  - server-b\ncooldown_hours: 2\n---\n",
			"utf-8",
		);

		const skill = makeStore(driftDir).scanSkills()[0];
		expect(skill?.description).toContain("多行描述的第一行");
		expect(skill?.description).toContain("第二行说明适用时机");
		expect(skill?.requiresMcp).toEqual(["server-a", "server-b"]);
		expect(skill?.cooldownHours).toBe(2);
	});

	it("persists continuum, cursor, journal, self_state and runs on save_finish", () => {
		const driftDir = makeDriftDir();
		writeSkill(driftDir, "skill-a", "A 活动");
		const store = makeStore(driftDir);
		const now = new Date("2026-05-01T00:00:00Z");

		store.saveFinish({
			skillUsed: "skill-a",
			status: "paused",
			briefing: "做了一半",
			messageResult: "silent",
			scratchpadUpdate: "下次从第二步继续",
			globalNoteUpdate: null,
			nowUtc: now,
			cursorUpdate: { next_action: "sample", active_id: "m1" },
			journalAppend: [{ entry_type: "memory_audited", key: "m1", payload: { result: "clean" } }],
			selfUpdate: { next_tendency: "下次继续审计", current_intention: "审计记忆" },
		});

		const continuum = store.loadSkillContinuum("skill-a");
		expect(continuum.runCount).toBe(1);
		expect(continuum.lastStatus).toBe("paused");
		expect(continuum.scratchpad).toContain("第二步");
		expect((continuum.cursor as Record<string, unknown>).next_action).toBe("sample");

		const journal = store.loadSkillJournal("skill-a");
		expect(journal.length).toBe(1);
		expect(journal[0]?.entry_type).toBe("memory_audited");
		expect((journal[0]?.payload as Record<string, unknown>).result).toBe("clean");

		const selfState = store.loadSelfState();
		expect(selfState.current_skill).toBe("skill-a");
		expect(selfState.next_tendency).toContain("继续审计");
		expect(selfState.current_intention).toContain("审计记忆");
	});

	it("merges cursor updates and supports deletion via null", () => {
		const driftDir = makeDriftDir();
		writeSkill(driftDir, "skill-a", "A 活动");
		const store = makeStore(driftDir);
		const now = new Date();
		store.saveFinish({
			skillUsed: "skill-a",
			status: "completed",
			briefing: "闭环",
			messageResult: "silent",
			nowUtc: now,
			cursorUpdate: { next_action: "sample" },
			selfUpdate: { next_tendency: "x" },
		});
		store.saveFinish({
			skillUsed: "skill-a",
			status: "completed",
			briefing: "再闭环",
			messageResult: "silent",
			nowUtc: new Date(now.getTime() + 1000),
			cursorUpdate: { next_action: null, active_id: "m2" },
			selfUpdate: { next_tendency: "y" },
		});
		const cursor = store.loadSkillContinuum("skill-a").cursor as Record<string, unknown>;
		expect(cursor.next_action).toBeUndefined();
		expect(cursor.active_id).toBe("m2");
		expect(store.loadSkillContinuum("skill-a").runCount).toBe(2);
	});

	it("builds the drift briefing with skill status and recent runs", () => {
		const driftDir = makeDriftDir();
		writeSkill(driftDir, "skill-a", "A 活动");
		const store = makeStore(driftDir);
		store.saveFinish({
			skillUsed: "skill-a",
			status: "completed",
			briefing: "完成了一次审计",
			messageResult: "silent",
			nowUtc: new Date("2026-05-01T00:00:00Z"),
			selfUpdate: { next_tendency: "x" },
		});
		const skills = store.scanSkills();
		const briefing = store.loadBriefing(skills);
		expect(briefing).toContain("【Drift Briefing】");
		expect(briefing).toContain("skill-a");
		expect(briefing).toContain("completed");
		expect(briefing).toContain("完成了一次审计");
		expect(briefing).toContain("最近 Drift runs");
	});

	it("rejects invalid finish status", () => {
		const driftDir = makeDriftDir();
		writeSkill(driftDir, "skill-a", "A 活动");
		const store = makeStore(driftDir);
		expect(() =>
			store.saveFinish({
				skillUsed: "skill-a",
				status: "waiting",
				briefing: "x",
				messageResult: "silent",
				nowUtc: new Date(),
				selfUpdate: { next_tendency: "x" },
			}),
		).toThrow("drift status must be completed or paused");
	});

	it("persists message_hash on staged runs and markRunMessageSent flips to sent (ack 回写)", () => {
		const driftDir = makeDriftDir();
		writeSkill(driftDir, "skill-a", "A 活动");
		const store = makeStore(driftDir);
		const hash = "deadbeef";
		const now = new Date("2026-05-01T00:00:00Z");

		store.saveFinish({
			skillUsed: "skill-a",
			status: "completed",
			briefing: "推送了一条消息",
			messageResult: "staged",
			nowUtc: now,
			messageHash: hash,
			selfUpdate: { next_tendency: "x" },
		});
		// 另一条 silent run 不带 hash,不应被回写影响。
		store.saveFinish({
			skillUsed: "skill-a",
			status: "completed",
			briefing: "静默闭环",
			messageResult: "silent",
			nowUtc: new Date(now.getTime() + 1000),
			selfUpdate: { next_tendency: "x" },
		});

		const runs = store.loadDrift().recentRuns;
		expect(runs).toHaveLength(2);
		expect(runs[0]?.message_result).toBe("staged");

		// ack 回写前:错误 hash 不生效。
		store.markRunMessageSent("nope");
		expect(store.loadDrift().recentRuns[0]?.message_result).toBe("staged");

		// ack 回写:staged → sent,幂等。
		store.markRunMessageSent(hash);
		store.markRunMessageSent(hash);
		expect(store.loadDrift().recentRuns[0]?.message_result).toBe("sent");
		expect(store.loadDrift().recentRuns[1]?.message_result).toBe("silent");
	});
});

describe("Drift MCP (akashic mcp 支持)", () => {
	it("requires_mcp skills are filtered by connected servers", async () => {
		const driftDir = makeDriftDir();
		const dir = join(driftDir, "skills", "mcp-skill");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "SKILL.md"),
			"---\nname: mcp-skill\ndescription: 需要 MCP 的活动\nrequires_mcp: server-a\n---\n\n# MCP Skill\n\n## 单次闭环\n1. 调用 MCP 工具。\n",
			"utf-8",
		);
		const store = makeStore(driftDir);
		const ctx = createDriftContext("local", new Date());
		const deps = makeDeps(driftDir, store);

		// 无连接:skill 不可用,pipeline 不进入。
		const pipelineNoMcp = new DriftTurnPipeline({ store, toolDeps: deps, maxSteps: 5 });
		const enteredNoMcp = await pipelineNoMcp.run(ctx, scriptedLlm([]));
		expect(enteredNoMcp).toBe(false);

		// server-a 已连接:skill 可用,正常进入并挂载调用。
		deps.mcp = {
			servers: [
				{
					name: "server-a",
					tools: [
						{
							name: "mcp_echo",
							description: "回显",
							parameters: { type: "object", properties: { text: { type: "string" } } },
							call: async (args) => `echo: ${String(args.text ?? "")}`,
						},
					],
				},
			],
		};
		const ctx2 = createDriftContext("local", new Date());
		const pipelineMcp = new DriftTurnPipeline({ store, toolDeps: deps, maxSteps: 5 });
		const enteredMcp = await pipelineMcp.run(
			ctx2,
			scriptedLlm([
				{
					tool: "select_skill",
					args: { skill_name: "mcp-skill", decision: "explore", intention: "i", reason: "r" },
				},
				{ tool: "mount_server", args: { server: "server-a" } },
				{ tool: "mcp_echo", args: { text: "hi" } },
				{
					tool: "finish_drift",
					args: {
						skill_used: "mcp-skill",
						status: "completed",
						briefing: "调用了 MCP 工具",
						self_update: { pattern: "ordinary", reflection: "x", next_tendency: "y" },
					},
				},
			]),
		);
		expect(enteredMcp).toBe(true);
		expect(ctx2.driftFinished).toBe(true);
		expect(store.loadSkillContinuum("mcp-skill").runCount).toBe(1);
	});

	it("mount_server rejects unknown servers and context lists drift_mcp_directory", async () => {
		const driftDir = makeDriftDir();
		writeSkill(driftDir, "skill-a", "A 活动");
		const store = makeStore(driftDir);
		const ctx = createDriftContext("local", new Date());
		const deps = makeDeps(driftDir, store);
		deps.mcp = {
			servers: [{ name: "srv", tools: [{ name: "t1", description: "d", parameters: {}, call: async () => "ok" }] }],
		};

		let sawDirectory = false;
		let sawUnknownRejection = false;
		const llm: DriftLlmFn = async (messages, schemas, _toolChoice, systemPrompt) => {
			const names = schemas.map((schema) => (schema.function as { name: string }).name);
			const systemText = systemPrompt ?? "";
			if (systemText.includes("drift_mcp_directory") && systemText.includes("srv")) sawDirectory = true;
			const toolResults = messages
				.filter((m) => m.role === "toolResult")
				.map((m) => driftToolResultText(m as Record<string, unknown>))
				.join("\n");
			if (toolResults.includes("不存在或未连接")) {
				sawUnknownRejection = true;
				return {
					id: "c4",
					name: "finish_drift",
					input: {
						skill_used: "skill-a",
						status: "completed",
						briefing: "b",
						self_update: { pattern: "ordinary", reflection: "x", next_tendency: "y" },
					},
				};
			}
			if (names.includes("mount_server")) {
				return { id: "c2", name: "mount_server", input: { server: "missing" } };
			}
			return {
				id: "c1",
				name: "select_skill",
				input: { skill_name: "skill-a", decision: "explore", intention: "i", reason: "r" },
			};
		};

		const pipeline = new DriftTurnPipeline({ store, toolDeps: deps, maxSteps: 10 });
		await pipeline.run(ctx, llm);
		expect(sawDirectory).toBe(true);
		expect(sawUnknownRejection).toBe(true);
		expect(ctx.driftFinished).toBe(true);
	});
});

describe("recall memory (akashic memory retriever)", () => {
	it("reranks candidates by embedding cosine similarity and falls back on failure", async () => {
		const driftDir = makeDriftDir();
		writeSkill(driftDir, "skill-a", "A 活动");
		const store = makeStore(driftDir);

		// 造记忆库:两条 LIKE 命中的候选(term: 音乐)。
		const memoryDb = join(driftDir, "memory.sqlite");
		const mdb = new DatabaseSync(memoryDb);
		mdb.exec(`CREATE TABLE memory_items (id TEXT PRIMARY KEY, memory_type TEXT, summary TEXT,
			reinforcement INTEGER, status TEXT, updated_at TEXT);
			INSERT INTO memory_items VALUES ('m1', 'preference', '用户喜欢古典音乐', 3, 'active', '2026-01-01'),
			                                ('m2', 'preference', '用户最近在听电子音乐', 1, 'active', '2026-01-01');`);
		mdb.close();

		const ctx = createDriftContext("local", new Date());
		const deps = makeDeps(driftDir, store);
		deps.memoryDbPath = memoryDb;
		// mock 嵌入:query 与 m2 更相似(query 向量 = m2 向量)。
		deps.memoryEmbeddingFn = async (texts) => {
			const vectors: Record<string, number[]> = {
				电子音乐: [1, 0],
				用户喜欢古典音乐: [0, 1],
				用户最近在听电子音乐: [1, 0],
			};
			return texts.map((text) => vectors[text] ?? [0, 0]);
		};

		let sawRanked = false;
		let call = 0;
		const llm: DriftLlmFn = async (messages, _schemas, _toolChoice, _systemPrompt) => {
			call += 1;
			const toolResults = messages
				.filter((m) => m.role === "toolResult")
				.map((m) => driftToolResultText(m as Record<string, unknown>));
			if (call === 3) {
				const parsed = JSON.parse(toolResults[toolResults.length - 1] ?? "{}") as { items: Array<{ id: string }> };
				sawRanked = parsed.items?.[0]?.id === "m2";
				return {
					id: "c3",
					name: "finish_drift",
					input: {
						skill_used: "skill-a",
						status: "completed",
						briefing: "b",
						self_update: { pattern: "ordinary", reflection: "x", next_tendency: "y" },
					},
				};
			}
			if (call === 2) {
				return {
					id: "c2",
					name: "recall_memory",
					input: { query: "电子音乐", limit: 8 },
				};
			}
			return {
				id: "c1",
				name: "select_skill",
				input: { skill_name: "skill-a", decision: "explore", intention: "i", reason: "r" },
			};
		};

		const pipeline = new DriftTurnPipeline({ store, toolDeps: deps, maxSteps: 5 });
		await pipeline.run(ctx, llm);
		expect(sawRanked).toBe(true);

		// 嵌入失败 → 降级 LIKE(无抛错,结果仍可用)。
		deps.memoryEmbeddingFn = async () => {
			throw new Error("embedding service down");
		};
		const ctx2 = createDriftContext("local", new Date());
		let sawFallback = false;
		let call2 = 0;
		const llm2: DriftLlmFn = async () => {
			call2 += 1;
			if (call2 === 3) {
				sawFallback = true;
				return {
					id: "c3",
					name: "finish_drift",
					input: {
						skill_used: "skill-a",
						status: "completed",
						briefing: "b",
						self_update: { pattern: "ordinary", reflection: "x", next_tendency: "y" },
					},
				};
			}
			if (call2 === 2) {
				return {
					id: "c1",
					name: "recall_memory",
					input: { query: "音乐", limit: 8 },
				};
			}
			return {
				id: "c1",
				name: "select_skill",
				input: { skill_name: "skill-a", decision: "explore", intention: "i", reason: "r" },
			};
		};
		const pipeline2 = new DriftTurnPipeline({ store, toolDeps: deps, maxSteps: 5 });
		await pipeline2.run(ctx2, llm2);
		expect(sawFallback).toBe(true);
	});
});

describe("skill health signals (akashic review-drift-gaps 内置化)", () => {
	it("marks stale-paused and flaky skills in briefing and selection context", async () => {
		const driftDir = makeDriftDir();
		writeSkill(driftDir, "stale-skill", "长期停摆的活动");
		writeSkill(driftDir, "ok-skill", "正常活动");
		const store = makeStore(driftDir);

		// stale-skill:5 天前 paused。
		const old = new Date(Date.now() - 5 * 86_400_000);
		store.saveFinish({
			skillUsed: "stale-skill",
			status: "paused",
			briefing: "卡住了",
			scratchpadUpdate: "下次继续",
			messageResult: "silent",
			nowUtc: old,
			selfUpdate: { next_tendency: "x" },
		});
		// ok-skill:昨天 completed。
		store.saveFinish({
			skillUsed: "ok-skill",
			status: "completed",
			briefing: "闭环",
			messageResult: "silent",
			nowUtc: new Date(Date.now() - 86_400_000),
			selfUpdate: { next_tendency: "x" },
		});
		// flaky:给 ok-skill 造 run_steps,一半是错误(需要 run_id 关联)。
		const nowIso = new Date().toISOString();
		const db = new DatabaseSync(store.dbFile);
		const runRow = db.prepare("SELECT id FROM runs WHERE skill_name = 'ok-skill' ORDER BY id DESC LIMIT 1").get() as {
			id: number;
		};
		db.prepare(
			"INSERT INTO run_steps (run_id, step_index, tool_name, input_preview, output_preview, created_at) VALUES (?, 1, 'shell', '', '{\"error\": \"boom\"}', ?), (?, 2, 'shell', '', 'ok', ?)",
		).run(runRow.id, nowIso, runRow.id, nowIso);
		db.close();

		const skills = store.scanSkills();
		const briefing = store.loadBriefing(skills);
		expect(briefing).toContain("[stale-paused]");
		expect(briefing).toContain("[flaky]");

		// selection context 同样标注。
		const ctx = createDriftContext("local", new Date());
		const deps = makeDeps(driftDir, store);
		let sawMarkers = false;
		const llm: DriftLlmFn = async (_messages, _schemas, _toolChoice, systemPrompt) => {
			const systemText = systemPrompt ?? "";
			if (systemText.includes("stale-paused") && systemText.includes("flaky")) sawMarkers = true;
			return { id: "c1", name: "idle_drift", input: { reason: "测试收尾" } };
		};
		const pipeline = new DriftTurnPipeline({ store, toolDeps: deps, maxSteps: 5 });
		await pipeline.run(ctx, llm);
		expect(sawMarkers).toBe(true);
	});
});

describe("frontmatter extensions + read_journal + skill hash (9a/9b/9c)", () => {
	it("cooldown_hours / max_runs_per_day / time_window filter candidates", async () => {
		const driftDir = makeDriftDir();
		// cooldown:1 小时冷却的活动(10 分钟前跑过)。
		mkdirSync(join(driftDir, "skills", "frequent-skill"), { recursive: true });
		writeFileSync(
			join(driftDir, "skills", "frequent-skill", "SKILL.md"),
			"---\nname: frequent-skill\ndescription: 高频活动\ncooldown_hours: 1\n---\n",
			"utf-8",
		);
		writeSkill(driftDir, "normal-skill", "正常活动");
		const store = makeStore(driftDir);
		store.saveFinish({
			skillUsed: "frequent-skill",
			status: "completed",
			briefing: "刚跑过",
			messageResult: "silent",
			nowUtc: new Date(Date.now() - 10 * 60_000),
			selfUpdate: { next_tendency: "x" },
		});

		const ctx = createDriftContext("local", new Date());
		const deps = makeDeps(driftDir, store);
		let sawFrequent = false;
		let sawNormal = false;
		const llm: DriftLlmFn = async (_messages, _schemas, _toolChoice, systemPrompt) => {
			const systemText = systemPrompt ?? "";
			if (systemText.includes("frequent-skill/")) sawFrequent = true;
			if (systemText.includes("normal-skill/")) sawNormal = true;
			return { id: "c1", name: "idle_drift", input: { reason: "测试收尾" } };
		};
		const pipeline = new DriftTurnPipeline({ store, toolDeps: deps, maxSteps: 5 });
		await pipeline.run(ctx, llm);
		expect(sawFrequent).toBe(false); // 冷却中被过滤
		expect(sawNormal).toBe(true);
	});

	it("read_journal returns cursor and entries for the selected skill", async () => {
		const driftDir = makeDriftDir();
		writeSkill(driftDir, "skill-a", "A 活动");
		const store = makeStore(driftDir);
		// 预置一条 journal + cursor,供 read_journal 读取。
		store.saveFinish({
			skillUsed: "skill-a",
			status: "completed",
			briefing: "预置",
			messageResult: "silent",
			nowUtc: new Date(),
			cursorUpdate: { next_action: "sample" },
			journalAppend: [{ entry_type: "memory_audited", key: "m1", payload: { result: "clean" } }],
			selfUpdate: { next_tendency: "x" },
		});
		const ctx = createDriftContext("local", new Date());
		const deps = makeDeps(driftDir, store);

		let sawJournal = false;
		let call = 0;
		const llm: DriftLlmFn = async (messages, _schemas, _toolChoice, _systemPrompt) => {
			call += 1;
			const toolResults = messages
				.filter((m) => m.role === "toolResult")
				.map((m) => driftToolResultText(m as Record<string, unknown>));
			if (call === 3) {
				const parsed = JSON.parse(toolResults[toolResults.length - 1] ?? "{}") as {
					ok: boolean;
					entries: Array<{ entry_type: string }>;
					cursor: Record<string, unknown>;
				};
				sawJournal =
					parsed.ok === true &&
					parsed.entries?.[0]?.entry_type === "memory_audited" &&
					parsed.cursor?.next_action === "sample";
				return {
					id: "c3",
					name: "finish_drift",
					input: {
						skill_used: "skill-a",
						status: "completed",
						briefing: "b",
						self_update: { pattern: "ordinary", reflection: "x", next_tendency: "y" },
					},
				};
			}
			if (call === 2) {
				return { id: "c2", name: "read_journal", input: { skill_name: "skill-a", limit: 5 } };
			}
			return {
				id: "c1",
				name: "select_skill",
				input: { skill_name: "skill-a", decision: "explore", intention: "i", reason: "r" },
			};
		};

		const pipeline = new DriftTurnPipeline({ store, toolDeps: deps, maxSteps: 5 });
		await pipeline.run(ctx, llm);
		expect(sawJournal).toBe(true);
	});

	it("skill-updated marker appears after SKILL.md changes", async () => {
		const driftDir = makeDriftDir();
		writeSkill(driftDir, "skill-a", "A 活动");
		const store = makeStore(driftDir);
		store.saveFinish({
			skillUsed: "skill-a",
			status: "completed",
			briefing: "闭环",
			messageResult: "silent",
			nowUtc: new Date(),
			selfUpdate: { next_tendency: "x" },
		});

		// 修改 SKILL.md → 重新扫描出现 skill-updated。
		writeFileSync(
			join(driftDir, "skills", "skill-a", "SKILL.md"),
			"---\nname: skill-a\ndescription: A 活动\n---\n\n# skill-a\n\n## 新流程\n",
			"utf-8",
		);
		const skills = store.scanSkills();
		expect(skills.find((s) => s.name === "skill-a")?.skillUpdated).toBe(true);
		const briefing = store.loadBriefing(skills);
		expect(briefing).toContain("[skill-updated]");

		// 再 finish 一次 → 哈希对齐,标注消失。
		store.saveFinish({
			skillUsed: "skill-a",
			status: "completed",
			briefing: "再闭环",
			messageResult: "silent",
			nowUtc: new Date(),
			selfUpdate: { next_tendency: "x" },
		});
		const after = store.scanSkills();
		expect(after.find((s) => s.name === "skill-a")?.skillUpdated).toBe(false);
	});
});

describe("ShellTool (akashic DriftShellTool)", () => {
	it("runs a command and returns output", async () => {
		const driftDir = makeDriftDir();
		const shell = new ShellTool(driftDir);
		const result = await shell.execute({ command: "echo hello" });
		expect(result).toContain("hello");
	});

	it("kills long-running commands on timeout", async () => {
		const driftDir = makeDriftDir();
		const shell = new ShellTool(driftDir);
		const started = Date.now();
		const result = await shell.execute({ command: "sleep 30", timeout: 1000 });
		expect(Date.now() - started).toBeLessThan(10_000);
		expect(result).toContain("timed out");
	});

	it("terminate() kills running processes (akashic terminate_owner)", async () => {
		const driftDir = makeDriftDir();
		const shell = new ShellTool(driftDir);
		const promise = shell.execute({ command: "sleep 30" });
		await new Promise((resolve) => setTimeout(resolve, 300));
		await shell.terminate();
		const started = Date.now();
		const result = await promise;
		expect(Date.now() - started).toBeLessThan(5000);
		expect(result).toContain("error");
	});

	it("writes stdin to a background task and stops tasks", async () => {
		const driftDir = makeDriftDir();
		const shell = new ShellTool(driftDir);
		const started = JSON.parse(await shell.execute({ command: "read line; echo reply:$line", background: true })) as {
			task_id: string;
		};
		const response = JSON.parse(await shell.writeStdin(started.task_id, "hello\n", 100)) as {
			stdout: string;
			running: boolean;
		};
		expect(response.stdout).toContain("reply:hello");
		expect(response.running).toBe(false);

		const longRunning = JSON.parse(await shell.execute({ command: "sleep 30", background: true })) as {
			task_id: string;
		};
		const stopped = JSON.parse(await shell.stopTask(longRunning.task_id)) as {
			running: boolean;
			signal: string | null;
		};
		expect(stopped.running).toBe(false);
		expect(stopped.signal).toBe("SIGTERM");
	});
});

describe("Drift web tools", () => {
	it("uses host web fetch and search implementations", async () => {
		const driftDir = makeDriftDir();
		const store = makeStore(driftDir);
		const ctx = createDriftContext("local", new Date("2026-05-01T00:00:00Z"));
		const deps = makeDeps(driftDir, store);
		deps.webFetchFn = async (url) => ({ url, text: "fetched text", truncated: false });
		deps.webSearchFn = async (query) => [{ title: query, url: "https://example.test/result", snippet: "result" }];
		const tools = buildDriftToolRegistry(ctx, deps);
		const fetchTool = tools.find((tool) => tool.name === "web_fetch")!;
		const searchTool = tools.find((tool) => tool.name === "web_search")!;

		const fetched = JSON.parse(await fetchTool.execute({ url: "https://example.test" }, ctx)) as { text: string };
		const searched = JSON.parse(await searchTool.execute({ query: "drift" }, ctx)) as {
			results: Array<{ title: string }>;
		};
		expect(fetched.text).toBe("fetched text");
		expect(searched.results[0]?.title).toBe("drift");
	});
});

describe("DriftTurnPipeline (akashic runtime.py)", () => {
	it("runs scan -> select -> action -> finish and persists the run", async () => {
		const driftDir = makeDriftDir();
		writeSkill(driftDir, "skill-a", "A 活动");
		const store = makeStore(driftDir);
		const ctx = createDriftContext("local", new Date("2026-05-01T00:00:00Z"));

		const llm = scriptedLlm([
			{
				tool: "select_skill",
				args: { skill_name: "skill-a", decision: "explore", intention: "想做点安静的事", reason: "最近没做过" },
			},
			{ tool: "read_file", args: { path: "skills/skill-a/SKILL.md" } },
			{
				tool: "finish_drift",
				args: {
					skill_used: "skill-a",
					status: "completed",
					briefing: "读完了说明书",
					self_update: { pattern: "ordinary", reflection: "普通一轮", next_tendency: "下次可能继续" },
					journal_append: [{ entry_type: "read_done", key: "SKILL.md", payload: {} }],
				},
			},
		]);

		const pipeline = new DriftTurnPipeline({ store, toolDeps: makeDeps(driftDir, store), maxSteps: 10 });
		const entered = await pipeline.run(ctx, llm);

		expect(entered).toBe(true);
		expect(ctx.driftFinished).toBe(true);
		expect(ctx.driftFinishStatus).toBe("completed");
		expect(ctx.driftSelectedSkill).toBe("skill-a");
		expect(store.loadSkillContinuum("skill-a").runCount).toBe(1);
		expect(store.loadDrift().recentRuns.length).toBe(1);
	});

	it("returns false when no skills exist", async () => {
		const driftDir = makeDriftDir();
		const store = makeStore(driftDir);
		const ctx = createDriftContext("local", new Date());
		const pipeline = new DriftTurnPipeline({ store, toolDeps: makeDeps(driftDir, store), maxSteps: 5 });
		const entered = await pipeline.run(ctx, scriptedLlm([]));
		expect(entered).toBe(false);
		expect(ctx.driftEntered).toBe(false);
	});

	it("restricts tools before select_skill (schema-level)", async () => {
		const driftDir = makeDriftDir();
		writeSkill(driftDir, "skill-a", "A 活动");
		const store = makeStore(driftDir);
		const ctx = createDriftContext("local", new Date());

		// 第一个工具尝试 read_file(违反阶段约束)——scriptedLlm 会因 schema 不含该工具而抛错,
		// 验证 pipeline 在 before_select 阶段只暴露 select_skill/idle_drift。
		let sawSelectSchema = false;
		const llm: DriftLlmFn = async (_messages, schemas) => {
			const names = schemas.map((schema) => (schema.function as { name: string }).name);
			sawSelectSchema = names.length === 2 && names.includes("select_skill") && names.includes("idle_drift");
			return { id: "c1", name: "idle_drift", input: { reason: "最近刚打扰过" } };
		};

		const pipeline = new DriftTurnPipeline({ store, toolDeps: makeDeps(driftDir, store), maxSteps: 5 });
		await pipeline.run(ctx, llm);
		expect(sawSelectSchema).toBe(true);
		expect(ctx.driftFinished).toBe(true);
		// akashic idle_drift:save_finish(skill_used="idle", completed)。
		expect(store.loadSkillContinuum("idle").lastStatus).toBe("completed");
	});

	it("message_push stages hash and finish_drift persists it (web 投递闭环)", async () => {
		const driftDir = makeDriftDir();
		writeSkill(driftDir, "skill-a", "A 活动");
		const store = makeStore(driftDir);
		const ctx = createDriftContext("local", new Date());

		let sawAfterSendConstraint = false;
		const llm: DriftLlmFn = async (messages, schemas) => {
			const names = schemas.map((schema) => (schema.function as { name: string }).name);
			const pushed = messages.some(
				(m) =>
					m.role === "assistant" &&
					Array.isArray(m.content) &&
					(m.content as Array<{ type?: string; name?: string }>).some(
						(c) => c.type === "toolCall" && c.name === "message_push",
					),
			);
			if (pushed) {
				sawAfterSendConstraint = names.length === 1 && names[0] === "finish_drift";
				return {
					id: "c2",
					name: "finish_drift",
					input: {
						skill_used: "skill-a",
						status: "completed",
						briefing: "推送了一条轻量消息",
						self_update: { pattern: "ordinary", reflection: "x", next_tendency: "y" },
					},
				};
			}
			if (names.includes("message_push")) {
				return {
					id: "c1",
					name: "message_push",
					input: { message: "最近在看什么书?" },
				};
			}
			return {
				id: "c0",
				name: "select_skill",
				input: { skill_name: "skill-a", decision: "explore", intention: "i", reason: "r" },
			};
		};

		const pipeline = new DriftTurnPipeline({ store, toolDeps: makeDeps(driftDir, store), maxSteps: 10 });
		const entered = await pipeline.run(ctx, llm);

		expect(entered).toBe(true);
		expect(sawAfterSendConstraint).toBe(true);
		expect(ctx.driftMessageStaged).toBe(true);
		expect(ctx.driftMessageHash.length).toBe(64);

		const run = store.loadDrift().recentRuns[0];
		expect(run?.message_result).toBe("staged");
		store.markRunMessageSent(ctx.driftMessageHash);
		expect(store.loadDrift().recentRuns[0]?.message_result).toBe("sent");
	});

	it("message_push accepts media-only deliveries and preserves the target route", async () => {
		const driftDir = makeDriftDir();
		writeSkill(driftDir, "skill-a", "A 活动");
		const store = makeStore(driftDir);
		const ctx = createDriftContext("local", new Date("2026-05-01T00:00:00.000Z"));
		let committed:
			| {
					message: string;
					media?: readonly string[];
					attachments?: readonly { kind: string; source: string; filename?: string }[];
					target_channel?: string;
					target_chat_id?: string;
			  }
			| undefined;
		const deps = makeDeps(driftDir, store);
		deps.storeDb = {
			insertDelivery: (record) => {
				committed = record;
				return 1;
			},
		};

		const pipeline = new DriftTurnPipeline({ store, toolDeps: deps, maxSteps: 10 });
		await pipeline.run(
			ctx,
			scriptedLlm([
				{ tool: "select_skill", args: { skill_name: "skill-a", decision: "explore", intention: "i", reason: "r" } },
				{
					tool: "message_push",
					args: {
						image: "/tmp/one.png",
						media: "/tmp/two.png",
						file: "/tmp/report.pdf",
						target_channel: "feishu",
						target_chat_id: "oc_target",
					},
				},
				{
					tool: "finish_drift",
					args: {
						skill_used: "skill-a",
						status: "completed",
						briefing: "发送图片",
						self_update: { pattern: "ordinary", reflection: "x", next_tendency: "y" },
					},
				},
			]),
		);

		expect(ctx.draftMessage).toBe("");
		expect(ctx.draftMedia).toEqual(["/tmp/one.png", "/tmp/two.png"]);
		expect(ctx.draftAttachments).toEqual([{ kind: "file", source: "/tmp/report.pdf", filename: "report.pdf" }]);
		expect(ctx.draftTargetChannel).toBe("feishu");
		expect(ctx.draftTargetChatId).toBe("oc_target");
		expect(committed).toMatchObject({
			message: "",
			media: ["/tmp/one.png", "/tmp/two.png"],
			attachments: [{ kind: "file", source: "/tmp/report.pdf", filename: "report.pdf" }],
			target_channel: "feishu",
			target_chat_id: "oc_target",
		});
	});

	it("uses the unified delivery receipt and emits lifecycle events", async () => {
		const driftDir = makeDriftDir();
		writeSkill(driftDir, "skill-a", "A 活动");
		const store = makeStore(driftDir);
		const ctx = createDriftContext("local", new Date("2026-05-01T00:00:00.000Z"));
		const events: string[] = [];
		let insertCalled = false;
		const deps = makeDeps(driftDir, store);
		deps.storeDb = {
			insertDelivery: () => {
				insertCalled = true;
				return 1;
			},
			sendDelivery: async (record) => ({
				deliveryId: 42,
				status: "success",
				providerMessageId: "provider-1",
				canonicalMedia: record.media,
			}),
		};
		const pipeline = new DriftTurnPipeline({
			store,
			toolDeps: deps,
			maxSteps: 10,
			eventSink: {
				emit: (event) => {
					events.push(event.type);
				},
			},
		});

		await pipeline.run(
			ctx,
			scriptedLlm([
				{ tool: "select_skill", args: { skill_name: "skill-a", decision: "explore", intention: "i", reason: "r" } },
				{ tool: "message_push", args: { message: "统一出站测试" } },
				{
					tool: "finish_drift",
					args: {
						skill_used: "skill-a",
						status: "completed",
						briefing: "完成",
						self_update: { pattern: "ordinary", reflection: "x", next_tendency: "y" },
					},
				},
			]),
		);

		expect(insertCalled).toBe(false);
		expect(ctx.driftDeliveryId).toBe(42);
		expect(ctx.driftDeliveryStatus).toBe("success");
		expect(ctx.driftMessageCommitted).toBe(true);
		expect(ctx.driftDeliveryReceipt?.providerMessageId).toBe("provider-1");
		expect(events[0]).toBe("drift_started");
		expect(events).toContain("drift_delivery_committed");
		expect(events.at(-1)).toBe("drift_finished");
		expect(events.filter((event) => event === "drift_tool_called")).toHaveLength(3);
	});

	it("wrap-up forces finish_drift when steps are exhausted", async () => {
		const driftDir = makeDriftDir();
		writeSkill(driftDir, "skill-a", "A 活动");
		const store = makeStore(driftDir);
		const ctx = createDriftContext("local", new Date());

		const toolCalls: Step[] = [
			{ tool: "select_skill", args: { skill_name: "skill-a", decision: "explore", intention: "i", reason: "r" } },
			{ tool: "read_file", args: { path: "skills/skill-a/SKILL.md" } },
			// 预算耗尽:第三步起是 wrap-up 强制 finish。
			{
				tool: "finish_drift",
				args: {
					skill_used: "skill-a",
					status: "paused",
					briefing: "步数耗尽",
					scratchpad_update: "读到说明书,下次继续",
					self_update: { pattern: "ordinary", reflection: "x", next_tendency: "y" },
				},
			},
		];
		const llm = scriptedLlm(toolCalls);

		const pipeline = new DriftTurnPipeline({ store, toolDeps: makeDeps(driftDir, store), maxSteps: 2 });
		await pipeline.run(ctx, llm);
		expect(ctx.driftFinished).toBe(true);
		expect(ctx.driftFinishStatus).toBe("paused");
		expect(store.loadSkillContinuum("skill-a").lastStatus).toBe("paused");
	});

	it("time budget: maxDurationMs exceeded triggers wrap-up (时长预算)", async () => {
		const driftDir = makeDriftDir();
		writeSkill(driftDir, "skill-a", "A 活动");
		const store = makeStore(driftDir);
		const ctx = createDriftContext("local", new Date());

		// 预算为负:deadline 必然已过期,首个 LLM 调用即进入 wrap-up(确定性,不依赖机器速度)。
		const schemaSets: string[][] = [];
		const llm: DriftLlmFn = async (_messages, schemas) => {
			const names = schemas.map((schema) => (schema.function as { name: string }).name);
			schemaSets.push(names);
			return {
				id: "c1",
				name: "finish_drift",
				input: {
					skill_used: "unknown-skill",
					status: "paused",
					briefing: "超时收尾",
					scratchpad_update: "时间预算耗尽",
					self_update: { pattern: "ordinary", reflection: "x", next_tendency: "y" },
				},
			};
		};

		const pipeline = new DriftTurnPipeline({
			store,
			toolDeps: makeDeps(driftDir, store),
			maxSteps: 20,
			maxDurationMs: -1,
		});
		await pipeline.run(ctx, llm);
		// wrap-up 一旦触发,所有调用只允许 finish_drift。
		expect(schemaSets[0]).toEqual(["finish_drift"]);
		// finish_drift 校验 skill_used,unknown 失败 → 重试 → 仍失败 → fallback pause。
		expect(ctx.driftFinished).toBe(true);
		expect(ctx.driftFinishStatus).toBe("paused");
		expect(store.loadSkillContinuum("unknown").lastStatus).toBe("paused");
	});

	it("fallback pause when wrap-up finish fails repeatedly", async () => {
		const driftDir = makeDriftDir();
		writeSkill(driftDir, "skill-a", "A 活动");
		const store = makeStore(driftDir);
		const ctx = createDriftContext("local", new Date());

		// 第一轮 select;之后所有调用都返回非法工具(非 finish_drift),wrap-up 重试 2 次后 fallback pause。
		const llm: DriftLlmFn = async (_messages, schemas) => {
			const names = schemas.map((schema) => (schema.function as { name: string }).name);
			const hasFinish = names.includes("finish_drift");
			if (!hasFinish) {
				return {
					id: "c1",
					name: "select_skill",
					input: { skill_name: "skill-a", decision: "explore", intention: "i", reason: "r" },
				};
			}
			return { id: "c2", name: "read_file", input: { path: "skills/skill-a/SKILL.md" } };
		};

		const pipeline = new DriftTurnPipeline({ store, toolDeps: makeDeps(driftDir, store), maxSteps: 1 });
		await pipeline.run(ctx, llm);
		expect(ctx.driftFinished).toBe(true);
		expect(ctx.driftFinishStatus).toBe("paused");
		expect(store.loadSkillContinuum("skill-a").lastStatus).toBe("paused");
	});

	it("finish_drift validates contracts (unknown skill, mismatched skill, missing fields)", async () => {
		const driftDir = makeDriftDir();
		writeSkill(driftDir, "skill-a", "A 活动");
		const store = makeStore(driftDir);
		const ctx = createDriftContext("local", new Date());

		const results: string[] = [];
		const llm: DriftLlmFn = async (_messages, schemas) => {
			const names = schemas.map((schema) => (schema.function as { name: string }).name);
			if (!ctx.driftSelectedSkill && names.includes("select_skill")) {
				return {
					id: "c1",
					name: "select_skill",
					input: { skill_name: "skill-a", decision: "explore", intention: "i", reason: "r" },
				};
			}
			const step = results.length;
			results.push("called");
			if (step === 0) {
				return {
					id: "c2",
					name: "finish_drift",
					input: {
						skill_used: "unknown-skill",
						status: "completed",
						briefing: "b",
						self_update: { pattern: "ordinary", reflection: "r", next_tendency: "t" },
					},
				};
			}
			if (step === 1) {
				return {
					id: "c3",
					name: "finish_drift",
					input: {
						skill_used: "skill-a",
						status: "completed",
						briefing: "b",
						self_update: { pattern: "ordinary", reflection: "r", next_tendency: "t" },
					},
				};
			}
			return null;
		};

		const pipeline = new DriftTurnPipeline({ store, toolDeps: makeDeps(driftDir, store), maxSteps: 10 });
		await pipeline.run(ctx, llm);
		expect(results.length).toBe(2);
		expect(ctx.driftFinished).toBe(true);
		// 第一次 unknown skill 被拒绝(错误作为 tool result 返回),第二次成功。
		expect(store.loadSkillContinuum("skill-a").runCount).toBe(1);
	});

	it("builds runtime context with briefing, memory and recent chat", async () => {
		const driftDir = makeDriftDir();
		writeSkill(driftDir, "skill-a", "A 活动");
		const store = makeStore(driftDir);
		const ctx = createDriftContext("local", new Date());

		let sawBriefing = false;
		let sawChat = false;
		const llm: DriftLlmFn = async (_messages, _schemas, _toolChoice, systemPrompt) => {
			const systemText = systemPrompt ?? "";
			if (systemText.includes("【Drift Briefing】")) sawBriefing = true;
			if (systemText.includes("recent_raw_chat")) sawChat = true;
			return { id: "c1", name: "idle_drift", input: { reason: "测试收尾" } };
		};

		const pipeline = new DriftTurnPipeline({
			store,
			toolDeps: makeDeps(driftDir, store),
			maxSteps: 5,
			recentChatFn: async () => [{ role: "user", content: "最近聊了什么" }],
		});
		await pipeline.run(ctx, llm);
		expect(sawBriefing).toBe(true);
		expect(sawChat).toBe(true);
	});

	it("injects file-backed VEDA and memory context into the run", async () => {
		const driftDir = makeDriftDir();
		const workspace = makeDriftDir();
		mkdirSync(join(workspace, "memory"), { recursive: true });
		writeFileSync(join(workspace, "memory", "VEDA.md"), "VEDA persona", "utf-8");
		writeFileSync(join(workspace, "memory", "SELF.md"), "assistant self model", "utf-8");
		writeFileSync(join(workspace, "memory", "MEMORY.md"), "stable user memory", "utf-8");
		writeFileSync(join(workspace, "memory", "RECENT_CONTEXT.md"), "recent context", "utf-8");
		writeSkill(driftDir, "skill-a", "A 活动");
		const store = makeStore(driftDir);
		const ctx = createDriftContext("local", new Date("2026-05-01T00:00:00.000Z"));
		let systemText = "";
		const pipeline = new DriftTurnPipeline({
			store,
			toolDeps: makeDeps(driftDir, store),
			contextProvider: new FileDriftContextProvider({ workspaceDir: workspace, requiredVeda: true }),
			maxSteps: 5,
		});

		await pipeline.run(ctx, async (_messages, _schemas, _toolChoice, systemPrompt) => {
			systemText = systemPrompt ?? "";
			return { id: "c1", name: "idle_drift", input: { reason: "测试收尾" } };
		});

		expect(systemText).toContain("VEDA persona");
		expect(systemText).toContain("## assistant_self_model\nassistant self model");
		expect(systemText).toContain("## long_term_memory\nstable user memory");
		expect(systemText).toContain("## recent_context\nrecent context");
	});

	it("message_push rejects duplicates via sink dedupeCheck (推送去重)", async () => {
		const driftDir = makeDriftDir();
		writeSkill(driftDir, "skill-a", "A 活动");
		const store = makeStore(driftDir);
		const ctx = createDriftContext("local", new Date());

		let sawDedupeError = false;
		let finished = false;
		const llm: DriftLlmFn = async (messages, schemas) => {
			const names = schemas.map((schema) => (schema.function as { name: string }).name);
			const toolResults = messages
				.filter((m) => m.role === "toolResult")
				.map((m) => driftToolResultText(m as Record<string, unknown>))
				.join("\n");
			if (toolResults.includes("message_push rejected")) {
				sawDedupeError = true;
				finished = true;
				return {
					id: "c3",
					name: "finish_drift",
					input: {
						skill_used: "skill-a",
						status: "completed",
						briefing: "消息重复,静默闭环",
						self_update: { pattern: "ordinary", reflection: "x", next_tendency: "y" },
					},
				};
			}
			if (names.includes("message_push")) {
				return {
					id: "c1",
					name: "message_push",
					input: { message: "重复的消息" },
				};
			}
			return {
				id: "c0",
				name: "select_skill",
				input: { skill_name: "skill-a", decision: "explore", intention: "i", reason: "r" },
			};
		};

		const deps = makeDeps(driftDir, store);
		deps.storeDb = {
			insertDelivery: () => 1,
			dedupeCheck: () => ({ duplicate: true, reason: "24 小时内已推送过相同消息" }),
		};
		const pipeline = new DriftTurnPipeline({ store, toolDeps: deps, maxSteps: 10 });
		await pipeline.run(ctx, llm);

		expect(sawDedupeError).toBe(true);
		expect(ctx.driftMessageStaged).toBe(false);
		expect(ctx.driftMessageHash).toBe("");
		expect(finished).toBe(true);
		expect(store.loadDrift().recentRuns[0]?.message_result).toBe("silent");
	});

	it("commits a staged message only after finish_drift", async () => {
		const driftDir = makeDriftDir();
		writeSkill(driftDir, "skill-a", "A 活动");
		const store = makeStore(driftDir);
		const ctx = createDriftContext("local", new Date("2026-05-01T00:00:00.000Z"));
		let commitCount = 0;
		let resultAtCommit = "";
		const deps = makeDeps(driftDir, store);
		deps.storeDb = {
			insertDelivery: () => {
				commitCount += 1;
				resultAtCommit = store.loadDrift().recentRuns[0]?.message_result ?? "";
				return 1;
			},
		};

		const pipeline = new DriftTurnPipeline({ store, toolDeps: deps, maxSteps: 10 });
		await pipeline.run(
			ctx,
			scriptedLlm([
				{ tool: "select_skill", args: { skill_name: "skill-a", decision: "explore", intention: "i", reason: "r" } },
				{ tool: "message_push", args: { message: "提交时机测试" } },
				{
					tool: "finish_drift",
					args: {
						skill_used: "skill-a",
						status: "completed",
						briefing: "已完成",
						self_update: { pattern: "ordinary", reflection: "x", next_tendency: "y" },
					},
				},
			]),
		);

		expect(commitCount).toBe(1);
		expect(resultAtCommit).toBe("staged");
		expect(ctx.driftMessageCommitted).toBe(true);
		expect(store.loadDrift().recentRuns[0]?.message_result).toBe("staged");
	});

	it("injects host context hooks and shared tools", async () => {
		const driftDir = makeDriftDir();
		writeSkill(driftDir, "skill-a", "A 活动");
		const store = makeStore(driftDir);
		const ctx = createDriftContext("local", new Date("2026-05-01T00:00:00.000Z"));
		let sawHostPrompt = false;
		let sawCurrentContext = false;
		let sawSharedTool = false;
		let llmCalls = 0;
		const sharedTool: DriftTool = {
			name: "web_fetch",
			description: "读取网页",
			parameters: { type: "object", properties: {} },
			execute: async () => JSON.stringify({ ok: true }),
		};
		const pipeline = new DriftTurnPipeline({
			store,
			toolDeps: { ...makeDeps(driftDir, store), sharedTools: [sharedTool] },
			maxSteps: 5,
			host: {
				augmentSystemPrompt: (prompt) => `${prompt}\nHOST_RULE`,
				currentContextFn: () => "event: fresh-context",
				renderContextFrame: (sections, frameCtx) => {
					expect(frameCtx.nowUtc.toISOString()).toBe("2026-05-01T00:00:00.000Z");
					return sections.map((section) => `## ${section.name}\n${section.content}`).join("\n\n");
				},
			},
		});
		await pipeline.run(ctx, async (_messages, schemas, _toolChoice, systemPrompt) => {
			llmCalls += 1;
			const systemText = systemPrompt ?? "";
			sawHostPrompt = systemText.includes("HOST_RULE");
			sawCurrentContext = systemText.includes("## current_context_events") && systemText.includes("fresh-context");
			if (llmCalls > 1) {
				// 选中 skill 后，宿主共享工具才应进入可调用 schema。
				sawSharedTool ||= schemas.some((schema) => (schema.function as { name: string }).name === "web_fetch");
			}
			return llmCalls === 1
				? {
						id: "c1",
						name: "select_skill",
						input: { skill_name: "skill-a", decision: "explore", intention: "i", reason: "r" },
					}
				: {
						id: "c2",
						name: "finish_drift",
						input: {
							skill_used: "skill-a",
							status: "completed",
							briefing: "测试收尾",
							self_update: { pattern: "ordinary", reflection: "x", next_tendency: "y" },
						},
					};
		});
		expect(sawHostPrompt).toBe(true);
		expect(sawCurrentContext).toBe(true);
		expect(sawSharedTool).toBe(true);
	});

	it("runtime_clock has utc + local time and activityFn adds user_activity", async () => {
		const driftDir = makeDriftDir();
		writeSkill(driftDir, "skill-a", "A 活动");
		const store = makeStore(driftDir);
		const ctx = createDriftContext("local", new Date("2026-05-01T00:00:00.000Z"));

		let sawClock = false;
		let sawActivity = false;
		let sawFixedClock = false;
		const llm: DriftLlmFn = async (_messages, _schemas, _toolChoice, systemPrompt) => {
			const systemText = systemPrompt ?? "";
			if (systemText.includes("current_time_utc=") && systemText.includes("current_time_local=")) {
				sawClock = true;
			}
			if (systemText.includes("current_time_utc=2026-05-01T00:00:00.000Z")) sawFixedClock = true;
			if (systemText.includes("## user_activity") && systemText.includes("last_user_at=")) {
				sawActivity = true;
			}
			return { id: "c1", name: "idle_drift", input: { reason: "测试收尾" } };
		};

		const pipeline = new DriftTurnPipeline({
			store,
			toolDeps: makeDeps(driftDir, store),
			maxSteps: 5,
			activityFn: async () => "last_user_at=2026-05-01T00:00:00.000Z (5 分钟前)",
		});
		await pipeline.run(ctx, llm);
		expect(sawClock).toBe(true);
		expect(sawFixedClock).toBe(true);
		expect(sawActivity).toBe(true);

		// 未提供 activityFn 时不出 user_activity 段。
		let sawNoActivity = true;
		const ctx2 = createDriftContext("local", new Date());
		const llm2: DriftLlmFn = async (_messages, _schemas, _toolChoice, systemPrompt) => {
			const systemText = systemPrompt ?? "";
			if (systemText.includes("## user_activity")) sawNoActivity = false;
			return { id: "c1", name: "idle_drift", input: { reason: "测试收尾" } };
		};
		const pipeline2 = new DriftTurnPipeline({ store, toolDeps: makeDeps(driftDir, store), maxSteps: 5 });
		await pipeline2.run(ctx2, llm2);
		expect(sawNoActivity).toBe(true);
	});
});
