# Drift/Proactive 完善计划(create-drift-skill + 文档 + energy 电量模型)

> 状态:待评审。评审通过后按 Phase 1→3 实施。

## 1. 背景与目标

对照 akashic(`/home/wu/projects/akashic-agent`)补齐三个差距:

1. **create-drift-skill 内置技能** —— 让 agent 自己创建/更新 drift skill 的元技能。
2. **用户向文档** —— akashic 有 `_handbook/drift-guide.md`(231 行)与
   `proactive-guide.md`(126 行),cogito 的包 README 偏技术说明;akashic
   drift-guide 里的 3 个案例技能(记忆审计/好奇心探索/自我反思)可移植为测试技能。
3. **energy 电量模型** —— akashic 按用户活跃度自适应轮询频率;cogito 的 wake
   生命周期固定 `tickS0`。

## 2. 现状盘点(重要:与预期有出入)

### 2.1 create-drift-skill —— **已存在,但未接线**

- `packages/drift/src/index.ts:229` 已有 `seedExampleDriftSkill(skillsDir)`,内容是对
  akashic `skills/create-drift-skill/SKILL.md` 的忠实移植(frontmatter + 何时使用 +
  工作流 + 最低条件 + 状态模型 + 约束 + 收尾),且已适配 cogito 的 `finish_drift`
  契约(`scratchpad_update`/`cursor_update`/`journal_append`/`self_update`)。
- **缺口**:没有任何调用方(drift daemon 启动时不种入),所以用户技能目录
  (`~/.cogito/agent/drift/skills`)里没有它。另外 akashic 的 3 个案例技能
  (audit-dirty-memories / explore-curiosity / review-drift-gaps)cogito 没有。

### 2.2 energy 电量模型 —— **default 生命周期已完整移植,wake 与 presence 有缺口**

- `packages/proactive/src/stages/schedule.ts` 已完整移植 akashic `energy.py`:
  `computeEnergy`(三尺度指数衰减 τ=30/240/2880min)、`dEnergy`、`dRecent`、
  `nextTickFromScore`(base_score>0.2→tickS1,否则 tickS0,带 jitter)、
  `TickScheduler`、`EnergyScheduleStrategy`。
- default 生命周期(`stages/defaults.ts:290`)已用 `EnergyScheduleStrategy`。
- **缺口 A**:wake 生命周期(`wake/runtime.ts` 的 `nextIntervalSeconds` 恒为
  `tickIntervalSeconds`)绕过了 energy —— 用户部署跑 wake,`tickS0:30` 即固定 30s。
- **缺口 B:presence 无数据源**。presence(`stages/sense.ts`,akashic presence.py
  移植)靠扫描 `sessionsDir` 的 jsonl 取最近用户消息;但 `proactive.json` 的
  `sessionsDir` 指向 `.run/agent/sessions`,而 gateway 的聊天会话实际写在
  `~/.cogito/agent/channel-agent-sessions`(SessionManager)与 `~/.cogito/agent/sessions`
  —— 目录错位,presence 表恒空(实测 0 行),energy 永远拿不到 lastUserAt。
  与之前修的 driftDir 错位是同一类配置问题。

### 2.3 文档 —— 缺失

- `packages/drift/README.md` / `packages/proactive/README.md` 偏技术移植说明。
- 根 `README.md` 有架构图但无用户向指南;无 akashic 那样的真实案例。

## 3. 任务一:create-drift-skill 接线 + 案例技能

### 3.1 daemon 启动种入(必做)

`packages/drift/src/daemon.ts` 在 `runDriftDaemon` 构建 store 后调用
`seedExampleDriftSkill(join(driftDir, "skills"))`(已有 helper,幂等:文件存在即跳过)。

- 用户现有部署重启后 `~/.cogito/agent/drift/skills/create-drift-skill/` 自动出现,
  下一轮 drift 即可被 agent 选中用于创建新技能。
- 同步在 `drift-plan.md` 与包 README 中记录该行为。

### 3.2 案例技能:示例目录(必做)

新增 `packages/drift/examples/skills/`(静态 SKILL.md,不自动种入,文档里说明
"复制到 `driftDir/skills/` 即可启用"),移植 akashic 3 个案例并适配 cogito 工具:

