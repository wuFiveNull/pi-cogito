import type { Api, AssistantMessage, Context, Model } from "@cogito/ai/compat";
import { describe, expect, it, vi } from "vitest";
import {
	type ApprovalCompleteFn,
	type ApprovalRequest,
	createLlmApprovalJudge,
	parseVerdict,
	parseVerdicts,
} from "../src/core/approval/judge.ts";

function textMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
		usage: undefined,
		stopReason: "stop",
	} as unknown as AssistantMessage;
}

function fakeModelFor(entry: { provider: string; id: string }): Model<Api> {
	return { provider: entry.provider, id: entry.id, api: "openai-completions" } as unknown as Model<Api>;
}

function fakeModelSource(models: Array<{ provider: string; id: string; auth: boolean }>, complete: ApprovalCompleteFn) {
	const getModelCalls: Array<[string, string]> = [];
	return {
		getModelCalls,
		async getModel(providerId: string, modelId: string) {
			getModelCalls.push([providerId, modelId]);
			const found = models.find((m) => m.provider === providerId && m.id === modelId);
			if (!found || !found.auth) return undefined;
			return fakeModelFor(found);
		},
		async getModels() {
			return models.filter((m) => m.auth).map((m) => fakeModelFor(m));
		},
		complete,
	};
}

const request: ApprovalRequest = { kind: "bash-domain", target: "example.com" };

describe("parseVerdict", () => {
	it("parses a bare JSON verdict", () => {
		expect(parseVerdict('{"decision":"allow","rule":"example.com","reason":"dev host"}')).toEqual({
			decision: "allow",
			rule: "example.com",
			reason: "dev host",
		});
	});

	it("parses JSON embedded in prose or fences", () => {
		const text = 'Sure!\n```json\n{"decision":"deny","rule":"example.com","reason":"no need"}\n```';
		expect(parseVerdict(text)).toEqual({ decision: "deny", rule: "example.com", reason: "no need" });
	});

	it("rejects malformed output", () => {
		expect(parseVerdict("no json here")).toBeUndefined();
		expect(parseVerdict("{not json}")).toBeUndefined();
		expect(parseVerdict('{"decision":"maybe","rule":"x","reason":"y"}')).toBeUndefined();
		expect(parseVerdict('{"decision":"allow","reason":"missing rule"}')).toBeUndefined();
		expect(parseVerdict('{"decision":"allow","rule":"","reason":"empty rule"}')).toBeUndefined();
		expect(parseVerdict('{"decision":"allow","rule":"x"}')).toBeUndefined();
	});
});

