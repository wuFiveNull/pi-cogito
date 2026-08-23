/**
 * Proactive daemon(三进程模式的 proactive 进程入口)。
 *
 * 基于 pi-host 服务(ModelRuntime 认证/模型)组装 proactive pusher:
 *   - wake 生命周期的 chat 走 host 的 ModelRuntime(createHostChatFn)
 *   - 每轮 tick 把判题结果写入 drift.db 的 drift_gate(drift daemon 消费)
 */

import { join } from "node:path";
import type { Model } from "@cogito/ai";
import { DriftGateStore, pickDaemonModel } from "@cogito/gate";
import { createAgentSessionServices, getAgentDir, SettingsManager } from "@cogito/host";
import type { DriftGateWriter } from "./drift-gate.ts";
import { loadPusherConfig, runPusher } from "./index.ts";

/** Options for {@link runProactiveDaemon}. */
export interface ProactiveDaemonOptions {
	/** proactive.json 路径(默认 cwd/proactive.json)。 */
	configPath?: string;
	cwd?: string;
	agentDir?: string;
	/** 错误回调(默认 console.error)。 */
	onError?: (error: unknown) => void;
}

/**
 * 启动 proactive daemon(常驻,直到进程退出;SIGINT/SIGTERM 优雅停止)。
 * 需要 host 的模型/认证配置(agentDir/auth.json + models.json)。
 */
export async function runProactiveDaemon(options: ProactiveDaemonOptions = {}): Promise<void> {
	const cwd = options.cwd ?? process.cwd();
	const agentDir = options.agentDir ?? getAgentDir();
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const services = await createAgentSessionServices({ cwd, agentDir, settingsManager });
	const models = await services.modelRuntime.getAvailable();
	const model = pickDaemonModel(models, settingsManager.getEnabledModels());
	if (!model) {
		throw new Error(
			"No allowed model available. Configure a model and API key first (opencode-go only allows deepseek-v4-flash).",
		);
	}

	const config = loadPusherConfig(options.configPath ?? join(cwd, "proactive.json"));
	// 挂载目录统一在项目 .cogito/extensions 下(与 proactive 扩展同层)。
	const driftDir = config.drift?.driftDir ?? join(cwd, ".cogito", "extensions", "drift");
	const driftGateStore = new DriftGateStore({ driftDir });
	const driftGate: DriftGateWriter = (gate) => driftGateStore.writeDriftGate(gate);

	const handle = await runPusher({
		...config,
		host: { modelRuntime: services.modelRuntime, model: model as Model<any> },
		driftGate,
	});

	const onError = options.onError ?? ((error: unknown) => console.error("proactive daemon error", error));
	const shutdown = async (): Promise<void> => {
		try {
			await handle.stop();
		} catch (error) {
			onError(error);
		}
		process.exit(0);
	};
	process.once("SIGINT", () => void shutdown());
	process.once("SIGTERM", () => void shutdown());
}
