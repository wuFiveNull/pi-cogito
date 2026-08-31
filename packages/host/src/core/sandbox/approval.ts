/**
 * AI approval resolution for the sandbox extension.
 *
 * There is no human review path: every blocked action is judged by the
 * ApprovalJudge (see core/approval). An allow verdict grants a session-level
 * rule; a deny verdict, a malformed rule, or a judge failure blocks the action
 * (fail closed) with the reason fed back to the agent. Config files are never
 * written by this module.
 */

import type {
	ApprovalAuditRecord,
	ApprovalJudge,
	ApprovalJudgeSettings,
	ApprovalKind,
	ApprovalVerdict,
} from "../approval/index.ts";
import type { ExtensionContext } from "../extensions/index.ts";
import { getConfigPaths, type SandboxConfig } from "./config.ts";
import { allowsAllDomains, domainIsAllowed, matchesPattern } from "./policy.ts";
import type { SessionAllowances } from "./runtime.ts";

export type { ApprovalAuditRecord };

export type ApprovalOutcome = { action: "granted"; value: string } | { action: "blocked"; reason: string };

const FAIL_CLOSED_REASON = "AI approval judge unavailable (timeout, budget, or no model); failing closed";

/**
 * Review several targets of one action with a single judge call (one budget
 * unit when the judge supports judgeBatch, otherwise one call per target).
 * Grants are applied in one applySession batch; every deny, malformed rule,
 * or missing verdict fails closed individually. Callers decide whether a mix
 * of grants and denials blocks the action.
 */
export interface BatchApprovalOutcome {
	granted: Array<{ target: string; rule: string }>;
	denied: Array<{ target: string; reason: string }>;
}

export async function resolveApprovalBatch(options: {
	kind: ApprovalKind;
	targets: string[];
	command?: string;
	validateRule: (target: string, rule: string) => string | null;
	judge: ApprovalJudge;
	settings?: ApprovalJudgeSettings;
	applySession: (rules: string[]) => Promise<void>;
	audit?: (record: ApprovalAuditRecord) => void;
}): Promise<BatchApprovalOutcome> {
	const { kind, targets } = options;
	if (targets.length === 0) return { granted: [], denied: [] };

	let verdicts: Map<string, ApprovalVerdict> | undefined;
	if (options.judge.judgeBatch) {
		verdicts = await options.judge.judgeBatch(
			targets.map((target) => ({ kind, target, context: { command: options.command } })),
			options.settings,
		);
	} else {
		verdicts = new Map();
		for (const target of targets) {
			const verdict = await options.judge.judge(
				{ kind, target, context: { command: options.command } },
				options.settings,
			);
			if (verdict) verdicts.set(target, verdict);
		}
	}

	const granted: Array<{ target: string; rule: string }> = [];
	const denied: Array<{ target: string; reason: string }> = [];
	for (const target of targets) {
		const verdict = verdicts?.get(target);
		if (!verdict) {
			options.audit?.({ kind, target, decision: "fail-closed", reason: FAIL_CLOSED_REASON });
			denied.push({ target, reason: FAIL_CLOSED_REASON });
			continue;
		}
		if (verdict.decision === "allow") {
			const invalidRule = options.validateRule(target, verdict.rule);
			if (invalidRule === null) {
				options.audit?.({ kind, target, decision: "allow", rule: verdict.rule, reason: verdict.reason });
				granted.push({ target, rule: verdict.rule });
				continue;
			}
			const reason = `AI verdict rule rejected: ${invalidRule}`;
			options.audit?.({ kind, target, decision: "deny", reason });
			denied.push({ target, reason });
			continue;
		}
		options.audit?.({ kind, target, decision: "deny", reason: verdict.reason });
		denied.push({ target, reason: verdict.reason });
	}

	if (granted.length > 0) await options.applySession(granted.map((entry) => entry.rule));
	return { granted, denied };
}

