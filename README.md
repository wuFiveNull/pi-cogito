# Cogito

Cogito 是一个私人 AI 助手：通过 IM 渠道（飞书、QQ、Web）与你交流，在空闲时执行 drift 任务，并主动推送有价值的信息。它没有 CLI 和 TUI，唯一的前端是一个 Web dashboard。

本项目是 [earendil-works/pi](https://github.com/earendil-works/pi)（pi-mono）的一个 fork 改造：保留了 agent 运行时，去掉了 CLI/TUI/远程会话协议等，新增了 IM 网关、主动推送（proactive）和空闲任务（drift）三个常驻守护进程。

## 架构

```
IM 渠道 (飞书 / QQ / Web)
        │
        ▼
┌───────────────────┐     ┌──────────────────────────┐
│  gateway          │     │  ui (Web dashboard)       │
│  (scripts/        │────▶│  聊天/知识与运行/监控/设置  │
│   cogito-gateway) │     └──────────────────────────┘
└─────────┬─────────┘
          │ runChatModule (@cogito/chat)
          ▼
┌───────────────────┐
│  chat             │  聊天模块：每会话 AgentSession、流式回复、
│  (@cogito/chat)   │  记忆/推送/网络/定时工具、web 面板
└─────────┬─────────┘
          │ createAgentSession
          ▼
┌───────────────────┐
│  host             │  无头 agent 运行时（扩展系统、会话、工具）
│  (@cogito/host)   │
└─────────┬─────────┘
          │
┌─────────▼─────────────────────────────┐
│  proactive ──▶ gate ──▶ drift          │  三进程常驻守护
│  主动推送 / 判断打扰 / 空闲任务          │  (systemd 或 scripts/run-daemons.sh)
└───────────────────────────────────────┘
```

底层共享库：`@cogito/ai`（统一 LLM API）、`@cogito/agent-core`（agent 运行时）、`@cogito/mcp`（MCP 客户端/服务端）、`@cogito/storage-sqlite-node`（会话存储）。

## 包一览

| 包 | 作用 |
|---|---|
| `@cogito/ai` (`packages/ai`) | 统一多 provider LLM API（OpenAI/Anthropic/Google/Mistral/Bedrock 等）、模型发现、OAuth |
| `@cogito/agent-core` (`packages/agent`) | 通用 agent 运行时：工具调用、状态管理、附件 |
| `@cogito/storage-sqlite-node` (`packages/storage/sqlite-node`) | 会话的 sqlite 存储后端 |
| `@cogito/mcp` (`packages/mcp`) | 共享 MCP client + server 库 |
| `@cogito/host` (`packages/host`) | 无头 agent 运行时 + 扩展系统（gateway/proactive/drift 的宿主） |
| `@cogito/chat` (`packages/chat`) | 聊天模块（以 host 为底座）：每会话 AgentSession、流式回复、记忆/推送/网络/定时工具，入口 `scripts/cogito-gateway.ts` |
| `@cogito/gateway` (`packages/gateway`) | 统一 IM 通道抽象：飞书、QQ/OneBot、Web 等 |
| `@cogito/gate` (`packages/gate`) | proactive 与 drift 之间的共享门控/调度层 |
| `@cogito/proactive` (`packages/proactive`) | 主动推送引擎：轮询来源、判断是否打扰、证据优先投递 |
| `@cogito/drift` (`packages/drift`) | 空闲时间后台任务引擎（akashic drift_flow 移植）：Scan→Prepare→Execute→Finish |
| `@cogito/ui` (`packages/ui`) | Web dashboard 托管层（挂载在 gateway 的 web channel 上） |

## 配置

- `config.json`：gateway 通道配置（feishu / qq / web）与 proactive 投递目标
- `~/.cogito/agent/`：agent 主目录（`auth.json`、`models.json`、会话、扩展、skills）
- `.cogito/`：仓库级扩展（`extensions/`）、memory、prompts、skills
- `.run/`：运行时状态（日志、sqlite、pid）

## 指南

- [docs/drift-guide.md](docs/drift-guide.md) — Drift 空闲任务:写自己的 SKILL.md、案例技能、工具表
- [docs/proactive-guide.md](docs/proactive-guide.md) — Proactive 主动推送:生命周期、数据源插件、energy 调度、验证清单

## 运行

```bash
npm install --ignore-scripts
npm run build         # 构建所有包
npm run check         # lint + 类型检查

# 三进程守护（gateway + proactive + drift）
scripts/run-daemons.sh start
scripts/run-daemons.sh status
scripts/run-daemons.sh logs
scripts/run-daemons.sh stop

# 或作为 systemd 用户服务（见 systemd/README.md）
systemctl --user enable --now cogito-gateway cogito-proactive cogito-drift
```

启动后：

- IM 渠道按 `config.json` 的通道配置工作
- Web dashboard：`http://127.0.0.1:8787/`（聊天 / 知识与运行 / 监控 / 设置）
- `/api/health` 为公开存活探针；管理端点需要 `Authorization: Bearer <token>`

## 开发

```bash
npm run check         # biome + tsgo 全仓检查
./test.sh             # 跑测试（无 LLM 依赖）
```

## 备注

- `packages/coding-agent` 保留在仓库中作为参考代码，已不再被任何模块引用，也不参与构建/发布。
- 本仓库的完整历史备份在 `/home/wu/projects/pi-cogito`（只读）。

## License

MIT
