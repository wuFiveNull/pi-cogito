/**
 * ApprovalJudge — LLM-backed permission reviewer for sandboxed actions.
 *
 * The AI is the sole reviewer: a blocked action is described to a small model
 * which must answer with a strict JSON verdict. Parse errors, timeouts, an
 * exhausted per-session budget, or a missing/unauthenticated model all return
 * undefined, which callers treat as "deny" (fail closed). Verdicts are cached
 * per (kind, target) for the lifetime of the judge instance (one session).
 *
 * judgeBatch() reviews many targets with a single model call (one budget
 * unit); targets already answered by the cache are excluded from the call.
 */

import { join } from "node:path";

import type { Api, AssistantMessage, Context, Model } from "@cogito/ai/compat";

import { getAgentDir } from "../../config.ts";
import { ModelRuntime } from "../model-runtime.ts";

export type ApprovalKind = "bash-domain" | "fs-read" | "fs-write";

export interface ApprovalRequest {
	kind: ApprovalKind;
	/** Domain or canonicalized path being requested. */
	target: string;
	context?: { command?: string; cwd?: string };
}

export interface ApprovalVerdict {
	decision: "allow" | "deny";
	/** Minimal rule covering the request; callers re-validate before applying. */
	rule: string;
	/** Human/agent-readable rationale; fed back on deny. */
	reason: string;
}

export interface ApprovalJudgeSettings {
	/** "provider/model-id"; unset uses the first catalog model with configured auth. */
	model?: string;
	timeoutSeconds?: number;
	maxPerSession?: number;
}

export interface ApprovalJudge {
	judge(request: ApprovalRequest, settings?: ApprovalJudgeSettings): Promise<ApprovalVerdict | undefined>;
	/**
	 * Judge several targets with one model call (one budget unit). Returns
	 * verdicts keyed by target; requested targets missing from the map failed
	 * individually and are treated as denied by callers. undefined means the
	 * batch call itself failed (timeout, budget, no model, unparseable
	 * output) and every target must fail closed. Optional: callers fall back
	 * to per-target judge() loops when absent.
	 */
	judgeBatch?(
		requests: ApprovalRequest[],
		settings?: ApprovalJudgeSettings,
	): Promise<Map<string, ApprovalVerdict> | undefined>;
}

/** Audit record for one approval resolution, suitable for pi.appendEntry. */
export interface ApprovalAuditRecord {
	kind: ApprovalKind;
	target: string;
	decision: "allow" | "deny" | "fail-closed";
	/** Granted rule when decision is "allow". */
	rule?: string;
	reason: string;
}

export type ApprovalCompleteFn = (
	model: Model<Api>,
	context: Context,
	options?: { signal?: AbortSignal; maxTokens?: number },
) => Promise<AssistantMessage>;

/**
 * Model resolution plus execution. `complete` must inject credentials itself —
 * the default source routes through `ModelRuntime.completeSimple`, whose
 * prepareRequest resolves the provider API key (a bare compat call cannot).
 */
export interface ApprovalModelSource {
	getModel(providerId: string, modelId: string): Promise<Model<Api> | undefined>;
	getModels(): Promise<readonly Model<Api>[]>;
	complete(
		model: Model<Api>,
		context: Context,
		options?: { signal?: AbortSignal; maxTokens?: number },
	): Promise<AssistantMessage>;
}

export const DEFAULT_APPROVAL_TIMEOUT_SECONDS = 30;
export const DEFAULT_APPROVAL_MAX_PER_SESSION = 20;
const VERDICT_MAX_TOKENS = 512;
const BATCH_VERDICT_MAX_TOKENS = 2048;

const JUDGE_SYSTEM_PROMPT = [
	"You are the sole permission reviewer for a sandboxed coding agent, deciding on behalf of a user who",
	"prioritizes machine safety but does not want to be interrupted. Answer with ONLY a JSON object:",
	'{"decision":"allow"|"deny","rule":"<minimal rule covering the request>","reason":"<short rationale>"}',
	"",
	"Rules of thumb:",
	"- bash-domain: development staples (npm, pypi, github and similar package/CI hosts) lean allow;",
	"  unknown or suspicious hosts and any exfiltration of local data lean deny.",
	"- fs-read: project files, dependency and tool directories lean allow; credential-shaped paths",
	"  (.env, id_rsa, *.pem, *.key, ssh/cloud configs) lean deny.",
	"- fs-write: project and build-output directories lean allow; home dotfiles, system paths, and",
	"  credential files lean deny.",
	'- The rule must be minimal and concrete (a specific domain or directory); never "*" or a',
	"  whole-home/system wildcard.",
	"- If information is insufficient, answer deny and say what is missing; do not guess.",
	"",
	"When asked to review several targets at once, answer with ONLY a JSON array with one entry per",
	"requested target, each carrying the target verbatim:",
	'[{"target":"<requested target>","decision":"allow"|"deny","rule":"...","reason":"..."}]',
	"A single target may use either form.",
].join("\n");