| 案例 | akashic 工具 | cogito 适配 |
|---|---|---|
| `audit-dirty-memories`(记忆审计) | fetch_messages + 脚本抽样 + message_push | cogito drift 无 fetch_messages → 改用 `recall_memory`(gate 的 recallPreferences/`memory.sqlite`)+ `read_file` + `message_push`;脚本用 `shell` |
| `explore-curiosity`(好奇心探索) | recall_memory + message_push | cogito `recall_memory` 等价物(`recallPreferencesRanked`)+ `message_push`;工具名按 drift 实际注册名 |
| `review-drift-gaps`(自我反思) | 读 drift.db + 健康摘要 | cogito `read_journal` + `read_file`(drift.db 只读查询)+ 静默闭环 |

每个示例含 frontmatter(`name`/`description` 写明"何时可能选择")+ 单次闭环 +
`finish_drift` 收尾(status/paused 语义)+ 状态延续(scratchpad/cursor/journal)。
工具名以 `packages/drift/src/tools.ts` 实际注册名为准(实施时逐一对表)。

### 3.3 可选:更多内置技能(待决策)

- `create-proactive-source`(akashic 也有)—— 需 proactive 侧 source 文档配合,本期
  建议只放进文档,不种子。

## 4. 任务二:用户向文档

### 4.1 位置与结构

新建根级 `docs/` 目录(与 akashic `_handbook/` 对应):

```
docs/
├── drift-guide.md        # 移植 akashic drift-guide.md,适配 cogito
├── proactive-guide.md    # 移植 akashic proactive-guide.md,适配 cogito
└── README.md             # 文档索引
```

根 `README.md` 的 Proactive/Drift 小节各加一行指向对应指南(akashic 同款做法)。

### 4.2 drift-guide.md(大纲,对应 akashic 231 行)

1. **它是什么**:后台任务系统;与 proactive 的本质区别(proactive=代码写死判断,
   drift=你写的 SKILL.md)。
2. **触发条件**:proactive 无内容可推 → drift;`minIntervalHours` 与 gate 语义。
3. **核心约束**:每轮重新选技能 / message_push 最多一次 fire-and-forget /
   必须 finish_drift / message_result 由 runtime 记 / completed vs paused /
   max_steps wrap-up。
4. **自我连续性**:self_state / recent runs / self_observation(journal 三态:
   question/reinforce/revise)—— 对应 cogito `drift.db` 表。
5. **SKILL.md 格式**:frontmatter(name/description)+ 目标/工作文件/工作流程/要求;
   哪些文件你写、哪些 runtime 写。
6. **cogito 工具表**:read_file/list_dir/write_file/edit_file/shell/
   web_fetch/web_search/message_push/finish_drift/select_skill/idle_drift/
   read_journal/mount_server 逐个一句话用途。
7. **3 个真实案例**(直接引用 §3.2 的示例技能 + 运行记录格式)。
8. **写自己的 skill**:最小示例 + 注意事项 + 指向 `create-drift-skill` 技能
   (让 agent 帮你建)。

### 4.3 proactive-guide.md(大纲,对应 akashic 126 行)

1. **架构**:tick 生命周期(default/wake 两条链,引用包 README 的模块图)。
2. **两种生命周期怎么选**:default(LLM 判题,evidence-first)vs wake(蓄水池 +
   hazard 抽签 + 语义过滤)—— 这是 cogito 与 akashic 的差异点,重点写清。
3. **数据源插件**:`sourcesDir` 插件格式(contributing source/lifecycle/module/
   runtime factory)+ 插件示例。
4. **投递**:delivery 目标(config.json proactive.targets)、与 gateway `/api/deliver`
   的关系、drift staged 投递恢复。
5. **energy 调度**(§5 实施后):tickS0/tickS1/tickJitter/scoreWeightEnergy 配置语义,
   presence 数据来源。
6. **drift 门控**:drift_gate(proactive 写许可、drift 读、TTL)、`minIntervalHours`。
7. **验证清单**(移植 akashic):source 能抓取 / 无内容不打扰 / 重复 tick 不重复投递 /
   drift 静默闭环可观察。

### 4.4 包 README 补充(小改)

- `packages/drift/README.md`:`create-drift-skill` 自动种入行为 + examples 目录链接。
- `packages/proactive/README.md`:energy 配置小节(§5 落地后)。

## 5. 任务三:energy 电量模型补全

### 5.1 wake 生命周期接入 energy(必做)

