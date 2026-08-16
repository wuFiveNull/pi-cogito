/** 消息渲染:解析 content parts → thinking 折叠块 / tool 调用卡 / markdown / 图片。 */

import { useEffect, useMemo, useRef, useState } from "react";
import hljs from "highlight.js/lib/common";
import { marked } from "marked";
export interface ChatMessagePart {
	type: string;
	text?: string;
	thinking?: string;
	name?: string;
	arguments?: unknown;
	mimeType?: string;
	data?: string;
}


function escapeHtml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(value: string): string {
	return escapeHtml(value).replace(/"/g, "&quot;");
}

/**
 * 渲染 markdown;代码块先抽出单独高亮(highlight.js),其余交给 marked。
 * 用占位符避免 marked 的默认 code 渲染覆盖高亮。
 */
function renderMarkdown(text: string): string {
	const blocks: Array<{ lang: string; code: string }> = [];
	const withoutCode = text.replace(/```([\w-]*)\n([\s\S]*?)```/g, (_match, lang: string, code: string) => {
		const index = blocks.length;
		blocks.push({ lang: lang.trim(), code: code.replace(/\n$/, "") });
		return `\u0000CODE${index}\u0000`;
	});
	const html = marked.parse(withoutCode, { async: false }) as string;
	return html.replace(/\u0000CODE(\d+)\u0000/g, (_match, index: string) => {
		const block = blocks[Number(index)];
		if (!block) return "";
		const lang = block.lang;
		const highlighted = lang && hljs.getLanguage(lang) ? hljs.highlight(block.code, { language: lang }).value : escapeHtml(block.code);
		return `<div class="code-block"><div class="code-block__head"><span>${escapeHtml(lang || "text")}</span><button type="button" class="code-block__copy" data-code="${escapeAttr(block.code)}">复制</button></div><pre><code class="hljs">${highlighted}</code></pre></div>`;
	});
}

export interface RenderedMessage {
	role: "user" | "assistant";
	content: string;
	parts?: ChatMessagePart[];
	streaming?: boolean;
}

function argumentsText(args: unknown): string {
	if (typeof args === "string") return args;
	try {
		return JSON.stringify(args, null, 2);
	} catch {
		return String(args);
	}
}

export function MessageView({ message }: { message: RenderedMessage }) {
	const [thinkingOpen, setThinkingOpen] = useState(false);
	const containerRef = useRef<HTMLDivElement>(null);

	// 消息到达时自动展开 thinking;完成(streaming=false)后收起。
	useEffect(() => {
		if (message.streaming) {
			setThinkingOpen(true);
		} else {
			setThinkingOpen(false);
		}
	}, [message.streaming, message.content]);

	// 流式结束后给代码块绑定复制按钮。
	useEffect(() => {
		if (message.streaming) return;
		const container = containerRef.current;
		if (!container) return;
		const buttons = container.querySelectorAll<HTMLButtonElement>("button.code-block__copy");
		for (const button of buttons) {
			if (button.dataset.bound) continue;
			button.dataset.bound = "1";
			button.addEventListener("click", () => {
				const code = button.dataset.code ?? "";
				void navigator.clipboard?.writeText(code);
			});
		}
	}, [message.content, message.streaming]);

	const thinking = message.parts?.filter((part) => part.type === "thinking").map((part) => part.thinking ?? "").join("\n") ?? "";
	const tools = message.parts?.filter((part) => part.type === "toolCall") ?? [];
	const images = message.parts?.filter((part) => part.type === "image") ?? [];
	const text = message.parts?.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n") ?? message.content;

	const html = useMemo(() => (text ? renderMarkdown(text) : ""), [text]);

	return (
		<div className={`msg-view ${message.role}`}>
			{thinking && (
				<div className="thinking">
					<button type="button" className="thinking__toggle" onClick={() => setThinkingOpen((open) => !open)}>
						<span className="thinking__chevron">{thinkingOpen ? "▾" : "▸"}</span>
						<span className="thinking__label">思考过程</span>
						{message.streaming && <span className="thinking__live">正在思考…</span>}
					</button>
					{thinkingOpen && <div className="thinking__body">{thinking}</div>}
				</div>
			)}

			{tools.length > 0 && (
				<div className="tool-chain">
					{tools.map((tool, index) => (
						<ToolCard key={`${tool.name}-${index}`} tool={tool} />
					))}
				</div>
			)}

			{images.length > 0 && (
				<div className="msg-images">
					{images.map((image, index) => (
						<img
							key={index}
							src={`data:${image.mimeType ?? "image/png"};base64,${image.data ?? ""}`}
							alt="附件"
							className="msg-image"
						/>
					))}
				</div>
			)}

			{html && <div ref={containerRef} className="msg-markdown" dangerouslySetInnerHTML={{ __html: html }} />}
			{!html && message.content && <div className="msg-plain">{message.content}</div>}
		</div>
	);
}

function ToolCard({ tool }: { tool: ChatMessagePart }) {
	const [open, setOpen] = useState(false);
	return (
		<div className={`tool-card ${open ? "open" : ""}`}>
			<button type="button" className="tool-card__head" onClick={() => setOpen((value) => !value)}>
				<span className="tool-card__icon">🔧</span>
				<span className="tool-card__name">{tool.name ?? "tool"}</span>
				<span className="tool-card__chevron">{open ? "▾" : "▸"}</span>
			</button>
			{open && <pre className="tool-card__args"><code>{argumentsText(tool.arguments)}</code></pre>}
		</div>
	);
}
