import { useState } from "react";
import { ChatView } from "./views/chat.tsx";
import { DashboardView } from "./views/dashboard.tsx";
import { RuntimeView } from "./views/runtime.tsx";
import { SettingsView } from "./views/settings.tsx";

export type Surface = "chat" | "runtime" | "dashboard" | "settings";

const NAV: Array<{ id: Surface; label: string; icon: string }> = [
	{ id: "chat", label: "聊天", icon: "💬" },
	{ id: "runtime", label: "知识与运行", icon: "📚" },
	{ id: "dashboard", label: "监控", icon: "📊" },
	{ id: "settings", label: "设置", icon: "⚙️" },
];

export function App() {
	const [surface, setSurface] = useState<Surface>(() => {
		const param = new URLSearchParams(window.location.search).get("surface");
		return NAV.some((item) => item.id === param) ? (param as Surface) : "chat";
	});

	const navigate = (next: Surface) => {
		setSurface(next);
		window.history.replaceState(null, "", next === "chat" ? window.location.pathname : `${window.location.pathname}?surface=${next}`);
	};

	return (
		<div className="app-shell">
			<aside className="sidebar">
				<header className="sidebar-brand">
					<span className="sidebar-brand__mark">◈</span>
					<span><strong>pi</strong><small>web</small></span>
				</header>
				<nav className="sidebar-nav">
					{NAV.map((item) => (
						<button
							key={item.id}
							type="button"
							className={`nav-item ${surface === item.id ? "active" : ""}`}
							onClick={() => navigate(item.id)}
						>
							<span className="nav-item-icon">{item.icon}</span>
							<span>{item.label}</span>
						</button>
					))}
				</nav>
			</aside>
			<main className="surface">
				{surface === "chat" && <ChatView />}
				{surface === "runtime" && <RuntimeView />}
				{surface === "dashboard" && <DashboardView />}
				{surface === "settings" && <SettingsView />}
			</main>
		</div>
	);
}
