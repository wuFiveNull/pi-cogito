/**
 * SandboxManager wiring for the sandbox extension: effective allowance
 * resolution, runtime config construction, sandboxed bash operations, and the
 * process-level lease registry.
 *
 * SandboxManager is a per-process singleton, while the host SDK can run
 * several sessions in one process. Each enabled session holds a lease (its
 * config + live session allowances); the OS sandbox is always built from the
 * union of all active leases, and it is torn down only when the last lease is
 * released — one session shutting down must not strip the sandbox (or the
 * granted allowances) from the others.
 *
 * Ported from pi-sandbox (https://github.com/carderne/pi-sandbox, MIT), with
 * the multi-session lease layer and the judgeable network ask callback added
 * for cogito.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";

import { type SandboxAskCallback, SandboxManager, type SandboxRuntimeConfig } from "@carderne/sandbox-runtime";

import { getShellConfig } from "../../utils/shell.ts";
import type { BashOperations } from "../tools/bash.ts";
import type { SandboxConfig } from "./config.ts";
import { canonicalizePath, domainIsAllowed } from "./policy.ts";

export interface SessionAllowances {
	domains: string[];
	readPaths: string[];
	writePaths: string[];
}

export interface EffectiveAllowances {
	domains: string[];
	readPaths: string[];
	writePaths: string[];
}

function unique(values: string[]): string[] {
	return [...new Set(values)];
}

const canonicalizeFilesystemPattern = (path: string) => (path.includes("*") ? path : canonicalizePath(path));

const canonicalizeFilesystemPatterns = (paths: string[]) => unique(paths.map(canonicalizeFilesystemPattern));

export function resolveAllowances(config: SandboxConfig, allowances?: SessionAllowances): EffectiveAllowances {
	const writePaths = unique([...(config.filesystem?.allowWrite ?? []), ...(allowances?.writePaths ?? [])]);

	return {
		domains: unique([...(config.network?.allowedDomains ?? []), ...(allowances?.domains ?? [])]),
		readPaths: unique([...(config.filesystem?.allowRead ?? []), ...(allowances?.readPaths ?? []), ...writePaths]),
		writePaths,
	};
}

function unionDefined(lists: Array<string[] | undefined>): string[] | undefined {
	const defined = lists.filter((list): list is string[] => list !== undefined);
	return defined.length > 0 ? unique(defined.flat()) : undefined;
}

function unionRecords(records: Array<Record<string, string[]> | undefined>): Record<string, string[]> | undefined {
	const defined = records.filter((record): record is Record<string, string[]> => record !== undefined);
	if (defined.length === 0) return undefined;
	const merged: Record<string, string[]> = {};
	for (const record of defined) {
		for (const [key, values] of Object.entries(record)) {
			merged[key] = unique([...(merged[key] ?? []), ...values]);
		}
	}
	return merged;
}

export function buildRuntimeConfig(config: SandboxConfig, allowances?: SessionAllowances): SandboxRuntimeConfig {
	const effective = resolveAllowances(config, allowances);

	return {
		network: {
			...config.network,
			allowedDomains: effective.domains,
			deniedDomains: config.network?.deniedDomains ?? [],
		},
		filesystem: {
			disabled: config.filesystem?.disabled,
			denyRead: canonicalizeFilesystemPatterns(config.filesystem?.denyRead ?? []),
			allowRead: canonicalizeFilesystemPatterns(effective.readPaths),
			allowWrite: canonicalizeFilesystemPatterns(effective.writePaths),
			denyWrite: canonicalizeFilesystemPatterns(config.filesystem?.denyWrite ?? []),
		},
		ignoreViolations: config.ignoreViolations,
		enableWeakerNestedSandbox: config.enableWeakerNestedSandbox,
		allowBrowserProcess: config.allowBrowserProcess,
		allowPty: config.allowPty,
		enableWeakerNetworkIsolation: true,
	};
}

interface SandboxLease {
	config: SandboxConfig;
	allowances: SessionAllowances;
	ask?: SandboxAskCallback;
}

/**
 * Active leases keyed by an opaque per-session token. Module-level because
 * SandboxManager itself is a process-wide singleton.
 */
const activeLeases = new Map<object, SandboxLease>();

