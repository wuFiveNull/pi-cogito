import { useCallback, useEffect, useRef, useState } from "react";
import { api, formatRelative, formatTime, type ChatMessagePart, type ChatMessageRow, type SessionRow } from "../api.ts";
import { MessageView } from "../message-view.tsx";

const CHAT_ID = "web-default";
const SENDER_ID = "web-ui";

interface StreamMessage {
	id: string;
	role: "user" | "assistant";
	content: string;
	timestamp: string;
	parts?: ChatMessagePart[];
	streaming?: boolean;
	/** 回复引用的消息 id(仅本地发送的消息带) */
	replyTo?: string;
	/** 引用预览文本(从本地消息里解析) */
	replyPreview?: string;
	/** 被用户停止生成 */
	interrupted?: boolean;
}

interface ComposerFile {
	filename: string;
	mimeType: string;
	/** 上传后的访问路径(/api/media?path=...) */
	url?: string;
	/** base64 数据(上传前暂存) */
	data?: string;
}

function rowToMessage(row: ChatMessageRow): StreamMessage {
	return { id: row.id, role: row.role, content: row.content, timestamp: row.timestamp, parts: row.parts };
}

function replyPreviewOf(message: StreamMessage): string {
	const text = message.content.trim();
	const firstLine = text.split("\n")[0] ?? "";
	return firstLine.length > 60 ? `${firstLine.slice(0, 60)}…` : firstLine || "(空消息)";
}

