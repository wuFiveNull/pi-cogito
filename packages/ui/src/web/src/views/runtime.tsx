import { useEffect, useState } from "react";
import { api, formatTime, type McpServerEntry, type MemoryRow, type RuntimeOverview, type SkillInfo } from "../api.ts";

type RuntimeTab = "documents" | "skills" | "mcp" | "jobs";

interface RuntimeJob {
	key: string;
	name: string;
	description: string;
	last_user_at: number | null;
	last_proactive_at: number | null;
	state: Record<string, string>;
}

interface SkillDetail extends SkillInfo {
	content: string;
}

const TABS: Array<{ id: RuntimeTab; label: string }> = [
	{ id: "documents", label: "文档" },
	{ id: "skills", label: "Skills" },
	{ id: "mcp", label: "MCP" },
	{ id: "jobs", label: "运行状态" },
];

export function RuntimeView() {
	const [tab, setTab] = useState<RuntimeTab>("skills");
	const [overview, setOverview] = useState<RuntimeOverview | null>(null);
	const [skills, setSkills] = useState<SkillInfo[]>([]);
	const [mcp, setMcp] = useState<Record<string, McpServerEntry>>({});
	const [documents, setDocuments] = useState<MemoryRow[]>([]);
	const [jobs, setJobs] = useState<RuntimeJob[]>([]);
	const [selected, setSelected] = useState<{ title: string; subtitle: string; body: string } | null>(null);
	const [error, setError] = useState("");
	const [loading, setLoading] = useState(true);

	const load = (nextTab: RuntimeTab) => {
		setLoading(true);
		setError("");
		setSelected(null);
		Promise.all([
			api.runtimeOverview().catch(() => null),
			api.listSkills().catch(() => ({ items: [] as SkillInfo[] })),
			api.listMcp().catch(() => ({ servers: {} as Record<string, McpServerEntry> })),
			api.listMemories(1, 50).catch(() => ({ items: [] as MemoryRow[] })),
			fetch("/api/runtime/jobs").then((res) => res.json() as Promise<{ items: RuntimeJob[] }>).catch(() => ({ items: [] as RuntimeJob[] })),
		])
			.then(([ov, skillsPage, mcpData, memPage, jobsData]) => {
				setOverview(ov);
				setSkills(skillsPage.items);
				setMcp(mcpData.servers);
				setDocuments(memPage.items);
				setJobs(jobsData.items);
			})
			.catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
			.finally(() => setLoading(false));
		void nextTab;
	};

	useEffect(() => {
		load(tab);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const openSkill = (skill: SkillInfo) => {
		setSelected(null);
		fetch(`/api/runtime/skills/${encodeURIComponent(skill.name)}`)
			.then((res) => res.json() as Promise<SkillDetail>)
			.then((detail) => setSelected({ title: detail.name, subtitle: detail.description, body: detail.content }))
			.catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
	};

	const openDocument = (memory: MemoryRow) => {
		setSelected({
			title: memory.summary,
			subtitle: `${memory.memory_type} · 强化 ×${memory.reinforcement} · ${formatTime(memory.updated_at)}`,
			body: memory.summary,
		});
	};

	return (
		<div className="panel-view">
			<header className="panel-header">
				<div>
					<h1>知识与运行</h1>
					<p>当前电脑的只读投影 · 记忆文档 · drift skills · MCP · 运行状态</p>
				</div>
				<div className="panel-header__actions">
					<button type="button" className="btn" onClick={() => load(tab)} disabled={loading}>
						{loading ? "正在刷新" : "刷新"}
					</button>
					{error && <span className="error-text">{error}</span>}
				</div>
			</header>

			<section className="metric-row">
				<MetricCard label="文档(记忆)" value={overview?.documents ?? documents.length} />
				<MetricCard label="Drift Skills" value={overview?.skills ?? 0} />
				<MetricCard label="MCP Servers" value={overview?.mcp_servers ?? 0} />
			</section>

			<nav className="tabs" role="tablist">
				{TABS.map((item) => (
					<button
						key={item.id}
						type="button"
						role="tab"
						className={tab === item.id ? "active" : ""}
						onClick={() => {
							setTab(item.id);
							load(item.id);
						}}
					>
						{item.label}
					</button>
				))}
			</nav>

			<div className={`runtime-directory ${selected ? "detail-open" : ""}`}>
				<div className="runtime-directory__list">
					{tab === "documents" && (
						<>
							<header><h2>文档</h2><p>记忆引擎中的知识条目</p></header>
							{documents.length === 0 && <p className="empty-hint">暂无记忆条目</p>}
							{documents.map((memory) => (
								<button key={memory.id} type="button" className="directory-item" onClick={() => openDocument(memory)}>
									<span className="directory-item__title">{memory.summary}</span>
									<span className="directory-item__meta">{memory.memory_type} · 强化 ×{memory.reinforcement}</span>
								</button>
							))}
						</>
					)}

					{tab === "skills" && (
						<>
							<header><h2>Skills</h2><p>drift 技能目录</p></header>
							{skills.length === 0 && <p className="empty-hint">没有已安装的 skill</p>}
							{skills.map((skill) => (
								<button key={skill.name} type="button" className="directory-item" onClick={() => openSkill(skill)}>
									<span className="directory-item__title">{skill.name}</span>
									<span className="directory-item__meta">{skill.description || "无描述"}</span>
								</button>
							))}
						</>
					)}

					{tab === "mcp" && (
						<>
							<header><h2>MCP</h2><p>已配置的 MCP 服务</p></header>
							{Object.keys(mcp).length === 0 && <p className="empty-hint">没有配置 MCP 服务</p>}
							{Object.entries(mcp).map(([name, entry]) => (
								<button
									key={name}
									type="button"
									className="directory-item"
									onClick={() => setSelected({ title: name, subtitle: "MCP 服务", body: `命令: ${entry.command}${entry.args?.length ? ` ${entry.args.join(" ")}` : ""}` })}
								>
									<span className="directory-item__title">{name}</span>
									<span className="directory-item__meta"><code>{entry.command}</code></span>
								</button>
							))}
						</>
					)}

					{tab === "jobs" && (
						<>
							<header><h2>运行状态</h2><p>presence 与 pusher 状态</p></header>
							{jobs.length === 0 && <p className="empty-hint">暂无运行数据(需先运行 proactive pusher)</p>}
							{jobs.map((job) => (
								<button
									key={job.key}
									type="button"
									className="directory-item"
									onClick={() => setSelected({
										title: job.name,
										subtitle: job.description,
										body: JSON.stringify(job.state, null, 2),
									})}
								>
									<span className="directory-item__title">{job.name}</span>
									<span className="directory-item__meta">
										用户活跃: {job.last_user_at ? formatTime(job.last_user_at) : "—"}
									</span>
								</button>
							))}
						</>
					)}
				</div>

				<aside className="runtime-directory__detail">
					{selected ? (
						<>
							<h3>{selected.title}</h3>
							<p className="detail-sub">{selected.subtitle}</p>
							<pre className="detail-body">{selected.body}</pre>
						</>
					) : (
						<p className="empty-hint">在左侧选择要查看的内容</p>
					)}
				</aside>
			</div>
		</div>
	);
}

function MetricCard({ label, value }: { label: string; value: number }) {
	return (
		<div className="metric-card">
			<div className="metric-card__value">{value}</div>
			<div className="metric-card__label">{label}</div>
		</div>
	);
}