describe("createLlmApprovalJudge", () => {
	it("returns the model's verdict and caches by kind+target", async () => {
		const complete = vi.fn(async () => textMessage('{"decision":"allow","rule":"example.com","reason":"dev host"}'));
		const source = fakeModelSource(
			[{ provider: "test", id: "m1", auth: true }],
			complete as unknown as ApprovalCompleteFn,
		);
		const judge = createLlmApprovalJudge(source);

		const first = await judge.judge(request);
		const second = await judge.judge({ kind: "bash-domain", target: "example.com" });
		expect(first).toEqual({ decision: "allow", rule: "example.com", reason: "dev host" });
		expect(second).toEqual(first);
		expect(complete).toHaveBeenCalledTimes(1);

		const [model, context] = complete.mock.calls[0] as unknown as [Model<Api>, Context];
		expect(model.id).toBe("m1");
		expect(context.systemPrompt).toContain("permission reviewer");
		expect(context.messages[0]?.content).toContain('"target":"example.com"');
		expect(source.getModelCalls).toHaveLength(0);
	});

	it("propagates deny verdicts", async () => {
		const source = fakeModelSource([{ provider: "test", id: "m1", auth: true }], (async () =>
			textMessage(
				'{"decision":"deny","rule":"example.com","reason":"unexpected host"}',
			)) as unknown as ApprovalCompleteFn);
		const judge = createLlmApprovalJudge(source);

		const verdict = await judge.judge({ kind: "fs-write", target: "/etc/hosts" });
		expect(verdict).toEqual({ decision: "deny", rule: "example.com", reason: "unexpected host" });
	});

	it("fails closed when the model errors, returns no text, or stalls", async () => {
		const failing = createLlmApprovalJudge(
			fakeModelSource([{ provider: "test", id: "m1", auth: true }], (async () => {
				throw new Error("provider down");
			}) as unknown as ApprovalCompleteFn),
		);
		expect(await failing.judge(request)).toBeUndefined();

		const empty = createLlmApprovalJudge(
			fakeModelSource([{ provider: "test", id: "m1", auth: true }], (async () =>
				textMessage("I cannot answer that.")) as unknown as ApprovalCompleteFn),
		);
		expect(await empty.judge(request)).toBeUndefined();

		const stalled = createLlmApprovalJudge(
			fakeModelSource([{ provider: "test", id: "m1", auth: true }], ((
				_model: Model<Api>,
				_context: Context,
				options?: { signal?: AbortSignal },
			) => {
				return new Promise((_resolve, reject) => {
					options?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
				});
			}) as unknown as ApprovalCompleteFn),
		);
		expect(await stalled.judge(request, { timeoutSeconds: 0.05 })).toBeUndefined();
	});

	it("enforces the per-session budget", async () => {
		const complete = vi.fn(async () => textMessage('{"decision":"allow","rule":"x.example.com","reason":"ok"}'));
		const judge = createLlmApprovalJudge(
			fakeModelSource([{ provider: "test", id: "m1", auth: true }], complete as unknown as ApprovalCompleteFn),
		);
		const settings = { maxPerSession: 1 };

		expect(await judge.judge({ kind: "bash-domain", target: "a.example.com" }, settings)).toBeDefined();
		expect(await judge.judge({ kind: "bash-domain", target: "b.example.com" }, settings)).toBeUndefined();
		expect(complete).toHaveBeenCalledTimes(1);
	});

	it("resolves an explicit model setting and fails closed without auth", async () => {
		const complete = vi.fn(async () => textMessage('{"decision":"deny","rule":"x","reason":"no"}'));
		const source = fakeModelSource(
			[
				{ provider: "test", id: "m1", auth: false },
				{ provider: "other", id: "m2", auth: true },
			],
			complete as unknown as ApprovalCompleteFn,
		);
		const judge = createLlmApprovalJudge(source);

		expect(await judge.judge(request, { model: "test/m1" })).toBeUndefined();
		expect(source.getModelCalls).toEqual([["test", "m1"]]);

		expect(await judge.judge(request, { model: "other/m2" })).toEqual({
			decision: "deny",
			rule: "x",
			reason: "no",
		});
		// Model resolution is cached per setting; the same setting reuses it.
		await judge.judge({ kind: "bash-domain", target: "other.org" }, { model: "other/m2" });
		expect(source.getModelCalls).toEqual([
			["test", "m1"],
			["other", "m2"],
		]);
	});

	it("falls back to the first configured catalog model when unset", async () => {
		const complete = vi.fn(async () => textMessage('{"decision":"allow","rule":"x","reason":"ok"}'));
		const judge = createLlmApprovalJudge(
			fakeModelSource(
				[
					{ provider: "test", id: "m1", auth: false },
					{ provider: "other", id: "m2", auth: true },
				],
				complete as unknown as ApprovalCompleteFn,
			),
		);

		expect(await judge.judge(request)).toBeDefined();
		const [model] = complete.mock.calls[0] as unknown as [Model<Api>];
		expect(model.provider).toBe("other");
		expect(model.id).toBe("m2");
	});
});

