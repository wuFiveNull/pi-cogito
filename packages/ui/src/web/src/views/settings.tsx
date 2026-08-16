import { useEffect, useState } from "react";
import { api, type AgentTickSettings, type SettingsState } from "../api.ts";

type RuntimeKind = "api" | "opencode-go" | "codex";

const RUNTIME_META: Array<{ kind: RuntimeKind; name: string; note: string }> = [
	{ kind: "api", name: "通用 API", note: "OpenAI 兼容端点" },
	{ kind: "opencode-go", name: "OpenCode Go", note: "Zen 网关" },
	{ kind: "codex", name: "Codex", note: "OpenAI" },
];

const EFFORT_OPTIONS = ["low", "medium", "high", "extreme"];

const DEFAULT_RUNTIME: AgentTickSettings = {
	model: "deepseek-v4-flash",
	apiBaseUrl: "https://opencode.ai/zen/go/v1",
	apiKey: "",
	reasoningEffort: "",
	contextWindow: 128000,
	maxOutputTokens: 0,
};

interface RuntimeConfig extends AgentTickSettings {}

interface SettingsStateExt {
	runtimes: Record<RuntimeKind, RuntimeConfig>;
	activeRuntime: RuntimeKind;
	drift: { enabled: boolean; maxSteps: number; minIntervalHours: number };
	agentTick: AgentTickSettings;
}