export async function resolveApproval(options: {
	kind: ApprovalKind;
	target: string;
	command?: string;
	validateRule: (rule: string) => string | null;
	judge: ApprovalJudge;
	settings?: ApprovalJudgeSettings;
	applySession: (rule: string) => Promise<void>;
	audit?: (record: ApprovalAuditRecord) => void;
}): Promise<ApprovalOutcome> {
	const { kind, target } = options;
	const verdict = await options.judge.judge({ kind, target, context: { command: options.command } }, options.settings);

	if (verdict) {
		const invalidRule = verdict.decision === "allow" ? options.validateRule(verdict.rule) : null;
		if (verdict.decision === "allow" && invalidRule === null) {
			await options.applySession(verdict.rule);
			options.audit?.({ kind, target, decision: "allow", rule: verdict.rule, reason: verdict.reason });
			return { action: "granted", value: verdict.rule };
		}
		const reason = verdict.decision === "deny" ? verdict.reason : `AI verdict rule rejected: ${invalidRule}`;
		options.audit?.({ kind, target, decision: "deny", reason });
		return { action: "blocked", reason };
	}

	const reason = FAIL_CLOSED_REASON;
	options.audit?.({ kind, target, decision: "fail-closed", reason });
	return { action: "blocked", reason };
}

const validRule = (value: string, matches: boolean, target: string): string | null => {
	if (value.length === 0) return "Rule cannot be empty.";
	return matches ? null : `Rule must match the requested ${target}.`;
};

export function validDomainRule(domain: string, rule: string): string | null {
	if (rule === "*") return 'Rule must not be "*"; allow specific domains.';
	return validRule(rule, domainIsAllowed(domain, [rule]), `domain "${domain}"`);
}

export function validPathRule(path: string, rule: string): string | null {
	if (rule === "*" || rule === "/*" || rule === "**") return "Rule must not allow every path.";
	return validRule(rule, matchesPattern(path, [rule]), `path "${path}"`);
}

export function warnIfAllDomainsAllowed(ctx: ExtensionContext, config: SandboxConfig): void {
	if (!allowsAllDomains(config.network?.allowedDomains)) return;
	ctx.ui.notify(
		'Network sandbox allows all domains because network.allowedDomains contains "*". ' +
			'Only use this intentionally; remove "*" to restore per-request AI review.',
		"warning",
	);
}

export function formatSandboxStatus(config: SandboxConfig, allowances: SessionAllowances): string {
	const networkLabel = allowsAllDomains(config.network?.allowedDomains)
		? "all domains"
		: `${config.network?.allowedDomains?.length ?? 0} domains`;
	const sessionRules = allowances.domains.length + allowances.readPaths.length + allowances.writePaths.length;
	return `Sandbox: AI review (${sessionRules} session rules), ${networkLabel}`;
}

export function formatSandboxConfiguration(
	config: SandboxConfig,
	paths: { globalPath: string; projectPath: string },
	allowances: SessionAllowances,
): string {
	return [
		"Sandbox Configuration",
		`  Project config: ${paths.projectPath}`,
		`  Global config:  ${paths.globalPath}`,
		"",
		"AI approval (no human review; denied requests fail closed):",
		`  Model:   ${config.approval?.model ?? "(first configured model)"}`,
		`  Timeout: ${config.approval?.timeoutSeconds ?? 30}s`,
		`  Budget:  ${config.approval?.maxPerSession ?? 20} calls/session`,
		"",
		"Network (bash + !cmd):",
		`  Allowed domains: ${config.network?.allowedDomains?.join(", ") || "(none)"}`,
		...(allowsAllDomains(config.network?.allowedDomains)
			? ['  Note: "*" allows all domains and disables per-request AI review.']
			: []),
		`  Denied domains:  ${config.network?.deniedDomains?.join(", ") || "(none)"}`,
		...(allowances.domains.length ? [`  Session rules (AI granted): ${allowances.domains.join(", ")}`] : []),
		"",
		"Filesystem (bash + read/write/edit tools):",
		`  Deny Read:   ${config.filesystem?.denyRead?.join(", ") || "(none)"}`,
		`  Allow Read:  ${config.filesystem?.allowRead?.join(", ") || "(none)"}`,
		`  Allow Write: ${config.filesystem?.allowWrite?.join(", ") || "(none)"}`,
		`  Deny Write:  ${config.filesystem?.denyWrite?.join(", ") || "(none)"}`,
		...(allowances.readPaths.length ? [`  Session read (AI granted):  ${allowances.readPaths.join(", ")}`] : []),
		...(allowances.writePaths.length ? [`  Session write (AI granted): ${allowances.writePaths.join(", ")}`] : []),
		"",
		"Note: reads outside allowRead/allowWrite are judged by the AI model.",
		"Note: allowWrite also grants read access to the same path.",
		"Note: denyWrite takes PRECEDENCE and is never judged or granted.",
	].join("\n");
}

// Re-exported for callers that need the config path helpers alongside formatting.
export { getConfigPaths };
