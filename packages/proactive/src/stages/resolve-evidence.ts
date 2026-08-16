/**
 * Proactive resolve — Evidence-First message writing (akashic
 * prompts/proactive.py compose design).
 *
 * The final message is written from evidence, never from titles:
 * - every concrete fact must trace back to an evidence id
 * - no subjective booster words without evidence
 * - insufficient evidence -> <no_content/> (no message)
 * - at most 1-2 key points; links only when the evidence provides them
 * - plain text, no JSON, no question ending, no system-notification tone
 * - evidence ids never appear in the user-facing text
 */

import { type ChatCompletionClient, OpenAICompatibleChatClient } from "@cogito/ai/chat";
import { normalizeOutboundText } from "./outbound-text.ts";
import type { Evidence, ResolveStrategy, TurnContext } from "./types.ts";

export const NO_CONTENT_TOKEN = "<no_content/>";

export interface ResolveOptions {
	evidence: Evidence[];
	preferenceBlock: string;
	rulesPanel: string;
	model: string;
	baseUrl: string;
	apiKey: string | undefined;
	nowStr: string;
	requestTimeoutMs?: number;
	fetchFn?: typeof fetch;
	/** 宿主注入的 ChatCompletionClient(pi-host ModelRuntime);缺省走配置式客户端。 */
	client?: ChatCompletionClient;
}

const SYSTEM_PROMPT = `你是用户的主动助手。负责把真实新内容提炼成一条值得发送、又自然像人说出来的消息。

【Evidence-First 严格规则】
1. 你已获得正文级证据(Evidence),每条证据包含:id、来源、标题、正文片段。
2. 消息中的每一个具体事实(人名/项目名/功能/数字/时间)必须能追溯到某条 Evidence。
3. 禁止基于标题做任何事实推断或点评,必须基于正文片段。
4. 禁止使用无证据支撑的主观强化词(如"拉满""带劲")与事实混写。
5. 如果证据不足以支撑任何具体提炼,必须输出 <no_content/>。
6. 允许在开头加一句自然的人话式开场,但这句开场不能引入任何新事实。
7. 消息正文最多提炼 1 到 2 个关键信息点,不要把整篇文章复述成摘要。
8. 只有当 Evidence 里明确出现了可用的来源链接时,才可在消息末尾附上对应链接。
9. 如果「用户偏好记录」里出现了明确的禁推/过滤/不要推送规则,且该规则与候选内容匹配,必须直接输出 <no_content/>。
10. 输出纯文本,不要 JSON,不要提问收尾,不要像系统通知。
11. Evidence 的 id(如 [ev1])仅供你内部核对,禁止在最终发给用户的文案中出现。`;

function buildUserPrompt(options: ResolveOptions): string {
	const evidenceLines = options.evidence
		.map((ev) => `[${ev.id}]\n来源: ${ev.source}\n标题: ${ev.title}\n正文片段:\n${ev.snippet.slice(0, 1200)}`)
		.join("\n\n");
	const sections = [
		`当前时间:${options.nowStr}`,
		options.preferenceBlock || "(无用户偏好记录)",
		`## 主动推送硬规则(必须遵守)\n${options.rulesPanel || "(无)"}`,
		`## 正文证据(Evidence)\n${evidenceLines}`,
		"请基于以上证据写一条要发送给用户的消息。",
	];
	return sections.join("\n\n");
}

/**
 * Write the delivery message from evidence. Returns the message text, or
 * null when the LLM decides there is nothing worth sending
 * (<no_content/>), or when the LLM call fails.
 */
export async function resolveMessage(options: ResolveOptions): Promise<string | null> {
	const prompt = buildUserPrompt(options);
	try {
		const client =
			options.client ??
			new OpenAICompatibleChatClient({
				model: options.model,
				baseUrl: options.baseUrl,
				apiKey: options.apiKey ?? "",
				requestTimeoutMs: options.requestTimeoutMs,
			});
		const response = await client.complete({
			messages: [
				{ role: "system", content: SYSTEM_PROMPT },
				{ role: "user", content: prompt },
			],
			maxTokens: 1024,
			temperature: 0.7,
			fetchFn: options.fetchFn,
		});
		if (!response.content || response.content.includes(NO_CONTENT_TOKEN)) return null;
		// 出站文本清洗(akashic outbound_text.py):统一换行并解码被转义的 \n。
		return normalizeOutboundText(response.content).trim();
	} catch {
		return null;
	}
}

// ------------------------------------------------------------------
// 生成策略(默认:Evidence-First 消息)
// ------------------------------------------------------------------

export interface EvidenceFirstResolveOptions {
	model: string;
	baseUrl: string;
	apiKey: string | undefined;
	/** 宿主注入的 ChatCompletionClient(pi-host ModelRuntime);缺省走配置式客户端。 */
	client?: ChatCompletionClient;
}

export class EvidenceFirstResolveStrategy implements ResolveStrategy {
	readonly id = "evidence-first";
	private readonly options: EvidenceFirstResolveOptions;

	constructor(options: EvidenceFirstResolveOptions) {
		this.options = options;
	}

	async resolve(evidence: Evidence[], ctx: TurnContext): Promise<string | null> {
		if ((!this.options.apiKey && !this.options.client) || evidence.length === 0) return null;
		return resolveMessage({
			evidence,
			preferenceBlock: ctx.preferenceBlock,
			rulesPanel: ctx.rulesPanel,
			model: this.options.model,
			baseUrl: this.options.baseUrl,
			apiKey: this.options.apiKey,
			client: this.options.client,
			nowStr: ctx.now.toISOString(),
		});
	}
}