export function SettingsView() {
	const [state, setState] = useState<SettingsStateExt | null>(null);
	const [kind, setKind] = useState<RuntimeKind>("api");
	const [saving, setSaving] = useState(false);
	const [saved, setSaved] = useState(false);
	const [error, setError] = useState("");
	const [models, setModels] = useState<string[]>([]);
	const [loadingModels, setLoadingModels] = useState(false);

	useEffect(() => {
		api.getSettings()
			.then((savedState) => {
				const raw = savedState as unknown as SettingsStateExt;
				const runtimes: Record<RuntimeKind, RuntimeConfig> = {
					api: { ...DEFAULT_RUNTIME, ...(raw.runtimes?.api ?? {}) },
					"opencode-go": { ...DEFAULT_RUNTIME, ...(raw.runtimes?.["opencode-go"] ?? {}) },
					codex: { ...DEFAULT_RUNTIME, ...(raw.runtimes?.codex ?? {}) },
				};
				setState({
					runtimes,
					activeRuntime: (raw.activeRuntime as RuntimeKind) ?? "api",
					drift: raw.drift ?? { enabled: false, maxSteps: 20, minIntervalHours: 3 },
					agentTick: raw.agentTick ?? DEFAULT_RUNTIME,
				});
			})
			.catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
	}, []);

	if (!state) {
		return <div className="panel-view"><p className="empty-hint">加载设置…</p>{error && <p className="error-text">{error}</p>}</div>;
	}

	const runtime = state.runtimes[kind];

	const patchRuntime = (patch: Partial<RuntimeConfig>) => {
		setState((current) => {
			if (!current) return current;
			return { ...current, runtimes: { ...current.runtimes, [kind]: { ...current.runtimes[kind], ...patch } } };
		});
		setSaved(false);
	};

	const patchDrift = (patch: Partial<SettingsState["drift"]>) => {
		setState((current) => {
			if (!current) return current;
			return { ...current, drift: { ...current.drift, ...patch } };
		});
		setSaved(false);
	};

	const probeModels = () => {
		setLoadingModels(true);
		setError("");
		const params = new URLSearchParams({ baseUrl: runtime.apiBaseUrl, apiKey: runtime.apiKey });
		fetch(`/api/settings/models?${params.toString()}`)
			.then(async (res) => {
				const body = (await res.json()) as { models?: string[]; error?: string };
				if (!res.ok) throw new Error(body.error ?? `请求失败: ${res.status}`);
				setModels(body.models ?? []);
			})
			.catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
			.finally(() => setLoadingModels(false));
	};

	const save = () => {
		setSaving(true);
		setError("");
		api.saveSettings({
			runtimes: state.runtimes,
			activeRuntime: state.activeRuntime,
			drift: state.drift,
			agentTick: state.runtimes[state.activeRuntime],
		} as unknown as SettingsState)
			.then(() => setSaved(true))
			.catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
			.finally(() => setSaving(false));
	};

	const switchRuntime = (next: RuntimeKind) => {
		setKind(next);
		setModels([]);
		setSaved(false);
	};

	return (
		<div className="panel-view">
			<header className="panel-header">
				<div>
					<h1>设置</h1>
					<p>多个 Provider runtime,切换生效配置(保存到 web-settings.json)</p>
				</div>
				<div className="panel-header__actions">
					{state.activeRuntime !== kind && (
						<span className="muted">编辑中(未生效)</span>
					)}
					{saved && <span className="ok-text">已保存</span>}
					{error && <span className="error-text">{error}</span>}
					<button type="button" className="btn primary" onClick={save} disabled={saving}>
						{saving ? "保存中…" : "保存"}
					</button>
				</div>
			</header>

			<section className="settings-section">
				<div className="runtime-switch">
					{RUNTIME_META.map((meta) => (
						<button
							key={meta.kind}
							type="button"
							className={`runtime-tab ${kind === meta.kind ? "active" : ""}`}
							onClick={() => switchRuntime(meta.kind)}
						>
							<span className="runtime-tab__name">{meta.name}</span>
							<span className="runtime-tab__note">{meta.note}</span>
							{state.activeRuntime === meta.kind && <span className="runtime-tab__active">生效中</span>}
						</button>
					))}
				</div>
				<p className="muted runtime-hint">
					当前生效: {RUNTIME_META.find((meta) => meta.kind === state.activeRuntime)?.name}
					{" · "}
					把其它 runtime 设为生效请在左侧选择后保存
				</p>
			</section>

			<section className="settings-section">
				<h2>{RUNTIME_META.find((meta) => meta.kind === kind)?.name} 配置</h2>
				<div className="settings-row">
					<Field label="Base URL">
						<input
							value={runtime.apiBaseUrl}
							onChange={(event) => patchRuntime({ apiBaseUrl: event.target.value })}
							placeholder="https://opencode.ai/zen/go/v1"
						/>
					</Field>
					<div className="settings-row__action">
						<button type="button" className="btn" onClick={probeModels} disabled={loadingModels}>
							{loadingModels ? "探测中…" : "探测模型"}
						</button>
					</div>
				</div>
				<Field label="API Key">
					<input
						type="password"
						value={runtime.apiKey}
						onChange={(event) => patchRuntime({ apiKey: event.target.value })}
						placeholder="留空使用环境变量"
					/>
				</Field>
				<Field label="模型">
					<input
						value={runtime.model}
						onChange={(event) => patchRuntime({ model: event.target.value })}
						placeholder="deepseek-v4-flash"
						list="model-options"
					/>
					{models.length > 0 && (
						<datalist id="model-options">
							{models.map((model) => <option key={model} value={model} />)}
						</datalist>
					)}
				</Field>
				<Field label="思考强度">
					<div className="settings-row">
						<select
							value={EFFORT_OPTIONS.includes(runtime.reasoningEffort) ? runtime.reasoningEffort : "custom"}
							onChange={(event) => {
								const value = event.target.value;
								if (value !== "custom") patchRuntime({ reasoningEffort: value });
							}}
						>
							<option value="">(默认)</option>
							{EFFORT_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
							<option value="custom">自定义…</option>
						</select>
						{!EFFORT_OPTIONS.includes(runtime.reasoningEffort) && runtime.reasoningEffort && (
							<input
								value={runtime.reasoningEffort}
								onChange={(event) => patchRuntime({ reasoningEffort: event.target.value })}
								placeholder="自定义思考强度"
							/>
						)}
					</div>
				</Field>
				<div className="settings-row">
					<Field label="上下文窗口">
						<input
							type="number"
							value={runtime.contextWindow}
							onChange={(event) => patchRuntime({ contextWindow: Number(event.target.value) || 0 })}
						/>
					</Field>
					<Field label="最大输出(0 = Provider 决定)">
						<input
							type="number"
							value={runtime.maxOutputTokens}
							onChange={(event) => patchRuntime({ maxOutputTokens: Number(event.target.value) || 0 })}
						/>
					</Field>
				</div>
			</section>

			<section className="settings-section">
				<h2>Drift(空闲后台任务)</h2>
				<Field label="启用">
					<label className="checkbox-row">
						<input
							type="checkbox"
							checked={state.drift.enabled}
							onChange={(event) => patchDrift({ enabled: event.target.checked })}
						/>
						<span>候选为空时进入 Drift 模式</span>
					</label>
				</Field>
				<div className="settings-row">
					<Field label="最大步数">
						<input
							type="number"
							value={state.drift.maxSteps}
							onChange={(event) => patchDrift({ maxSteps: Number(event.target.value) || 0 })}
						/>
					</Field>
					<Field label="最小间隔(小时)">
						<input
							type="number"
							value={state.drift.minIntervalHours}
							onChange={(event) => patchDrift({ minIntervalHours: Number(event.target.value) || 0 })}
						/>
					</Field>
				</div>
			</section>
		</div>
	);
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<label className="settings-field">
			<span className="settings-field__label">{label}</span>
			{children}
		</label>
	);
}