`packages/proactive/src/wake/runtime.ts` 的 `decideDrift`/`decideContent` 路径在
无 alert、无内容时 `nextIntervalSeconds` 恒为 `tickIntervalSeconds`。改为:

- `WakeRuntime` 增加 `presence`(lastUserAt)与 `tickScheduler` 依赖(wake 插件装配处
  传入,复用现有 `TickScheduler`,config 沿用 `tick.tickS0/tickS1/tickJitter/
  scoreWeightEnergy`)。
- 无 alert 分支:`nextIntervalSeconds = tickScheduler.nextInterval(null, lastUserAt)`:
  - 有 presence(用户刚聊过)→ energy 高 → base_score 低 → tickS0(长间隔,不打扰);
  - 长时间无互动 → energy 低 → base_score 高 → tickS1(短间隔,保持警觉);
  - 无 presence 数据 → 保持现配置的 fallback(兼容现状)。
- alert 分支保持 1s/interval 不等(现状)。

### 5.2 presence 数据源修复(必做)

两处配合:

1. **配置对齐**:`proactive.json` 的 `sessionsDir` 指向真实聊天会话目录
   (`~/.cogito/agent/channel-agent-sessions`,与 gateway 的 `channelSessionStore`
   一致);实施时确认 presence 扫描对新格式 jsonl 有效。
2. **gateway 实时写入(推荐)**:chat 模块(`packages/chat/src/turn.ts` 入站处)在收到
   用户消息时,向 proactive 的 presence 表写入 `last_user_at`
   (`proactive.sqlite` 的 `presence` 表,gateway 已有 `resolveProactiveDbPath`)。
   跨进程写共享 DB 已有先例(chat→proactive.db 的 dashboard 读、drift→staged)。
   备选(不推荐):proactive 每 tick 读 gateway 的 `channel-messages.json`。

   ⚠️ 注意:presence 扫描是"proactive 进程读自己库",gateway 直写是"另一个进程写
   同一个 sqlite"——WAL 模式支持并发,但需确认 proactive 的 store 连接参数。

### 5.3 配置与默认值

`proactive.json` `tick` 节扩展语义(与现有 tickS0/tickS1 兼容):

```json
{
  "tick": {
    "tickS0": 4800,
    "tickS1": 30,
    "tickJitter": 0.3,
    "scoreWeightEnergy": 0.35
  }
}
```

- `tickS1` = 有推送价值/空闲警觉时的短间隔(当前部署是 30s);
- `tickS0` = 刚互动完的长间隔(默认 4800s = 80min,akashic 默认);
- 无 presence 时仍按现状 fallback,行为不退化。

### 5.4 测试

- `packages/proactive/test/energy.test.ts`(若已有则补):computeEnergy 三尺度衰减
  边界、nextTickFromScore 阈值与 jitter、TickScheduler 三态(无 presence /
  有 presence 高能量 / 低能量)。
- wake 接入后:`WakeRuntime` 无 alert 时 interval 随 presence 变化(fake presence)。
- chat 的 presence 写入:单测(入站消息 → presence 表更新)或并入现有 chat 测试。

## 6. 实施阶段

### Phase 1 — create-drift-skill 接线 + 案例技能
- daemon 启动种入 `seedExampleDriftSkill`;`packages/drift/examples/skills/` 三个案例
  技能(适配工具名);包 README 说明。
- 验收:`npm run check` 全绿;drift 测试不回归;重启 drift daemon 后技能目录出现
  create-drift-skill;examples 三个 SKILL.md 通过现有 skill 解析。

### Phase 2 — 文档
- `docs/drift-guide.md`、`docs/proactive-guide.md`、`docs/README.md`;根 README 加链接;
  包 README 小改。
- 验收:文档与实现一致(工具名/配置项逐一核对);markdown 无 lint 问题。

### Phase 3 — energy 补全
- 5.1 wake 接入 energy;5.2 presence 配置对齐 + gateway 写入;5.3 配置文档化;5.4 测试。
- 验收:`npm run check` + `./test.sh` 全绿;冒烟:wake 部署下,聊天后 interval 变长
  (presence 生效)、长时间无互动回到短 interval;presence 表有数据。

## 7. 决策记录(2025-08-16 已确认)

1. **examples 位置**:`packages/drift/examples/skills/`(随包发布)。
2. **presence 数据源**:配置对齐 + gateway 直写(chat 模块入站时写
   `proactive.sqlite` 的 presence 表,实时;tick 扫描作为兜底)。
