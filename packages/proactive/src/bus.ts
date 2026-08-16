/**
 * EventBus — 类型化事件发布订阅(akashic bus/event_bus.py 的最小移植)。
 *
 * 事件以「类」为类型键,handler 收到的是已构造的事件实例。订阅返回退订函数。
 * 用于:tick 终局/投递结果的通知(monitor 订阅、插件 hook),替代轮询与回调。
 */

import type { DriftEvent } from "@cogito/gate";

// biome-ignore lint/suspicious/noConfusingVoidType: handlers may be observers or ordered event transformers.
export type EventHandler<T> = (event: T) => T | void | Promise<T | void>;

export type EventErrorHandler = (error: unknown, event: object) => void | Promise<void>;

export interface EventScopeOptions {
	scope?: string;
}

export interface EventBusOptions {
	onHandlerError?: EventErrorHandler;
}

type EventType = new (...args: never[]) => object;
type EventKey = EventType | typeof ANY_EVENT;
type HandlerEntry = { handler: EventHandler<object>; scope?: string };
type QueuedEvent = { event: object; scope?: string };

const ANY_EVENT = Symbol("any-event");

interface EventBusState {
	handlers: Map<EventKey, Set<HandlerEntry>>;
	queue: QueuedEvent[];
	dispatchPromise: Promise<void> | undefined;
	closed: boolean;
	onHandlerError?: EventErrorHandler;
}

export class EventBus {
	private readonly state: EventBusState;
	private readonly scopeId: string | undefined;
	private readonly ownsState: boolean;
	private readonly subscriptions = new Set<() => void>();
	private closed = false;

	constructor(options: EventBusOptions = {}, state?: EventBusState, scopeId?: string) {
		this.state = state ?? {
			handlers: new Map(),
			queue: [],
			dispatchPromise: undefined,
			closed: false,
			onHandlerError: options.onHandlerError,
		};
		this.scopeId = scopeId;
		this.ownsState = state === undefined;
	}

	/** Create a child bus whose emissions and default subscriptions are scope-local. */
	scope(scopeId: string): EventBus {
		const normalized = scopeId.trim();
		if (!normalized) throw new Error("event bus scope must not be empty");
		this.ensureOpen();
		return new EventBus({}, this.state, normalized);
	}

	/** 订阅某类事件,返回退订函数。 */
	on<T extends object>(
		type: new (...args: never[]) => T,
		handler: EventHandler<T>,
		options: EventScopeOptions = {},
	): () => void {
		return this.subscribe(type, handler, options);
	}

	/** Subscribe to every event type in the current/default scope. */
	onAny(handler: EventHandler<object>, options: EventScopeOptions = {}): () => void {
		return this.subscribe(ANY_EVENT, handler, options);
	}

	private subscribe<T extends object>(
		type: EventKey,
		handler: EventHandler<T>,
		options: EventScopeOptions,
	): () => void {
		this.ensureOpen();
		let set = this.state.handlers.get(type);
		if (!set) {
			set = new Set();
			this.state.handlers.set(type, set);
		}
		const entry: HandlerEntry = {
			handler: handler as unknown as EventHandler<object>,
			scope: options.scope ?? this.scopeId,
		};
		set.add(entry);
		let active = true;
		const unsubscribe = () => {
			if (!active) return;
			active = false;
			set?.delete(entry);
			this.subscriptions.delete(unsubscribe);
		};
		this.subscriptions.add(unsubscribe);
		return unsubscribe;
	}

	/**
	 * Ordered interceptor chain. A handler can return a replacement event for
	 * the next handler; failures are isolated and reported through onHandlerError.
	 */
	async emit<T extends object>(event: T, options: EventScopeOptions = {}): Promise<T> {
		this.ensureOpen();
		const scope = options.scope ?? this.scopeId;
		let current = event;
		for (const entry of this.handlersFor(event, scope)) {
			const replacement = await this.invoke(entry, current);
			if (replacement !== undefined) current = replacement as T;
		}
		return current;
	}

	/** Sequential observer delivery. Handler return values are ignored. */
	async observe<T extends object>(event: T, options: EventScopeOptions = {}): Promise<void> {
		this.ensureOpen();
		const scope = options.scope ?? this.scopeId;
		for (const entry of this.handlersFor(event, scope)) {
			await this.invoke(entry, event);
		}
	}

	/** Parallel observer delivery. Handler return values are ignored. */
	async fanout<T extends object>(event: T, options: EventScopeOptions = {}): Promise<void> {
		this.ensureOpen();
		const scope = options.scope ?? this.scopeId;
		await Promise.all(this.handlersFor(event, scope).map(async (entry) => await this.invoke(entry, event)));
	}

	/** Queue non-critical observer work without holding up the caller's turn. */
	enqueue<T extends object>(event: T, options: EventScopeOptions = {}): void {
		if (this.closed || this.state.closed) return;
		this.state.queue.push({ event, scope: options.scope ?? this.scopeId });
		this.startQueuedDispatch();
	}

