# @cogito/gateway

Unified IM channel abstraction (nanobot-style), extracted from the former
`apps/agent-gateway`.

Channels convert platform messages into generic `InboundMessage`, hand them to
the agent via a `MessageBus`, and deliver agent replies (`OutboundMessage` /
`OutboundDelta`) back to the platform.

## Channels

- HTTP/SSE (`WebChannel`), WebSocket (`WebSocketChannel`), console
- Telegram, Discord, Slack, Mattermost, Matrix, Feishu, Email
- OneBot (QQ / NapCat / custom WebSocket)

## Usage

```ts
import { createChannelSdk, FileOutboundOutbox } from "@cogito/gateway";

const channels = createChannelSdk({ configPath: "./config.json" });
channels.onMessage(async (message) => {
	// hand the normalized message to an agent
	await channels.send({ channel: message.channel, chatId: message.chatId, content: "ok" });
});
await channels.start();
```

`ChannelSdk` exposes the stable surface used by applications: `start`, `stop`,
`onMessage`, `send`, `sendDelta`, `status`, and `capabilities`. The bus,
registry, channel classes, and bounded retry policy remain implementation
details. Use the lower-level exports only when implementing a new channel or a
gateway integration.

## Multimodal outbound

All channels accept media on outbound messages. `media` accepts bare strings
(HTTP(S) URLs, local paths, or data URLs) and `attachments` accepts structured
`ChannelAttachment` entries (`kind`, `source`, `filename`, `mimeType`); the two
are merged and normalized by `collectOutboundMedia()` before sending, with the
kind inferred from the file extension:

```ts
await sdk.send({
	channel: "telegram",
	chatId: "42",
	content: "see attached",
	media: ["https://example.com/a.png", "/tmp/report.pdf"],
	attachments: [{ kind: "video", source: "clip.mp4", filename: "clip.mp4" }],
});
```

`resolveOutboundMedia()` turns any source into bytes: data URLs are decoded,
HTTP(S) URLs are downloaded (with a size cap), and local files are read. Image
bytes get their mime type corrected from magic numbers. Each channel declares
its `mediaCapabilities` (`kinds`, whether the platform accepts URLs directly,
size cap); media the channel does not support throws instead of being silently
dropped. Telegram sends URLs straight through; Discord, Slack, Matrix,
Mattermost, and email upload the bytes and attach the result.

Media failures do not block the message: the failed file is listed in the text
as `[附件发送失败: <name>]` and the delivery receipt reports `partial` with a
`detail` listing the failed items.

`createDeliveryClient()` is the cross-process public outbound exit: it POSTs
`OutboundMessage` to the gateway's authenticated `/api/deliver`, reusing the
connections the gateway process owns. Local file paths in `media`/`attachments`
are automatically embedded as data URLs before transport, so the gateway does
not need access to the caller's filesystem. `DELIVERY_CHANNELS` covers every
send-capable channel (feishu, qq, onebot, napcat, telegram, discord, slack,
mattermost, matrix, email, web, websocket).

## Reliability and host integration

Inbound messages carry a stable `messageId`. The bus suppresses duplicate
events, bounds all queues, and rejects publishes after shutdown. For retries
across process restarts, pass a `sessionStatePath` or provide a custom
`sessionManager`:

```ts
const gateway = createChannelSdk({
	config,
	sessionStatePath: "./var/channel-sessions.json",
	offsetStatePath: "./var/channel-offsets.json",
	inboundHandoffStatePath: "./var/channel-inbound.json",
	inboundDeadLetterStatePath: "./var/channel-inbound-dlq.json",
	messageStatePath: "./var/channel-messages.json",
	inboundRetry: { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 5000 },
	bus: {
		outboundOutbox: new FileOutboundOutbox("./var/channel-outbox.json"),
	},
});
```

