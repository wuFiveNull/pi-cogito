import { ProactiveStore } from "../../../proactive/src/store.ts";
import { DriftStateStore } from "../../src/state.ts";

const [mode, target, value] = process.argv.slice(2);

if (mode === "delivery") {
	const store = new ProactiveStore(target);
	try {
		const id = store.insertDelivery({
			session_key: "local",
			message: "concurrent",
			message_hash: "concurrent-hash",
			source_refs: "[]",
			evidence: "[]",
			action: "send",
			state_summary_tag: "none",
			delivered_at: 1,
			idempotency_key: value,
		});
		console.log(JSON.stringify({ ok: true, id }));
	} finally {
		store.close();
	}
} else if (mode === "drift") {
	const store = new DriftStateStore({ driftDir: target });
	try {
		try {
			store.startRun({
				runId: value,
				sessionKey: "local",
				nowUtc: new Date("2026-05-01T00:00:00.000Z"),
			});
			console.log(JSON.stringify({ ok: true, runId: value }));
		} catch (error) {
			console.log(JSON.stringify({ ok: false, name: error instanceof Error ? error.name : String(error) }));
		}
	} finally {
		store.close();
	}
} else {
	throw new Error(`unknown mode: ${mode}`);
}