function buildMergedRuntimeConfig(): SandboxRuntimeConfig {
	const leases = [...activeLeases.values()];
	const effective = leases.map((lease) => resolveAllowances(lease.config, lease.allowances));
	const synthetic: SandboxConfig = {
		network: {
			allowUnauthenticatedSocksProxy: leases.some((lease) => lease.config.network?.allowUnauthenticatedSocksProxy),
			sshProxy: leases.every((lease) => lease.config.network?.sshProxy !== false),
			allowedDomains: unique(effective.flatMap((entry) => entry.domains)),
			deniedDomains: unique(leases.flatMap((lease) => lease.config.network?.deniedDomains ?? [])),
			allowUnixSockets: unionDefined(leases.map((lease) => lease.config.network?.allowUnixSockets)),
			allowMachLookup: unionDefined(leases.map((lease) => lease.config.network?.allowMachLookup)),
		},
		filesystem: {
			disabled: leases.some((lease) => lease.config.filesystem?.disabled) || undefined,
			denyRead: unique(leases.flatMap((lease) => lease.config.filesystem?.denyRead ?? [])),
			allowRead: unique(effective.flatMap((entry) => entry.readPaths)),
			allowWrite: unique(effective.flatMap((entry) => entry.writePaths)),
			denyWrite: unique(leases.flatMap((lease) => lease.config.filesystem?.denyWrite ?? [])),
		},
		ignoreViolations: unionRecords(leases.map((lease) => lease.config.ignoreViolations)),
		enableWeakerNestedSandbox: leases.some((lease) => lease.config.enableWeakerNestedSandbox) || undefined,
		allowBrowserProcess: leases.some((lease) => lease.config.allowBrowserProcess) || undefined,
		allowPty: leases.some((lease) => lease.config.allowPty) || undefined,
	};
	return buildRuntimeConfig(synthetic);
}

async function reinitializeMerged(ask?: SandboxAskCallback): Promise<void> {
	await SandboxManager.reset();
	await SandboxManager.initialize(buildMergedRuntimeConfig(), ask);
}

/**
 * Register (or update) the calling session's lease and rebuild the OS sandbox
 * from the union of all active leases. `ask` — typically the calling
 * session's judgeable ask callback — is installed for the rebuilt sandbox.
 */
export async function acquireSandboxLease(
	token: object,
	config: SandboxConfig,
	allowances: SessionAllowances,
	ask?: SandboxAskCallback,
): Promise<void> {
	activeLeases.set(token, { config, allowances, ask });
	try {
		await reinitializeMerged(ask);
	} catch (error) {
		activeLeases.delete(token);
		throw error;
	}
}

/**
 * Drop the calling session's lease. Tears the OS sandbox down entirely when
 * the last lease is released; otherwise rebuilds it from the remaining
 * leases so the surviving sessions keep every granted allowance.
 */
export async function releaseSandboxLease(token: object): Promise<void> {
	if (!activeLeases.delete(token)) return;
	if (activeLeases.size === 0) {
		await SandboxManager.reset();
		return;
	}
	const remaining = [...activeLeases.values()];
	await reinitializeMerged(remaining[remaining.length - 1]?.ask);
}

/**
 * Network ask callback for the sandbox runtime. The runtime consults it only
 * for hosts matching neither deniedDomains nor allowedDomains, so this layer
 * handles dynamic grants: rules granted after initialization (session
 * allowances grow live) pass without a judge call, everything else goes to
 * the judge hook, whose return value (granted rule or null) decides the
 * connection.
 */
export type AskJudgeHook = (host: string, port: number | undefined) => Promise<string | null>;

export function createNetworkAskCallback(options: {
	getGrantedRules: () => string[];
	judgeHost?: AskJudgeHook;
}): SandboxAskCallback {
	return async ({ host, port }) => {
		if (domainIsAllowed(host, options.getGrantedRules())) return true;
		if (!options.judgeHost) return false;
		const rule = await options.judgeHost(host, port);
		return rule !== null;
	};
}

export function supportsNodeEnvProxy(version: string): boolean {
	const [major, minor] = version.split(".").map(Number);
	return (major === 22 && minor >= 21) || major >= 24;
}

export function extractBlockedWritePath(output: string): string | null {
	const match = output.match(/(?:\/bin\/bash|bash|sh): (?:line \d: )?(\/[^\s:]+): Operation not permitted/);
	return match ? match[1] : null;
}

const EXIT_STDIO_GRACE_MS = 100;

/**
 * Wait for a child process to exit without hanging on inherited stdio handles.
 *
 * After exit, keep reading while output is active. If a detached descendant
 * holds the pipes open but leaves them idle, release them after a short grace.
 */
