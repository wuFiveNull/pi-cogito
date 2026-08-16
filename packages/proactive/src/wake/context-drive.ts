/**
 * Wake context 驱动(akashic plugins/wake_proactive/context_drive.py port)。
 */

export type Presence = "active" | "idle" | "sleeping" | "in_game" | "offline" | "unknown";
export type ContextSignal = "refresh" | "reevaluate";

export interface NormalizedContext {
	presence: Presence;
	interruptibility: number;
	confidence: number;
	transition: string;
	observedAt: Date | null;
	expiresAt: Date | null;
	raw: Record<string, unknown>;
}

export interface ContextDriveResult {
	context: NormalizedContext;
	signal: ContextSignal;
	shouldContact: boolean;
	changedFields: string[];
}

const PRESENCE_ALIASES: Record<string, Presence> = {
	active: "active",
	awake: "active",
	online: "active",
	idle: "idle",
	away: "idle",
	sleeping: "sleeping",
	asleep: "sleeping",
	in_game: "in_game",
	playing: "in_game",
	offline: "offline",
	unknown: "unknown",
};

const INTERRUPTIBILITY_DEFAULTS: Record<Presence, number> = {
	active: 0.8,
	idle: 0.65,
	sleeping: 0.0,
	in_game: 0.15,
	offline: 0.0,
	unknown: 0.5,
};

function bounded(value: unknown): number {
	try {
		return Math.min(1, Math.max(0, Number(String(value))));
	} catch {
		return 0;
	}
}

function optionalTime(value: unknown): Date | null {
	if (value === null || value === undefined || value === "") return null;
	const parsed = new Date(String(value).replace("Z", "+00:00"));
	return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function presence(snapshot: Record<string, unknown>): Presence {
	const raw = String(snapshot.presence ?? "")
		.trim()
		.toLowerCase()
		.replace(/-/g, "_");
	if (raw in PRESENCE_ALIASES) return PRESENCE_ALIASES[raw]!;
	if (snapshot.sleeping === true) return "sleeping";
	if (snapshot.in_game === true || String(snapshot.current_game ?? "").trim()) return "in_game";
	if (snapshot.online === false) return "offline";
	return "unknown";
}

function interruptibility(snapshot: Record<string, unknown>, presenceValue: Presence): number {
	const explicit = snapshot.interruptibility;
	if (typeof explicit === "string") {
		const values: Record<string, number> = { high: 0.85, medium: 0.5, low: 0.15, none: 0 };
		const key = explicit.trim().toLowerCase();
		if (key in values) return values[key]!;
	}
	if (explicit !== null && explicit !== undefined) return bounded(explicit);
	const value = INTERRUPTIBILITY_DEFAULTS[presenceValue]!;
	return snapshot.busy === true ? Math.min(value, 0.1) : value;
}

function changedFields(
	previous: NormalizedContext | null,
	presenceValue: Presence,
	interruptibilityValue: number,
): string[] {
	if (previous === null) return [];
	const changed: string[] = [];
	if (previous.presence !== presenceValue) changed.push("presence");
	if (Math.abs(previous.interruptibility - interruptibilityValue) >= 0.2) changed.push("interruptibility");
	return changed;
}

/** 评估一条 context 快照(akashic evaluate_context)。 */
export function evaluateContext(
	snapshot: Record<string, unknown>,
	options: { previous?: NormalizedContext | null; transitionConfidence?: number } = {},
): ContextDriveResult {
	const previous = options.previous ?? null;
	const transitionConfidence = options.transitionConfidence ?? 0.55;
	const presenceValue = presence(snapshot);
	const confidence = bounded(snapshot.confidence ?? snapshot.presence_confidence ?? 0.5);
	const interruptibilityValue = interruptibility(snapshot, presenceValue);
	const observedAt = optionalTime(snapshot.observed_at ?? snapshot.changed_at);
	const expiresAt = optionalTime(snapshot.expires_at);
	const changed = changedFields(previous, presenceValue, interruptibilityValue);
	let transition = String(snapshot.transition ?? "").trim();
	if (!transition && previous !== null && changed.length > 0) {
		transition = `${previous.presence}->${presenceValue}`;
	}
	const meaningfulTransition =
		Boolean(transition) && confidence >= transitionConfidence && (previous === null || changed.length > 0);
	return {
		context: {
			presence: presenceValue,
			interruptibility: interruptibilityValue,
			confidence,
			transition,
			observedAt,
			expiresAt,
			raw: { ...snapshot },
		},
		signal: meaningfulTransition ? "reevaluate" : "refresh",
		shouldContact: false,
		changedFields: changed,
	};
}
