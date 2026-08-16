import { randomUUID } from "node:crypto";
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { atomicWriteJson } from "./file-state.ts";

interface GatewayLockRecord {
	pid: number;
	startedAt: number;
	token: string;
}

interface ExistingGatewayLock {
	state: "missing" | "invalid" | "valid";
	record?: GatewayLockRecord;
}

export interface GatewayInstanceLockOwner {
	pid: number;
	startedAt: number;
}

export class GatewayInstanceLockError extends Error {
	readonly lockPath: string;
	readonly owner: GatewayInstanceLockOwner | undefined;

	constructor(lockPath: string, owner: GatewayInstanceLockOwner | undefined) {
		super(
			owner
				? `gateway is already running (pid ${owner.pid}): ${lockPath}`
				: `gateway lock already exists and cannot be safely recovered: ${lockPath}`,
		);
		this.name = "GatewayInstanceLockError";
		this.lockPath = lockPath;
		this.owner = owner;
	}
}

/** An exclusive process lock that can recover files left by a crashed process. */
export class GatewayInstanceLock {
	private released = false;
	readonly path: string;
	private readonly fileDescriptor: number;
	private readonly token: string;

	private constructor(path: string, fileDescriptor: number, token: string) {
		this.path = path;
		this.fileDescriptor = fileDescriptor;
		this.token = token;
	}

	static acquire(path: string): GatewayInstanceLock {
		mkdirSync(dirname(path), { recursive: true });
		for (let attempt = 0; attempt < 2; attempt++) {
			const token = randomUUID();
			let fileDescriptor: number;
			try {
				fileDescriptor = openSync(path, "wx", 0o600);
			} catch (error) {
				if (errorCode(error) !== "EEXIST") throw error;
				const existing = inspectLock(path);
				if (existing.state === "missing") continue;
				if (existing.record && !processExists(existing.record.pid)) {
					removeStaleLock(path, existing.record.token);
					continue;
				}
				throw new GatewayInstanceLockError(path, existing.record && toOwner(existing.record));
			}

			try {
				writeFileSync(fileDescriptor, JSON.stringify({ pid: process.pid, startedAt: Date.now(), token }), "utf8");
			} catch (error) {
				closeSync(fileDescriptor);
				unlinkIfPresent(path);
				throw error;
			}
			return new GatewayInstanceLock(path, fileDescriptor, token);
		}
		throw new GatewayInstanceLockError(path, undefined);
	}

	release(): void {
		if (this.released) return;
		this.released = true;
		closeSync(this.fileDescriptor);
		const existing = inspectLock(this.path);
		if (existing.record?.token === this.token) unlinkIfPresent(this.path);
	}
}

export type GatewayReadinessState = "starting" | "ready" | "degraded" | "stopped";

export interface GatewayReadinessChannel {
	name: string;
	running: boolean;
	ready: boolean;
}

export interface GatewayReadinessRecord {
	state: GatewayReadinessState;
	pid: number;
	updatedAt: number;
	channels: GatewayReadinessChannel[];
}

/** Write a secret-free readiness snapshot for local supervisors and diagnostics. */
export function writeGatewayReadiness(
	path: string,
	state: GatewayReadinessState,
	channels: readonly GatewayReadinessChannel[],
): GatewayReadinessRecord {
	const record: GatewayReadinessRecord = {
		state,
		pid: process.pid,
		updatedAt: Date.now(),
		channels: channels.map((channel) => ({ ...channel })),
	};
	atomicWriteJson(path, record, "gateway readiness");
	return record;
}

function inspectLock(path: string): ExistingGatewayLock {
	try {
		const stat = lstatSync(path);
		if (stat.isSymbolicLink() || !stat.isFile()) return { state: "invalid" };
	} catch (error) {
		if (errorCode(error) === "ENOENT") return { state: "missing" };
		throw error;
	}
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (!isGatewayLockRecord(parsed)) return { state: "invalid" };
		return { state: "valid", record: parsed };
	} catch {
		return { state: "invalid" };
	}
}

function removeStaleLock(path: string, token: string): void {
	const current = inspectLock(path);
	if (current.state === "missing") return;
	if (current.record?.token !== token) return;
	unlinkIfPresent(path);
}

function processExists(pid: number): boolean {
	if (!Number.isSafeInteger(pid) || pid < 1) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return errorCode(error) !== "ESRCH";
	}
}

function toOwner(record: GatewayLockRecord): GatewayInstanceLockOwner {
	return { pid: record.pid, startedAt: record.startedAt };
}

function isGatewayLockRecord(value: unknown): value is GatewayLockRecord {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		typeof (value as { pid?: unknown }).pid === "number" &&
		Number.isSafeInteger((value as { pid: number }).pid) &&
		typeof (value as { startedAt?: unknown }).startedAt === "number" &&
		Number.isFinite((value as { startedAt: number }).startedAt) &&
		typeof (value as { token?: unknown }).token === "string" &&
		(value as { token: string }).token.length > 0
	);
}

function unlinkIfPresent(path: string): void {
	try {
		unlinkSync(path);
	} catch (error) {
		if (errorCode(error) !== "ENOENT") throw error;
	}
}

function errorCode(error: unknown): string | undefined {
	if (!error || typeof error !== "object") return undefined;
	const code = (error as { code?: unknown }).code;
	return typeof code === "string" ? code : undefined;
}
