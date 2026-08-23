/**
 * 富记忆注入块(akashic retriever._format_relative_age / _format_source_tag /
 * _procedure_steps 的 chat 侧渲染)。
 *
 * 纯渲染:输入 MemoryHit[],输出带相对时间、证据标签、过程步骤/触发词、低置信
 * 标注的注入块。替换 host 的 buildInjectionBlock(信息量少的 id+摘要 形态),
 * host 零改动。
 */

import type { MemoryHit, MemoryType } from "@cogito/host";

export interface RichBlockOptions {
	/** 字符预算(与 host retriever INJECT_MAX_CHARS=1200 对齐)。默认 1200。 */
	maxChars?: number;
	/** 分数阈值。默认 0.45。 */
	scoreThreshold?: number;
	/** procedure/preference 条数上限。默认 4。 */
	maxProcedurePreference?: number;
	/** event/profile 条数上限。默认 2。 */
	maxEventProfile?: number;
	/** 强制约束 procedure(tool_requirement)上限。默认 3。 */
	maxForced?: number;
	/** 渲染基准时间。默认当前时间。 */
	now?: Date;
}

const DEFAULT_MAX_CHARS = 1200;
const DEFAULT_SCORE_THRESHOLD = 0.45;
const DEFAULT_MAX_PROCEDURE_PREFERENCE = 4;
const DEFAULT_MAX_EVENT_PROFILE = 2;
const DEFAULT_MAX_FORCED = 3;

const TYPE_LABELS: Record<MemoryType, string> = {
	event: "事件",
	profile: "画像",
	preference: "偏好",
	procedure: "流程",
};

/** 相对时间渲染(akashic _format_relative_age):"距今约 N 分钟/小时/天"。 */
export function formatRelativeAge(happenedAt: string | null, now: Date): string {
	if (!happenedAt) return "";
	const time = Date.parse(happenedAt);
	if (!Number.isFinite(time)) return "";
	const minutes = Math.max(0, Math.floor((now.getTime() - time) / 60_000));
	if (minutes < 1) return "刚刚";
	if (minutes < 60) return `距今约 ${minutes} 分钟`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `距今约 ${hours} 小时`;
	const days = Math.floor(hours / 24);
	if (days < 30) return `距今约 ${days} 天`;
	const months = Math.floor(days / 30);
	if (months < 12) return `距今约 ${months} 个月`;
	return `距今约 ${Math.floor(months / 12)} 年`;
}

/** 过程标注:trigger_tags(触发词)+ steps(步骤),akashic _procedure_steps 语义。 */
export function formatProcedureAnnotations(extra: Record<string, unknown> | undefined): string {
	if (!extra) return "";
	const annotations: string[] = [];
	const tags = extra.trigger_tags;
	if (Array.isArray(tags) && tags.length > 0) {
		const tagText = tags
			.filter((tag): tag is string => typeof tag === "string" && tag.trim().length > 0)
			.slice(0, 4)
			.join("、");
		if (tagText) annotations.push(`触发:${tagText}`);
	}
	const steps = extra.steps;
	if (Array.isArray(steps) && steps.length > 0) {
		const stepText = steps
			.filter((step): step is string => typeof step === "string" && step.trim().length > 0)
			.slice(0, 3)
			.map((step, index) => `${index + 1}.${step.trim()}`)
			.join(" ");
		if (stepText) annotations.push(`步骤:${stepText}`);
	}
	return annotations.length > 0 ? `(${annotations.join("；")})` : "";
}

/** 逐条渲染:`- [id] (类型) [相对时间] summary(标注)`,akashic _format_source_tag 语义。 */
export function formatRichHitLine(hit: MemoryHit, now: Date): string {
	const annotations: string[] = [];
	const toolRequirement = hit.extra?.tool_requirement;
	if (typeof toolRequirement === "string" && toolRequirement.trim().length > 0) {
		annotations.push(`必须调用工具:${toolRequirement.trim()}`);
	} else {
		const procedureMeta = formatProcedureAnnotations(hit.extra);
		if (procedureMeta) annotations.push(procedureMeta.replace(/^\(|\)$/g, ""));
	}
	if (hit.sourceRef && hit.sourceRef.trim().length > 0) {
		annotations.push("证据:可回源原文");
	}
	if (hit.confidenceLabel && hit.confidenceLabel.trim().length > 0) {
		annotations.push(hit.confidenceLabel.trim());
	}
	const time = formatRelativeAge(hit.happenedAt, now);
	const meta = annotations.length > 0 ? `(${annotations.join("；")})` : "";
	const timePart = time ? ` [${time}]` : "";
	return `- [${hit.id}] (${TYPE_LABELS[hit.memoryType]})${timePart} ${hit.summary}${meta}`;
}

/**
 * 富注入块:按分数排序,按类型配额 + 字符预算选择条目并渲染。
 * 强制约束 procedure(带 tool_requirement)优先且不受类型配额限制。
 */
export function buildRichInjectionBlock(hits: MemoryHit[], options: RichBlockOptions = {}): string {
	const now = options.now ?? new Date();
	const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
	const scoreThreshold = options.scoreThreshold ?? DEFAULT_SCORE_THRESHOLD;
	const maxProcedurePreference = options.maxProcedurePreference ?? DEFAULT_MAX_PROCEDURE_PREFERENCE;
	const maxEventProfile = options.maxEventProfile ?? DEFAULT_MAX_EVENT_PROFILE;
	const maxForced = options.maxForced ?? DEFAULT_MAX_FORCED;

	const sorted = [...hits].sort((a, b) => b.score - a.score);
	const lines: string[] = [];
	const selectedIds: string[] = [];
	let forced = 0;
	let procedurePreference = 0;
	let eventProfile = 0;
	let total = 0;

	for (const hit of sorted) {
		const isForced =
			hit.memoryType === "procedure" &&
			typeof hit.extra?.tool_requirement === "string" &&
			hit.extra.tool_requirement.trim().length > 0;
		if (!isForced && hit.score < scoreThreshold) continue;
		if (isForced) {
			if (forced >= maxForced) continue;
			forced++;
		} else if (hit.memoryType === "procedure" || hit.memoryType === "preference") {
			if (procedurePreference >= maxProcedurePreference) continue;
			procedurePreference++;
		} else {
			if (eventProfile >= maxEventProfile) continue;
			eventProfile++;
		}
		const line = formatRichHitLine(hit, now);
		const addLen = line.length + (lines.length > 0 ? 1 : 0);
		if (total + addLen > maxChars) break;
		lines.push(line);
		selectedIds.push(hit.id);
		total += addLen;
	}
	if (lines.length === 0) return "";
	const ids = selectedIds.length > 0 ? ` <!-- ids: ${selectedIds.join(",")} -->` : "";
	return `## 记忆检索\n${lines.join("\n")}${ids}`;
}