function waitForChildProcess(child: ChildProcess): Promise<number | null> {
	return new Promise((resolve, reject) => {
		let settled = false;
		let exited = false;
		let exitCode: number | null = null;
		let postExitTimer: NodeJS.Timeout | undefined;
		let stdoutEnded = child.stdout === null;
		let stderrEnded = child.stderr === null;

		const cleanup = () => {
			if (postExitTimer) {
				clearTimeout(postExitTimer);
				postExitTimer = undefined;
			}
			child.removeListener("error", onError);
			child.removeListener("exit", onExit);
			child.removeListener("close", onClose);
			child.stdout?.removeListener("end", onStdoutEnd);
			child.stderr?.removeListener("end", onStderrEnd);
			child.stdout?.removeListener("data", onData);
			child.stderr?.removeListener("data", onData);
		};

		const finalize = (code: number | null) => {
			if (settled) return;
			settled = true;
			cleanup();
			child.stdout?.destroy();
			child.stderr?.destroy();
			resolve(code);
		};

		const maybeFinalizeAfterExit = () => {
			if (!exited || settled) return;
			if (stdoutEnded && stderrEnded) finalize(exitCode);
		};

		const armIdleTimer = () => {
			if (postExitTimer) clearTimeout(postExitTimer);
			postExitTimer = setTimeout(() => finalize(exitCode), EXIT_STDIO_GRACE_MS);
		};

		const onData = () => {
			if (exited && !settled) armIdleTimer();
		};

		const onStdoutEnd = () => {
			stdoutEnded = true;
			maybeFinalizeAfterExit();
		};

		const onStderrEnd = () => {
			stderrEnded = true;
			maybeFinalizeAfterExit();
		};

		const onError = (error: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		};

		const onExit = (code: number | null) => {
			exited = true;
			exitCode = code;
			maybeFinalizeAfterExit();
			if (!settled) armIdleTimer();
		};

		const onClose = (code: number | null) => {
			finalize(code);
		};

		child.stdout?.once("end", onStdoutEnd);
		child.stderr?.once("end", onStderrEnd);
		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);
		child.once("error", onError);
		child.once("exit", onExit);
		child.once("close", onClose);
	});
}

export function createSandboxedBashOps(shellPath?: string, sshProxy = true): BashOperations {
	return {
		async exec(command, cwd, { onData, signal, timeout, env }) {
			if (!existsSync(cwd)) throw new Error(`Working directory does not exist: ${cwd}`);

			const { shell, args } = getShellConfig(shellPath);

			// Note: each exec starts fresh in-netns proxy relays (socat) inside the
			// bwrap wrapper with no readiness wait (sandbox-runtime 0.0.70). A
			// command connecting within ~10 ms of start can hit ECONNREFUSED;
			// real commands pay binary startup first, and a retried run succeeds.

			// OpenSSH does not honor ALL_PROXY, unlike most of the tools that use
			// the sandbox network proxy. Install a shell function so ordinary
			// `ssh host` commands use the runtime's local SOCKS proxy too. This is
			// deliberately opt-in at the config layer, but enabled by default.
			const socksProxyPort = sshProxy ? SandboxManager.getSocksProxyPort() : undefined;
			const sshProxyCommand =
				process.platform === "darwin" && socksProxyPort !== undefined
					? `ssh() { /usr/bin/ssh -o 'ProxyCommand=/usr/bin/nc -X 5 -x localhost:${socksProxyPort} %h %p' "$@"; }; `
					: "";
			const wrappedCommand = await SandboxManager.wrapWithSandbox(`${sshProxyCommand}${command}`, shell);

			const child = spawn(shell, [...args, wrappedCommand], {
				cwd,
				env,
				detached: true,
				stdio: ["ignore", "pipe", "pipe"],
			});

			let timedOut = false;
			let timeoutHandle: NodeJS.Timeout | undefined;

			const killProcessGroup = () => {
				if (!child.pid) return;
				try {
					process.kill(-child.pid, "SIGKILL");
				} catch {
					child.kill("SIGKILL");
				}
			};

			if (timeout !== undefined && timeout > 0) {
				timeoutHandle = setTimeout(() => {
					timedOut = true;
					killProcessGroup();
				}, timeout * 1000);
			}

			child.stdout?.on("data", onData);
			child.stderr?.on("data", onData);
			signal?.addEventListener("abort", killProcessGroup, { once: true });

			try {
				const exitCode = await waitForChildProcess(child);
				if (signal?.aborted) throw new Error("aborted");
				if (timedOut) throw new Error(`timeout:${timeout}`);
				return { exitCode };
			} finally {
				if (timeoutHandle) clearTimeout(timeoutHandle);
				signal?.removeEventListener("abort", killProcessGroup);
				SandboxManager.cleanupAfterCommand();
			}
		},
	};
}
