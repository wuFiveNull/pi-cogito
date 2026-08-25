/** API 客户端与共享类型(对应 packages/ui/src/web-api.ts 的端点)。 */

export interface SessionRow {
	key: string;
	title: string;
	message_count: number;
	updated_at: string | null;
	first_message_content: string;
}

export interface ChatMessagePart {
	type: string;
	text?: string;
	thinking?: string;
	name?: string;
	arguments?: unknown;
	mimeType?: string;
	data?: string;
}

export interface ChatMessageRow {
	id: string;
	role: "user" | "assistant";
	content: string;
	timestamp: string;
	parts?: ChatMessagePart[];
}

export interface SkillInfo {
	name: string;
	description: string;
	path: string;
}

export interface TickLogRow {
	id: number;
	started_at: number;
	finished_at: number | null;
	base_score: number | null;
	candidates: number;
	steps: number;
	action: string;
	skip_reason: string;
	error: string | null;
}

export interface TickStepRow {
	id: number;
	tick_id: number;
	step_index: number;
	phase: string;
	detail: string;
	action_after: string;
	skip_reason_after: string;
	duration_ms: number;
}

export interface DeliveryRow {
	id: number;
	message: string;
	message_hash: string;
	source_refs: string;
	evidence: string;
	action: string;
	state_summary_tag: string;
	delivered_at: number;
	acked: number;
}

export interface MemoryRow {
	id: string;
	memory_type: string;
	summary: string;
	reinforcement: number;
	emotional_weight: number;
	status: string;
	created_at: string;
	updated_at: string;
}

export interface PageResult<T> {
	items: T[];
	total: number;
	page?: number;
	page_size?: number;
}

export interface ProactiveOverview {
	action_counts: Record<string, number>;
	skip_reason_counts: Record<string, number>;
	delivery_count: number;
	item_counts: { total: number; new: number; pushed: number };
	last_tick: TickLogRow | null;
}

export interface DriftActiveRunRow {
	run_id: string;
	session_key: string;
	started_at: string;
	updated_at: string;
	stage: string;
	skill_name: string;
	message_hash: string | null;
}

export interface DriftRunDiagnostics {
	run: Record<string, unknown> | null;
	active: DriftActiveRunRow | null;
	steps: Array<{
		id: number;
		run_id: number | null;
		run_key: string | null;
		step_index: number;
		tool_name: string;
		input_preview: string;
		output_preview: string;
		created_at: string;
	}>;
}

export interface RuntimeOverview {
	skills: number;
	mcp_servers: number;
	sources: number;
	documents?: number;
}

export interface UsageTotals {
	totalTokens: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cacheHitRate: number;
	reasoning: number;
	cost: number;
	calls: number;
}

export interface UsageChannelRow extends UsageTotals {
	channel: string;
}

export interface UsageBucketRow {
	label: string;
	short: string;
	totalTokens: number;
	input: number;
	output: number;
	cacheHitRate: number;
	cost: number;
	calls: number;
}

export interface UsageOverview {
	totals: UsageTotals;
	channels: UsageChannelRow[];
	days: UsageBucketRow[];
}

export interface McpServerEntry {
	command: string;
	args?: string[];
	env?: Record<string, string>;
}

export interface AgentTickSettings {
	model: string;
	apiBaseUrl: string;
	apiKey: string;
	reasoningEffort: string;
	contextWindow: number;
	maxOutputTokens: number;
}

export interface WebPluginInfo {
	id: string;
	name: string;
	description?: string;
	hasModule?: boolean;
}

export interface PluginPanel<T = Record<string, unknown>> {
	columns: Array<{ key: string; label: string }>;
	rows: T[];
}

export interface SettingsState {
	agentTick: AgentTickSettings;
	drift: { enabled: boolean; maxSteps: number; minIntervalHours: number };
}

export class ApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
	}
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
	const response = await fetch(url, init);
	const text = await response.text();
	let payload: unknown = null;
	if (text) {
		try {
			payload = JSON.parse(text);
		} catch {
			// non-JSON body
		}
	}
	if (!response.ok) {
		const detail =
			payload && typeof payload === "object" && "error" in payload
				? String((payload as { error: unknown }).error)
				: `请求失败: ${response.status}`;
		throw new ApiError(detail, response.status);
	}
	return payload as T;
}

