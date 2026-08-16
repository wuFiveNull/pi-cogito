import type { MessageBusSnapshot } from "./bus.ts";
import type { ChannelCatalogEntry } from "./channels/registry.ts";
import type { InboundDeadLetterRecord } from "./inbound-dlq.ts";
import type { ChannelMessageQuery, ChannelMessageRecord } from "./messages.ts";
import type { OutboxCleanupOptions, OutboxRecord, OutboxStatus } from "./outbox.ts";
import type { DeliveryReceipt, OutboundMessage } from "./types.ts";

/** Narrow management surface exposed by the Web channel and host integrations. */
export interface GatewayManagement {
	status(): unknown;
	metrics(): MessageBusSnapshot;
	listOutbox(status?: OutboxStatus): OutboxRecord[];
	retryDelivery(messageId: string): Promise<boolean>;
	cleanupOutbox(options?: OutboxCleanupOptions): number;
	listMessages(query?: ChannelMessageQuery): ChannelMessageRecord[] | undefined;
	listInboundDeadLetters(): InboundDeadLetterRecord[];
	retryInbound(messageId: string): Promise<boolean>;
	onDelivery(listener: (receipt: DeliveryReceipt) => void | Promise<void>): () => void;
	/** Deliver an outbound message through a configured channel (delivery SDK entry). */
	deliver(message: OutboundMessage): Promise<DeliveryReceipt>;
	/** Channel catalog for onboarding: builtin + host-registered plugin types. */
	channelCatalog?(): ChannelCatalogEntry[];
}
