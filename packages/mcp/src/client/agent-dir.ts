import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function getAgentDir(): string {
	// cogito fork: prefer COGITO_CODING_AGENT_DIR, then PI_CODING_AGENT_DIR
	const configured = process.env.COGITO_CODING_AGENT_DIR?.trim() ?? process.env.PI_CODING_AGENT_DIR?.trim();
	if (!configured) {
		return join(homedir(), ".cogito", "agent");
	}
	if (configured === "~") {
		return homedir();
	}
	if (configured.startsWith("~/")) {
		return resolve(homedir(), configured.slice(2));
	}
	return resolve(configured);
}

export function getAgentPath(...segments: string[]): string {
	return join(getAgentDir(), ...segments);
}