export const api = {
	listSessions: () => requestJson<PageResult<SessionRow>>("/api/chat/sessions"),
	listMessages: (sessionKey: string) =>
		requestJson<PageResult<ChatMessageRow>>(`/api/chat/sessions/${encodeURIComponent(sessionKey)}/messages`),

	runtimeOverview: () => requestJson<RuntimeOverview>("/api/runtime/overview"),
	listSkills: () => requestJson<PageResult<SkillInfo>>("/api/runtime/skills"),
	listMcp: () => requestJson<{ servers: Record<string, McpServerEntry> }>("/api/runtime/mcp"),

	proactiveOverview: () => requestJson<ProactiveOverview>("/api/dashboard/proactive/overview"),
	usageOverview: () => requestJson<UsageOverview>("/api/dashboard/usage"),
	listTickLogs: (page = 1, pageSize = 30, action = "") =>
		requestJson<PageResult<TickLogRow>>(
			`/api/dashboard/proactive/tick_logs?page=${page}&page_size=${pageSize}${action ? `&action=${encodeURIComponent(action)}` : ""}`,
		),
	getTickLog: (id: string | number) => requestJson<TickLogRow>(`/api/dashboard/proactive/tick_logs/${id}`),
	listTickSteps: (id: string | number) =>
		requestJson<PageResult<TickStepRow>>(`/api/dashboard/proactive/tick_logs/${id}/steps`),
	listDeliveries: (page = 1, pageSize = 30) =>
		requestJson<PageResult<DeliveryRow>>(`/api/dashboard/proactive/deliveries?page=${page}&page_size=${pageSize}`),
	listDriftActiveRuns: (page = 1, pageSize = 30) =>
		requestJson<PageResult<DriftActiveRunRow>>(
			`/api/dashboard/proactive/drift/active?page=${page}&page_size=${pageSize}`,
		),
	getDriftDiagnostics: (runId: string) =>
		requestJson<DriftRunDiagnostics>(`/api/dashboard/proactive/drift/diagnostics/${encodeURIComponent(runId)}`),
	ackDeliveries: (ids: number[]) =>
		requestJson<{ ok: boolean; acked: number; drift_runs_sent: number }>("/api/dashboard/proactive/deliveries/ack", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ ids }),
		}),

	listMemories: (page = 1, pageSize = 30) =>
		requestJson<PageResult<MemoryRow>>(`/api/dashboard/memories?page=${page}&page_size=${pageSize}`),
	similarMemories: (id: string) =>
		requestJson<{ items: Array<MemoryRow & { score: number }>; note: string }>(
			`/api/dashboard/memories/${encodeURIComponent(id)}/similar`,
		),
	batchDeleteMemories: (ids: string[]) =>
		requestJson<{ ok: boolean; deleted: number }>("/api/dashboard/memories/batch-delete", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ ids }),
		}),

	listPlugins: () => requestJson<PageResult<WebPluginInfo>>("/api/plugins"),
	getPluginPanel: (id: string) => requestJson<PluginPanel>(`/api/plugins/${encodeURIComponent(id)}`),
	getPluginModule: async (id: string): Promise<string> => {
		const response = await fetch(`/api/plugins/${encodeURIComponent(id)}/module`);
		if (!response.ok) throw new ApiError(`插件模块加载失败: ${response.status}`, response.status);
		return response.text();
	},

	getSettings: () => requestJson<SettingsState>("/api/settings/state"),
	saveSettings: (state: SettingsState) =>
		requestJson<{ ok: boolean }>("/api/settings/save", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(state),
		}),
};

export function formatTime(timestamp: string | number | null | undefined): string {
	if (timestamp === null || timestamp === undefined) return "—";
	const date = typeof timestamp === "number" ? new Date(timestamp) : new Date(timestamp);
	if (Number.isNaN(date.getTime())) return String(timestamp);
	return date.toLocaleString("zh-CN", {
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
	});
}

export function formatRelative(timestamp: string | null | undefined): string {
	if (!timestamp) return "";
	const diff = Date.now() - Date.parse(timestamp);
	if (Number.isNaN(diff)) return "";
	if (diff < 60_000) return "刚刚";
	if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
	if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
	if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
	return new Date(timestamp).toLocaleDateString("zh-CN");
}
