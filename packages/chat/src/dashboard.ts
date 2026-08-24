/**
 * Chat dashboard — mount the web dashboard on the web channel.
 *
 * Mirrors the legacy cogito-gateway mount: UiRegistry + builtinWebApp +
 * createWebApi (sessions, proactive, memory, drift skills, mcp, settings).
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ChannelSdk, WebChannel } from "@cogito/gateway";
import { builtinWebApp, createWebApi, UiRegistry } from "@cogito/ui";

export interface ChatDashboardOptions {
	projectDir: string;
	agentDir: string;
	log?: (message: string) => void;
}

export function mountWebDashboard(sdk: ChannelSdk, options: ChatDashboardOptions): void {
	const channel = sdk.getChannel("web") as WebChannel | undefined;
	if (!channel) {
		options.log?.("web channel not enabled, dashboard not mounted");
		return;
	}
	const ui = new UiRegistry();
	ui.register(builtinWebApp);
	const webApi = createWebApi({
		// 会话列表读取聊天会话落盘目录(channel-agent-sessions),而非 coding-agent
		// 的 sessions 目录——聊天会话都在 channel session 里,指向后者页面恒为空。
		sessionsDir: join(options.agentDir, "channel-agent-sessions"),
		proactiveDbPath: resolveProactiveDbPath(options.projectDir, options.agentDir),
		wakeDbPath: resolveWakeProactiveDbPath(options.projectDir, options.agentDir),
		memoryDbPath: join(options.agentDir, "memory", "memory.sqlite"),
		// drift 挂载目录统一在项目 .cogito/extensions/drift 下。
		driftSkillsDir: join(options.projectDir, ".cogito", "extensions", "drift", "skills"),
		driftDbPath: join(options.projectDir, ".cogito", "extensions", "drift", "drift.db"),
		mcpConfigPath: join(options.agentDir, "mcp.json"),
		settingsPath: join(options.agentDir, "web-settings.json"),
		channelSessionsPath: join(options.agentDir, "channel-sessions.json"),
	});
	channel.registerApi("GET", "/*", (url, res, req) => {
		if (webApi.handle(req, res, url)) return;
		if (!ui.handle(req, res, url)) res.writeHead(404).end("Not found");
	});
	channel.registerApi("POST", "/api/*", (url, res, req) => {
		if (!webApi.handle(req, res, url)) res.writeHead(404).end("Not found");
	});
	options.log?.("web dashboard mounted on web channel");
}

/** Resolve the proactive daemon's database path (matches .run/proactive.json dbPath). */
export function resolveProactiveDbPath(projectDir: string, agentDir: string): string {
	// Match the proactive daemon's default config (.run/proactive.json) when present.
	const configPath = join(projectDir, ".run", "proactive.json");
	if (existsSync(configPath)) {
		try {
			const config = JSON.parse(readFileSync(configPath, "utf-8")) as { dbPath?: unknown };
			if (typeof config.dbPath === "string" && config.dbPath.length > 0) {
				return resolve(config.dbPath);
			}
		} catch {
			// fall through to the default path
		}
	}
	return join(agentDir, "proactive.sqlite");
}

/** wake 生命周期下 tick/observations 落在与 proactive.sqlite 同目录的 wake_proactive.db。 */
export function resolveWakeProactiveDbPath(projectDir: string, agentDir: string): string | undefined {
	const configPath = join(projectDir, ".run", "proactive.json");
	if (!existsSync(configPath)) return undefined;
	try {
		const config = JSON.parse(readFileSync(configPath, "utf-8")) as { dbPath?: unknown; lifecycle?: unknown };
		if (config.lifecycle !== "wake") return undefined;
		const dbPath =
			typeof config.dbPath === "string" && config.dbPath.length > 0
				? resolve(config.dbPath)
				: join(agentDir, "proactive.sqlite");
		return join(dirname(dbPath), "wake_proactive.db");
	} catch {
		return undefined;
	}
}