export function ChatView() {
	const [sessions, setSessions] = useState<SessionRow[]>([]);
	const [activeSession, setActiveSession] = useState<SessionRow | null>(null);
	const [messages, setMessages] = useState<StreamMessage[]>([]);
	const [input, setInput] = useState("");
	const [status, setStatus] = useState<"idle" | "sending" | "error">("idle");
	const [error, setError] = useState("");
	const [streaming, setStreaming] = useState(false);
	const [replyTarget, setReplyTarget] = useState<StreamMessage | null>(null);
	const [copiedId, setCopiedId] = useState("");
	const [files, setFiles] = useState<ComposerFile[]>([]);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const streamBufferRef = useRef("");
	const pendingIdRef = useRef<string | null>(null);
	const messagesEndRef = useRef<HTMLDivElement>(null);
	const socketRef = useRef<EventSource | null>(null);

	const loadSessions = useCallback(() => {
		api.listSessions()
			.then((page) => setSessions(page.items))
			.catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
	}, []);

	const openSession = useCallback((session: SessionRow) => {
		setActiveSession(session);
		setReplyTarget(null);
		setMessages([]);
		api.listMessages(session.key)
			.then((page) => setMessages(page.items.map(rowToMessage)))
			.catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
	}, []);

	useEffect(() => {
		loadSessions();
		const source = new EventSource(`/api/stream?chatId=${encodeURIComponent(CHAT_ID)}`);
		socketRef.current = source;
		source.addEventListener("delta", (event) => {
			try {
				// OutboundDelta broadcasts { channel, chatId, delta, type, streamId, ... }.
				const delta = JSON.parse(String(event.data)) as { delta?: unknown; content?: unknown };
				const chunk =
					typeof delta.delta === "string" ? delta.delta : typeof delta.content === "string" ? delta.content : "";
				if (chunk.length === 0) return;
				setStreaming(true);
				streamBufferRef.current += chunk;
				setMessages((current) => {
					const next = [...current];
					const last = next[next.length - 1];
					if (last && last.streaming) {
						next[next.length - 1] = { ...last, content: streamBufferRef.current };
					} else {
						const id = pendingIdRef.current ?? `stream-${Date.now()}`;
						pendingIdRef.current = id;
						next.push({ id, role: "assistant", content: streamBufferRef.current, timestamp: new Date().toISOString(), streaming: true });
					}
					return next;
				});
			} catch {
				// ignore malformed events
			}
		});
		source.addEventListener("message", (event) => {
			try {
				const msg = JSON.parse(String(event.data)) as { content?: unknown; id?: unknown };
				const content = typeof msg.content === "string" ? msg.content : "";
				streamBufferRef.current = "";
				pendingIdRef.current = null;
				setStreaming(false);
				setMessages((current) => {
					const next = [...current];
					const last = next[next.length - 1];
					if (last && last.streaming) {
						next[next.length - 1] = { ...last, content, streaming: false };
					} else {
						next.push({ id: String(msg.id ?? `msg-${Date.now()}`), role: "assistant", content, timestamp: new Date().toISOString() });
					}
					return next;
				});
			} catch {
				// ignore malformed events
			}
		});
		source.addEventListener("stopped", () => {
			streamBufferRef.current = "";
			pendingIdRef.current = null;
			setStreaming(false);
			setMessages((current) => {
				const next = [...current];
				const last = next[next.length - 1];
				if (last?.streaming) {
					next[next.length - 1] = { ...last, streaming: false, interrupted: true };
				}
				return next;
			});
		});
		source.onerror = () => {
			setStreaming(false);
		};
		return () => {
			source.close();
			socketRef.current = null;
		};
	}, []);

	useEffect(() => {
		messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
	}, [messages]);

	const send = useCallback(async () => {
		const text = input.trim();
		if (!text || status === "sending") return;
		setInput("");
		setError("");
		setStatus("sending");
		const optimisticId = `opt-${crypto.randomUUID()}`;
		const media: string[] = [];
		try {
			for (const file of files) {
				if (file.url) {
					media.push(file.url);
					continue;
				}
				if (!file.data) continue;
				const upload = await fetch("/api/uploads", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ filename: file.filename, mimeType: file.mimeType, data: file.data }),
				});
				if (!upload.ok) throw new Error(`附件上传失败: ${upload.status}`);
				const body = (await upload.json()) as { path: string };
				media.push(body.path);
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			return;
		}
		setMessages((current) => [...current, {
			id: optimisticId,
			role: "user",
			content: text || files.map((file) => file.filename).join(", "),
			timestamp: new Date().toISOString(),
			replyTo: replyTarget?.id,
			replyPreview: replyTarget ? replyPreviewOf(replyTarget) : undefined,
		}]);
		try {
			const response = await fetch("/api/messages", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					senderId: SENDER_ID,
					chatId: CHAT_ID,
					clientMessageId: optimisticId,
					content: text,
					media: media.length > 0 ? media : undefined,
					...(replyTarget ? { metadata: { replyTo: replyTarget.id } } : {}),
				}),
			});
			if (!response.ok) throw new Error(`发送失败: ${response.status}`);
			setReplyTarget(null);
			setFiles([]);
		} catch (err) {
			setMessages((current) => current.filter((m) => m.id !== optimisticId));
			setInput(text);
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setStatus("idle");
		}
	}, [input, status, replyTarget, files]);

	const addFiles = (list: FileList | null) => {
		if (!list) return;
		for (const file of Array.from(list)) {
			const reader = new FileReader();
			reader.onload = () => {
				const data = String(reader.result ?? "").split(",")[1] ?? "";
				setFiles((current) => [...current, { filename: file.name, mimeType: file.type || "application/octet-stream", data }]);
			};
			reader.readAsDataURL(file);
		}
	};

	const stopTurn = async () => {
		try {
			const response = await fetch("/api/stop", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ chatId: CHAT_ID }),
			});
			if (!response.ok) throw new Error(`停止失败: ${response.status}`);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	};

	const copyMessage = async (message: StreamMessage) => {
		try {
			await navigator.clipboard.writeText(message.content);
			setCopiedId(message.id);
			setTimeout(() => setCopiedId(""), 1500);
		} catch {
			setError("复制失败:剪贴板不可用");
		}
	};

	const shareMessage = async (message: StreamMessage) => {
		const text = message.content;
		if (navigator.share) {
			try {
				await navigator.share({ text });
				return;
			} catch {
				// 用户取消或失败 → fallback 复制
			}
		}
		await copyMessage(message);
	};

	return (
		<div className="chat-layout">
			<aside className="session-panel">
				<header className="session-panel__header">
					<h2>最近会话</h2>
					<button type="button" className="icon-btn" title="刷新" onClick={loadSessions}>⟳</button>
				</header>
				<div className="session-list">
					{sessions.length === 0 && <p className="empty-hint">暂无会话</p>}
					{sessions.map((session) => (
						<button
							key={session.key}
							type="button"
							className={`session-item ${activeSession?.key === session.key ? "active" : ""}`}
							onClick={() => openSession(session)}
						>
							<span className="session-item__title">{session.title}</span>
							<span className="session-item__meta">
								{session.message_count} 条 · {formatRelative(session.updated_at)}
							</span>
						</button>
					))}
				</div>
			</aside>

			<section className="conversation">
				<header className="conversation__header">
					<h2>{activeSession ? activeSession.title : "今天有什么计划?"}</h2>
					{streaming && <span className="live-badge">正在生成…</span>}
					{error && <span className="error-text">{error}</span>}
				</header>
				<div className="message-list">
					{messages.length === 0 && (
						<div className="empty-state">
							<h1>今天有什么计划?</h1>
							<p>发送一条消息开始对话。</p>
						</div>
					)}
					{messages.map((message) => (
						<div key={message.id} className={`msg-row ${message.role}`}>
							<div className="msg-bubble">
								{message.replyTo && (
									<div className="msg-reply-ref">
										<span className="msg-reply-ref__label">回复</span>
										<span className="msg-reply-ref__preview">{message.replyPreview ?? `消息 #${message.replyTo.slice(0, 8)}`}</span>
									</div>
								)}
								<MessageView message={message} />
								{message.streaming && <span className="cursor">▋</span>}
								{message.interrupted && <span className="interrupted-badge">已中断</span>}
							</div>
							<div className="msg-actions">
								<button type="button" className="icon-btn" title={copiedId === message.id ? "已复制" : "复制"} onClick={() => void copyMessage(message)}>
									{copiedId === message.id ? "✓" : "⧉"}
								</button>
								<button type="button" className="icon-btn" title="回复" onClick={() => setReplyTarget(message)}>↩</button>
								<button type="button" className="icon-btn" title="共享" onClick={() => void shareMessage(message)}>↗</button>
							</div>
							<span className="msg-meta">{formatTime(message.timestamp)}</span>
						</div>
					))}
					<div ref={messagesEndRef} />
				</div>
				{files.length > 0 && (
					<div className="composer-files">
						{files.map((file, index) => (
							<span key={`${file.filename}-${index}`} className="composer-file">
								📎 {file.filename}
								<button type="button" className="icon-btn" title="移除" onClick={() => setFiles((current) => current.filter((_, i) => i !== index))}>✕</button>
							</span>
						))}
					</div>
				)}
				{replyTarget && (
					<div className="composer-reply">
						<span className="composer-reply__label">回复 {replyTarget.role === "assistant" ? "助手" : "你"}</span>
						<span className="composer-reply__preview">{replyPreviewOf(replyTarget)}</span>
						<button type="button" className="icon-btn" title="取消回复" onClick={() => setReplyTarget(null)}>✕</button>
					</div>
				)}
				<form
					className="composer"
					onSubmit={(event) => {
						event.preventDefault();
						void send();
					}}
					onDragOver={(event) => event.preventDefault()}
					onDrop={(event) => {
						event.preventDefault();
						addFiles(event.dataTransfer.files);
					}}
				>
					<input
						value={input}
						onChange={(event) => setInput(event.target.value)}
						placeholder="输入消息,回车发送"
						maxLength={2000}
					/>
					<input
						ref={fileInputRef}
						type="file"
						multiple
						hidden
						onChange={(event) => {
							addFiles(event.target.files);
							event.target.value = "";
						}}
					/>
					<button type="button" className="btn" title="添加附件" onClick={() => fileInputRef.current?.click()}>📎</button>
					{streaming ? (
						<button type="button" className="btn stop" onClick={() => void stopTurn()}>停止</button>
					) : (
						<button type="submit" disabled={status === "sending" || (!input.trim() && files.length === 0)}>发送</button>
					)}
				</form>
			</section>
		</div>
	);
}
