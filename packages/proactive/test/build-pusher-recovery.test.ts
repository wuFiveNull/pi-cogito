import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DriftStateStore } from "@cogito/drift";
import { afterEach, describe, expect, it } from "vitest";
import { buildPusher } from "../src/index.ts";
import type { DeliveryOutlet } from "../src/stages/deliver.ts";
import type { DeliveryRecord } from "../src/store.ts";
import { ProactiveStore } from "../src/store.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

class CrashOnceProvider implements DeliveryOutlet {
	readonly attempts: string[] = [];
	readonly accepted = new Set<string>();
	private crashed = false;
	starts = 0;
	stops = 0;

	async start(): Promise<void> {
		this.starts++;
	}

	async stop(): Promise<void> {
		this.stops++;
	}

	async send(record: DeliveryRecord): Promise<{ status: "success"; providerMessageId: string }> {
		this.attempts.push(record.idempotency_key);
		const firstAcceptance = !this.accepted.has(record.idempotency_key);
		this.accepted.add(record.idempotency_key);
		if (firstAcceptance && !this.crashed) {
			this.crashed = true;
			throw new Error("simulated process crash after provider acceptance");
		}
		return { status: "success", providerMessageId: `provider:${record.idempotency_key}` };
	}
}

function seedStagedRun(driftDir: string): void {
	const store = new DriftStateStore({ driftDir });
	const now = new Date("2026-05-01T00:00:00.000Z");
	try {
		store.startRun({ runId: "crash-run", sessionKey: "local", nowUtc: now });
		store.updateRunProgress({
			runId: "crash-run",
			stage: "message_staged",
			nowUtc: now,
			skillName: "skill-a",
			messageHash: "crash-hash",
			message: "只应被 provider 接受一次",
		});
		store.saveFinish({
			runId: "crash-run",
			sessionKey: "local",
			skillUsed: "skill-a",
			status: "completed",
			briefing: "staged before delivery commit",
			messageResult: "staged",
			messageHash: "crash-hash",
			message: "只应被 provider 接受一次",
			nowUtc: now,
		});
	} finally {
		store.close();
	}
}

function makeConfig(root: string, provider: DeliveryOutlet) {
	const sourcesDir = join(root, "sources");
	const sessionsDir = join(root, "sessions");
	const driftDir = join(root, "drift");
	mkdirSync(sourcesDir, { recursive: true });
	mkdirSync(sessionsDir, { recursive: true });
	writeFileSync(
		join(sourcesDir, "idle.ts"),
		`export default class IdleSource {
  id = "idle";
  label = "Idle";
  channels = ["content"] as const;
  async fetch() { return []; }
}\n`,
		"utf-8",
	);
	seedStagedRun(driftDir);
	return {
		sourcesDir,
		sessionsDir,
		dbPath: join(root, "proactive.sqlite"),
		drift: { enabled: false, driftDir },
		delivery: { outlet: provider },
		gate: { busyFn: () => true },
	};
}

describe("buildPusher staged delivery recovery", () => {
	it("recovers after provider acceptance before ack without duplicating the provider message", async () => {
		const root = mkdtempSync(join(tmpdir(), "proactive-build-recovery-"));
		tempDirs.push(root);
		const provider = new CrashOnceProvider();
		const config = makeConfig(root, provider);
		const seeded = new DriftStateStore({ driftDir: config.drift.driftDir });
		expect(seeded.listStagedDeliveries()).toHaveLength(1);
		seeded.close();

		const first = await buildPusher(config);
		await first.start();
		await first.stop();
		expect(provider.starts).toBe(1);
		const outboxAfterFirst = new ProactiveStore(config.dbPath);
		expect(outboxAfterFirst.listDeliveries()).toHaveLength(1);
		outboxAfterFirst.close();
		const afterFirst = new DriftStateStore({ driftDir: config.drift.driftDir });
		expect(afterFirst.listStagedDeliveries()).toHaveLength(1);
		afterFirst.close();
		expect(provider.attempts).toEqual(["drift:crash-hash"]);

		const second = await buildPusher(config);
		await second.start();
		await second.stop();

		expect(provider.attempts).toEqual(["drift:crash-hash", "drift:crash-hash"]);
		expect(provider.accepted).toEqual(new Set(["drift:crash-hash"]));

		const proactive = new ProactiveStore(config.dbPath);
		try {
			expect(proactive.listDeliveries()).toMatchObject([
				{ idempotency_key: "drift:crash-hash", acked: 1, delivery_status: "success" },
			]);
		} finally {
			proactive.close();
		}

		const drift = new DriftStateStore({ driftDir: config.drift.driftDir });
		try {
			expect(drift.listStagedDeliveries()).toHaveLength(0);
			expect(drift.getRunDiagnostics("crash-run")).toMatchObject({ run: { message_result: "sent" } });
		} finally {
			drift.close();
		}
	});
});
