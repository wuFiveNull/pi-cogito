# @cogito/gate

三进程共享状态层:proactive 与 drift 都只依赖本包,互相零引用。

## 内容

| 模块 | 导出 | 用途 |
|---|---|---|
| `gate.ts` | `DriftGateStore` / `DriftGate` / `DriftGateWriter` / `WAKE_DRIFT_GATE_TTL_HOURS` | `drift_gate` 许可读写(proactive 写,drift daemon 读,TTL 过期视为无许可) |
| `staged.ts` | `DriftStagedDeliveryStore` / `DriftStagedDelivery` / `DriftDeliverySink` / `DriftDeliveryRecord` / `DriftDeliveryReceipt` / `DriftDeliveryStatus` | 跨进程 staged 投递恢复(drift 写 staged,proactive 恢复投递) |
| `events.ts` | `DriftEvent` / `DriftEventSink` | Drift 生命周期事件契约(proactive 经 EventBus 订阅) |
| `drive.ts` | `advanceDriftDrive` / `sampleDriftDelayHours` / `DriftDriveResult` | 空闲 drift 调度(纯函数) |
| `model-pick.ts` | `pickDaemonModel` | daemon 模型选择(settings.json `enabledModels`) |
| `memory.ts` | `recallPreferences` / `recallPreferencesRanked` / `formatPreferenceBlock` / `RecalledPreference` | 用户偏好召回(只读 memory.sqlite) |
| `outbound.ts` | `hashOutboundMessage` / `hashMessage` / `DriftOutboundAttachment` / `DriftAttachmentKind` | 出站消息哈希与附件类型 |

## 依赖方向

```
proactive ──► pi-gate ◄── drift
     (不引用 drift)        (不引用 proactive)
```

两个业务包互不可见;门控/调度/投递恢复/事件契约等跨进程共享逻辑全部收在本包。

## 用法

```ts
import { DriftGateStore } from "@cogito/gate";

// proactive 侧:写许可
const gate = new DriftGateStore({ driftDir: "~/.cogito/agent/drift" });
gate.writeDriftGate({ sessionKey: "local", verdict: "allowed", reason: "wake_idle", grantedAt: new Date(), ttlHours: 1 });

// drift 侧:读许可(TTL 过期返回 null)
const gate2 = new DriftGateStore({ driftDir: "~/.cogito/agent/drift" });
const verdict = gate2.readDriftGate("local", new Date());
```
