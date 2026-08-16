/**
 * Proactive runtime snapshots.
 *
 * A snapshot owns one compiled runtime resource. New work leases the current
 * committed snapshot; a reload stops admitting new leases, publishes a
 * candidate, and drains the retired snapshot after its leases are released.
 * AsyncLocalStorage provides the JavaScript equivalent of Akashic's
 * ContextVar binding for code running inside a leased tick.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { type Clock, SystemClock } from "../clock.ts";

export type RuntimeSnapshotState = "compiled" | "validating" | "committed" | "retired" | "aborted" | "drained";

export interface RuntimeSnapshot<T> {
	readonly snapshotId: string;
	readonly fenceToken: number;
	readonly resource: T;
	state: RuntimeSnapshotState;
	leaseCount: number;
	acceptingLeases: boolean;
}

export interface SnapshotTransaction<T> {
	readonly previous: RuntimeSnapshot<T> | undefined;
	readonly candidate: RuntimeSnapshot<T>;
}

export interface SnapshotResourceLifecycle {
	pause?(): Promise<void> | void;
	resume?(): Promise<void> | void;
	stop?(): Promise<void> | void;
}

export interface RuntimeReplayEvent {
	sequence: number;
	type:
		| "snapshot_installed"
		| "snapshot_publish_started"
		| "snapshot_committed"
		| "snapshot_aborted"
		| "snapshot_paused"
		| "snapshot_resumed"
		| "lease_acquired"
		| "lease_released"
		| "snapshot_drained";
	at: number;
	snapshotId: string;
	fenceToken: number;
	leaseCount: number;
	payload?: Record<string, unknown>;
}

/** Append-only runtime journal used by reload/replay diagnostics. */
export class RuntimeReplayJournal {
	private readonly path: string;
	private readonly clock: Clock;
	private sequence: number;

	constructor(path: string, clock: Clock = SystemClock) {
		this.path = path;
		this.clock = clock;
		this.sequence = this.readLastSequence();
	}

	append(event: Omit<RuntimeReplayEvent, "sequence" | "at">): RuntimeReplayEvent {
		const record: RuntimeReplayEvent = {
			...event,
			sequence: ++this.sequence,
			at: this.clock.nowMs(),
		};
		mkdirSync(dirname(this.path), { recursive: true });
		appendFileSync(this.path, `${JSON.stringify(record)}\n`, "utf-8");
		return record;
	}

	list(limit = 100): RuntimeReplayEvent[] {
		if (!existsSync(this.path)) return [];
		let lines: string[];
		try {
			lines = readFileSync(this.path, "utf-8").split("\n");
		} catch {
			return [];
		}
		const events: RuntimeReplayEvent[] = [];
		for (const line of lines) {
			if (!line.trim()) continue;
			try {
				const value: unknown = JSON.parse(line);
				if (isReplayEvent(value)) events.push(value);
			} catch {
				// A truncated final line must not make the rest of the journal unreadable.
			}
		}
		return events.slice(Math.max(0, events.length - Math.max(1, Math.trunc(limit))));
	}

	private readLastSequence(): number {
		const last = this.list(1)[0];
		return last?.sequence ?? 0;
	}
}

export class RuntimeSnapshotFenceError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RuntimeSnapshotFenceError";
	}
}

export class RuntimeSnapshotLease<T> {
	private released = false;
	private readonly store: RuntimeSnapshotStore<T>;
	readonly snapshot: RuntimeSnapshot<T>;

	constructor(store: RuntimeSnapshotStore<T>, snapshot: RuntimeSnapshot<T>) {
		this.store = store;
		this.snapshot = snapshot;
	}

	get active(): boolean {
		return !this.released;
	}

	get resource(): T {
		this.assertActive();
		return this.snapshot.resource;
	}

	assertActive(): void {
		if (this.released || this.snapshot.state === "aborted" || this.snapshot.state === "drained") {
			throw new RuntimeSnapshotFenceError(`runtime snapshot lease is fenced: ${this.snapshot.snapshotId}`);
		}
	}

	/** A lease may finish after publication, but never after it is released. */
	assertFence(): void {
		this.assertActive();
	}

	fork(): RuntimeSnapshotLease<T> {
		this.assertActive();
		return this.store.forkLease(this);
	}

	async release(): Promise<void> {
		if (this.released) return;
		this.released = true;
		await this.store.releaseLease(this.snapshot);
	}
}

interface RuntimeSnapshotBinding {
	readonly lease: RuntimeSnapshotLease<unknown>;
}

