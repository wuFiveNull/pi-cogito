#!/usr/bin/env node
/**
 * Drift daemon entry(三进程模式)。用法:
 *   node --import tsx packages/drift/scripts/daemon.ts [driftDir]
 */
import { runDriftDaemon } from "../src/daemon.ts";

const driftDir = process.argv[2] || undefined;
runDriftDaemon({ driftDir }).catch((error) => {
	console.error("drift daemon failed to start:", error);
	process.exit(1);
});
