# Drift 系统指南

## 先理解它是什么

Drift 是一个**你写模型可以做什么、模型照着执行**的后台任务系统。

- **什么时候跑**:proactive 拉了一圈啥也没有(无 alert、无 content、无 context fallback)
- **做什么**:你写在 `drift/skills/<skill-name>/SKILL.md` 里的事
- **怎么做**:SKILL.md 是一份分步操作指南——先读哪个文件、跑什么脚本、怎么判断、什么时候发消息——模型一步步按着走
- **跟 proactive 的本质区别**:proactive 的行为是代码里写死的判断,drift 的行为是你写的 SKILL.md

**一个 drift skill 就是一个 agent run**:它拿到一套工具(read_file / write_file / shell / fetch_messages / recall_memory / message_push / web_fetch / web_search...),带着 runtime 注入的 Drift Briefing,拿着你写的 SKILL.md 当 system prompt,一步一步执行,最后调 `finish_drift` 收尾。

```text
┌─ proactive 无 alert / content / context
│  └─ DriftTurnPipeline
│     ├─ 扫描并比较 drift skills
│     ├─ 注入记忆、近期上下文与连续性前情
│     ├─ select_skill 或 idle_drift
│     └─ 执行一个原子动作
│        ├─ 可选 message_push(最多一次)
│        └─ finish_drift
│           ├─ completed / paused
│           ├─ skill continuum(cursor)
│           ├─ self_update
│           └─ skill journal(append-only)
└─ done
```

## 部署形态

三进程 systemd 服务(`cogito-gateway` / `cogito-proactive` / `cogito-drift`),
drift 的宿主是 `cogito-drift`:

- 技能目录:`<project>/.cogito/extensions/drift/skills/<skill-name>/SKILL.md`
- 状态库:`<project>/.cogito/extensions/drift/drift.db`(runs / skill_continuum / skill_journal /
  self_state / drift_observations / drift_active_runs)
- 门控:proactive 空闲时向 `drift_gate` 写 `allowed` 许可(TTL 1h);drift 每轮读许可,
  `suppressed` 时跳过
- 节奏:drift daemon 每 5 分钟 tick 一次,是否真的跑一轮由"一次性到期采样"决定
  (锚点 = 最近用户活动 + 最近 drift + 重复度,变更即重采样);用户可改
  `proactive.json` 的 `drift.minIntervalHours`

## Drift 的核心约束

1. **每次重新选择**:不默认继续上次的 skill,每轮重新比较所有 skill
2. **message_push 是 fire-and-forget**:最多推送一次;成功后本轮动作已经完成,只能调用
   `finish_drift`。未来真有用户回答时,它会作为新会话上下文和记忆进入,但 Drift
   不保存"等待回答",也不能推断"用户没回"
3. **必须 finish_drift**:执行结束前必须调用,填写 `status`、`briefing` 和 `self_update`
4. **message_result 由 runtime 记录**:调用过 `message_push` 且提交成功就是 sent,
   否则是 silent,不由 skill 自报
5. **status 表示系统自己的进度**:
   - `"completed"` — 本轮小闭环已完成,不强行生成下一步
   - `"paused"` — 本轮没做完,必须在 `scratchpad_update` 写清下次从哪里继续
6. **到达 max_steps 会收尾**:如果模型没主动调 finish_drift,runtime 会进入 wrap-up
   phase,只允许调用 `finish_drift` 保存接续点
7. **最小间隔**:`drift.min_interval_hours` 控制连续两次 drift 的最小间隔

## Drift 的自我连续性

Drift 会被反复触发。它既要保留当前意图,也要能从多轮行为中形成可修正的暂定认识。

```text
┌─ self_state
│  ├─ 上轮意图与选择原因
│  └─ 宽松的 next_tendency,不是下一轮指令
├─ runs(skill_continuum)
│  └─ 最近真实做过的活动
└─ skill_journal / drift_observations
   ├─ question       首次提出暂定观察
   ├─ reinforce      后续重复证据加强
   └─ revise         反例或主动变化修正
```

`finish_drift.self_update` 必须包含:

- `reflection`:本轮与近期行为是什么关系。
- `pattern`:`ordinary`、`repeat`、`change` 或 `contradiction`。
- `next_tendency`:下次可能想做什么的宽松倾向,不能写等待用户回答。
- `observation`:当 pattern 不是 ordinary 时必填,保存 statement、basis 和 effect。

这些观察只属于 Drift 自身的空闲行为,不写入用户长期记忆,也不是稳定人格结论。

## Drift Skill 格式

每个 skill 是一个目录,放在 `<project>/.cogito/extensions/drift/skills/<skill-name>/` 下,
核心文件是 `SKILL.md`。

### 哪些文件你写、哪些 agent 写

| 文件 | 维护方式 | 说明 |
|------|---------|------|
| `drift/skills/<name>/SKILL.md` | **你写**(或让 agent 用内置技能 `create-drift-skill` 生成) | drift 任务定义,agent 每轮当 system prompt 读 |
| `drift/drift.db` | **runtime 写** | 保存 run、skill continuum(cursor)、journal、self_state |
| `drift/skills/<name>/*.md` | **按 skill 需要读写** | 工作文件(audited.md、读书笔记等),不是系统级连续性的唯一来源 |
| `drift/skills/<name>/scripts/*` | **你写** | 固定脚本,skill 通过 `shell` 工具调用 |