	/** Wait until events accepted by enqueue before this call have been dispatched. */
	async drain(): Promise<void> {
		while (this.state.dispatchPromise) {
			await this.state.dispatchPromise;
		}
	}

	/** Unsubscribe resources owned by this bus scope. */
	close(): void {
		if (this.closed) return;
		this.closed = true;
		for (const unsubscribe of [...this.subscriptions]) unsubscribe();
	}

	/** Close this scope; root buses also stop accepting queued events after draining. */
	async aclose(): Promise<void> {
		this.close();
		if (!this.ownsState) return;
		this.state.closed = true;
		await this.drain();
	}

	/** 退订(与 on 返回的退订函数等价,便于显式管理)。 */
	off<T extends object>(
		type: new (...args: never[]) => T,
		handler: EventHandler<T>,
		options: EventScopeOptions = {},
	): void {
		const set = this.state.handlers.get(type);
		if (!set) return;
		const scope = options.scope ?? this.scopeId;
		for (const entry of [...set]) {
			if (entry.handler === (handler as unknown as EventHandler<object>) && entry.scope === scope) {
				set.delete(entry);
			}
		}
	}

	/** 某类事件的订阅者数量(测试用)。 */
	subscriberCount<T extends object>(type: new (...args: never[]) => T, options: EventScopeOptions = {}): number {
		const scope = options.scope ?? this.scopeId;
		return [...(this.state.handlers.get(type) ?? [])].filter(
			(entry) => entry.scope === undefined || entry.scope === scope,
		).length;
	}

	private handlersFor(event: object, scope: string | undefined): HandlerEntry[] {
		const type = event.constructor as EventType;
		const handlers = [...(this.state.handlers.get(type) ?? []), ...(this.state.handlers.get(ANY_EVENT) ?? [])];
		return handlers.filter((entry) => entry.scope === undefined || entry.scope === scope);
	}

	private async invoke(entry: HandlerEntry, event: object): Promise<object | undefined> {
		try {
			const result = await entry.handler(event);
			return result === undefined ? undefined : result;
		} catch (error) {
			try {
				await this.state.onHandlerError?.(error, event);
			} catch {
				// Error reporting must not interfere with a protected event path.
			}
			return undefined;
		}
	}

	private startQueuedDispatch(): void {
		if (this.state.dispatchPromise) return;
		const dispatch = this.dispatchQueuedEvents();
		this.state.dispatchPromise = dispatch;
		void dispatch.finally(() => {
			if (this.state.dispatchPromise !== dispatch) return;
			this.state.dispatchPromise = undefined;
			if (this.state.queue.length > 0) this.startQueuedDispatch();
		});
	}

	private async dispatchQueuedEvents(): Promise<void> {
		while (this.state.queue.length > 0) {
			const queued = this.state.queue.shift();
			if (!queued) continue;
			await Promise.all(
				this.handlersFor(queued.event, queued.scope).map(async (entry) => await this.invoke(entry, queued.event)),
			);
		}
	}

	private ensureOpen(): void {
		if (this.closed || this.state.closed) throw new Error("event bus is closed");
	}
}

// ------------------------------------------------------------------
// 事件定义
// ------------------------------------------------------------------

/** 一次主动生命周期 turn 开始前的异步事件。 */
export class BeforeTurn {
	readonly sessionKey: string;
	readonly turnIndex: number;
	readonly startedAt: number;

	constructor(sessionKey: string, turnIndex: number, startedAt: number) {
		this.sessionKey = sessionKey;
		this.turnIndex = turnIndex;
		this.startedAt = startedAt;
	}
}

/** 一次 proactive tick 的终局(含 gate blocked / 空候选 / drift / 异常分支)。 */
export class ProactiveFinished {
	readonly tickId: number;
	readonly sessionKey: string;
	readonly action: string;
	readonly skipReason: string;
	readonly baseScore: number | null;
	readonly steps: number;
	readonly startedAt: number;
	readonly finishedAt: number;

	constructor(
		tickId: number,
		sessionKey: string,
		action: string,
		skipReason: string,
		baseScore: number | null,
		steps: number,
		startedAt: number,
		finishedAt: number,
	) {
		this.tickId = tickId;
		this.sessionKey = sessionKey;
		this.action = action;
		this.skipReason = skipReason;
		this.baseScore = baseScore;
		this.steps = steps;
		this.startedAt = startedAt;
		this.finishedAt = finishedAt;
	}
}

/** 一条推送消息投递成功。 */
export class Delivered {
	readonly sessionKey: string;
	readonly message: string;
	readonly itemIds: number[];
	readonly deliveredAt: number;

	constructor(sessionKey: string, message: string, itemIds: number[], deliveredAt: number) {
		this.sessionKey = sessionKey;
		this.message = message;
		this.itemIds = itemIds;
		this.deliveredAt = deliveredAt;
	}
}

/** Drift 生命周期事件在 Proactive 宿主总线中的统一封装。 */
export class DriftEventObserved {
	readonly event: DriftEvent;

	constructor(event: DriftEvent) {
		this.event = event;
	}
}
