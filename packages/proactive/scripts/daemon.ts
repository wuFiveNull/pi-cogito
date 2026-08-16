#!/usr/bin/env node
/**
 * Proactive daemon entry(三进程模式)。用法:
 *   node --import tsx packages/proactive/scripts/daemon.ts [configPath]
 */
import { runProactiveDaemon } from "../src/daemon.ts";

const configPath = process.argv[2] || undefined;
runProactiveDaemon({ configPath }).catch((error) => {
	console.error("proactive daemon failed to start:", error);
process.exit(1);
});
