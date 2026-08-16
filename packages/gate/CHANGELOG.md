# Changelog

## [Unreleased]

### Added

- 三进程共享状态层:proactive 与 drift 解耦,门控/调度/投递恢复/事件契约收编到本包,双方互不依赖。
- `DriftGateStore`:`drift_gate` 许可读写(TTL 过期返回 null),proactive 写、drift daemon 读。
- `DriftStagedDeliveryStore`:跨进程 staged 投递恢复(drift 写 staged,proactive 恢复投递),含投递类型契约(`DriftDeliverySink`/`DriftDeliveryRecord`/`DriftDeliveryReceipt`/`DriftDeliveryStatus`)。
- `DriftEvent`/`DriftEventSink`:Drift 生命周期事件契约。
- `advanceDriftDrive`/`sampleDriftDelayHours`:空闲 drift 调度纯函数。
- `pickDaemonModel`:settings.json `enabledModels` 驱动的 daemon 模型选择。
- `recallPreferences`/`recallPreferencesRanked`/`formatPreferenceBlock`:用户偏好召回。
- `hashOutboundMessage`/`hashMessage`/`DriftOutboundAttachment`:出站消息哈希与附件类型。
- `recallPreferencesRanked` 增加可选 `minScore` relevance floor(akashic `relevance_floor` 的近似),低于阈值的向量召回结果被丢弃。
- `DriftEvent.drift_finished` 增加 `llmCacheReadTokens`/`llmCacheWriteTokens`:run 级 LLM cache usage 审计(akashic `record_llm_cache` 对应物)。