function buildContext(requests: ApprovalRequest[]): Context {
	const payload =
		requests.length === 1
			? {
					kind: requests[0]?.kind,
					target: requests[0]?.target,
					...(requests[0]?.context?.command ? { command: requests[0].context?.command } : {}),
					...(requests[0]?.context?.cwd ? { cwd: requests[0].context?.cwd } : {}),
				}
			: {
					requests: requests.map((request) => ({
						kind: request.kind,
						target: request.target,
						...(request.context?.command ? { command: request.context.command } : {}),
						...(request.context?.cwd ? { cwd: request.context.cwd } : {}),
					})),
				};
	return {
		systemPrompt: JUDGE_SYSTEM_PROMPT,
		messages: [{ role: "user", content: JSON.stringify(payload), timestamp: Date.now() }],
		tools: [],
	};
}

/** Parse the model's reply into a verdict; anything malformed yields undefined. */
export function parseVerdict(text: string): ApprovalVerdict | undefined {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start < 0 || end <= start) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(text.slice(start, end + 1));
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const record = parsed as Record<string, unknown>;
	const { decision, rule, reason } = record;
	if (decision !== "allow" && decision !== "deny") return undefined;
	if (typeof rule !== "string" || rule.trim().length === 0) return undefined;
	if (typeof reason !== "string") return undefined;
	return { decision, rule: rule.trim(), reason };
}

function parseVerdictEntry(entry: unknown): ApprovalVerdict | undefined {
	if (typeof entry !== "object" || entry === null) return undefined;
	const record = entry as Record<string, unknown>;
	const { decision, rule, reason } = record;
	if (decision !== "allow" && decision !== "deny") return undefined;
	if (typeof rule !== "string" || rule.trim().length === 0) return undefined;
	if (typeof reason !== "string") return undefined;
	return { decision, rule: rule.trim(), reason };
}

/**
 * Parse a batch reply into verdicts keyed by target. Accepts a JSON array of
 * verdict objects (each echoing the requested target), a {"verdicts":[...]}
 * wrapper, or — when exactly one target was requested — a single verdict
 * object. Entries without a usable target only count for a single-target
 * batch; unknown or duplicate targets are ignored (first wins).
 */
export function parseVerdicts(text: string, requested: readonly string[]): Map<string, ApprovalVerdict> | undefined {
	const start = text.indexOf("[");
	let parsed: unknown;
	if (start >= 0) {
		const end = text.lastIndexOf("]");
		if (end > start) {
			try {
				parsed = JSON.parse(text.slice(start, end + 1));
			} catch {
				parsed = undefined;
			}
		}
	}
	if (parsed === undefined) {
		const single = parseVerdict(text);
		if (!single) return undefined;
		if (requested.length !== 1) return undefined;
		return new Map([[requested[0] as string, single]]);
	}

	const entries: unknown[] = Array.isArray(parsed)
		? parsed
		: typeof parsed === "object" && parsed !== null && Array.isArray((parsed as Record<string, unknown>).verdicts)
			? ((parsed as Record<string, unknown>).verdicts as unknown[])
			: [];
	if (entries.length === 0) return undefined;

	const verdicts = new Map<string, ApprovalVerdict>();
	for (const entry of entries) {
		const verdict = parseVerdictEntry(entry);
		if (!verdict) continue;
		const target =
			typeof entry === "object" && entry !== null && typeof (entry as Record<string, unknown>).target === "string"
				? (entry as Record<string, unknown>).target
				: undefined;
		if (typeof target === "string" && requested.includes(target)) {
			if (!verdicts.has(target)) verdicts.set(target, verdict);
			continue;
		}
		if (target === undefined && requested.length === 1 && !verdicts.has(requested[0] as string)) {
			verdicts.set(requested[0] as string, verdict);
		}
	}
	if (verdicts.size > 0) return verdicts;
	if (requested.length === 1) {
		const single = parseVerdict(text);
		if (single) return new Map([[requested[0] as string, single]]);
	}
	return undefined;
}

