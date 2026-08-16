import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import {
	closeSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export interface FileStateLockOptions {
	/** Maximum time spent waiting for another process to release the lock. */
	lockTimeoutMs?: number;
	/** A lock older than this is assumed to belong to a crashed process. */
	staleLockMs?: number;
}

const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_STALE_LOCK_MS = 30_000;

/** Read a state file only when it is a regular, non-symlink file. */
export function readRegularFile(filePath: string, label: string): string | undefined {
	const stat = existingStat(filePath);
	if (!stat) return undefined;
	if (stat.isSymbolicLink() || !stat.isFile()) {
		throw new Error(`${label} path is not a regular file: ${filePath}`);
	}
	return readFileSync(filePath, "utf8");
}

/** Atomically replace a JSON state file after checking the target path. */
export function atomicWriteJson(filePath: string, value: unknown, label: string): void {
	mkdirSync(dirname(filePath), { recursive: true });
	const existing = existingStat(filePath);
	if (existing && (existing.isSymbolicLink() || !existing.isFile())) {
		throw new Error(`${label} path is not a regular file: ${filePath}`);
	}
	const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporaryPath, JSON.stringify(value), { encoding: "utf8", mode: 0o600 });
		renameSync(temporaryPath, filePath);
	} finally {
		unlinkIfPresent(temporaryPath);
	}
}

/** Serialize a read/modify/write transaction across gateway processes. */
export function withFileStateLock<T>(filePath: string, operation: () => T, options: FileStateLockOptions = {}): T {
	mkdirSync(dirname(filePath), { recursive: true });
	const lockPath = `${filePath}.lock`;
	const lockFd = acquireLock(
		lockPath,
		positiveNumber(options.lockTimeoutMs, DEFAULT_LOCK_TIMEOUT_MS),
		positiveNumber(options.staleLockMs, DEFAULT_STALE_LOCK_MS),
	);
	try {
		return operation();
	} finally {
		closeSync(lockFd);
		unlinkIfPresent(lockPath);
	}
}

function unlinkIfPresent(path: string): void {
	try {
		unlinkSync(path);
	} catch (error) {
		if (errorCode(error) !== "ENOENT") throw error;
	}
}

function acquireLock(lockPath: string, timeoutMs: number, staleLockMs: number): number {
	const deadline = Date.now() + timeoutMs;
	const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
	for (;;) {
		try {
			return openSync(lockPath, "wx", 0o600);
		} catch (error) {
			if (errorCode(error) !== "EEXIST") throw error;
			const lock = existingStat(lockPath);
			if (!lock) continue;
			if (lock.isSymbolicLink()) throw new Error(`state lock path is a symbolic link: ${lockPath}`);
			if (Date.now() - lock.mtimeMs >= staleLockMs) {
				try {
					unlinkSync(lockPath);
				} catch (unlinkError) {
					if (errorCode(unlinkError) !== "ENOENT") throw unlinkError;
				}
				continue;
			}
			if (Date.now() >= deadline) {
				throw new Error(`state file lock timed out: ${lockPath}`);
			}
			Atomics.wait(waitBuffer, 0, 0, Math.min(10, Math.max(1, deadline - Date.now())));
		}
	}
}

function existingStat(filePath: string): Stats | undefined {
	try {
		return lstatSync(filePath);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return undefined;
		throw error;
	}
}

function positiveNumber(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function errorCode(error: unknown): string | undefined {
	if (!error || typeof error !== "object") return undefined;
	const code = (error as { code?: unknown }).code;
	return typeof code === "string" ? code : undefined;
}