describe("parseVerdicts", () => {
	const requested = ["a.dev", "b.dev"];

	it("parses an array of verdicts keyed by target", () => {
		const text =
			'[{"target":"a.dev","decision":"allow","rule":"a.dev","reason":"ok"},' +
			'{"target":"b.dev","decision":"deny","rule":"b.dev","reason":"no"}]';
		const verdicts = parseVerdicts(text, requested);
		expect(verdicts?.get("a.dev")).toEqual({ decision: "allow", rule: "a.dev", reason: "ok" });
		expect(verdicts?.get("b.dev")).toEqual({ decision: "deny", rule: "b.dev", reason: "no" });
	});

	it("accepts a verdicts wrapper object embedded in prose", () => {
		const text =
			'Verdicts:\n```json\n{"verdicts":[{"target":"a.dev","decision":"deny","rule":"a.dev","reason":"no"}]}\n```';
		expect(parseVerdicts(text, requested)?.get("a.dev")).toEqual({
			decision: "deny",
			rule: "a.dev",
			reason: "no",
		});
	});

	it("accepts a single verdict object for a single-target batch", () => {
		const verdicts = parseVerdicts('{"decision":"allow","rule":"x.dev","reason":"ok"}', ["x.dev"]);
		expect(verdicts?.get("x.dev")).toEqual({ decision: "allow", rule: "x.dev", reason: "ok" });
	});

	it("ignores unknown targets and keeps the first duplicate", () => {
		const text =
			'[{"target":"unknown.dev","decision":"allow","rule":"x","reason":"ok"},' +
			'{"target":"a.dev","decision":"deny","rule":"a.dev","reason":"first"},' +
			'{"target":"a.dev","decision":"allow","rule":"a.dev","reason":"second"}]';
		const verdicts = parseVerdicts(text, requested);
		expect(verdicts?.size).toBe(1);
		expect(verdicts?.get("a.dev")).toEqual({ decision: "deny", rule: "a.dev", reason: "first" });
	});

	it("returns undefined without any usable verdict", () => {
		expect(parseVerdicts("no json here", requested)).toBeUndefined();
		expect(parseVerdicts("[1, 2]", requested)).toBeUndefined();
		expect(parseVerdicts('{"decision":"maybe","rule":"x","reason":"y"}', requested)).toBeUndefined();
	});
});

describe("judgeBatch", () => {
	it("reviews several targets with one model call and one budget unit", async () => {
		const complete = vi.fn(async () =>
			textMessage(
				'[{"target":"a.dev","decision":"allow","rule":"a.dev","reason":"ok"},' +
					'{"target":"b.dev","decision":"deny","rule":"b.dev","reason":"no"}]',
			),
		);
		const judge = createLlmApprovalJudge(
			fakeModelSource([{ provider: "test", id: "m1", auth: true }], complete as unknown as ApprovalCompleteFn),
		);

		const verdicts = await judge.judgeBatch?.([
			{ kind: "bash-domain", target: "a.dev" },
			{ kind: "bash-domain", target: "b.dev" },
		]);
		expect(complete).toHaveBeenCalledTimes(1);
		expect(verdicts?.get("a.dev")?.decision).toBe("allow");
		expect(verdicts?.get("b.dev")?.decision).toBe("deny");

		// One batch call consumed the whole budget; a new target fails closed.
		const overBudget = await judge.judgeBatch?.([{ kind: "bash-domain", target: "c.dev" }], { maxPerSession: 1 });
		expect(overBudget).toBeUndefined();
	});

	it("serves cached targets without a model call and drops unanswered targets", async () => {
		const complete = vi.fn(async () =>
			textMessage('[{"target":"a.dev","decision":"allow","rule":"a.dev","reason":"ok"}]'),
		);
		const judge = createLlmApprovalJudge(
			fakeModelSource([{ provider: "test", id: "m1", auth: true }], complete as unknown as ApprovalCompleteFn),
		);

		// b.dev is never answered: it is simply missing (callers fail closed).
		const first = await judge.judgeBatch?.([
			{ kind: "bash-domain", target: "a.dev" },
			{ kind: "bash-domain", target: "b.dev" },
		]);
		expect(complete).toHaveBeenCalledTimes(1);
		expect(first?.has("a.dev")).toBe(true);
		expect(first?.has("b.dev")).toBe(false);

		const second = await judge.judgeBatch?.([{ kind: "bash-domain", target: "a.dev" }]);
		expect(complete).toHaveBeenCalledTimes(1);
		expect(second?.get("a.dev")).toBeDefined();
	});

	it("returns undefined when the batch reply is unparseable", async () => {
		const complete = vi.fn(async () => textMessage("I cannot answer that."));
		const judge = createLlmApprovalJudge(
			fakeModelSource([{ provider: "test", id: "m1", auth: true }], complete as unknown as ApprovalCompleteFn),
		);

		const verdicts = await judge.judgeBatch?.([
			{ kind: "bash-domain", target: "a.dev" },
			{ kind: "bash-domain", target: "b.dev" },
		]);
		expect(verdicts).toBeUndefined();
	});
});