const runtimeSnapshotStorage = new AsyncLocalStorage<RuntimeSnapshotBinding | undefined>();

/** Run a callback with a leased runtime snapshot bound to the async context. */
export function withRuntimeSnapshot<T, R>(lease: RuntimeSnapshotLease<T>, callback: () => R): R {
	lease.assertActive();
	const binding: RuntimeSnapshotBinding = { lease: lease as unknown as RuntimeSnapshotLease<unknown> };
	return runtimeSnapshotStorage.run(binding, callback);
}

/** Bind a snapshot for synchronous/manual scopes; always call token.reset(). */
export function bindRuntimeSnapshot<T>(lease: RuntimeSnapshotLease<T>): { reset(): void } {
	lease.assertActive();
	const previous = runtimeSnapshotStorage.getStore();
	runtimeSnapshotStorage.enterWith({ lease: lease as unknown as RuntimeSnapshotLease<unknown> });
	return {
		reset: () => runtimeSnapshotStorage.enterWith(previous),
	};
}

export function getCurrentRuntimeLease<T>(): RuntimeSnapshotLease<T> | undefined {
	const lease = runtimeSnapshotStorage.getStore()?.lease;
	if (!lease || !lease.active) return undefined;
	return lease as RuntimeSnapshotLease<T>;
}

export function getCurrentRuntimeSnapshot<T>(): RuntimeSnapshot<T> | undefined {
	const lease = getCurrentRuntimeLease<T>();
	return lease?.snapshot;
}

export interface RuntimeSnapshotStoreOptions<T> {
	clock?: Clock;
	journal?: RuntimeReplayJournal;
	/** Stop a resource when its snapshot drains; default true. */
	stopResource?: boolean;
	onDrained?: (snapshot: RuntimeSnapshot<T>) => Promise<void> | void;
	onDrainError?: (snapshot: RuntimeSnapshot<T>, error: unknown) => void | Promise<void>;
}

/** Transactional snapshot store with lease admission and retired-resource drain. */
export class RuntimeSnapshotStore<T> {
	private readonly snapshots = new Map<string, RuntimeSnapshot<T>>();
	private readonly clock: Clock;
	private readonly journal: RuntimeReplayJournal | undefined;
	private readonly stopResource: boolean;
	private readonly onDrained: ((snapshot: RuntimeSnapshot<T>) => Promise<void> | void) | undefined;
	private readonly onDrainError: ((snapshot: RuntimeSnapshot<T>, error: unknown) => void | Promise<void>) | undefined;
	private currentSnapshot: RuntimeSnapshot<T> | undefined;
	private pendingTransaction: SnapshotTransaction<T> | undefined;
	private nextFenceToken = 0;
	private readonly waiters = new Set<() => void>();
	private readonly drains = new Map<string, Promise<void>>();

	constructor(options: RuntimeSnapshotStoreOptions<T> = {}) {
		this.clock = options.clock ?? SystemClock;
		this.journal = options.journal;
		this.stopResource = options.stopResource ?? true;
		this.onDrained = options.onDrained;
		this.onDrainError = options.onDrainError;
	}

	get current(): RuntimeSnapshot<T> | undefined {
		return this.currentSnapshot;
	}

	get pendingCandidate(): RuntimeSnapshot<T> | undefined {
		return this.pendingTransaction?.candidate;
	}

	get retainedSnapshotIds(): string[] {
		return [...this.snapshots.keys()].sort();
	}

	install(resource: T, snapshotId = this.newSnapshotId()): RuntimeSnapshot<T> {
		if (this.currentSnapshot || this.pendingTransaction) {
			throw new Error("runtime snapshot store already has an installed snapshot");
		}
		const snapshot = this.createSnapshot(resource, snapshotId);
		snapshot.state = "committed";
		snapshot.acceptingLeases = true;
		this.snapshots.set(snapshot.snapshotId, snapshot);
		this.currentSnapshot = snapshot;
		this.record("snapshot_installed", snapshot);
		return snapshot;
	}

	beginPublish(resource: T, snapshotId = this.newSnapshotId()): SnapshotTransaction<T> {
		if (this.pendingTransaction) throw new Error("runtime snapshot publish transaction already exists");
		if (this.snapshots.has(snapshotId)) throw new Error(`runtime snapshot already exists: ${snapshotId}`);
		const candidate = this.createSnapshot(resource, snapshotId);
		candidate.state = "validating";
		candidate.acceptingLeases = false;
		const transaction = { previous: this.currentSnapshot, candidate };
		this.snapshots.set(candidate.snapshotId, candidate);
		this.pendingTransaction = transaction;
		this.record("snapshot_publish_started", candidate);
		return transaction;
	}

