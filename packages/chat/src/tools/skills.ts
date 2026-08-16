/**
 * load_skill tool — the agent loads a SKILL.md body on demand (akashic
 * skill_loader equivalent). Skills live in <agentDir>/skills and
 * <projectDir>/.cogito/skills, one directory per skill.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AgentToolResult, ToolDefinition } from "@cogito/host";
import { defineTool } from "@cogito/host";
import { Type } from "typebox";

export interface LoadSkillToolOptions {
	agentDir: string;
	projectDir: string;
	/** Max characters returned per skill body. Default 8000. */
	maxChars?: number;
}

export function createLoadSkillTool(options: LoadSkillToolOptions): ToolDefinition {
	const roots = [join(options.agentDir, "skills"), join(options.projectDir, ".cogito", "skills")];
	const maxChars = Math.max(500, options.maxChars ?? 8000);
	return defineTool({
		name: "load_skill",
		label: "load_skill",
		description:
			"加载一个技能(SKILL.md)的完整内容。技能是按目录组织的(SKILL.md 位于技能目录内)。调用前可用 read 或本工具直接加载。",
		searchHint: "技能 加载技能 SKILL skill 指令集",
		promptSnippet: "Load a skill body",
		promptGuidelines: ["Use load_skill to read the full body of a skill before executing its steps."],
		parameters: Type.Object({
			name: Type.String({ description: "技能名(技能目录名)" }),
		}),
		async execute(_toolCallId, params): Promise<AgentToolResult<undefined>> {
			const skill = findSkill(roots, params.name);
			if (!skill) {
				const available = listSkills(roots);
				return textResult(
					`未找到技能 "${params.name}"。可用技能: ${available.length > 0 ? available.join(", ") : "(无)"}`,
				);
			}
			let body: string;
			try {
				body = readFileSync(skill, "utf-8");
			} catch (error) {
				return textResult(`读取技能失败: ${error instanceof Error ? error.message : String(error)}`);
			}
			return textResult(body.slice(0, maxChars) + (body.length > maxChars ? "\n…(已截断)" : ""));
		},
	});
}

/** Find the SKILL.md for a skill name across the roots. */
export function findSkill(roots: readonly string[], name: string): string | undefined {
	const normalized = name.trim();
	if (normalized.length === 0) return undefined;
	for (const root of roots) {
		const candidate = join(root, normalized, "SKILL.md");
		if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
	}
	return undefined;
}

/** List available skill names across the roots (deduplicated, first root wins). */
export function listSkills(roots: readonly string[]): string[] {
	const seen = new Set<string>();
	const names: string[] = [];
	for (const root of roots) {
		if (!existsSync(root)) continue;
		let entries: string[];
		try {
			entries = readdirSync(root);
		} catch {
			continue;
		}
		for (const entry of entries.sort()) {
			if (seen.has(entry)) continue;
			const skillMd = join(root, entry, "SKILL.md");
			if (existsSync(skillMd) && statSync(skillMd).isFile()) {
				seen.add(entry);
				names.push(entry);
			}
		}
	}
	return names;
}

function textResult(text: string): AgentToolResult<undefined> {
	return { content: [{ type: "text", text }], details: undefined };
}
