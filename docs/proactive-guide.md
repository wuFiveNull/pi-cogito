# Proactive 主动推送指南

Proactive 是常驻推送引擎:轮询数据源、判断候选是否值得打扰用户、生成并投递消息;
没有值得推送的内容时,把空闲时间交给 `@cogito/drift`(用户写的 SKILL.md 后台任务)。

```text
┌─ 数据源(sourcesDir 插件)
│  └─ 每个 tick 抓取 → 候选入库
├─ 生命周期(default 或 wake)
│  ├─ default:gate 准入 → 感知 → 空候选转 drift → LLM 判题(证据优先)→ 生成 → 投递 → 闭环调度
│  └─ wake:    事件入蓄水池 → hazard 概率抽签 → 语义兴趣过滤 → 无内容转 drift drive
├─ 投递
│  └─ config.json proactive.targets → gateway /api/deliver → 飞书 / QQ / web
└─ drift 门控
   └─ proactive 空闲时写 drift_gate 许可(TTL 1h),drift daemon 读许可执行技能
```

## 部署形态

三进程 systemd 服务。proactive 是独立 daemon(`cogito-proactive`),配置在
`.run/proactive.json`(或 `--config` 指定的文件):

```json
{
  "lifecycle": "wake",
  "sourcesDir": ".../sources",
  "dbPath": ".../proactive.sqlite",
  "sessionsDir": ".../sessions",
  "drift": { "enabled": true, "driftDir": "~/.cogito/agent/drift", "minIntervalHours": 1, "gateTtlHours": 1 },
  "tick": { "tickS0": 4800, "tickS1": 30, "tickJitter": 0.3, "scoreWeightEnergy": 0.35 },
  "delivery": { "enabled": true }
}
```

投递目标在根 `config.json` 的 `proactive.targets`(channel + chatId 列表)。

## 两种生命周期

### default(LLM 判题,evidence-first)

`proactive.run.start → proactive.admission.collect → proactive.sense →
proactive.route → proactive.judge → proactive.resolve → proactive.commit →
proactive.schedule`。

- 候选交给 LLM agent tick 判题(证据优先,给出来源与理由)
- 空候选直接转 drift 空闲分支
- 适合对推送质量要求高、愿意消耗 LLM 调用的场景

### wake(蓄水池 + hazard 抽签)

`wake.start → wake.ingest → wake.content.decide → wake.drift.decide → wake.schedule`。

- 事件进蓄水池(`reservoir_events`),新事件质量推动概率抽签
- 语义兴趣过滤(嵌入相似度),长时间无内容转 drift drive
- 无 LLM 判题,资源占用小;适合微博/知乎热搜这类高频低价值源
- 状态在独立库 `wake_proactive.db`(wake_tick_log / reservoir_events / hazard_state)

## 写一个 proactive 数据源插件

插件文件放进 `sourcesDir`(默认 `.run/agent/sources/`;也可用项目内
`.cogito/extensions/proactive/`),无需注册代码:

```ts
// dailyhot.ts — 旧格式:「default 导出 source 对象」仍兼容
import type { ProactiveSource } from "@cogito/proactive";

export default {
  id: "dailyhot",
  label: "微博/知乎热搜",
  defaultIntervalMs: 60000,
  channels: ["content"],
  async fetch() {
    return [{
      kind: "content",
      eventId: "hot-1",
      preprocessScore: 0.6,
      source: "dailyhot",
      title: "标题",
      url: "https://...",
      summary: "摘要",
    }];
  },
} satisfies ProactiveSource;
```

插件还可以贡献生命周期、模块、runtime 工厂(`export const plugin = {...}` 新格式,
见包 README)。源故障有熔断(`sourceHealth`)与 ACK 重试(`sourceAck`),抓取健康
状态存在 `state` 表(`health.source.<id>`),可在 web 面板查看。

## 投递