function extractText(message: AssistantMessage): string {
	const parts = Array.isArray(message.content) ? message.content : [];
	return parts
		.map((part) =>
			part !== null && typeof part === "object" && "type" in part && part.type === "text"
				? String((part as { text?: unknown }).text ?? "")
				: "",
		)
		.join("");
}

function createDefaultModelSource(): ApprovalModelSource {
	let runtimePromise: Promise<ModelRuntime> | undefined;
	const getRuntime = () => {
		runtimePromise ??= ModelRuntime.create({
			authPath: join(getAgentDir(), "auth.json"),
			modelsPath: join(getAgentDir(), "models.json"),
		});
		return runtimePromise;
	};
	return {
		async getModel(providerId: string, modelId: string) {
			const runtime = await getRuntime();
			const model = runtime.getModel(providerId, modelId);
			return model && runtime.hasConfiguredAuth(providerId) ? model : undefined;
		},
		async getModels() {
			const runtime = await getRuntime();
			return [...runtime.getModels()].filter((model) => runtime.hasConfiguredAuth(model.provider));
		},
		async complete(model, context, options) {
			const runtime = await getRuntime();
			return runtime.completeSimple(model, context, {
				...options,
				maxTokens: options?.maxTokens ?? VERDICT_MAX_TOKENS,
			});
		},
	};
}

export function createLlmApprovalJudge(modelSource: ApprovalModelSource = createDefaultModelSource()): ApprovalJudge {
	const cache = new Map<string, ApprovalVerdict>();
	let calls = 0;
	let resolved: { key: string; model: Model<Api> | undefined } | undefined;

	async function resolveModel(settings: ApprovalJudgeSettings): Promise<Model<Api> | undefined> {
		const key = settings.model ?? "";
		if (resolved?.key === key) return resolved.model;
		let model: Model<Api> | undefined;
		if (settings.model) {
			const slash = settings.model.indexOf("/");
			model =
				slash > 0
					? await modelSource.getModel(settings.model.slice(0, slash), settings.model.slice(slash + 1))
					: undefined;
		} else {
			model = (await modelSource.getModels())[0];
		}
		resolved = { key, model };
		return model;
	}

	async function judgeRequests(
		requests: ApprovalRequest[],
		settings: ApprovalJudgeSettings,
	): Promise<Map<string, ApprovalVerdict> | undefined> {
		const results = new Map<string, ApprovalVerdict>();
		const pending: ApprovalRequest[] = [];
		for (const request of requests) {
			const cached = cache.get(`${request.kind}\u0000${request.target}`);
			if (cached) results.set(request.target, cached);
			else pending.push(request);
		}
		if (pending.length === 0) return results;

		const max = settings.maxPerSession ?? DEFAULT_APPROVAL_MAX_PER_SESSION;
		if (calls >= max) return undefined;

		const model = await resolveModel(settings);
		if (!model) return undefined;
		calls += 1;

		const timeoutSeconds = settings.timeoutSeconds ?? DEFAULT_APPROVAL_TIMEOUT_SECONDS;
		const signal = AbortSignal.timeout(timeoutSeconds * 1000);
		try {
			const message = await modelSource.complete(model, buildContext(pending), {
				signal,
				maxTokens: pending.length > 1 ? BATCH_VERDICT_MAX_TOKENS : undefined,
			});
			const verdicts = parseVerdicts(
				extractText(message),
				pending.map((request) => request.target),
			);
			if (!verdicts) return undefined;
			for (const request of pending) {
				const verdict = verdicts.get(request.target);
				if (!verdict) continue;
				cache.set(`${request.kind}\u0000${request.target}`, verdict);
				results.set(request.target, verdict);
			}
			return results;
		} catch {
			return undefined;
		}
	}

	return {
		async judge(request, settings = {}) {
			const verdicts = await judgeRequests([request], settings);
			return verdicts?.get(request.target);
		},
		judgeBatch(requests, settings = {}) {
			return judgeRequests(requests, settings);
		},
	};
}
