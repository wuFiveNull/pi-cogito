import { useEffect, useState } from "react";
import {
	api,
	formatRelative,
	formatTime,
	type ChatMessageRow,
	type DeliveryRow,
	type DriftActiveRunRow,
	type DriftRunDiagnostics,
	type MemoryRow,
	type PluginPanel,
	type ProactiveOverview,
	type SessionRow,
	type TickLogRow,
	type TickStepRow,
	type UsageBucketRow,
	type UsageOverview,
	type WebPluginInfo,
} from "../api.ts";
import { MessageView } from "../message-view.tsx";

type DashboardTab = "sessions" | "tick" | "deliveries" | "drift" | "memories" | "usage" | "plugins";

/**
 * 插件 tab 暂时隐藏(宿主尚未注册任何 WebPlugin,面板恒为空)。
 * 恢复显示:改为 true。
 */
const PLUGINS_TAB_ENABLED = false;

export function DashboardView() {
	const [tab, setTab] = useState<DashboardTab>("tick");
	const [overview, setOverview] = useState<ProactiveOverview | null>(null);
	const [ticks, setTicks] = useState<TickLogRow[]>([]);
	const [selectedTick, setSelectedTick] = useState<TickLogRow | null>(null);
	const [tickSteps, setTickSteps] = useState<TickStepRow[]>([]);
	const [deliveries, setDeliveries] = useState<DeliveryRow[]>([]);
	const [driftRuns, setDriftRuns] = useState<DriftActiveRunRow[]>([]);
	const [selectedDriftRun, setSelectedDriftRun] = useState<DriftActiveRunRow | null>(null);
	const [driftDiagnostics, setDriftDiagnostics] = useState<DriftRunDiagnostics | null>(null);
	const [memories, setMemories] = useState<MemoryRow[]>([]);
	const [selectedMemory, setSelectedMemory] = useState<MemoryRow | null>(null);
	const [selectedMemoryIds, setSelectedMemoryIds] = useState<Set<string>>(() => new Set());
	const [similarMemories, setSimilarMemories] = useState<Array<MemoryRow & { score: number }>>([]);
	const [similarNote, setSimilarNote] = useState("");
	const [sessions, setSessions] = useState<SessionRow[]>([]);
	const [activeSession, setActiveSession] = useState<SessionRow | null>(null);
	const [sessionMessages, setSessionMessages] = useState<ChatMessageRow[]>([]);
	const [usage, setUsage] = useState<UsageOverview | null>(null);
	const [error, setError] = useState("");
	const [actionFilter, setActionFilter] = useState<string>("");
	const [plugins, setPlugins] = useState<WebPluginInfo[]>([]);
	const [pluginPanel, setPluginPanel] = useState<PluginPanel | null>(null);
	const [activePlugin, setActivePlugin] = useState("");
	const [pluginContainer, setPluginContainer] = useState<HTMLDivElement | null>(null);
	const [pluginModuleError, setPluginModuleError] = useState("");

	const load = (filter = actionFilter) => {
		setError("");
		api.proactiveOverview().catch(() => null).then(setOverview);
		api.listTickLogs(1, filter ? 200 : 50, filter)
			.then((page) => setTicks(page.items))
			.catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
		api.listDeliveries()
			.then((page) => {
				setDeliveries(page.items);
				// outlet 已展示:未确认的投递标记为已确认(同时回写 drift run 的 sent 状态)。
				const unacked = page.items.filter((item) => item.acked === 0).map((item) => item.id);
				if (unacked.length > 0) api.ackDeliveries(unacked).catch(() => {});
			})
			.catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
		api.listDriftActiveRuns().then((page) => setDriftRuns(page.items)).catch(() => setDriftRuns([]));
		api.listMemories().then((page) => setMemories(page.items)).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
		api.listSessions().then((page) => setSessions(page.items)).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
		api.usageOverview().then(setUsage).catch(() => setUsage(null));
		api.listPlugins().then((page) => setPlugins(page.items)).catch(() => setPlugins([]));
	};

	// actionFilter 变化时按服务端过滤重新拉取 tick(客户端过滤只作用于当前页,翻不到历史行)。
	useEffect(() => {
		load();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [actionFilter]);

	const openSession = (session: SessionRow) => {
		setActiveSession(session);
		setSessionMessages([]);
		api.listMessages(session.key)
			.then((page) => setSessionMessages(page.items))
			.catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
	};

	const openTick = (tick: TickLogRow) => {
		setTickSteps([]);
		api.getTickLog(tick.id)
			.then(setSelectedTick)
			.catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
		api.listTickSteps(tick.id)
			.then((page) => setTickSteps(page.items))
			.catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
	};

	const openDriftRun = (run: DriftActiveRunRow) => {
		setSelectedDriftRun(run);
		setDriftDiagnostics(null);
		api.getDriftDiagnostics(run.run_id)
			.then(setDriftDiagnostics)
			.catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
	};

	const openPlugin = (plugin: WebPluginInfo) => {
		setActivePlugin(plugin.id);
		setPluginPanel(null);
		setPluginModuleError("");
		api.getPluginPanel(plugin.id)
			.then(setPluginPanel)
			.catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
	};

	// 模块插件:动态加载源码并 mount
	useEffect(() => {
		if (!pluginContainer) return;
		const plugin = plugins.find((item) => item.id === activePlugin);
		if (!plugin?.hasModule) return;
		let cancelled = false;
		api.getPluginModule(plugin.id)
			.then(async (source) => {
				if (cancelled) return;
				const blob = new Blob([source], { type: "application/javascript" });
				const url = URL.createObjectURL(blob);
				try {
					const module = (await import(/* @vite-ignore */ url)) as {
						mount?: (container: HTMLElement, ctx: { api: typeof api }) => void;
					};
					module.mount?.(pluginContainer, { api });
				} finally {
					URL.revokeObjectURL(url);
				}
			})
			.catch((err: unknown) => setPluginModuleError(err instanceof Error ? err.message : String(err)));
		return () => {
			cancelled = true;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [activePlugin, pluginContainer]);

	const openMemory = (memory: MemoryRow) => {
		setSelectedMemory(memory);
		setSimilarMemories([]);
		setSimilarNote("");
		api.similarMemories(memory.id)
			.then((result) => {
				setSimilarMemories(result.items);
				setSimilarNote(result.note);
			})
			.catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
	};

	const toggleMemorySelection = (id: string) => {
		setSelectedMemoryIds((current) => {
			const next = new Set(current);
			if (next.has(id)) {
				next.delete(id);
			} else {
				next.add(id);
			}
			return next;
		});
	};

	const batchDelete = async () => {
		if (selectedMemoryIds.size === 0) return;
		try {
			const result = await api.batchDeleteMemories([...selectedMemoryIds]);
			setMemories((current) => current.filter((item) => !selectedMemoryIds.has(item.id)));
			setSelectedMemoryIds(new Set());
			setSelectedMemory(null);
			setError(result.deleted > 0 ? "" : "没有删除任何记忆");
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	};

	const deleteMemory = async (memory: MemoryRow) => {
		try {
			const response = await fetch(`/api/dashboard/memories/${encodeURIComponent(memory.id)}`, { method: "DELETE" });
			if (!response.ok) throw new Error(`删除失败: ${response.status}`);
			setMemories((current) => current.filter((item) => item.id !== memory.id));
			setSelectedMemory(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	};

	const actionTotal = overview ? Object.values(overview.action_counts).reduce((sum, n) => sum + n, 0) : 0;
	const filteredTicks = actionFilter ? ticks.filter((tick) => tick.action === actionFilter) : ticks;

	return (
		<div className="panel-view">
			<header className="panel-header">
				<div>
					<h1>监控</h1>
					<p>会话 · proactive tick · 投递 · 记忆</p>
				</div>
				{error && <span className="error-text">{error}</span>}
			</header>

			<section className="metric-row">
				<MetricCard label="Ticks" value={actionTotal} />
				<MetricCard label="已投递消息" value={overview?.delivery_count ?? 0} />
				<MetricCard label="候选条目" value={overview?.item_counts.total ?? 0} />
				<MetricCard label="待处理" value={overview?.item_counts.new ?? 0} />
			</section>

			<nav className="tabs" role="tablist">
				<button type="button" role="tab" className={tab === "sessions" ? "active" : ""} onClick={() => setTab("sessions")}>会话</button>
				<button type="button" role="tab" className={tab === "tick" ? "active" : ""} onClick={() => setTab("tick")}>Tick 记录</button>
				<button type="button" role="tab" className={tab === "deliveries" ? "active" : ""} onClick={() => setTab("deliveries")}>投递</button>
				<button type="button" role="tab" className={tab === "drift" ? "active" : ""} onClick={() => setTab("drift")}>Drift 运行</button>
				<button type="button" role="tab" className={tab === "memories" ? "active" : ""} onClick={() => setTab("memories")}>记忆</button>
				<button type="button" role="tab" className={tab === "usage" ? "active" : ""} onClick={() => setTab("usage")}>用量</button>
				{PLUGINS_TAB_ENABLED && (
					<button type="button" role="tab" className={tab === "plugins" ? "active" : ""} onClick={() => setTab("plugins")}>插件</button>
				)}
			</nav>

			{tab === "sessions" && (
				<div className="dashboard-split">
					<div className="session-panel-inline">
						{sessions.map((session) => (
							<button
								key={session.key}
								type="button"
								className={`session-item ${activeSession?.key === session.key ? "active" : ""}`}
								onClick={() => openSession(session)}
							>
								<span className="session-item__title">{session.title}</span>
								<span className="session-item__meta">
									{session.message_count} 条 · {formatRelative(session.updated_at)}
								</span>
							</button>
						))}
						{sessions.length === 0 && <p className="empty-hint">暂无会话</p>}
					</div>
					<div className="session-messages">
						{sessionMessages.length === 0 && <p className="empty-hint">{activeSession ? "该会话没有消息" : "选择左侧会话查看消息"}</p>}
						{sessionMessages.map((message) => (
							<div key={message.id} className={`msg-row ${message.role}`}>
								<div className="msg-bubble">
									<MessageView message={message} />
								</div>
							</div>
						))}
					</div>
				</div>
			)}

			{tab === "tick" && (
				<div className="dashboard-split">
					<div className="table-wrap">
						<div className="filter-row">
							<button type="button" className={`filter-chip ${actionFilter === "" ? "active" : ""}`} onClick={() => setActionFilter("")}>
								全部 ({ticks.length})
							</button>
							{Object.entries(overview?.action_counts ?? {}).map(([action, count]) => (
								<button
									key={action}
									type="button"
									className={`filter-chip ${actionFilter === action ? "active" : ""}`}
									onClick={() => setActionFilter(actionFilter === action ? "" : action)}
								>
									{action} ({count})
								</button>
							))}
						</div>
						<table className="data-table">
							<thead>
								<tr>
									<th>时间</th>
									<th>Action</th>
									<th>Skip</th>
									<th>候选</th>
									<th>步数</th>
									<th>分数</th>
								</tr>
							</thead>
							<tbody>
								{filteredTicks.map((tick) => (
									<tr key={tick.id} className="clickable" onClick={() => openTick(tick)}>
										<td>{formatTime(tick.started_at)}</td>
										<td><span className={`tag tag-${tick.action}`}>{tick.action}</span></td>
										<td className="muted">{tick.skip_reason || "—"}</td>
										<td>{tick.candidates}</td>
										<td>{tick.steps}</td>
										<td>{tick.base_score !== null ? tick.base_score.toFixed(2) : "—"}</td>
									</tr>
								))}
								{filteredTicks.length === 0 && (
									<tr><td colSpan={6} className="empty-hint">暂无 tick 记录</td></tr>
								)}
							</tbody>
						</table>
					</div>
					{selectedTick && (
						<aside className="detail-panel">
							<header>
								<h3>Tick #{selectedTick.id}</h3>
								<button type="button" className="icon-btn" onClick={() => setSelectedTick(null)}>✕</button>
							</header>
							<dl className="detail-list">
								<dt>开始</dt><dd>{formatTime(selectedTick.started_at)}</dd>
								<dt>结束</dt><dd>{formatTime(selectedTick.finished_at)}</dd>
								<dt>Action</dt><dd><span className={`tag tag-${selectedTick.action}`}>{selectedTick.action}</span></dd>
								<dt>Skip 原因</dt><dd>{selectedTick.skip_reason || "—"}</dd>
								<dt>候选数</dt><dd>{selectedTick.candidates}</dd>
								<dt>步数</dt><dd>{selectedTick.steps}</dd>
								<dt>基础分</dt><dd>{selectedTick.base_score?.toFixed(2) ?? "—"}</dd>
								{selectedTick.error && <><dt>错误</dt><dd className="error-text">{selectedTick.error}</dd></>}
							</dl>
							<h4 className="steps-title">阶段回放</h4>
							<ol className="step-timeline">
								{tickSteps.map((step) => (
									<li key={step.id} className="step-item">
										<div className="step-item__head">
											<span className={`tag tag-phase tag-${step.phase}`}>{step.phase}</span>
											<span className="step-item__time">{step.duration_ms}ms</span>
										</div>
										<div className="step-item__detail">{step.detail}</div>
										{step.candidates && step.candidates.length > 0 && (
											<ul className="step-item__candidates">
												{step.candidates.map((candidate, index) => (
													<li key={index}>
														{candidate.url ? (
															<a href={candidate.url} target="_blank" rel="noreferrer">{candidate.title}</a>
														) : (
															<span>{candidate.title}</span>
														)}
													</li>
												))}
											</ul>
										)}
										{step.action_after && (
											<div className="step-item__after">
												→ <span className={`tag tag-${step.action_after}`}>{step.action_after}</span>
												{step.skip_reason_after && <span className="muted"> · {step.skip_reason_after}</span>}
											</div>
										)}
									</li>
								))}
								{tickSteps.length === 0 && <li className="muted">该 tick 没有步骤记录(旧数据或未升级)</li>}
							</ol>
						</aside>
					)}
				</div>
			)}

			{tab === "deliveries" && (
				<div className="item-list">
					{deliveries.map((delivery) => (
						<div key={delivery.id} className="item-card">
							<div className="item-card__title">{delivery.message}</div>
							<div className="item-card__meta">
								<span className={`tag tag-${delivery.action}`}>{delivery.action}</span>
								<span>{formatTime(delivery.delivered_at)}</span>
								<span className="muted">{delivery.message_hash.slice(0, 12)}…</span>
								{delivery.acked === 0 && <span className="tag tag-pending">未确认</span>}
							</div>
						</div>
					))}
					{deliveries.length === 0 && <p className="empty-hint">暂无投递记录</p>}
				</div>
			)}

			{tab === "drift" && (
				<div className="dashboard-split">
					<div className="table-wrap">
						<table className="data-table">
							<thead>
								<tr>
									<th>Run ID</th>
									<th>Skill</th>
									<th>Session</th>
									<th>阶段</th>
									<th>更新时间</th>
								</tr>
							</thead>
							<tbody>
								{driftRuns.map((run) => (
									<tr key={run.run_id} className="clickable" onClick={() => openDriftRun(run)}>
										<td className="mono">{run.run_id}</td>
										<td>{run.skill_name || "—"}</td>
										<td>{run.session_key}</td>
										<td><span className={`tag tag-${run.stage}`}>{run.stage}</span></td>
										<td>{formatTime(run.updated_at)}</td>
									</tr>
								))}
								{driftRuns.length === 0 && <tr><td colSpan={5} className="empty-hint">暂无 active Drift run</td></tr>}
							</tbody>
						</table>
					</div>
					{selectedDriftRun && (
						<aside className="detail-panel">
							<header>
								<h3>{selectedDriftRun.run_id}</h3>
								<button type="button" className="icon-btn" onClick={() => {
									setSelectedDriftRun(null);
									setDriftDiagnostics(null);
								}}>✕</button>
							</header>
							{driftDiagnostics ? (
								<>
									<dl className="detail-list">
										<dt>阶段</dt><dd>{selectedDriftRun.stage}</dd>
										<dt>Skill</dt><dd>{selectedDriftRun.skill_name || "—"}</dd>
										<dt>步骤数</dt><dd>{driftDiagnostics.steps.length}</dd>
									</dl>
									<h4 className="steps-title">工具步骤</h4>
									<ol className="step-timeline">
										{driftDiagnostics.steps.map((step) => (
											<li key={step.id} className="step-item">
												<div className="step-item__head">
													<span className="tag tag-phase">{step.tool_name}</span>
													<span className="step-item__time">#{step.step_index}</span>
												</div>
												<div className="step-item__detail">{step.output_preview || step.input_preview || "—"}</div>
											</li>
										))}
										{driftDiagnostics.steps.length === 0 && <li className="muted">暂无工具步骤</li>}
									</ol>
									{driftDiagnostics.run && <pre className="detail-body">{JSON.stringify(driftDiagnostics.run, null, 2)}</pre>}
								</>
							) : <p className="empty-hint">正在加载诊断…</p>}
						</aside>
					)}
				</div>
			)}

			{tab === "memories" && (
				<div className="dashboard-split">
					<div className="item-list">
						<div className="batch-bar">
							<span className="muted">已选 {selectedMemoryIds.size} 条</span>
							<button type="button" className="btn danger" disabled={selectedMemoryIds.size === 0} onClick={() => void batchDelete()}>
								批量删除
							</button>
						</div>
						{memories.map((memory) => (
							<div key={memory.id} className={`item-card clickable ${selectedMemoryIds.has(memory.id) ? "selected" : ""}`} onClick={() => openMemory(memory)}>
								<div className="item-card__title">
									<input
										type="checkbox"
										checked={selectedMemoryIds.has(memory.id)}
										onClick={(event) => event.stopPropagation()}
										onChange={() => toggleMemorySelection(memory.id)}
									/>
									<span>{memory.summary}</span>
								</div>
								<div className="item-card__meta">
									<span className={`tag tag-${memory.memory_type}`}>{memory.memory_type}</span>
									<span>强化 ×{memory.reinforcement}</span>
									<span className="muted">{formatTime(memory.updated_at)}</span>
								</div>
							</div>
						))}
						{memories.length === 0 && <p className="empty-hint">暂无记忆</p>}
					</div>
					{selectedMemory && (
						<aside className="detail-panel">
							<header>
								<h3>记忆详情</h3>
								<div>
									<button type="button" className="icon-btn danger" onClick={() => void deleteMemory(selectedMemory)}>删除</button>
									<button type="button" className="icon-btn" onClick={() => setSelectedMemory(null)}>✕</button>
								</div>
							</header>
							<dl className="detail-list">
								<dt>ID</dt><dd className="mono">{selectedMemory.id.slice(0, 18)}…</dd>
								<dt>类型</dt><dd>{selectedMemory.memory_type}</dd>
								<dt>摘要</dt><dd>{selectedMemory.summary}</dd>
								<dt>强化</dt><dd>×{selectedMemory.reinforcement}</dd>
								<dt>情绪权重</dt><dd>{selectedMemory.emotional_weight}</dd>
								<dt>状态</dt><dd>{selectedMemory.status}</dd>
								<dt>创建</dt><dd>{formatTime(selectedMemory.created_at)}</dd>
								<dt>更新</dt><dd>{formatTime(selectedMemory.updated_at)}</dd>
							</dl>
							<h4 className="steps-title">相似记忆</h4>
							{similarNote && <p className="muted step-item__time">{similarNote}</p>}
							<ul className="similar-list">
								{similarMemories.map((similar) => (
									<li key={similar.id}>
										<span className="similar-list__score">{similar.score.toFixed(3)}</span>
										<span>{similar.summary}</span>
									</li>
								))}
								{similarMemories.length === 0 && !similarNote && <li className="muted">无相似记忆</li>}
							</ul>
						</aside>
					)}
				</div>
			)}
			{tab === "usage" && usage && (
				<div className="usage-view">
					<section className="metric-row">
						<MetricCard label="总 Tokens" value={fmtTokens(usage.totals.totalTokens)} />
						<MetricCard label="缓存命中率" value={`${usage.totals.cacheHitRate.toFixed(1)}%`} />
						<MetricCard label="总成本" value={fmtCost(usage.totals.cost)} />
						<MetricCard label="调用次数" value={String(usage.totals.calls)} />
						<MetricCard
							label="日均(有记录天数)"
							value={fmtTokens(usage.totals.totalTokens / Math.max(1, usage.days.length))}
						/>
					</section>
					<div className="dashboard-split">
						<div className="usage-channels">
							<h4 className="steps-title">渠道分布</h4>
							<table className="data-table">
								<thead>
									<tr><th>渠道</th><th>Tokens</th><th>占比</th><th>成本</th></tr>
								</thead>
								<tbody>
									{usage.channels.map((channel) => (
										<tr key={channel.channel}>
											<td><span className={`tag tag-${channel.channel}`}>{channel.channel}</span></td>
											<td>{fmtTokens(channel.totalTokens)}</td>
											<td>
												<div className="usage-bar-row">
													<div
														className="usage-bar-inline"
														style={{ width: `${(channel.totalTokens / Math.max(1, usage.totals.totalTokens)) * 100}%` }}
													/>
												</div>
											</td>
											<td>{fmtCost(channel.cost)}</td>
										</tr>
									))}
									{usage.channels.length === 0 && (
										<tr><td colSpan={4} className="empty-hint">暂无用量记录</td></tr>
									)}
								</tbody>
							</table>
						</div>
						<UsageCalendar days={usage.days} />
					</div>
				</div>
			)}
			{PLUGINS_TAB_ENABLED && tab === "plugins" && (
				<div className="dashboard-split">
					<div className="session-panel-inline">
						{plugins.map((plugin) => (
							<button
								key={plugin.id}
								type="button"
								className={`session-item ${activePlugin === plugin.id ? "active" : ""}`}
								onClick={() => openPlugin(plugin)}
							>
								<span className="session-item__title">{plugin.name}</span>
								{plugin.description && <span className="session-item__meta">{plugin.description}</span>}
							</button>
						))}
						{plugins.length === 0 && <p className="empty-hint">暂无插件面板(宿主可通过 createWebApi 的 plugins 选项注册)</p>}
					</div>
					<div className="table-wrap">
						<div ref={setPluginContainer} className="plugin-module-host" />
						{pluginModuleError && <p className="error-text">{pluginModuleError}</p>}
						{pluginPanel ? (
							<table className="data-table">
								<thead>
									<tr>
										{pluginPanel.columns.map((column) => <th key={column.key}>{column.label}</th>)}
									</tr>
								</thead>
								<tbody>
									{pluginPanel.rows.map((row, index) => (
										<tr key={index}>
											{pluginPanel.columns.map((column) => (
												<td key={column.key}>{formatCell(row[column.key])}</td>
											))}
										</tr>
									))}
									{pluginPanel.rows.length === 0 && (
										<tr><td colSpan={pluginPanel.columns.length} className="empty-hint">面板暂无数据</td></tr>
									)}
								</tbody>
							</table>
						) : (
							<p className="empty-hint">{activePlugin ? "正在加载面板…" : "选择左侧插件查看面板"}</p>
						)}
					</div>
				</div>
			)}
		</div>
	);
}

function formatCell(value: unknown): string {
	if (value === null || value === undefined) return "—";
	if (typeof value === "object") {
		try {
			return JSON.stringify(value);
		} catch {
			return String(value);
		}
	}
	return String(value);
}

function MetricCard({ label, value }: { label: string; value: number | string }) {
	return (
		<div className="metric-card">
			<div className="metric-card__value">{value}</div>
			<div className="metric-card__label">{label}</div>
		</div>
	);
}

const WEEKDAY_LABELS = ["一", "二", "三", "四", "五", "六", "日"];

/** 月历用量视图:一行一周,单元格显示当日用量,悬浮显示明细,可切换月份。 */
function UsageCalendar({ days }: { days: UsageBucketRow[] }) {
	const now = new Date();
	const [viewYear, setViewYear] = useState(now.getFullYear());
	const [viewMonth, setViewMonth] = useState(now.getMonth());
	const [hoverKey, setHoverKey] = useState<string | null>(null);

	const dayMap = new Map(days.map((day) => [day.label, day]));
	const monthPrefix = `${viewYear}-${String(viewMonth + 1).padStart(2, "0")}`;
	const firstDay = new Date(viewYear, viewMonth, 1);
	const leadingBlanks = (firstDay.getDay() + 6) % 7; // 周一为一周起点
	const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();

	const weeks: Array<Array<number | null>> = [];
	let week: Array<number | null> = [];
	for (let slot = 0; slot < leadingBlanks; slot++) week.push(null);
	for (let day = 1; day <= daysInMonth; day++) {
		week.push(day);
		if (week.length === 7) {
			weeks.push(week);
			week = [];
		}
	}
	while (week.length < 7) week.push(null);
	if (week.some((day) => day !== null)) weeks.push(week);

	const monthTokens = (day: number): number =>
		dayMap.get(`${monthPrefix}-${String(day).padStart(2, "0")}`)?.totalTokens ?? 0;
	const monthMax = Math.max(
		1,
		...Array.from({ length: daysInMonth }, (_, index) => monthTokens(index + 1)),
	);
	const hoverRow = hoverKey ? dayMap.get(hoverKey) : undefined;

	const shiftMonth = (delta: number): void => {
		let month = viewMonth + delta;
		let year = viewYear;
		if (month < 0) {
			month = 11;
			year -= 1;
		} else if (month > 11) {
			month = 0;
			year += 1;
		}
		setViewMonth(month);
		setViewYear(year);
		setHoverKey(null);
	};
	const isCurrentMonth = viewYear === now.getFullYear() && viewMonth === now.getMonth();

	return (
		<div className="usage-calendar">
			<div className="filter-row">
				<h4 className="steps-title">月度用量</h4>
				<button type="button" className="icon-btn" onClick={() => shiftMonth(-1)}>‹</button>
				<span className="usage-calendar__month">{viewYear} 年 {viewMonth + 1} 月</span>
				<button type="button" className="icon-btn" onClick={() => shiftMonth(1)}>›</button>
				{!isCurrentMonth && (
					<button type="button" className="filter-chip" onClick={() => { setViewYear(now.getFullYear()); setViewMonth(now.getMonth()); setHoverKey(null); }}>
						回到本月
					</button>
				)}
			</div>
			{hoverRow && (
				<div className="usage-calendar__tip">
					<span className="usage-calendar__tip-date">{hoverRow.label}</span>
					<span>Tokens {hoverRow.totalTokens.toLocaleString()}（{fmtTokens(hoverRow.totalTokens)}）</span>
					<span>缓存命中率 {hoverRow.cacheHitRate.toFixed(1)}%</span>
					<span>输入 {fmtTokens(hoverRow.input)} · 输出 {fmtTokens(hoverRow.output)}</span>
					<span>调用 {hoverRow.calls} 次 · 成本 {fmtCost(hoverRow.cost)}</span>
				</div>
			)}
			<div className="usage-calendar__grid">
				{WEEKDAY_LABELS.map((label) => (
					<div key={label} className="usage-calendar__weekday">{label}</div>
				))}
				{weeks.flatMap((row) => row).map((day, index) => {
					if (day === null) return <div key={`blank-${index}`} className="usage-calendar__cell blank" />;
					const key = `${monthPrefix}-${String(day).padStart(2, "0")}`;
					const row = dayMap.get(key);
					return (
						<div
							key={key}
							className={`usage-calendar__cell ${row ? "has-usage" : ""} ${hoverKey === key ? "hover" : ""}`}
							onMouseEnter={() => setHoverKey(key)}
							onMouseLeave={() => setHoverKey(null)}
						>
							<span className="usage-calendar__daynum">{day}</span>
							{row && (
								<>
									<span className="usage-calendar__amount">{fmtTokens(row.totalTokens)}</span>
									<span
										className="usage-calendar__bar"
										style={{ width: `${Math.max(8, (row.totalTokens / monthMax) * 100)}%` }}
									/>
								</>
							)}
						</div>
					);
				})}
			</div>
		</div>
	);
}

function fmtTokens(tokens: number): string {
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2)}M`;
	if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
	return String(Math.round(tokens));
}

function fmtCost(cost: number): string {
	if (cost >= 1) return `$${cost.toFixed(2)}`;
	if (cost >= 0.001) return `$${cost.toFixed(4)}`;
	if (cost > 0) return `$${cost.toFixed(6)}`;
	return "$0";
}
