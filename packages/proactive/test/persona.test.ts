import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readVeda, renderPersonaBlock, resetVeda, VedaLoadError } from "../src/persona.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("VEDA persona", () => {
	it("reads the Akashic workspace path and resets with a backup", () => {
		const workspaceDir = mkdtempSync(join(tmpdir(), "proactive-veda-"));
		tempDirs.push(workspaceDir);
		const config = { workspaceDir, required: true };
		expect(() => readVeda(config)).toThrow(VedaLoadError);

		const reset = resetVeda(config, "# old persona\n");
		expect(readVeda(config)).toContain("old persona");
		writeFileSync(reset.path, "# new persona\n");
		const second = resetVeda(config, "# default persona\n");
		expect(second.backupPath).toBeDefined();
		expect(existsSync(second.backupPath!)).toBe(true);
		expect(readFileSync(second.backupPath!, "utf-8")).toContain("new persona");
	});

	it("renders VEDA and behavior rules without exposing an absent optional file", () => {
		const workspaceDir = mkdtempSync(join(tmpdir(), "proactive-veda-"));
		tempDirs.push(workspaceDir);
		const block = renderPersonaBlock({ workspaceDir, behaviorRules: "只输出可验证结论。" });
		expect(block).toContain("行为规则");
		expect(block).toContain("只输出可验证结论");
		expect(block).not.toContain("Persona / VEDA");
	});
});
