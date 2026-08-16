/**
 * Host delivery orchestration.
 *
 * The transport is allowed to be supplied by the host. Once the transport
 * accepts a message, session and presence updates are best-effort side
 * effects keyed by the same logical delivery. A session write failure must
 * not turn an already delivered message into a retry that could duplicate it.
 */

import type { ProactiveOutboundMessage, ProactiveOutboundReceipt, ProactiveRuntimePorts } from "./ports.ts";

export interface ProactiveTurnRequest {
	sessionKey: string;
	message: string;
	sourceRefs: readonly Record<string, unknown>[];
	deliveryKey: string;
	timestamp: number;
	acknowledgements?: Readonly<Record<string, readonly string[]>>;
}

export interface ProactiveSideEffectReport {
	sessionRecorded: boolean;
	presenceRecorded: boolean;
	memoryRecorded: boolean;
	acknowledged: boolean;
	errors: readonly string[];
}

export class ProactiveTurnOrchestrator {
	private readonly ports: ProactiveRuntimePorts;

	constructor(ports: ProactiveRuntimePorts = {}) {
		this.ports = ports;
	}

	async send(
		request: ProactiveTurnRequest,
		fallback: () => Promise<ProactiveOutboundReceipt>,
	): Promise<ProactiveOutboundReceipt> {
		const outbound = this.ports.outbound;
		if (!outbound) return await fallback();
		return await outbound.send(toOutboundMessage(request));
	}

	async afterSuccessfulDelivery(request: ProactiveTurnRequest): Promise<ProactiveSideEffectReport> {
		const errors: string[] = [];
		let sessionRecorded = true;
		let presenceRecorded = true;
		let memoryRecorded = true;
		let acknowledged = true;

		const session = this.ports.session;
		if (session?.appendAssistantMessage) {
			try {
				await session.appendAssistantMessage({
					sessionKey: request.sessionKey,
					content: request.message,
					timestamp: request.timestamp,
					proactive: true,
				});
			} catch (error) {
				sessionRecorded = false;
				errors.push(`session append failed: ${formatError(error)}`);
			}
		}

		const presence = this.ports.presence;
		if (presence?.recordProactiveSent) {
			try {
				presence.recordProactiveSent({ sessionKey: request.sessionKey, timestamp: request.timestamp });
			} catch (error) {
				presenceRecorded = false;
				errors.push(`presence update failed: ${formatError(error)}`);
			}
		}

		const memory = this.ports.memory;
		if (memory?.recordEvent) {
			try {
				await memory.recordEvent({
					sessionKey: request.sessionKey,
					now: request.timestamp,
					event: {
						type: "proactive_delivery",
						deliveryKey: request.deliveryKey,
						message: request.message,
						sourceRefs: request.sourceRefs,
					},
				});
			} catch (error) {
				memoryRecorded = false;
				errors.push(`memory event failed: ${formatError(error)}`);
			}
		}

		const sourceAck = this.ports.sourceAck;
		if (sourceAck && request.acknowledgements) {
			for (const [sourceId, eventIds] of Object.entries(request.acknowledgements)) {
				if (eventIds.length === 0) continue;
				try {
					await sourceAck.acknowledge(sourceId, eventIds);
				} catch (error) {
					acknowledged = false;
					errors.push(`source acknowledgement failed (${sourceId}): ${formatError(error)}`);
				}
			}
		}

		return { sessionRecorded, presenceRecorded, memoryRecorded, acknowledged, errors };
	}
}

function toOutboundMessage(request: ProactiveTurnRequest): ProactiveOutboundMessage {
	return {
		sessionKey: request.sessionKey,
		message: request.message,
		sourceRefs: request.sourceRefs,
		deliveryKey: request.deliveryKey,
	};
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
