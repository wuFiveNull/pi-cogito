/**
 * @cogito/gateway — unified IM channel abstraction (nanobot-style).
 *
 * Channels convert platform messages into generic InboundMessage, hand them
 * to the agent via a MessageBus, and deliver agent replies (OutboundMessage /
 * OutboundDelta) back to the platform.
 *
 * Usage:
 *   const bus = new MessageBus();
 *   const registry = new ChannelRegistry();
 *   await registry.startAll(config, bus);
 *   const agent = new FakeAgent(bus); // or a real pi-core bridge later
 *   agent.start();
 */

export { type AgentAdapter, type AgentAdapterOptions, FakeAgent, type ReplyBuilder } from "./agent.ts";
export { FileAttachmentStore, type FileAttachmentStoreOptions } from "./attachments.ts";
export {
	type ChannelAuthConfig,
	type ChannelSignatureConfig,
	isAuthorizedRequest,
	verifyBodySignature,
} from "./auth.ts";
export {
	type DeliveryListener,
	type InboundListener,
	type InboundRetryOptions,
	MessageBus,
	MessageBusClosedError,
	MessageBusConsumerAbortedError,
	type MessageBusOptions,
	MessageBusOverflowError,
	type MessageBusSnapshot,
} from "./bus.ts";
export {
	BaseChannel,
	type ChannelConfig,
	type ChannelPublishResult,
	type ChannelPublishStatus,
	type GroupPolicy,
} from "./channels/base.ts";
export { ConsoleChannel } from "./channels/console.ts";
export {
	type ChannelAttachmentStore,
	type ChannelCleanup,
	type ChannelContext,
	type ChannelContextDependencies,
	ChannelContextScope,
	type ChannelEventBusLike,
	ChannelEventEmitter,
	type ChannelHttpResources,
	type ChannelInterruptControllerLike,
	type ChannelInterruptRequest,
	type ChannelInterruptResult,
	type ChannelLogger,
	type ChannelPushTool,
	type ChannelSessionManager,
	type ChannelStoredAttachment,
} from "./channels/context.ts";
export { DingtalkChannel, type DingtalkConfig } from "./channels/dingtalk.ts";
export { DiscordChannel } from "./channels/discord.ts";
export { OutboundDispatcher } from "./channels/dispatcher.ts";
export { EmailChannel } from "./channels/email.ts";
export { FeishuChannel } from "./channels/feishu.ts";
export { ChannelInterruptController } from "./channels/interrupt.ts";
export { MatrixChannel } from "./channels/matrix.ts";
export { MattermostChannel } from "./channels/mattermost.ts";
export { MochatChannel, type MochatConfig } from "./channels/mochat.ts";
export { MSTeamsChannel, type MSTeamsConfig } from "./channels/msteams.ts";
export {
	NapCatChannel,
	OneBotChannel,
	type OneBotConfig,
	type OneBotSocket,
	type OneBotTlsOptions,
	QqChannel,
	WebSocketClient,
} from "./channels/onebot.ts";
export {
	type ChannelFactory,
	type ChannelPluginDefinition,
	type ChannelSetupField,
	ChannelValidationError,
} from "./channels/plugin.ts";
export { type QqConfig, QqOfficialChannel } from "./channels/qq.ts";
export { type ChannelCatalogEntry, ChannelRegistry, type GatewayConfig } from "./channels/registry.ts";
export { SignalChannel, type SignalConfig } from "./channels/signal.ts";
export { SlackChannel } from "./channels/slack.ts";
export { TelegramChannel } from "./channels/telegram.ts";
export { type ApiRouteHandler, WebChannel } from "./channels/web.ts";
export { WebSocketChannel } from "./channels/websocket.ts";
export { WecomChannel, type WecomConfig } from "./channels/wecom.ts";
export { WeixinChannel, type WeixinConfig } from "./channels/weixin.ts";
export { GenericWsClient, WebSocketServer, type WsLike } from "./channels/ws-common.ts";
export {
	applyEnvOverrides,
	type GatewayConfigFile,
	GatewayConfigWatcher,
	type GatewayConfigWatchOptions,
	loadGatewayConfig,
	watchGatewayConfig,
} from "./config.ts";
export {
	createDeliveryClient,
	createDeliverySdk,
	DELIVERY_CHANNELS,
	type DeliveryChannelName,
	type DeliveryClient,
	type DeliveryClientOptions,
	type DeliverySdkOptions,
	type DeliveryTarget,
	type GatewayRootConfig,
	loadDeliveryTargets,
} from "./delivery.ts";
export {
	FileInboundDeadLetterStore,
	type InboundDeadLetterRecord,
	type InboundDeadLetterStore,
	InMemoryInboundDeadLetterStore,
} from "./inbound-dlq.ts";
export {
	GatewayInstanceLock,
	GatewayInstanceLockError,
	type GatewayInstanceLockOwner,
	type GatewayReadinessChannel,
	type GatewayReadinessRecord,
	type GatewayReadinessState,
	writeGatewayReadiness,
} from "./instance.ts";
export type { GatewayManagement } from "./management.ts";
export {
	attachmentFromMediaSource,
	type ChannelMediaCapabilities,
	collectOutboundMedia,
	guessMimeType,
	kindFromFilename,
	mediaFilename,
	mediaSourceKind,
	type ResolvedOutboundMedia,
	resolveOutboundMedia,
	sniffImageMime,
} from "./media.ts";
export {
	type ChannelMessageDirection,
	type ChannelMessageQuery,
	type ChannelMessageRecord,
	type ChannelMessageStatus,
	type ChannelMessageStore,
	FileChannelMessageStore,
	type InboundMessageRecord,
	type InboundMessageRecordStatus,
	messageRecordId,
	type OutboundMessageRecord,
	type OutboundMessageRecordStatus,
} from "./messages.ts";
export {
	FileOutboundOutbox,
	type OutboundOutbox,
	type OutboxCleanupOptions,
	type OutboxRecord,
	type OutboxStatus,
} from "./outbox.ts";
export { type ChannelRateLimitConfig, SlidingWindowRateLimiter } from "./rate-limit.ts";
export {
	type ChannelAgentErrorHandler,
	ChannelAgentRuntime,
	type ChannelAgentRuntimeOptions,
	type ChannelReply,
	type ChannelReplyHandler,
} from "./runtime.ts";
export {
	type ChannelMessageHandler,
	ChannelSdk,
	type ChannelSdkCapabilities,
	type ChannelSdkConfigWatchOptions,
	type ChannelSdkOptions,
	type ChannelSdkReadinessOptions,
	type ChannelSdkRetryOptions,
	type ChannelSdkStatus,
	type ChannelSdkTransportOptions,
	type ChannelSendReceipt,
	createChannelSdk,
} from "./sdk.ts";
export { type ChannelSessionRecord, FileChannelSessionStore } from "./session.ts";
export {
	type ChannelOffsetStore,
	FileChannelOffsetStore,
	FileInboundDedupStore,
	FileInboundHandoffStore,
	type InboundDedupStore,
	type InboundHandoffStore,
	InMemoryInboundDedupStore,
} from "./state.ts";
export { type ChannelTlsOptions, readTlsOptions } from "./tls.ts";
export {
	type AttachmentKind,
	buildSessionKey,
	type ChannelAttachment,
	type ChannelSendResult,
	createMessageId,
	type DeliveryReceipt,
	type DeliveryStatus,
	type ImageAttachment,
	type InboundMessage,
	type MessageId,
	type OutboundDelta,
	type OutboundMessage,
	type ReplyReference,
} from "./types.ts";
