/**
 * Drift 观测契约(跨包只读 schema)。
 *
 * proactive 的 monitor 进程只读 drift.db 做 dashboard 观测。为防止 schema
 * 漂移导致 dashboard 静默损坏,所有跨包 SELECT 的列清单定义在这里;
 * drift 改表时必须同步本文件,monitor 的查询引用这些常量,编译期即对齐。
 * (放在共享层 @cogito/gate:proactive 与 drift 都已依赖,避免新增包依赖。)
 */

/** runs 表观测列(monitor 时间线 + runs 列表共用)。 */
export const DRIFT_RUNS_OBSERVATION_COLUMNS = `id, run_id, session_key, run_at, skill_name, status, briefing, message_result, message_hash`;

/** run_steps 表观测列。 */
export const DRIFT_RUN_STEPS_OBSERVATION_COLUMNS = `id, run_id, step_index, tool_name, input_preview, output_preview, created_at`;

/** drift_active_runs 表观测列。 */
export const DRIFT_ACTIVE_RUNS_OBSERVATION_COLUMNS = `run_id, session_key, started_at, updated_at, stage, skill_name, message_hash`;

/** 诊断端点使用的 runs 明细列。 */
export const DRIFT_RUN_DETAIL_OBSERVATION_COLUMNS = `id, run_id, session_key, run_at, started_at, finished_at, skill_name, status, briefing, message_result, message_hash, message, target_channel, target_chat_id, delivery_status`;