`FileChannelSessionStore`, `FileChannelOffsetStore`, and
`FileOutboundOutbox` use lock-protected read/modify/write transactions and
atomic replacement. The outbox recovers messages left in `delivering` state
after a process crash; `FileInboundHandoffStore` keeps inbound messages on
disk until the registered application handler resolves. Streaming deltas
remain deliberately ephemeral. `FileChannelMessageStore` is an optional
canonical history: it retains complete normalized inbound and outbound
messages after successful processing, tracks inbound retry/dead-letter status
and outbound delivery receipts, and supports `ChannelSdk.listMessages()`.
Records are retained until the optional `maxRecords` cap is reached.

Handler failures are retried with exponential backoff. After the configured
attempt limit, the message is copied to `FileInboundDeadLetterStore` and can
be inspected or requeued with `listInboundDeadLetters()` and
`retryInbound()`. A failed `ChannelAgentRuntime` turn is propagated back to
the bus, so it participates in this retry policy.

Provider resume state is stored in `offsetStatePath`. Discord persists its
gateway session, resume URL, and sequence and sends a real `RESUME` payload
after reconnect. Slack, Feishu, and OneBot persist their last accepted event
cursor for diagnostics and pair it with the durable inbound handoff/dedup
store; those protocols do not provide a replay API equivalent to Discord.

To reload JSON config without restarting the process, pass `configPath` and
`watchConfig: true`. Valid snapshots are applied per channel with rollback on
startup failure; malformed snapshots leave the running configuration intact.

`onDelivery()` receives typed success, partial, failed, or cancelled receipts
with attempt counts and provider message IDs. `ChannelAgentRuntime` serializes
turns per chat, emits `turn.started`/`turn.completed`/`turn.failed`/
`turn.interrupted`, and passes an `AbortSignal` to the agent handler. Web and
WebSocket channels expose stop requests that use the same interrupt controller.

Hosts can inject a `ChannelContext` with a session manager, event bus, push
tool, attachment store, HTTP resources, logger, and interrupt controller. The
built-in `FileAttachmentStore` performs bounded atomic writes and safe path
resolution.

Web and WebSocket channels accept an optional shared secret:

```json
{
	"channels": {
		"web": {
			"allowFrom": ["*"],
			"auth": { "token": "change-me", "queryParam": "token" },
			"rateLimit": { "maxRequests": 30, "windowMs": 60000 }
		}
	}
}
```

`/api/health` remains public. Other Web API routes require the configured
token (`Authorization: Bearer <token>` by default); WebSocket authentication
is checked during the upgrade. For secret configuration, use
`GATEWAY_WEB_AUTH_TOKEN` or `GATEWAY_WEBSOCKET_AUTH_TOKEN` environment
overrides.

For signed HTTP webhooks, configure `auth.signature` instead of (or alongside)
the token:

```json
{
	"signature": {
		"secret": "webhook-secret",
		"header": "x-webhook-signature",
		"timestampHeader": "x-webhook-timestamp",
		"maxAgeMs": 300000
	}
}
```

The signature is HMAC-SHA256 over `<timestamp>.<raw-body>` when a timestamp
header is configured. `ChannelRegistry.replaceChannel()` and
`replaceChannels()` support runtime channel replacement with rollback when a
candidate fails to start.

Both Web transports can terminate TLS directly with `tls.keyFile` and
`tls.certFile` (optional `caFile`). Failed durable deliveries are retained in
the outbox; `ChannelSdk.listOutbox()`, `retryDelivery()`,
`cleanupOutbox()`, and `metrics()` expose retention, manual retry, and bus
counters to the host. The authenticated Web management endpoints are:

- `GET /api/status`, `GET /api/metrics`, `GET /metrics`
- `GET /api/messages` (when `messageStatePath` or `messageStore` is configured)
- `GET /api/history` uses canonical messages when configured
- `GET /api/outbox`, `POST /api/outbox/retry`, `POST /api/outbox/cleanup`
- `GET /api/inbound-dlq`, `POST /api/inbound-dlq/retry`

`/metrics` emits Prometheus text format. Cleanup only removes terminal outbox
records and never deletes pending or in-flight deliveries.

Zero runtime dependencies (node built-ins only).
