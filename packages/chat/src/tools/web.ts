/**
 * Chat web tools — web_fetch / web_search.
 *
 * Reuses the shared web toolkit from @cogito/gate (SSRF policy, DNS-validated
 * requests, redirect control, size caps) that drift also uses.
 */

import {
	boundedNumber,
	DEFAULT_WEB_MAX_CHARS,
	DEFAULT_WEB_MAX_RESULTS,
	DEFAULT_WEB_TIMEOUT_MS,
	type DriftWebDnsLookupFn,
	type DriftWebPolicy,
	fetchWebPage,
	isHttpUrl,
	searchWebPage,
	validateWebUrl,
} from "@cogito/gate";
import type { AgentToolResult, ToolDefinition } from "@cogito/host";
import { defineTool } from "@cogito/host";
import { Type } from "typebox";

export interface ChatWebToolOptions {
	maxChars?: number;
	maxRedirectHops?: number;
	timeoutMs?: number;
	searchUrl?: string;
	searchApiKey?: string;
	policy?: DriftWebPolicy;
	dnsLookupFn?: DriftWebDnsLookupFn;
	log?: (message: string) => void;
}

export function createWebTools(options: ChatWebToolOptions): ToolDefinition[] {
	const maxChars = boundedNumber(options.maxChars, DEFAULT_WEB_MAX_CHARS, 200, 50_000);
	const timeoutMs = options.timeoutMs ?? DEFAULT_WEB_TIMEOUT_MS;
	const policy = options.policy;
	const dnsLookupFn = options.dnsLookupFn;

	return [
		defineTool({
			name: "web_fetch",
			label: "web_fetch",
			description: "抓取一个 HTTP(S) 网页并返回去掉 HTML 标签的正文片段。",
			searchHint: "抓取 网页 网址 浏览页面 读取链接 fetch",
			promptSnippet: "Fetch a web page",
			promptGuidelines: [
				"web_fetch only allows public HTTP(S) destinations; private networks and local hosts are denied.",
			],
			parameters: Type.Object({
				url: Type.String({ description: "要抓取的 HTTP(S) URL" }),
				max_chars: Type.Optional(Type.Number({ description: `最多返回的字符数,默认 ${maxChars}` })),
			}),
			async execute(_toolCallId, params): Promise<AgentToolResult<undefined>> {
				const url = String(params.url ?? "").trim();
				if (!isHttpUrl(url)) return textResult("url must be an http(s) URL");
				const urlError = validateWebUrl(url, policy);
				if (urlError) return textResult(JSON.stringify({ error: urlError, url }));
				const chars = boundedNumber(params.max_chars, maxChars, 200, 50_000);
				try {
					const result = await fetchWebPage(url, chars, timeoutMs, policy, dnsLookupFn);
					return textResult(JSON.stringify({ url, ...result, text: result.text?.slice(0, chars) }));
				} catch (error) {
					return textResult(JSON.stringify({ error: errorMessage(error), url }));
				}
			},
		}),
		defineTool({
			name: "web_search",
			label: "web_search",
			description: "搜索网页并返回结果列表(标题、摘要、链接)。需要配置 chat.web.search.url。",
			searchHint: "搜索 查资料 上网 信息检索 谷歌 百度 search",
			promptSnippet: "Search the web",
			parameters: Type.Object({
				query: Type.String({ description: "搜索关键词或问题" }),
				limit: Type.Optional(Type.Number({ description: `最多返回结果数,默认 ${DEFAULT_WEB_MAX_RESULTS}` })),
			}),
			async execute(_toolCallId, params): Promise<AgentToolResult<undefined>> {
				if (!options.searchUrl) return textResult("web_search 未配置(chat.web.search.url)");
				const limit = boundedNumber(params.limit, DEFAULT_WEB_MAX_RESULTS, 1, 20);
				try {
					const items = await searchWebPage(
						options.searchUrl,
						options.searchApiKey,
						String(params.query ?? ""),
						limit,
						timeoutMs,
						policy,
						dnsLookupFn,
					);
					return textResult(JSON.stringify({ query: params.query, results: items }));
				} catch (error) {
					return textResult(JSON.stringify({ error: errorMessage(error), query: params.query }));
				}
			},
		}),
	];
}

function textResult(text: string): AgentToolResult<undefined> {
	return { content: [{ type: "text", text }], details: undefined };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
