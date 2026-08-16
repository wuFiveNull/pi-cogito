/**
 * Proactive rules panel — PROACTIVE_CONTEXT.md (akashic loop.py design).
 *
 * The main agent maintains this file; the proactive loop reads it every tick
 * (mtime-cached) and treats it as binding rules, not advisory context:
 * whitelists, blacklists, filters, priorities, must-verify steps. It never
 * carries news facts or candidate content — only rules.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const PROACTIVE_CONTEXT_FILE = "PROACTIVE_CONTEXT.md";

const PROACTIVE_CONTEXT_TEMPLATE = `# Proactive Context

在这里写用户当前对主动推送的明确要求和规则。

- 主 agent 负责维护这份文件。
- proactive 进程每轮都会读取它,并把它视为需要遵守的规则,不是普通参考建议。
- 这里适合写白名单、黑名单、过滤条件、优先级、必须先验证的步骤。
- 这里不提供新闻事实,不提供候选内容,只定义规则。
- 写结论即可,不要写冗长过程。
`;

export class ProactiveRules {
	private mtimeNs: number | null = null;
	private text = "";
	private readonly filePath: string;

	constructor(filePath: string) {
		this.filePath = filePath;
		this.ensure();
	}

	private ensure(): void {
		if (existsSync(this.filePath)) return;
		mkdirSync(dirname(this.filePath), { recursive: true });
		writeFileSync(this.filePath, PROACTIVE_CONTEXT_TEMPLATE, "utf-8");
	}

	/** Read the rules panel (cached by mtime). Never throws. */
	read(): string {
		try {
			const stat = statSync(this.filePath);
			const mtime = Math.trunc(stat.mtimeMs * 1e6);
			if (this.mtimeNs === mtime) return this.text;
			const text = readFileSync(this.filePath, "utf-8").trim();
			this.mtimeNs = mtime;
			this.text = text;
			return text;
		} catch {
			return this.text;
		}
	}

	file(): string {
		return this.filePath;
	}
}

/** Default rules panel path: agentDir/PROACTIVE_CONTEXT.md (overridable in config). */
export function defaultRulesPath(agentDir?: string): string {
	const base = agentDir ?? join(process.env.HOME ?? "/tmp", ".cogito", "agent");
	return join(base, PROACTIVE_CONTEXT_FILE);
}
