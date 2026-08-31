/**
 * Sandbox extension — OS-level sandboxing for bash plus policy enforcement for
 * the read/write/edit tools, with every blocked action decided by an AI
 * approval judge (see core/approval). There is no human review path; judge
 * failures fail closed.
 *
 * "核心在 host、挂载走扩展": the implementation lives in core/sandbox/; this
 * helper packages it as an InlineExtension. The host SDK mounts it on the
 * default resource loader; consumers with a custom loader add it to
 * `extensionFactories`.
 *
 * Sandboxed bash commands are wrapped with @carderne/sandbox-runtime
 * (sandbox-exec on macOS, bubblewrap on Linux). Read/write/edit tool calls are
 * intercepted before execution and checked against the same filesystem policy.
 *
 * Network review has two layers around the same whitelist (config
 * allowedDomains plus session-granted rules):
 * - Preflight: URL-shaped domains in a bash command are judged in one batch
 *   call before the command runs, so grants are OS-effective immediately.
 * - Connection-level: the sandbox runtime's ask callback consults the judge
 *   for any whitelisted-miss host at connect time (bare domains, IPs, hosts
 *   built at runtime). Grants are recorded as session allowances without a
 *   sandbox reinit — the ask callback fires mid-command, and reinitializing
 *   here could tear down the running command's sandbox on Linux.
 *
 * SandboxManager is a process-wide singleton shared by all sessions of the
 * host process. Each enabled session holds a lease (see core/sandbox/runtime);
 * the OS sandbox is rebuilt from the union of all active leases and torn down
 * only when the last lease is released, so one session exiting never strips
 * the others' protection or grants.
 *
 * Ported from pi-sandbox (https://github.com/carderne/pi-sandbox, MIT), which
 * is based on badlogic/pi-mono's sandbox example extension. Deltas from
 * pi-sandbox: config lives under the cogito config dir (`.cogito`), permission
 * prompts are replaced by AI review (session-level grants only, no config
 * writes from verdicts), the sandbox is disabled by default, and the Alt+S
 * shortcut / --no-sandbox flag are dropped (gate solely via `enabled`).
 */

import type { ApprovalAuditRecord, ApprovalJudge } from "../approval/index.ts";
import { createLlmApprovalJudge } from "../approval/index.ts";
import type { InlineExtension } from "../extensions/index.ts";
import { isToolCallEventType } from "../extensions/index.ts";
import { SettingsManager } from "../settings-manager.ts";
import { createBashToolDefinition } from "../tools/index.ts";
import {
	type BatchApprovalOutcome,
	formatSandboxConfiguration,
	formatSandboxStatus,
	resolveApproval,
	resolveApprovalBatch,
	validDomainRule,
	validPathRule,
	warnIfAllDomainsAllowed,
} from "./approval.ts";
import { getConfigPaths, loadConfig, type SandboxConfig } from "./config.ts";
import {
	canonicalizePath,
	decideWritePolicy,
	domainIsAllowed,
	extractDomainsFromCommand,
	matchesPattern,
} from "./policy.ts";
import {
	acquireSandboxLease,
	createNetworkAskCallback,
	createSandboxedBashOps,
	extractBlockedWritePath,
	releaseSandboxLease,
	resolveAllowances,
	type SessionAllowances,
	supportsNodeEnvProxy,
} from "./runtime.ts";

export interface CreateSandboxExtensionOptions {
	/** Judge override for tests; defaults to the LLM judge over the shared catalog. */
	judge?: ApprovalJudge;
}