	async commit(transaction: SnapshotTransaction<T>): Promise<void> {
		this.requirePending(transaction);
		const previous = transaction.previous;
		transaction.candidate.state = "committed";
		transaction.candidate.acceptingLeases = true;
		this.currentSnapshot = transaction.candidate;
		this.pendingTransaction = undefined;
		if (previous) {
			previous.state = "retired";
			previous.acceptingLeases = false;
		}
		this.record("snapshot_committed", transaction.candidate, {
			previousSnapshotId: previous?.snapshotId ?? null,
			previousFenceToken: previous?.fenceToken ?? null,
		});
		this.notifyWaiters();
		if (previous) this.scheduleDrain(previous);
	}

	async abort(transaction: SnapshotTransaction<T>): Promise<void> {
		this.requirePending(transaction);
		transaction.candidate.state = "aborted";
		transaction.candidate.acceptingLeases = false;
		this.pendingTransaction = undefined;
		if (this.currentSnapshot === transaction.previous && transaction.previous) {
			transaction.previous.acceptingLeases = true;
		}
		this.record("snapshot_aborted", transaction.candidate);
		this.notifyWaiters();
		this.scheduleDrain(transaction.candidate);
		await this.waitForDrain(transaction.candidate);
	}

	/** Pause current admission and await active work before a candidate starts. */
	async quiesceCurrent(): Promise<RuntimeSnapshot<T> | undefined> {
		const snapshot = this.pauseAdmission();
		if (!snapshot) return undefined;
		try {
			await callLifecycle(snapshot.resource, "pause");
			await this.waitForNoLeases(snapshot);
			return snapshot;
		} catch (error) {
			await this.resume(snapshot);
			throw error;
		}
	}

	pauseAdmission(): RuntimeSnapshot<T> | undefined {
		const snapshot = this.currentSnapshot;
		if (!snapshot) return undefined;
		snapshot.acceptingLeases = false;
		this.record("snapshot_paused", snapshot);
		this.notifyWaiters();
		return snapshot;
	}

	async resume(snapshot: RuntimeSnapshot<T> | undefined): Promise<void> {
		if (!snapshot) return;
		if (this.currentSnapshot === snapshot && snapshot.state === "committed") {
			await callLifecycle(snapshot.resource, "resume");
			snapshot.acceptingLeases = true;
			this.record("snapshot_resumed", snapshot);
		}
		this.notifyWaiters();
	}

	async acquire(snapshotId?: string): Promise<RuntimeSnapshotLease<T>> {
		for (;;) {
			const snapshot = snapshotId ? this.snapshots.get(snapshotId) : this.currentSnapshot;
			if (!snapshot) throw new RuntimeSnapshotFenceError("runtime snapshot is unavailable");
			if (snapshot.state === "aborted" || snapshot.state === "drained") {
				throw new RuntimeSnapshotFenceError(`runtime snapshot is not leasable: ${snapshot.state}`);
			}
			if (snapshotId && (snapshot.state !== "committed" || !snapshot.acceptingLeases)) {
				throw new RuntimeSnapshotFenceError(`runtime snapshot is not accepting leases: ${snapshot.snapshotId}`);
			}
			if (snapshot.state === "committed" && snapshot.acceptingLeases) {
				return this.claimLease(snapshot);
			}
			await this.waitForChange();
		}
	}

	lease(snapshotId?: string): RuntimeSnapshotLease<T> {
		const snapshot = snapshotId ? this.snapshots.get(snapshotId) : this.currentSnapshot;
		if (!snapshot) throw new RuntimeSnapshotFenceError("runtime snapshot is unavailable");
		if (snapshot.state !== "committed" || !snapshot.acceptingLeases) {
			throw new RuntimeSnapshotFenceError(`runtime snapshot is not accepting leases: ${snapshot.snapshotId}`);
		}
		return this.claimLease(snapshot);
	}

	forkLease(source: RuntimeSnapshotLease<T>): RuntimeSnapshotLease<T> {
		const snapshot = source.snapshot;
		if (!source.active || this.snapshots.get(snapshot.snapshotId) !== snapshot) {
			throw new RuntimeSnapshotFenceError(`runtime snapshot lease cannot be forked: ${snapshot.snapshotId}`);
		}
		return this.claimLease(snapshot);
	}

