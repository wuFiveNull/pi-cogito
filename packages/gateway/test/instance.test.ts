import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GatewayInstanceLock, GatewayInstanceLockError, writeGatewayReadiness } from "../src/instance.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryPath(name: string): string {
	const directory = mkdtempSync(join(tmpdir(), "gateway-instance-"));
	temporaryDirectories.push(directory);
	return join(directory, name);
}

describe("gateway instance lifecycle", () => {
	it("prevents concurrent instances and releases its own lock", () => {
		const path = temporaryPath("gateway.lock");
		const first = GatewayInstanceLock.acquire(path);
		expect(() => GatewayInstanceLock.acquire(path)).toThrow(GatewayInstanceLockError);
		first.release();
		expect(existsSync(path)).toBe(false);

		const replacement = GatewayInstanceLock.acquire(path);
		replacement.release();
	});

	it("reclaims a lock left by a dead process", () => {
		const path = temporaryPath("gateway.lock");
		writeFileSync(path, JSON.stringify({ pid: 2_147_483_647, startedAt: 1, token: "stale" }));

		const lock = GatewayInstanceLock.acquire(path);
		expect(JSON.parse(readFileSync(path, "utf8")) as { pid: number }).toMatchObject({ pid: process.pid });
		lock.release();
	});

	it("writes a secret-free readiness snapshot", () => {
		const path = temporaryPath("gateway-ready.json");
		writeGatewayReadiness(path, "ready", [{ name: "qq", running: true, ready: true }]);

		expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
			state: "ready",
			pid: process.pid,
			channels: [{ name: "qq", running: true, ready: true }],
		});
	});
});