> cogito 内置了元技能 `create-drift-skill`(daemon 启动自动种入),你可以在对话里让
> 主 agent 或 drift 自己创建新技能;另外 `packages/drift/examples/skills/` 有三个
> 可直接复制的案例技能。

### SKILL.md 结构

```yaml
---
name: <skill-name>
description: <做什么,以及什么空闲情境下适合选择>
---

## 目标

## 工作文件
（列出这个 skill 会读写的工作文件路径）

## 工作流程
1. ...

## 要求
- 约束和规则
```

## cogito drift 工具表

| 工具 | 用途 | 分类 |
|------|------|------|
| `select_skill` / `idle_drift` | 选定本轮技能 / 本轮不行动 | 控制 |
| `finish_drift` | 保存状态并结束本轮(status/briefing/scratchpad/cursor/journal/self_update) | 控制 |
| `read_file` / `list_dir` / `write_file` / `edit_file` | 读写 drift 工作文件 | 文件 |
| `fetch_messages` / `search_messages` | 读取/搜索会话历史 | 会话 |
| `recall_memory` | 检索长期记忆(用户偏好与规则) | 记忆 |
| `read_journal` | 只读查询当前 skill 的 journal 与 cursor | 状态 |
| `web_fetch` / `web_search` | 获取外部信息(SSRF 策略限制私网) | 网络 |
| `shell` / `write_stdin` / `task_stop` | 运行脚本 / 交互式 stdin / 终止子进程 | 执行 |
| `message_push` | 推一条消息给用户(最多一次,fire-and-forget) | 投递 |
| `mount_server` | 挂载 MCP server(requires_mcp 过滤) | MCP |

## 真实案例(可直接复制到技能目录)

### 案例一:audit-dirty-memories(记忆审计)

见 `packages/drift/examples/skills/audit-dirty-memories/SKILL.md`。

**目标**:抽检长期记忆,回溯原始消息,判断记忆摘要是否准确。

**工作流程**:
1. `recall_memory` 取一批候选
2. `fetch_messages` 读取来源上下文
3. 对比摘要与原文做"高置信可疑判断"
4. 干净 → 静默记录;可疑 → 发消息告诉用户哪条记忆为什么可疑
5. `finish_drift` + `journal_append` 记录已审计条目

### 案例二:explore-curiosity(好奇心探索)

见 `packages/drift/examples/skills/explore-curiosity/SKILL.md`。

**目标**:补足用户画像中的生活化信息空白,一次只问一个轻量、自然的问题。

**规则**:问题必须轻量自然;优先音乐/开源项目/运动/食物/消遣;
避开长期记忆里已有答案的信息;`message_push` 成功后立即闭环。

### 案例三:review-drift-gaps(Drift 自我反思)

见 `packages/drift/examples/skills/review-drift-gaps/SKILL.md`。

**目标**:定期回顾 Drift 全局行动历史,找出长期 paused 或反复失败的方向。

**规则**:显式跳过自身;不调用 message_push,纯后台记录;
权威来源是 drift.db 与 journal,不是 skill 工作文件。

## 写自己的 Drift Skill

### 最小示例

```markdown
---
name: my-skill
description: 定期把最近对话里值得回顾的内容归档到工作文件,适合长时间无新内容时执行。
---

## 目标
定期从最近对话中提取值得回顾的内容,追加到工作文件。

## 工作流程
1. `fetch_messages`(context 20)获取最近对话
2. 提取值得回顾的内容(计划、决策、偏好变化)
3. 有内容 → `write_file` 追加到 `digest.md`
4. 没有 → 静默结束

## 工作文件
- `digest.md`:追加式摘要

## 要求
- 不调用 message_push(纯后台)
- 完成后 `finish_drift(status="completed", briefing="提取了 N 条", self_update={...})`
- 没做完 → `finish_drift(status="paused", scratchpad_update="下次从 ... 继续", ...)`
```

### 注意事项

- `finish_drift.status` 必须是 `completed` 或 `paused`;`paused` 必须写
  `scratchpad_update`
- 连续性状态只走 runtime:`scratchpad_update`(自然语言)/ `cursor_update`(结构化,
  供脚本读)/ `journal_append`(已完成事实,防重复);不要自己维护 `state.json`
- 工作文件可以继续使用,但不要把它们写成模型必须手工维护的复杂状态机
- 只读工具(read_file / fetch_messages 等)放在前面,写操作放在后面
- 如果 skill 需要 MCP server,用 `mount_server` 挂载,并在 frontmatter 写
  `requires_mcp`
- frontmatter 支持 `cooldown_hours` / `max_runs_per_day` / `time_window` 限制

## 怎么观察

```bash
journalctl --user -u cogito-drift -f                 # [drift] enter 每 5 分钟一轮
sqlite3 .cogito/extensions/drift/drift.db "select skill_name,status,message_result,briefing from runs order by finished_at desc limit 10"
```