- 投递目标:`config.json` 的 `proactive.targets`(`channel` + `chatId` 数组),
  一条推送会发给全部目标。
- 出口:proactive 通过 gateway 的 `/api/deliver`(HTTP)复用 gateway 进程持有的
  通道连接(`createDeliveryClient`);三进程各自持有通道连接的问题不存在。
- 记录:`proactive.sqlite` 的 `deliveries` 表(delivery_status / target_receipts /
  idempotency_key 幂等去重)。
- **drift staged 投递恢复**:drift daemon 把 `message_push` 的消息写成
  `runs.message_result='staged'`;proactive 启动时恢复这些 staged 投递
  (`DriftStagedDeliveryStore`),按 `message_hash` 幂等,成功后回写 `sent`。
  ⚠️ `drift.driftDir` 必须指向 drift daemon 真实使用的目录,否则恢复永远看不到。

## 调度:energy 电量模型(akashic energy.py 移植)

轮询频率按用户活跃度自适应,而不是固定间隔。核心是三尺度指数衰减的电量:

```
E(t) = 0.50·exp(-t/30min)  +  0.35·exp(-t/240min)  +  0.15·exp(-t/2880min)
```

- 刚聊完(电量高)→ 互动饥渴度 `D_energy = 1 - E` 低 → base_score 低 →
  **tickS0(长间隔,不打扰,默认 4800s ≈ 80min)**
- 长时间无互动(电量→0)→ D_energy→1 → base_score 高 → **tickS1(短间隔,
  保持警觉,默认 2400s ≈ 40min)**
- 每次间隔带均匀抖动 `tickJitter`(默认 0.3),避免节奏呆板

配置(akashic 语义):

| 键 | 默认 | 含义 |
|---|---|---|
| `tick.tickS1` | 2400 | base_score > 0.2 时(空闲警觉)的下次 tick 秒数 |
| `tick.tickS0` | 4800 | base_score ≤ 0.2 时(刚互动完)的下次 tick 秒数 |
| `tick.tickJitter` | 0.3 | 间隔抖动比例 |
| `tick.scoreWeightEnergy` | 0.35 | 电量饥渴度在 base_score 中的权重 |

**presence(用户活跃度)数据来源**:proactive 维护 `presence` 表
(`last_user_at` / `last_proactive_at`),两个来源:
1. gateway 的 chat 模块在收到用户消息时直写(实时);
2. 每 tick 扫描 `sessionsDir` 的 jsonl 会话文件兜底(增量)。

⚠️ `sessionsDir` 必须指向真实会话目录(与 gateway 的 channel-agent-sessions 一致),
否则 presence 恒空,energy 退化为固定间隔。

## Drift 门控

`drift.gateTtlHours`(默认 1h):proactive 空闲时向 `drift_gate` 写
`allowed` 许可(TTL 1h);drift daemon 每轮读许可,`suppressed` 时跳过。
`drift.minIntervalHours` 控制连续 drift 的最小间隔。

## 验证清单

```text
├─ 源能抓取:state 表 health.source.<id> status=ok,无 quarantine
├─ 无内容不打扰:wake_tick_log base_score=0,不发消息
├─ 重复 tick 不重复投递:deliveries 按 idempotency_key 去重
├─ 有内容会推送:hazard 抽中或 default judge 通过 → deliveries 记录成功
├─ drift 静默闭环可观察:drift.db runs.status=completed, message_result=silent
└─ 聊天后间隔变长:presence.last_user_at 更新,tick 间隔走 tickS0
```

## 怎么观察

```bash
journalctl --user -u cogito-proactive -f     # 每 tick 的源抓取与决策日志
sqlite3 .run/agent/wake_proactive.db "select started_at,status,base_score,next_interval_seconds from wake_tick_log order by rowid desc limit 10"
sqlite3 .run/agent/proactive.sqlite "select * from deliveries order by id desc limit 5"
sqlite3 .run/agent/proactive.sqlite "select * from presence"
```
