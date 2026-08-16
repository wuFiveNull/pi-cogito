/**
 * dailyhot-mcp 数据源(主动推送用)。
 *
 * 通过 MCP 协议连接 dailyhot server(mcp.json 注册,与 agent 运行时共用),
 * 抓取指定平台热榜。默认抓取 weibo + github,可在 proactive.json 的
 * sources.dailyhot-mcp.calls 里覆盖。
 */

import { McpExtensionSource } from "./_mcp-source.ts";

export default class DailyhotMcpSource extends McpExtensionSource {
	id = "dailyhot-mcp";
	label = "dailyhot MCP 热榜";
	/** mcp.json 里的 server 名。 */
	serverName = "dailyhot";
	defaultCalls = [
		{ tool: "dailyhot", args: { source: "weibo", limit: 20 } },
		{ tool: "dailyhot", args: { source: "github", limit: 20, type: "daily" } },
	];
}
