import { SandboxManager } from "@carderne/sandbox-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SandboxConfig } from "../src/core/sandbox/config.ts";
import {
	acquireSandboxLease,
	createNetworkAskCallback,
	releaseSandboxLease,
	type SessionAllowances,
} from "../src/core/sandbox/runtime.ts";

const makeConfig = (overrides: Partial<SandboxConfig> = {}): SandboxConfig => ({
	enabled: true,
	network: { allowedDomains: ["example.com"], deniedDomains: [] },
	filesystem: { denyRead: [], allowRead: ["."], allowWrite: ["."], denyWrite: [] },
	...overrides,
});

const makeAllowances = (): SessionAllowances => ({ domains: [], readPaths: [], writePaths: [] });

describe("createNetworkAskCallback", () => {
	it("allows hosts covered by granted rules without consulting the judge", async () => {
		const judgeHost = vi.fn(async () => null);
		const ask = createNetworkAskCallback({ getGrantedRules: () => ["*.granted.dev"], judgeHost });
		expect(await ask({ host: "sub.granted.dev", port: 443 })).toBe(true);
		expect(judgeHost).not.toHaveBeenCalled();
	});

	it("judges whitelist misses and honors the granted rule afterwards", async () => {
		const granted: string[] = [];
		const judgeHost = vi.fn(async (host: string) => {
			if (host === "new.host.dev") {
				granted.push("new.host.dev");
				return "new.host.dev";
			}
			return null;
		});
		const ask = createNetworkAskCallback({ getGrantedRules: () => granted, judgeHost });

		expect(await ask({ host: "new.host.dev", port: 443 })).toBe(true);
		// The grant is live: later connections skip the judge.
		expect(await ask({ host: "new.host.dev", port: 443 })).toBe(true);
		expect(judgeHost).toHaveBeenCalledTimes(1);

		// Judge unavailable/deny: fail closed.
		expect(await ask({ host: "blocked.host.dev", port: 443 })).toBe(false);
	});

	it("denies everything when no judge hook is installed", async () => {
		const ask = createNetworkAskCallback({ getGrantedRules: () => [] });
		expect(await ask({ host: "anything.dev", port: 443 })).toBe(false);
	});
});

describe("sandbox leases", () => {
	let mocks: Array<{ mockRestore: () => void }> = [];

	afterEach(() => {
		for (const mock of mocks) mock.mockRestore();
		mocks = [];
	});

	it("rebuilds the sandbox from the union of all active leases", async () => {
		mocks.push(vi.spyOn(SandboxManager, "initialize").mockResolvedValue(undefined));
		mocks.push(vi.spyOn(SandboxManager, "reset").mockResolvedValue(undefined));
		const initialize = vi.mocked(SandboxManager.initialize);
		const reset = vi.mocked(SandboxManager.reset);

		const tokenA = {};
		const tokenB = {};
		const askA = async () => true;
		const configA = makeConfig({
			network: { allowedDomains: ["a.dev"], deniedDomains: [] },
			filesystem: { denyRead: [], allowRead: ["."], allowWrite: ["."], denyWrite: ["/locked"] },
		});
		await acquireSandboxLease(tokenA, configA, makeAllowances(), askA);
		await acquireSandboxLease(
			tokenB,
			makeConfig({ network: { allowedDomains: ["b.dev"], deniedDomains: [] } }),
			makeAllowances(),
		);

		let lastConfig = initialize.mock.calls.at(-1)?.[0];
		expect(lastConfig?.network?.allowedDomains).toEqual(["a.dev", "b.dev"]);
		// The ask callback of the acquiring session is installed.
		expect(initialize.mock.calls.at(-1)?.[1]).toBeUndefined();

		// A session-level grant from A shows up in the merged config.
		const allowancesA: SessionAllowances = { domains: ["granted.dev"], readPaths: [], writePaths: [] };
		await acquireSandboxLease(tokenA, configA, allowancesA, askA);
		lastConfig = initialize.mock.calls.at(-1)?.[0];
		expect(lastConfig?.network?.allowedDomains).toEqual(expect.arrayContaining(["a.dev", "b.dev", "granted.dev"]));
		expect(lastConfig?.network?.allowedDomains).toHaveLength(3);
		expect(initialize.mock.calls.at(-1)?.[1]).toBe(askA);

		// Filesystem deny lists are unioned across leases.
		await acquireSandboxLease(
			tokenB,
			makeConfig({
				network: { allowedDomains: ["b.dev"], deniedDomains: [] },
				filesystem: { denyRead: [], allowRead: ["."], allowWrite: ["."], denyWrite: ["/sealed"] },
			}),
			makeAllowances(),
		);
		lastConfig = initialize.mock.calls.at(-1)?.[0];
		expect(lastConfig?.filesystem?.denyWrite).toEqual(["/locked", "/sealed"]);

		// Releasing one lease rebuilds the sandbox from the remaining lease's view.
		const resetsBefore = reset.mock.calls.length;
		const initializationsBefore = initialize.mock.calls.length;
		await releaseSandboxLease(tokenA);
		expect(initialize.mock.calls.length).toBe(initializationsBefore + 1);
		lastConfig = initialize.mock.calls.at(-1)?.[0];
		expect(lastConfig?.network?.allowedDomains).toEqual(["b.dev"]);

		// Releasing the last lease tears the sandbox down without a rebuild.
		await releaseSandboxLease(tokenB);
		expect(initialize.mock.calls.length).toBe(initializationsBefore + 1);
		// One reset from the rebuild plus one final teardown.
		expect(reset.mock.calls.length).toBe(resetsBefore + 2);
	});

	it("does not keep a lease whose initialization failed", async () => {
		mocks.push(vi.spyOn(SandboxManager, "initialize").mockRejectedValue(new Error("no bwrap")));
		mocks.push(vi.spyOn(SandboxManager, "reset").mockResolvedValue(undefined));
		const reset = vi.mocked(SandboxManager.reset);

		const token = {};
		await expect(acquireSandboxLease(token, makeConfig(), makeAllowances())).rejects.toThrow("no bwrap");

		// The failed lease is gone: releasing it is a no-op (no teardown of others).
		const resetsBefore = reset.mock.calls.length;
		await releaseSandboxLease(token);
		expect(reset.mock.calls.length).toBe(resetsBefore);
	});
});