	async releaseLease(snapshot: RuntimeSnapshot<T>): Promise<void> {
		if (snapshot.leaseCount <= 0)
			throw new RuntimeSnapshotFenceError(`runtime snapshot lease imbalance: ${snapshot.snapshotId}`);
		snapshot.leaseCount -= 1;
		this.record("lease_released", snapshot);
		this.notifyWaiters();
		if (snapshot.leaseCount === 0) this.scheduleDrain(snapshot);
	}

	async waitForNoLeases(snapshot: RuntimeSnapshot<T>): Promise<void> {
		while (snapshot.leaseCount > 0) await this.waitForChange();
	}

	async waitForDrain(snapshot: RuntimeSnapshot<T>): Promise<void> {
		await this.drains.get(snapshot.snapshotId);
	}

	async close(): Promise<void> {
		if (this.pendingTransaction) throw new Error("runtime snapshot publish transaction is unfinished");
		const current = this.currentSnapshot;
		if (current) {
			this.pauseAdmission();
			await this.callResourcePause(current);
			await this.waitForNoLeases(current);
			current.state = "retired";
			this.currentSnapshot = undefined;
			this.notifyWaiters();
			this.scheduleDrain(current);
		}
		await Promise.all([...this.drains.values()]);
	}

	private createSnapshot(resource: T, snapshotId: string): RuntimeSnapshot<T> {
		return {
			snapshotId,
			fenceToken: ++this.nextFenceToken,
			resource,
			state: "compiled",
			leaseCount: 0,
			acceptingLeases: false,
		};
	}

	private claimLease(snapshot: RuntimeSnapshot<T>): RuntimeSnapshotLease<T> {
		snapshot.leaseCount += 1;
		this.record("lease_acquired", snapshot);
		return new RuntimeSnapshotLease(this, snapshot);
	}

	private scheduleDrain(snapshot: RuntimeSnapshot<T>): void {
		if ((snapshot.state !== "retired" && snapshot.state !== "aborted") || snapshot.leaseCount > 0) return;
		if (this.drains.has(snapshot.snapshotId)) return;
		const drain = this.drain(snapshot);
		this.drains.set(snapshot.snapshotId, drain);
	}

	private async drain(snapshot: RuntimeSnapshot<T>): Promise<void> {
		try {
			if (this.stopResource) await callLifecycle(snapshot.resource, "stop");
			if (snapshot.state !== "aborted") snapshot.state = "drained";
			this.record("snapshot_drained", snapshot);
			this.snapshots.delete(snapshot.snapshotId);
			await this.onDrained?.(snapshot);
		} catch (error) {
			await this.onDrainError?.(snapshot, error);
			throw error;
		}
	}

	private async callResourcePause(snapshot: RuntimeSnapshot<T>): Promise<void> {
		await callLifecycle(snapshot.resource, "pause");
	}

	private requirePending(transaction: SnapshotTransaction<T>): void {
		if (this.pendingTransaction !== transaction) throw new Error("runtime snapshot transaction is not pending");
	}

	private newSnapshotId(): string {
		return `snapshot-${this.nextFenceToken + 1}-${this.clock.nowMs()}`;
	}

	private record(
		type: RuntimeReplayEvent["type"],
		snapshot: RuntimeSnapshot<T>,
		payload?: Record<string, unknown>,
	): void {
		this.journal?.append({
			type,
			snapshotId: snapshot.snapshotId,
			fenceToken: snapshot.fenceToken,
			leaseCount: snapshot.leaseCount,
			payload,
		});
	}

	private notifyWaiters(): void {
		for (const resolve of this.waiters) resolve();
		this.waiters.clear();
	}

	private waitForChange(): Promise<void> {
		return new Promise((resolve) => this.waiters.add(resolve));
	}
}

async function callLifecycle<T>(resource: T, method: keyof SnapshotResourceLifecycle): Promise<void> {
	if (typeof resource !== "object" || resource === null) return;
	const action = (resource as SnapshotResourceLifecycle)[method];
	if (typeof action === "function") await action.call(resource);
}

function isReplayEvent(value: unknown): value is RuntimeReplayEvent {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.sequence === "number" &&
		typeof record.type === "string" &&
		typeof record.at === "number" &&
		typeof record.snapshotId === "string" &&
		typeof record.fenceToken === "number" &&
		typeof record.leaseCount === "number"
	);
}
