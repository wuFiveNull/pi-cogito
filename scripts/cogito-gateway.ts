/**
 * Cogito gateway entry — thin wrapper around @cogito/chat's runChatModule.
 *
 * All gateway/chat wiring (channels, sessions, tools, memory, scheduler,
 * dashboard, readiness, lock) lives in packages/chat/src/index.ts.
 */
import { runChatModule } from "../packages/chat/src/index.ts";

const chatModule = await runChatModule();

let stopping = false;
async function shutdown(signal: string): Promise<void> {
	if (stopping) return;
	stopping = true;
	console.error(`[cogito-gateway] stopping (${signal})`);
	try {
		await chatModule.stop();
	} catch (error: unknown) {
		console.error(`[cogito-gateway] shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
}

process.once("SIGINT", () => {
	void shutdown("SIGINT");
});
process.once("SIGTERM", () => {
	void shutdown("SIGTERM");
});