3. **wake 接入 energy 的配置语义**:akashic 语义 —— tickS1=空闲警觉短间隔(30s)/
   tickS0=刚互动后长间隔(4800s);无 presence 时 fallback 现状配置,不退化。
4. **proactive-guide 的 wake 细节**:本期写简介 + 指代码,不完整展开。
5. **create-proactive-source 技能**:本期只写文档,不种子。

实施中若发现需要推翻以上决策,按方案 §8 风险流程处理并在文档记录。

## 8. 风险与缓解

| 风险 | 缓解 |
|---|---|
| daemon 种入改变用户既有技能目录 | seedExampleDriftSkill 幂等(文件存在跳过),只新增不覆盖 |
| 案例技能工具名与 drift 实际注册名不一致 | 实施时对 `tools.ts` 注册表逐一对表;文档与示例共用同一份工具表 |
| gateway 直写 proactive.sqlite 并发冲突 | WAL + 短事务;先验证 proactive store 连接参数;失败仅 log 不阻断入站 |
| wake 接入 energy 后 interval 突变(30s→80min) | 无 presence 时 fallback 现状;配置显式控制;测试覆盖三态 |
| 文档与代码漂移 | 文档内工具表/配置表以"实施时核对"为验收项,check 不过不放行 |

## 9. 实施状态(2025-08-16 全部完成)

Phase 1-3 全部落地,`npm run check` 全绿;chat 31 测试、proactive 19+ 测试(含新增
wake-energy 5 个、presence-scan 3 个)、drift 67 测试全通过;全仓除 coding-agent
(其他会话未提交改动的预存失败,非本计划范围)外全部通过;三服务已用新代码重启并
实测验证。

### 交付物

- **Phase 1**:`seedExampleDriftSkill` 接入 `runDriftDaemon` 启动(重启后技能目录自动
  出现 create-drift-skill,已验证);`packages/drift/examples/skills/` 三个案例技能
  (audit-dirty-memories / explore-curiosity / review-drift-gaps);drift README 技能章节。
- **Phase 2**:`docs/drift-guide.md`、`docs/proactive-guide.md`、`docs/README.md`;
  根 README 增加指南链接。
- **Phase 3**:
  - wake 生命周期接入 energy:`WakeRuntime` 增加 `tickScheduler`(无 alert/内容时
    `scheduleNextInterval()`,无 presence fallback 固定间隔);装配处传
    `TickScheduler`(ReplayClock 除外)。
  - presence 数据源修复(三层,按发现顺序):
    1. `proactive.json` `sessionsDir` 对齐真实会话目录(channel-agent-sessions);
    2. `newestUserMessageAt` 支持整数(epoch-ms)时间戳 —— 原只认字符串,扫描恒空;
    3. **standalone presence 端口短路扫描** —— `StandaloneRuntimeAdapter` 的
       `presence.refresh` 原来只读 store,导致 `Presence.refresh()` 永远走
       runtimePort 分支、从不扫描会话文件;现在注入 `sessionsDir`/`sessionKey`,
       refresh 先 `scanSessionsDir()` 再与 store 合并写入。
  - chat 模块入站直写 presence(`ChatPresenceWriter`,每写开新连接规避 node:sqlite
    长连接 WAL 陈旧问题;写失败仅记日志,不阻断聊天)。
  - 配置:`.run/proactive.json` tick 节改为 akashic 语义
    (tickS1=30 空闲警觉 / tickS0=4800 刚互动 / tickJitter=0.3 /
    scoreWeightEnergy=0.35 / fallbackIntervalSeconds=30)。

### 实测验证(三服务重启后)

- wake tick 间隔:presence 为空时 fallback 30s;presence 有值后进入 energy 路径
  (实测 3907s ≈ tickS0×jitter)。
- presence 表:daemon 扫描填充真实最后用户消息时间(14:14:08)。
- create-drift-skill:重启 drift daemon 后 `~/.cogito/agent/drift/skills/` 出现。

### 与方案的差异

- 调试中发现并修复了两个方案外 bug:`newestUserMessageAt` 整数时间戳不识别;
  standalone presence 端口短路会话扫描(后者是 presence 恒空的根本原因)。
- `ChatPresenceWriter` 采用每写新连接(方案为长连接),规避 node:sqlite 在
  多连接 WAL 场景下的写入丢失问题。
