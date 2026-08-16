/**
 * 默认技能发现策略:目录扫描 + requires_mcp 过滤(akashic scan_skills 语义)。
 */

import type { DriftStateStore } from "../state.ts";
import type { DriftMcpConnections } from "../tools.ts";
import type { DriftScanStrategy } from "./types.ts";

export class ScanSkillsStrategy implements DriftScanStrategy {
	readonly id = "scan-skills";
	private readonly store: DriftStateStore;
	private readonly connectedServers: Set<string>;

	constructor(store: DriftStateStore, mcp?: DriftMcpConnections) {
		this.store = store;
		this.connectedServers = new Set((mcp?.servers ?? []).map((s) => s.name));
	}

	scan(nowUtc = new Date()) {
		const skills = this.store.scanSkills();
		// requires_mcp 的 skill 仅在对应 server 已连接时可用(akashic 集合包含语义);
		// 冷却/日限/时段(frontmatter 扩展)受限的 skill 不进候选。
		return skills.filter(
			(skill) =>
				skill.requiresMcp.every((name) => this.connectedServers.has(name)) &&
				!this.store.skillRestriction(skill, nowUtc).blocked,
		);
	}
}
