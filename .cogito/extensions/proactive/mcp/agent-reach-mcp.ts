/**
 * agent-reach-mcp 数据源(主动推送用)。
 *
 * 通过 MCP 协议连接 agent-reach server(mcp.json 注册,与 agent 运行时共用),
 * 默认抓取 v2ex 热帖,可在 proactive.json 的 sources.agent-reach-mcp.calls 里覆盖。
 */

import { McpExtensionSource } from "./_mcp-source.ts";

export default class AgentReachMcpSource extends McpExtensionSource {
	id = "agent-reach-mcp";
	label = "agent-reach 互联网数据源";
	/** mcp.json 里的 server 名。 */
	serverName = "agent-reach";
	defaultCalls = [{ tool: "v2ex_hot", args: { limit: 20 } }];
}
