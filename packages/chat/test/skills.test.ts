import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findSkill, listSkills } from "../src/tools/skills.ts";

const tempDirs: string[] = [];

function tempRoots(): { agentDir: string; projectDir: string; roots: string[] } {
	const dir = mkdtempSync(join(tmpdir(), "chat-skills-"));
	tempDirs.push(dir);
	const agentDir = join(dir, "agent");
	const projectDir = join(dir, "project");
	const roots = [join(agentDir, "skills"), join(projectDir, ".cogito", "skills")];
	for (const root of roots) mkdirSync(root, { recursive: true });
	return { agentDir, projectDir, roots };
}

function writeSkill(root: string, name: string, body: string): void {
	const dir = join(root, name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "SKILL.md"), body, "utf-8");
}

afterEach(() => {
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
	tempDirs.length = 0;
});

describe("skills discovery", () => {
	it("lists skills from agent and project roots", () => {
		const { roots } = tempRoots();
		writeSkill(roots[0]!, "research", "# Research\nsteps");
		writeSkill(roots[1]!, "daily", "# Daily\nsteps");
		expect(listSkills(roots).sort()).toEqual(["daily", "research"]);
	});

	it("deduplicates names across roots (agent root wins)", () => {
		const { roots } = tempRoots();
		writeSkill(roots[0]!, "shared", "# agent version");
		writeSkill(roots[1]!, "shared", "# project version");
		const names = listSkills(roots);
		expect(names).toEqual(["shared"]);
		expect(findSkill(roots, "shared")).toBe(join(roots[0]!, "shared", "SKILL.md"));
	});

	it("finds a skill by name and misses unknown ones", () => {
		const { roots } = tempRoots();
		writeSkill(roots[0]!, "drift", "# Drift\nsteps");
		expect(findSkill(roots, "drift")).toBe(join(roots[0]!, "drift", "SKILL.md"));
		expect(findSkill(roots, "nope")).toBeUndefined();
		expect(findSkill(roots, "  ")).toBeUndefined();
	});
});