export function createSandboxExtension(options: CreateSandboxExtensionOptions = {}): InlineExtension {
	return {
		name: "sandbox",
		factory: (pi) => {
			const judge = options.judge ?? createLlmApprovalJudge();
			const localCwd = process.cwd();
			const leaseToken: object = {};
			const settingsCache = new Map<string, SettingsManager>();
			const settingsFor = (cwd: string): SettingsManager => {
				let settings = settingsCache.get(cwd);
				if (!settings) {
					settings = SettingsManager.create(cwd);
					settingsCache.set(cwd, settings);
				}
				return settings;
			};

			let sandboxEnabled = false;
			let sandboxInitialized = false;
			const allowances: SessionAllowances = { domains: [], readPaths: [], writePaths: [] };

			const effectiveAllowances = (cwd: string) => resolveAllowances(loadConfig(cwd), allowances);
			const effectiveDomains = (cwd: string) => effectiveAllowances(cwd).domains;
			const effectiveReadPaths = (cwd: string) => effectiveAllowances(cwd).readPaths;
			const effectiveWritePaths = (cwd: string) => effectiveAllowances(cwd).writePaths;

			const addAllowance = (kind: "domain" | "read" | "write", value: string): void => {
				const list =
					kind === "domain" ? allowances.domains : kind === "read" ? allowances.readPaths : allowances.writePaths;
				if (!list.includes(value)) list.push(value);
			};

			/**
			 * Ask-callback judge hook for connection-level network review. Grants
			 * are recorded as session allowances without reinitializing: the ask
			 * callback fires while a command is running, and a reinit here could
			 * tear down that command's sandbox (Linux netns). The next refresh
			 * folds the grant into the merged runtime config.
			 */
			const makeAskCallback = (config: SandboxConfig) =>
				createNetworkAskCallback({
					getGrantedRules: () => allowances.domains,
					judgeHost: async (host) => {
						const outcome = await resolveApproval({
							kind: "bash-domain",
							target: host,
							validateRule: (rule) => validDomainRule(host, rule),
							judge,
							settings: config.approval,
							applySession: async () => {},
							audit,
						});
						if (outcome.action !== "granted") return null;
						addAllowance("domain", outcome.value);
						return outcome.value;
					},
				});

			async function refreshSandbox(cwd: string): Promise<void> {
				if (!sandboxInitialized) return;
				const config = loadConfig(cwd);
				try {
					await acquireSandboxLease(leaseToken, config, allowances, makeAskCallback(config));
				} catch (error) {
					console.error(`Warning: Failed to reinitialize sandbox: ${error}`);
				}
			}

			async function applyChoice(kind: "domain" | "read" | "write", value: string, cwd: string): Promise<void> {
				addAllowance(kind, value);
				await refreshSandbox(cwd);
			}

			function audit(record: ApprovalAuditRecord): void {
				try {
					pi.appendEntry("sandbox-approval", record);
				} catch {
					// Session replaced/reloaded; the record has nowhere to go.
				}
			}

			/**
			 * Batch-judge the URL-shaped domains of a bash command against the
			 * whitelist. Returns null when every domain is already allowed;
			 * otherwise grants and denials per target (grants already applied to
			 * the session allowances).
			 */
			async function judgeCommandDomains(
				command: string,
				cwd: string,
				config: SandboxConfig,
			): Promise<BatchApprovalOutcome | null> {
				const disallowed = extractDomainsFromCommand(command).filter(
					(domain) => !domainIsAllowed(domain, effectiveDomains(cwd)),
				);
				if (disallowed.length === 0) return null;
				return resolveApprovalBatch({
					kind: "bash-domain",
					targets: disallowed,
					command,
					validateRule: validDomainRule,
					judge,
					settings: config.approval,
					applySession: async (rules) => {
						for (const rule of rules) addAllowance("domain", rule);
					},
					audit,
				});
			}

			function deniedSummary(denied: BatchApprovalOutcome["denied"]): string {
				return denied.map((entry) => `"${entry.target}": ${entry.reason}`).join("; ");
			}

			function updateStatus(
				ctx: Parameters<typeof warnIfAllDomainsAllowed>[0],
				config: ReturnType<typeof loadConfig>,
			) {
				ctx.ui.setStatus("sandbox", formatSandboxStatus(config, allowances));
			}

			async function enableSandbox(
				ctx: Parameters<typeof warnIfAllDomainsAllowed>[0],
				setProxyEnvironment: boolean,
			): Promise<boolean> {
				if (sandboxEnabled) {
					ctx.ui.notify("Sandbox is already enabled", "info");
					return false;
				}

				const config = loadConfig(ctx.cwd);
				const platform = process.platform;
				if (platform !== "darwin" && platform !== "linux") {
					ctx.ui.notify(`Sandbox not supported on ${platform}`, "warning");
					return false;
				}

				try {
					await acquireSandboxLease(leaseToken, config, allowances, makeAskCallback(config));
					if (setProxyEnvironment && supportsNodeEnvProxy(process.versions.node)) {
						process.env.NODE_USE_ENV_PROXY ??= "1";
					}
					sandboxEnabled = true;
					sandboxInitialized = true;
					warnIfAllDomainsAllowed(ctx, config);
					updateStatus(ctx, config);
					return true;
				} catch (error) {
					sandboxEnabled = false;
					ctx.ui.notify(
						`Sandbox initialization failed: ${error instanceof Error ? error.message : error}`,
						"error",
					);
					return false;
				}
			}

			async function releaseLease(): Promise<void> {
				if (!sandboxInitialized) return;
				try {
					await releaseSandboxLease(leaseToken);
				} catch {
					// Ignore cleanup errors.
				}
				sandboxInitialized = false;
			}

			async function disableSandbox(ctx: Parameters<typeof warnIfAllDomainsAllowed>[0]): Promise<boolean> {
				if (!sandboxEnabled) {
					ctx.ui.notify("Sandbox is already disabled", "info");
					return false;
				}

				await releaseLease();
				sandboxEnabled = false;
				ctx.ui.setStatus("sandbox", undefined);
				return true;
			}

			const bashTemplate = createBashToolDefinition(localCwd);
			type BashToolResult = Awaited<ReturnType<typeof bashTemplate.execute>>;

			pi.registerTool({
				...bashTemplate,
				label: "bash (sandboxed)",
				async execute(toolCallId, params, signal, onUpdate, ctx) {
					const runBash = (): Promise<BashToolResult> => {
						const cwd = ctx?.cwd ?? localCwd;
						const settings = settingsFor(cwd);
						const sandboxed = sandboxEnabled && sandboxInitialized;
						const inner = createBashToolDefinition(cwd, {
							shellPath: settings.getShellPath(),
							commandPrefix: settings.getShellCommandPrefix(),
							...(sandboxed
								? {
										operations: createSandboxedBashOps(
											settings.getShellPath(),
											loadConfig(cwd).network?.sshProxy !== false,
										),
									}
								: {}),
						});
						return inner.execute(toolCallId, params, signal, onUpdate, ctx);
					};

					let result: BashToolResult;
					try {
						result = await runBash();
					} catch (error) {
						if (!(error instanceof Error) || !error.message.includes("Operation not permitted")) {
							throw error;
						}
						result = {
							content: [
								{
									type: "text",
									text: `Error: Command failed with OS-level sandbox restriction: ${error.message}`,
								},
							],
							details: undefined,
						};
					}

					if (sandboxEnabled && sandboxInitialized && ctx) {
						const output = result.content
							.filter((content) => content.type === "text")
							.map((content) => (content.type === "text" ? content.text : ""))
							.join("\n");
						const blockedPath = extractBlockedWritePath(output);

						if (blockedPath) {
							const path = canonicalizePath(blockedPath);
							const config = loadConfig(ctx.cwd);
							const policy = decideWritePolicy(
								path,
								effectiveWritePaths(ctx.cwd),
								config.filesystem?.denyWrite ?? [],
							);

							if (policy === "prompt") {
								const outcome = await resolveApproval({
									kind: "fs-write",
									target: path,
									command: params.command,
									validateRule: (rule) => validPathRule(path, rule),
									judge,
									settings: config.approval,
									applySession: (rule) => applyChoice("write", rule, ctx.cwd),
									audit,
								});
								if (outcome.action === "granted") {
									onUpdate?.({
										content: [
											{
												type: "text",
												text: `\n--- AI review granted write access for "${outcome.value}", retrying ---\n`,
											},
										],
										details: undefined,
									});
									await refreshSandbox(ctx.cwd);
									return runBash();
								}
								onUpdate?.({
									content: [
										{
											type: "text",
											text: `\n--- AI review denied write access for "${path}": ${outcome.reason} ---\n`,
										},
									],
									details: undefined,
								});
							}
						}
					}
					return result;
				},
			});

			pi.on("user_bash", async (event, ctx) => {
				if (!sandboxEnabled || !sandboxInitialized) return;

				const config = loadConfig(ctx.cwd);
				const outcome = await judgeCommandDomains(event.command, ctx.cwd, config);
				if (outcome) {
					if (outcome.granted.length > 0) await refreshSandbox(ctx.cwd);
					if (outcome.denied.length > 0) {
						return {
							result: {
								output: `Blocked: ${deniedSummary(outcome.denied)}`,
								exitCode: 1,
								cancelled: false,
								truncated: false,
							},
						};
					}
				}
				return {
					operations: createSandboxedBashOps(
						settingsFor(ctx.cwd).getShellPath(),
						loadConfig(ctx.cwd).network?.sshProxy !== false,
					),
				};
			});

			pi.on("tool_call", async (event, ctx) => {
				if (!sandboxEnabled) return;
				const config = loadConfig(ctx.cwd);
				if (!config.enabled) return;

				if (sandboxInitialized && isToolCallEventType("bash", event)) {
					const outcome = await judgeCommandDomains(event.input.command, ctx.cwd, config);
					if (outcome) {
						if (outcome.granted.length > 0) await refreshSandbox(ctx.cwd);
						if (outcome.denied.length > 0) {
							return {
								block: true,
								reason: `Network access denied — ${deniedSummary(outcome.denied)}`,
							};
						}
					}
				}

				if (isToolCallEventType("read", event)) {
					const path = canonicalizePath(event.input.path);
					if (!matchesPattern(path, effectiveReadPaths(ctx.cwd))) {
						const outcome = await resolveApproval({
							kind: "fs-read",
							target: path,
							validateRule: (rule) => validPathRule(path, rule),
							judge,
							settings: config.approval,
							applySession: (rule) => applyChoice("read", rule, ctx.cwd),
							audit,
						});
						if (outcome.action === "blocked") {
							return { block: true, reason: `Sandbox: read access denied for "${path}" — ${outcome.reason}` };
						}
						return;
					}
				}

				if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
					const path = canonicalizePath(event.input.path);
					const { projectPath, globalPath } = getConfigPaths(ctx.cwd);
					const policy = decideWritePolicy(path, effectiveWritePaths(ctx.cwd), config.filesystem?.denyWrite ?? []);

					if (policy === "deny") {
						return {
							block: true,
							reason:
								`Sandbox: write access denied for "${path}" (in denyWrite). ` +
								`To change this, edit denyWrite in:\n  ${projectPath}\n  ${globalPath}`,
						};
					}
					if (policy === "prompt") {
						const outcome = await resolveApproval({
							kind: "fs-write",
							target: path,
							validateRule: (rule) => validPathRule(path, rule),
							judge,
							settings: config.approval,
							applySession: (rule) => applyChoice("write", rule, ctx.cwd),
							audit,
						});
						if (outcome.action === "blocked") {
							return {
								block: true,
								reason: `Sandbox: write access denied for "${path}" — ${outcome.reason}`,
							};
						}
					}
				}
			});

			pi.on("session_start", async (_event, ctx) => {
				if (!loadConfig(ctx.cwd).enabled) {
					sandboxEnabled = false;
					await releaseLease();
					return;
				}
				await enableSandbox(ctx, true);
			});

			pi.on("session_shutdown", async () => {
				sandboxEnabled = false;
				await releaseLease();
			});

			pi.registerCommand("sandbox-enable", {
				description: "Enable the sandbox for this session",
				handler: async (_args, ctx) => {
					if (await enableSandbox(ctx, false)) ctx.ui.notify("Sandbox enabled", "info");
				},
			});

			pi.registerCommand("sandbox-disable", {
				description: "Disable the sandbox for this session",
				handler: async (_args, ctx) => {
					if (await disableSandbox(ctx)) ctx.ui.notify("Sandbox disabled", "info");
				},
			});

			pi.registerCommand("sandbox", {
				description: "Show sandbox configuration",
				handler: async (_args, ctx) => {
					if (!sandboxEnabled) {
						ctx.ui.notify("Sandbox is disabled", "info");
						return;
					}
					ctx.ui.notify(
						formatSandboxConfiguration(loadConfig(ctx.cwd), getConfigPaths(ctx.cwd), allowances),
						"info",
					);
				},
			});
		},
	};
}
