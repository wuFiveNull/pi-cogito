/**
 * Subagent extension — mount the spawn tool set on any extension runtime.
 *
 * "核心在 host、挂载走扩展": SubagentManager/subagent-runner/subagent-tools
 * live in host; this helper packages them as an `InlineExtension` that
 * registers the spawn tools through `pi.registerTool()`. Chat (and any other
 * host consumer) mounts it via its existing extension loading path
 * (resource loader `extensionFactories` or an extensions directory).
 *
 * Background completions are delivered back to the origin session through
 * `pi.sendUserMessage()` (always triggers/queues a turn), mirroring akashic's
 * SpawnCompletionEvent routed back to the origin chat.
 */

import type { InlineExtension } from "./extensions/types.ts";
import type { SubagentManager } from "./subagent-manager.ts";
import { createSpawnManageTool, createSpawnTool, formatSubagentCompletion } from "./subagent-tools.ts";

export interface CreateSubagentExtensionOptions {
	/** Manager backing the spawn tools; completion delivery is wired here. */
	manager: SubagentManager;
	/** Cap for the completion text delivered back to the origin session. Default: 12000. */
	backgroundResultMaxChars?: number;
	/** Extension display name shown in the startup Extensions list. Default: "subagent". */
	name?: string;
}

/** Build the inline extension that registers spawn / spawn_manage. */
export function createSubagentExtension(options: CreateSubagentExtensionOptions): InlineExtension {
	const backgroundResultMaxChars = options.backgroundResultMaxChars;
	return {
		name: options.name ?? "subagent",
		hidden: true,
		factory: (pi) => {
			options.manager.setCompletionHandler((jobId, result) => {
				try {
					pi.sendUserMessage(formatSubagentCompletion(jobId, result, backgroundResultMaxChars), {
						deliverAs: "followUp",
					});
				} catch {
					// Session replaced/reloaded; the background result has nowhere to go.
				}
			});
			pi.registerTool(createSpawnTool({ manager: options.manager }));
			pi.registerTool(createSpawnManageTool(options.manager));
			// Cancel in-flight jobs when the session is replaced or reloaded.
			pi.on("session_shutdown", () => {
				void options.manager.shutdown();
			});
		},
	};
}
