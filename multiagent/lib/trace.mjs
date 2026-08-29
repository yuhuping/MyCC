// multiagent/lib/trace.mjs
// Trace 读写（Audit §8）：append-only lifecycle events + 汇总；兼容旧（v1）trace。
import fs from 'node:fs'

export const TRACE_VERSION = 2

/** 追加式 trace sink + 汇总字段收集。 */
export function createTraceSink() {
  const events = []
  const startMs = Date.now()
  return {
    events,
    startMs,
    emit(ev) {
      const entry = { ts: new Date().toISOString(), ...ev }
      events.push(entry)
      return entry
    },
    elapsedMs() {
      return Date.now() - startMs
    },
  }
}

export const NODE_EVENT_NAMES = new Set([
  'node_started', 'node_completed', 'node_failed', 'node_cancelled',
  'node_retry', 'node_cleanup_failed', 'node_cleanup_ok', 'node_apply_status',
  'node_artifact_error', 'node_readonly_violation', 'node_timeout',
])

/**
 * 读取 trace 文件，容忍旧 v1 格式（无 version / coordination_mode 字段）。
 * 返回 { version, legacy, data }。
 */
export function readTrace(file) {
  const raw = fs.readFileSync(file, 'utf8')
  const data = JSON.parse(raw)
  if (data.version === TRACE_VERSION) return { version: TRACE_VERSION, legacy: false, data }
  return { version: 1, legacy: true, data }
}

/** 从任意 trace 提取节点级记录（新格式 nodes[]；旧格式从 stages[] 映射）。 */
export function nodeRecords(trace) {
  const { legacy, data } = trace
  if (legacy) {
    return (data.stages ?? []).map((s, i) => ({
      node_id: s.nodeId ?? s.node_id ?? `stage-${i + 1}`,
      agent_id: s.agentId ?? s.agent_id,
      kind: s.kind ?? 'relay',
      status: 'succeeded',
      started_at: s.startedAt ?? null,
      ended_at: s.endedAt ?? null,
      elapsed_ms: s.elapsedMs ?? null,
      attempts: 1,
    }))
  }
  return data.nodes ?? []
}

/** 顶层并行指标。 */
export function summaryOf(trace) {
  const { version, legacy, data } = trace
  return {
    version,
    legacy,
    coordination_mode: data.coordination_mode ?? (legacy ? 'relay' : null),
    plan_id: data.plan_id ?? null,
    observed_max_concurrency: data.observed_max_concurrency ?? 1,
    wall_clock_elapsed_ms: data.wall_clock_elapsed_ms ?? data.elapsed_ms ?? null,
    sum_agent_elapsed_ms: data.sum_agent_elapsed_ms ?? null,
    main_write_max_concurrency: data.main_write_max_concurrency ?? 1,
    integration_status: data.integration_status ?? null,
    baseline_commit: data.baseline_commit ?? null,
  }
}