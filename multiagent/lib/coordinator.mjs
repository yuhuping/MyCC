// multiagent/lib/coordinator.mjs
// 多智能体编排层（Audit §3 / §6）：
//   - runRelayTask：现有顺序接力（MultiAgentBench 指定基线），仅追加 Phase 0
//     观测字段（stage 起止时间、coordination_mode、observed_max_concurrency），
//     保持旧语义与历史格式兼容。
//   - runPlannedTask：显式 execution plan 驱动的 DAG scheduler。ready set 并发、
//     main writer 容量 1 mutex、isolated worktree 隔离、确定性集成（只由 integrate
//     node 带回 main）、生命周期 trace、重试/超时/取消/清理。
//
// 强制不变量（Audit §3）：
//   1. 任意时刻最多一个 node 对 main worktree 有写权限（validator + runtime mutex）。
//   2. 并行可写 node 只能写自身 linked worktree，且记录启动时 base_revision。
//   3. 只有 integrate node 将 isolated patch 带回 main；记录来源/决定/冲突/测试。
//   4. 后继 node 只消费全部 dependsOn 成功产生且 schema 校验过的 artifact。
//   5. 失败/冲突/取消/cleanup 失败都不能伪装成 handoff success（trace 有确定状态与证据）。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AgentInstance } from './agent-instance.mjs'
import {
  validatePlan, computeReadySet, hasPending, topologicalOrder,
  coordinationModeFor, PlanExecutionError,
} from './execution-plan.mjs'
import {
  initGitRepo, isGitRepo, headSha, commitAll,
  worktreeAdd, worktreeRemove,
  collectPatch, diffNameOnly, applyPatch, hardResetToHead,
  gitStatusPorcelain, lightSyntaxCheck, runTestCommand,
} from './worktree.mjs'
import {
  atomicWriteJson, validateNodeArtifacts, summarizeNodeArtifacts,
  extractStructuredArtifact, extractCommandsFromTranscript,
  validateArtifactObject,
} from './artifacts.mjs'
import {
  createLimiter, createMainWriterTracker, createConcurrencyObserver, ConcurrencyViolation,
} from './concurrency.mjs'

const sleep = ms => new Promise(r => setTimeout(r, ms))

/**
 * 测试打桩点：cleanup 失败留痕测试通过替换 remove 验证路径。
 * 生产语义不变；仅允许测试注入确定性故障。
 */
export const cleanupOps = { remove: worktreeRemove }

/** 瞬时错误识别：429/限流/网络/超时类错误可有限退避重试（Audit §6）。 */
export function isTransientError(error) {
  if (!error) return false
  const name = error?.name ?? ''
  if (['APIHttpError', 'RateLimitError', 'TimeoutError', 'NodeTimeoutError', 'ECONNRESET'].includes(name)) return true
  return /429|rate limit|too many requests|timeout|temporarily unavailable|ECONNRESET|ETIMEDOUT/i.test(error?.message ?? '')
}

function retryDelayMs(attempt) {
  return Math.min(500 * 2 ** (attempt - 1), 8000)
}

// ---------------------------------------------------------------- MessageBus

export class MessageBus {
  constructor() {
    this.messages = []
  }

  /** kind: 'handoff' (relay) | 'artifact_ready'（Audit §8：只发可验证 artifact 引用）。 */
  post({ from, to = null, kind, summary, stageId = null, artifact = null, sha256 = null }) {
    this.messages.push({
      seq: this.messages.length + 1,
      from,
      to,
      kind,
      summary,
      ...(stageId ? { stageId } : {}),
      ...(artifact ? { artifact, sha256 } : {}),
      ts: new Date().toISOString(),
    })
  }

  serialize() {
    return this.messages
      .map(m => `[#${m.seq}] ${m.from}${m.to ? ' -> ' + m.to : ''} (${m.kind})\n${m.summary}`)
      .join('\n')
  }
}

// ---------------------------------------------------------------- AgentGraph

export class AgentGraph {
  constructor({ agents, relationships }) {
    this.agents = agents
    this.edges = relationships ?? []
  }

  static fromConfig(agentConfigs, relationships) {
    const agents = agentConfigs.map(c => new AgentInstance({
      agentId: c.agent_id,
      type: c.type,
      profile: c.profile ?? '',
      maxTurns: c.max_turns ?? null,
      model: c.model ?? null,
    }))
    return new AgentGraph({ agents, relationships })
  }

  byId(id) {
    return this.agents.find(a => a.agentId === id) ?? null
  }
}

// ---------------------------------------------------------------- relay（Phase 0 观测）

/**
 * 顺序接力（基准，MultiAgentBench 指定基线）。
 * Phase 0 追加：每 stage 的 startedAt/endedAt/elapsedMs，result 顶层
 * coordination_mode:'relay'、observed_max_concurrency:1、wall/sum 耗时。
 * 旧字段全部保留，只追加新字段。
 */
export async function runRelayTask({
  graph,
  task,
  workspace,
  provider,
  sessionDirBase = null,
  maxContextChars = 6000,
  maxTurnsPerAgent = 30,
  onStage = () => {},
}) {
  if (graph.agents.length === 0) throw new Error('AgentGraph has no agents')
  const bus = new MessageBus()
  const stages = []
  let context = null
  const wallStart = Date.now()

  for (let i = 0; i < graph.agents.length; i++) {
    const agent = graph.agents[i]
    agent.workspace = workspace
    if (agent.maxTurns == null) agent.maxTurns = maxTurnsPerAgent
    agent.provider = provider
    const sessionDir = sessionDirBase ? path.join(sessionDirBase, `${String(i + 1).padStart(2, '0')}-${agent.agentId}`) : null

    const stageMeta = { index: i, agentId: agent.agentId, kind: i === 0 ? 'build' : 'relay' }
    const startedAt = new Date().toISOString()
    const startedMs = Date.now()
    onStage({ ...stageMeta, phase: 'start', startedAt })
    const result = await agent.run({ task, context, sessionDir })
    const endedAt = new Date().toISOString()
    const elapsedMs = Date.now() - startedMs
    const completed = { ...stageMeta, startedAt, endedAt, elapsedMs }
    const summary = agent.summarize(result, { maxContextChars })
    bus.post({ from: agent.agentId, kind: 'handoff', summary })
    stages.push({ ...completed, result, summary })
    onStage({ ...stageMeta, phase: 'done', startedAt, endedAt, elapsedMs, result })

    context = `What ${agent.agentId} just finished:\n${summary}`
  }

  const last = stages.at(-1)
  return {
    graph,
    stages,
    messages: bus.serialize(),
    messageList: bus.messages,
    finalText: last?.result.finalText ?? '',
    diff: last?.result.diff ?? '',
    // Phase 0 观测字段（追加，不影响旧读取方）
    coordination_mode: 'relay',
    observed_max_concurrency: 1,
    main_write_max_concurrency: 1,
    wall_clock_elapsed_ms: Date.now() - wallStart,
    sum_agent_elapsed_ms: stages.reduce((n, s) => n + (s.elapsedMs ?? 0), 0),
  }
}

// ---------------------------------------------------------------- planned（DAG）

/**
 * 显式 execution plan 驱动的 DAG 编排（Audit §6 核心 API）。
 * opts: graph, task, workspace, provider, plan, sessionDirBase, artifactDirBase,
 *       worktreeDirBase, maxTurnsPerAgent, maxParallelAgents, maxNodeAttempts,
 *       maxNodeTimeoutMs, repairLoops, repairAgentId, taskId, onEvent, signal
 */
export async function runPlannedTask({
  graph,
  task,
  workspace,
  provider,
  plan,
  sessionDirBase = null,
  artifactDirBase = null,
  worktreeDirBase = null,
  maxTurnsPerAgent = 30,
  maxParallelAgents = null,
  maxNodeAttempts = 1,
  maxNodeTimeoutMs = 0,
  repairLoops = 0,
  repairAgentId = null,
  taskId = null,
  onEvent = () => {},
  signal = null,
}) {
  const validated = validatePlan(plan, graph)
  if (maxParallelAgents && Number.isInteger(maxParallelAgents) && maxParallelAgents >= 1) {
    validated.maxParallelAgents = maxParallelAgents
  }
  if (repairAgentId == null && graph.agents.length) repairAgentId = graph.agents[0].agentId

  // 默认输出根目录（允许调用方只传 workspace，测试/run-mab 一般显式传）
  // 一律 path.resolve：相对 outDir 会把 worktree/artifact 路径解析进 main 仓库内（嵌套 worktree bug）
  const rootOut = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'out'))
  const artBase = path.resolve(artifactDirBase ?? path.join(rootOut, 'artifacts', String(taskId ?? 'task')))
  const wtBase = path.resolve(worktreeDirBase ?? path.join(rootOut, 'worktrees', String(taskId ?? 'task')))
  const sesBase = path.resolve(sessionDirBase ?? path.join(rootOut, 'sessions', String(taskId ?? 'task')))

  if (!(await isGitRepo(workspace))) await initGitRepo(workspace)

  const planId = validated.id
  const coordinationMode = coordinationModeFor(validated)
  const state = new Map(validated.nodes.map(n => [n.id, 'pending']))
  const limiter = createLimiter(validated.maxParallelAgents)
  const mainTracker = createMainWriterTracker()
  const observer = createConcurrencyObserver()
  const bus = new MessageBus()
  // 团队通信信道（Lead↔Worker / Worker↔Worker）：所有 node 的 agent 通过
  // postTeamMessage / getTeamMessages 读写；节点开始时注入快照，运行中可实时轮询。
  const teamChannel = {
    seq: 0,
    messages: [],
    reads: [],
    post(from, to, message) {
      const m = { seq: ++this.seq, ts: new Date().toISOString(), from, to: to ?? null, message: String(message).slice(0, 1200) }
      this.messages.push(m)
      emit({ event: 'team_message', plan_id: planId, node_id: from, to: m.to, seq: m.seq, message: m.message.slice(0, 240) })
      bus.post({ from, to: m.to ?? 'team', stageId: 'team', kind: 'team_message', summary: m.message.slice(0, 120) })
      return m
    },
    feed(agentId) {
      this.reads.push({ agent: agentId, ts: new Date().toISOString() })
      const others = this.messages.filter(m => m.from !== agentId).slice(-40)
      if (!others.length) return 'No team messages from teammates yet. Post one via postTeamMessage when you have contract or status updates.'
      return others
        .map(m => `[#${m.seq} ${m.to ? `${m.from} -> ${m.to}` : `${m.from} -> all`}] ${m.message}`)
        .join('\n')
    },
    snapshot(agentId) {
      const others = this.messages.filter(m => m.from !== agentId).slice(-30)
      if (!others.length) return '(no teammate messages yet)'
      return others.map(m => `- [#${m.seq}] ${m.from} ${m.to ? `-> ${m.to}` : '-> all'}: ${m.message}`).join('\n')
    },
  }
  const lifecycle = []
  const nodeResults = new Map()
  const cleanupFailures = []
  const activeNodes = new Set()
  const repairedNodes = new Set()
  const startMs = Date.now()
  let baselineCommit = null
  let runStatus = 'succeeded'
  let repairRound = 0

  const emit = (ev) => {
    const entry = { ts: new Date().toISOString(), ...ev, ...(taskId != null ? { task_id: taskId } : {}) }
    lifecycle.push(entry)
    onEvent(entry)
  }

  const resultOf = id => nodeResults.get(id)

  /** 为被取消/未运行的 node 物化确定状态记录（trace 证据，Audit §3 不变量 5）。 */
  function materializeCancelled(node, reason) {
    state.set(node.id, 'cancelled')
    if (!nodeResults.has(node.id)) {
      nodeResults.set(node.id, {
        node_id: node.id,
        agent_id: node.agentId,
        kind: node.kind,
        status: 'cancelled',
        started_at: null,
        ended_at: new Date().toISOString(),
        elapsed_ms: 0,
        attempts: 0,
        depends_on: [...(node.dependsOn ?? [])],
        workspace_mode: node.workspaceMode,
        base_revision: null,
        artifact_paths: [],
        patch_sha256: null,
        test_commands: [],
        test_exit_codes: [],
        failure_reason: reason,
        cleanup: null,
        trace_index: nodeResults.size,
      })
    }
    emit({ event: 'node_cancelled', plan_id: planId, node_id: node.id, reason })
  }

  // ------------------------------------------------------------ 机械集成

  /**
   * 集成次序（Audit §7）：按 nodeId 字典序消费依赖 patch artifact；
   * base_revision 不匹配 => stale_patch 拒绝；git apply --check 先行；
   * 每个 patch 后轻量语法检查；冲突绝不采用 last-writer-wins。
   */
  async function mechanicalIntegrate(node, integrateBase) {
    const deps = (node.dependsOn ?? [])
    const patchNodes = deps
      .map(id => validated.byId.get(id))
      .filter(n => n && n.kind === 'patch' && resultOf(n.id)?.status === 'succeeded')
      .sort((a, b) => a.id.localeCompare(b.id))
    const conflicts = []
    const stalePatches = []
    const appliedPatches = []
    for (const pn of patchNodes) {
      const patchDir = path.join(artBase, pn.id)
      const patchJsonPath = path.join(patchDir, 'patch.json')
      const diffPath = path.join(patchDir, 'patch.diff')
      if (!fs.existsSync(patchJsonPath) || !fs.existsSync(diffPath)) {
        conflicts.push({ nodeId: pn.id, reason: 'patch artifacts missing' })
        continue
      }
      let pj
      try {
        pj = JSON.parse(fs.readFileSync(patchJsonPath, 'utf8'))
      } catch {
        conflicts.push({ nodeId: pn.id, reason: 'patch.json unparsable' })
        continue
      }
      if (pj.base_revision !== integrateBase) {
        stalePatches.push({ nodeId: pn.id, reason: `patch base ${pj.base_revision} != main ${integrateBase}` })
        continue
      }
      const applied = await applyPatch({ dir: workspace, patchPath: diffPath, baseRevision: pj.base_revision, expectedBaseRevision: integrateBase })
      if (!applied.ok) {
        conflicts.push({ nodeId: pn.id, reason: applied.reason, detail: applied.detail })
        continue
      }
      const files = Array.isArray(pj.files) ? pj.files : []
      const syntaxIssues = await lightSyntaxCheck(workspace, files)
      if (syntaxIssues.length) {
        conflicts.push({ nodeId: pn.id, reason: 'syntax_check_failed', detail: syntaxIssues[0].detail })
        await hardResetToHead(workspace)
        emit({ event: 'node_apply_status', plan_id: planId, node_id: pn.id, status: 'reset_after_syntax_failure' })
        return { integrateBase, appliedPatches: [], conflicts, stalePatches, syntaxReset: true }
      }
      appliedPatches.push(pn.id)
      emit({ event: 'node_apply_status', plan_id: planId, node_id: pn.id, status: 'applied', base_revision: integrateBase })
    }
    return { integrateBase, appliedPatches, conflicts, stalePatches, syntaxReset: false }
  }

  // ------------------------------------------------------------ node context

  function buildNodeContext(node, integrationMeta = null, checkoutBase = null) {
    const parts = [`# Team objective\n${task}`]
    if (checkoutBase) parts.push(`\n## Your workspace base\nCheckout base SHA (use this exact value as "base_revision" in your JSON deliverable if required): ${checkoutBase}`)
    const topo = topologicalOrder(validated)
    const deps = topo.filter(id => (node.dependsOn ?? []).includes(id))
    for (const depId of deps) {
      const depNode = validated.byId.get(depId)
      const res = resultOf(depId)
      if (!res || res.status !== 'succeeded') continue
      parts.push(`\n## Verified artifact from node ${depId} (kind=${depNode.kind}, agent=${depNode.agentId})`)
      try {
        parts.push(summarizeNodeArtifacts({
          nodeId: depId, kind: depNode.kind,
          artifactDir: path.join(artBase, depId),
          baseRevision: res.base_revision,
        }))
      } catch (error) {
        parts.push(`  <artifact summary unavailable: ${error.message}>`)
      }
      if (res.test_exit_codes?.length) {
        parts.push(`  test commands: ${JSON.stringify(res.test_commands ?? [])}`)
        parts.push(`  test exit codes: ${JSON.stringify(res.test_exit_codes)}`)
      }
    }
    if (node.kind === 'integrate' && integrationMeta) {
      parts.push('\n## Mechanical integration status')
      parts.push(`base=${integrationMeta.integrateBase ?? '(none)'}; applied=${integrationMeta.appliedPatches.join(', ') || '(none)'}`)
      parts.push(`conflicts=${integrationMeta.conflicts.length ? integrationMeta.conflicts.map(c => `${c.nodeId}:${c.reason}`).join('; ') : '(none)'}`)
      parts.push(`stale_patches=${integrationMeta.stalePatches.length ? integrationMeta.stalePatches.map(s => `${s.nodeId}:${s.reason}`).join('; ') : '(none)'}`)
    }
    // 团队通信：节点开始前的队友消息快照（运行中可用 getTeamMessages 实时轮询）
    parts.push(`\n## Team messages so far\n${teamChannel.snapshot(node.agentId)}`)
    return parts.join('\n')
  }

  // ------------------------------------------------------------ artifact 落盘

  async function writeNodeArtifacts({ node, runResult, nodeBase, execWorkdir, integrationMeta }) {
    const artifactDir = path.join(artBase, node.id)
    const artifactPaths = []
    let patchSha256 = null
    let testCommands = []
    let testExitCodes = []

    if (node.kind === 'lead') {
      const obj = extractStructuredArtifact(runResult.finalText)
      if (!obj) return { ok: false, error: 'missing artifact lead.json (no JSON block in finalText)', artifactPaths: [] }
      obj.node_id = node.id
      obj.agent_id = node.agentId
      const errs = validateArtifactObject('lead', obj)
      if (errs.length) return { ok: false, error: `lead.json invalid: ${errs.join('; ')}`, artifactPaths: [] }
      atomicWriteJson(artifactDir, 'lead.json', obj)
      artifactPaths.push(path.join(artifactDir, 'lead.json'))
    } else if (node.kind === 'implement') {
      const changedFiles = await diffNameOnly({ dir: execWorkdir, baseRevision: nodeBase })
      const commands = extractCommandsFromTranscript(runResult.transcript)
      const impl = {
        node_id: node.id,
        agent_id: node.agentId,
        base_revision: nodeBase,
        changed_files: changedFiles,
        commands,
        results: (runResult.finalText || '').slice(0, 3000),
        termination: runResult.termination,
        turns: runResult.turns,
      }
      const errs = validateArtifactObject('implement', impl)
      if (errs.length) return { ok: false, error: `implementation.json invalid: ${errs.join('; ')}`, artifactPaths: [] }
      atomicWriteJson(artifactDir, 'implementation.json', impl)
      artifactPaths.push(path.join(artifactDir, 'implementation.json'))
    } else if (node.kind === 'patch') {
      const diff = await collectPatch({ dir: execWorkdir, baseRevision: nodeBase })
      fs.mkdirSync(artifactDir, { recursive: true })
      const diffPath = path.join(artifactDir, 'patch.diff')
      fs.writeFileSync(diffPath, diff.diff)
      const agentObj = extractStructuredArtifact(runResult.finalText)
      if (!agentObj) {
        return { ok: false, error: 'missing artifact patch.json (no JSON block in finalText)', artifactPaths: [diffPath] }
      }
      const computedSha = diff.sha256
      const patchJson = {
        node_id: node.id,
        agent_id: node.agentId,
        base_revision: nodeBase,
        files: await diffNameOnly({ dir: execWorkdir, baseRevision: nodeBase }),
        test_commands: Array.isArray(agentObj.test_commands) ? agentObj.test_commands : [],
        summary: typeof agentObj.summary === 'string' ? agentObj.summary : '',
        patch_sha256: computedSha,
      }
      if (agentObj.base_revision && agentObj.base_revision !== nodeBase) {
        return { ok: false, error: `patch.json base_revision ${agentObj.base_revision} != recorded ${nodeBase}`, artifactPaths: [diffPath] }
      }
      const errs = validateArtifactObject('patch', patchJson)
      if (errs.length) return { ok: false, error: `patch.json invalid: ${errs.join('; ')}`, artifactPaths: [diffPath] }
      atomicWriteJson(artifactDir, 'patch.json', patchJson)
      artifactPaths.push(diffPath, path.join(artifactDir, 'patch.json'))
      patchSha256 = computedSha
      testCommands = patchJson.test_commands
      // 快速验证（worker 自己的隔离 worktree）
      if (testCommands.length) {
        testExitCodes = []
        for (const cmd of testCommands) {
          const r = await runTestCommand({ dir: execWorkdir, command: cmd, timeoutMs: 120_000, signal })
          testExitCodes.push(r.exit_code)
          emit({ event: 'node_test', plan_id: planId, node_id: node.id, command: cmd, exit_code: r.exit_code, timed_out: r.timed_out })
        }
      }
    } else if (node.kind === 'review') {
      const obj = extractStructuredArtifact(runResult.finalText)
      if (!obj) return { ok: false, error: 'missing artifact review.json (no JSON block in finalText)', artifactPaths: [] }
      obj.node_id = node.id
      obj.agent_id = node.agentId
      const errs = validateArtifactObject('review', obj)
      if (errs.length) return { ok: false, error: `review.json invalid: ${errs.join('; ')}`, artifactPaths: [] }
      atomicWriteJson(artifactDir, 'review.json', obj)
      artifactPaths.push(path.join(artifactDir, 'review.json'))
    } else if (node.kind === 'test_review') {
      const obj = extractStructuredArtifact(runResult.finalText)
      if (!obj) return { ok: false, error: 'missing artifact test-plan.json (no JSON block in finalText)', artifactPaths: [] }
      obj.node_id = node.id
      obj.agent_id = node.agentId
      const errs = validateArtifactObject('test_plan', obj)
      if (errs.length) return { ok: false, error: `test-plan.json invalid: ${errs.join('; ')}`, artifactPaths: [] }
      atomicWriteJson(artifactDir, 'test-plan.json', obj)
      artifactPaths.push(path.join(artifactDir, 'test-plan.json'))
      testCommands = Array.isArray(obj.commands) ? obj.commands : []
    } else if (node.kind === 'integrate') {
      const obj = extractStructuredArtifact(runResult.finalText)
      if (!obj) return { ok: false, error: 'missing artifact integration.json (no JSON block in finalText)', artifactPaths: [] }
      obj.node_id = node.id
      obj.agent_id = node.agentId
      obj.base_revision = obj.base_revision ?? integrationMeta?.integrateBase ?? nodeBase
      obj.applied_patches = integrationMeta?.appliedPatches ?? []
      obj.conflicts = integrationMeta?.conflicts ?? []
      obj.stale_patches = integrationMeta?.stalePatches ?? []
      const errs = validateArtifactObject('integration', obj)
      if (errs.length) return { ok: false, error: `integration.json invalid: ${errs.join('; ')}`, artifactPaths: [] }
      atomicWriteJson(artifactDir, 'integration.json', obj)
      artifactPaths.push(path.join(artifactDir, 'integration.json'))
      testCommands = Array.isArray(obj.test_commands) ? obj.test_commands : []
    } else if (node.kind === 'verify') {
      const obj = extractStructuredArtifact(runResult.finalText)
      if (!obj) return { ok: false, error: 'missing artifact verification.json (no JSON block in finalText)', artifactPaths: [] }
      obj.node_id = node.id
      obj.agent_id = node.agentId
      obj.base_revision = obj.base_revision ?? nodeBase
      const errs = validateArtifactObject('verification', obj)
      if (errs.length) return { ok: false, error: `verification.json invalid: ${errs.join('; ')}`, artifactPaths: [] }
      atomicWriteJson(artifactDir, 'verification.json', obj)
      artifactPaths.push(path.join(artifactDir, 'verification.json'))
      testCommands = Array.isArray(obj.commands) ? obj.commands : []
    }
    return { ok: true, artifactPaths, patchSha256, testCommands, testExitCodes, artifactDir }
  }

  // ------------------------------------------------------------ 单 node 执行

  async function runNode(node, { traceIndex = nodeResults.size, batchHead = null, batchHadMainWriter = false } = {}) {
    const nodeId = node.id
    const startedAt = new Date().toISOString()
    const startedMs = Date.now()
    let releaseMain = null
    let worktree = null
    let nodeBase = null
    let attempt = 0
    let lastError = null

    state.set(nodeId, 'running')
    activeNodes.add(nodeId)
    emit({
      event: 'node_started', plan_id: planId, node_id: nodeId,
      agent_id: node.agentId, attempt: 1, workspace_mode: node.workspaceMode,
      workspace_ref: `base:${nodeBase ?? '(pending)'}`,
      active_nodes: [...activeNodes],
    })

    const nodeResult = {
      node_id: nodeId,
      agent_id: node.agentId,
      kind: node.kind,
      status: 'running',
      started_at: startedAt,
      ended_at: null,
      elapsed_ms: null,
      attempts: 0,
      depends_on: [...(node.dependsOn ?? [])],
      workspace_mode: node.workspaceMode,
      base_revision: null,
      artifact_paths: [],
      patch_sha256: null,
      test_commands: [],
      test_exit_codes: [],
      failure_reason: null,
      cleanup: null,
      trace_index: traceIndex,
    }
    nodeResults.set(nodeId, nodeResult)

    const finish = (status, extra = {}) => {
      const endedAt = new Date().toISOString()
      nodeResult.status = status
      nodeResult.ended_at = endedAt
      nodeResult.elapsed_ms = Date.now() - startedMs
      nodeResult.attempts = attempt
      Object.assign(nodeResult, extra)
      state.set(nodeId, status)
      if (status === 'succeeded') {
        bus.post({
          from: nodeId, to: (node.dependsOn ?? []).join(',') || null,
          stageId: node.kind, kind: 'artifact_ready',
          artifact: nodeResult.artifact_paths.map(p => path.basename(path.dirname(p)) + '/' + path.basename(p)).join(','),
          sha256: nodeResult.patch_sha256,
          summary: `${node.kind} artifact of ${nodeId} (base=${nodeResult.base_revision ?? '-'})`,
        })
        emit({ event: 'node_completed', plan_id: planId, node_id: nodeId, status, elapsed_ms: nodeResult.elapsed_ms, attempts: attempt, artifact_paths: nodeResult.artifact_paths, patch_sha256: nodeResult.patch_sha256, test_exit_codes: nodeResult.test_exit_codes })
      } else {
        emit({ event: 'node_failed', plan_id: planId, node_id: nodeId, status, failure_reason: nodeResult.failure_reason, attempts: attempt, elapsed_ms: nodeResult.elapsed_ms })
      }
      return nodeResult
    }

    try {
      // main writer mutex：容量 1（runtime assertion，validator 之外的第二道防线）
      if (node.workspaceMode === 'main') {
        releaseMain = mainTracker.enter(nodeId)
      }

      // 工作区准备（batchHead 由调度循环批量计算一次，避免每 node 一次 git spawn）
      let execWorkdir = workspace
      if (node.workspaceMode === 'isolated') {
        if (!worktreeDirBase) throw new PlanExecutionError(`isolated node ${nodeId} requires worktreeDirBase`)
        try {
          if (!batchHead) throw new Error('main has no HEAD to fork worktree from')
          worktree = await worktreeAdd({ mainRepo: workspace, worktreePath: path.join(wtBase, nodeId), baseRevision: batchHead })
          execWorkdir = worktree.path
          nodeBase = worktree.baseRevision
        } catch (error) {
          nodeResult.failure_reason = `worktree_create_failed: ${error.message}${error.stderr ? ' :: ' + String(error.stderr).slice(0, 300) : ''}`
          finish('failed')
          return nodeResult
        }
      } else {
        nodeBase = batchHead
        nodeResult.base_revision = nodeBase
      }

      // integrate 的机械集成（agent 之前）
      let integrationMeta = null
      if (node.kind === 'integrate') {
        integrationMeta = await mechanicalIntegrate(node, batchHead)
        nodeResult.base_revision = integrationMeta.integrateBase
        nodeBase = integrationMeta.integrateBase
        nodeResult.test_commands = []
      }

      const context = buildNodeContext(node, integrationMeta, nodeBase)
      const sessionDir = path.join(sesBase, nodeId)
      const agent = graph.byId(node.agentId)
      if (!agent) throw new PlanExecutionError(`agent ${node.agentId} not in graph`)
      const agentInst = new AgentInstance({
        agentId: node.agentId,
        type: agent.type,
        profile: agent.profile,
        workspace: execWorkdir,
        model: agent.model,
        maxTurns: agent.maxTurns ?? maxTurnsPerAgent,
        provider,
        team: teamChannel,
      })
      const nodeMeta = {
        nodeId, kind: node.kind, workspaceMode: node.workspaceMode,
        workspace: execWorkdir, baseRevision: nodeBase,
      }

      // 调用 agent（带退避重试 / 超时 / 取消传播 / 一次 artifact 合规重试）
      // 结构化 artifact 节点（review/test_review/patch/integrate/verify）要求模型
      // 在 finalText 末尾输出 JSON 块；缺失时用强化指令打回一次再跑。契约不放宽：
      // 仍不合格则确定性失败（missing artifact）。
      let runResult = null
      let artifactNudge = ''
      const complianceBudget = node.kind === 'implement' ? 0 : 1
      let complianceRetriesLeft = complianceBudget
      const effectiveMaxAttempts = maxNodeAttempts >= 1 ? maxNodeAttempts : 1
      const maxIterations = effectiveMaxAttempts + complianceBudget // 瞬态重试 + 至多 1 次合规重试
      for (attempt = 1; attempt <= maxIterations; attempt++) {
        nodeResult.attempts = attempt
        try {
          runResult = await runWithTimeout(
            agentInst.run({ task, context, sessionDir, signal, nodeMeta, artifactNudge }),
            maxNodeTimeoutMs,
            nodeId,
          )
        } catch (error) {
          lastError = error
          runResult = null
        }
        if (!runResult) {
          if (signal?.aborted) break
          if (isTransientError(lastError) && attempt < effectiveMaxAttempts) {
            const waitedMs = retryDelayMs(attempt)
            emit({ event: 'node_retry', plan_id: planId, node_id: nodeId, attempt, waited_ms: waitedMs, reason: lastError?.message ?? '' })
            await sleep(waitedMs)
            continue
          }
          break
        }
        if (signal?.aborted) break
        // artifact 合规重试（独立于瞬态错误重试预算）
        if (complianceRetriesLeft > 0 && extractStructuredArtifact(runResult.finalText) == null) {
          complianceRetriesLeft--
          artifactNudge = 'Correction from coordinator: your previous final message did NOT end with the required single JSON deliverable. ' +
            `Your NEW final message must end with exactly ONE JSON code block containing "node_id": "${nodeId}", "agent_id": "${node.agentId}", ` +
            'and the required structured fields for your node kind. Do not emit the JSON anywhere else, and do not include a second JSON block.'
          emit({ event: 'node_retry', plan_id: planId, node_id: nodeId, attempt, waited_ms: 0, reason: 'artifact_compliance: missing JSON deliverable' })
          continue
        }
        break
      }

      if (!runResult) {
        if (signal?.aborted) {
          nodeResult.failure_reason = 'cancelled'
          finish('cancelled')
        } else {
          nodeResult.failure_reason = `agent failed after ${attempt} attempt(s): ${lastError?.message ?? 'unknown'}`
          if (lastError?.name === 'NodeTimeoutError') nodeResult.failure_reason = `node_timeout: ${lastError.message}`
          finish('failed')
        }
        return nodeResult
      }
      if (signal?.aborted) {
        nodeResult.failure_reason = 'cancelled (signal aborted during run)'
        finish('cancelled')
        return nodeResult
      }

      // 落盘 artifact（写入 -> schema 校验 -> 结束事件）
      const written = await writeNodeArtifacts({ node, runResult, nodeBase, execWorkdir, integrationMeta })
      if (!written.ok) {
        nodeResult.failure_reason = `artifact_error: ${written.error}`
        nodeResult.artifact_paths = written.artifactPaths
        emit({ event: 'node_artifact_error', plan_id: planId, node_id: nodeId, reason: written.error })
        finish('failed')
        return nodeResult
      }
      nodeResult.artifact_paths = written.artifactPaths
      nodeResult.patch_sha256 = written.patchSha256
      nodeResult.test_commands = written.testCommands
      nodeResult.test_exit_codes = written.testExitCodes

      // 目录级契约校验（§5：schema / 哈希 / 路径越界 / base SHA）
      const dirCheck = validateNodeArtifacts({
        kind: node.kind,
        artifactDir: written.artifactDir,
        recordedBaseRevision: nodeBase,
        workspaceRoot: execWorkdir,
      })
      if (!dirCheck.ok) {
        nodeResult.failure_reason = `artifact_invalid: ${dirCheck.errors.join('; ')}`
        emit({ event: 'node_artifact_error', plan_id: planId, node_id: nodeId, reason: nodeResult.failure_reason })
        finish('failed')
        return nodeResult
      }

      // 测试命令（仅 integrate/verify 在 main 中执行；patch 已在自身 worktree 快速验证）
      if (written.testCommands.length && (node.kind === 'integrate' || node.kind === 'verify')) {
        const codes = []
        for (const cmd of written.testCommands) {
          const r = await runTestCommand({ dir: workspace, command: cmd, timeoutMs: 120_000, signal })
          codes.push(r.exit_code)
          emit({ event: 'node_test', plan_id: planId, node_id: nodeId, command: cmd, exit_code: r.exit_code, timed_out: r.timed_out })
        }
        nodeResult.test_commands = written.testCommands
        nodeResult.test_exit_codes = codes
      }
      if (node.kind === 'patch') {
        // 快速层：patch 自己的 worktree 内测试失败 => node 失败（保留命令与输出证据）
        if (written.testExitCodes.length && written.testExitCodes.some(c => c !== 0)) {
          nodeResult.failure_reason = `patch_tests_failed: exit codes ${JSON.stringify(written.testExitCodes)}`
          finish('failed')
          return nodeResult
        }
      }

      // main 写者提交（可复现 commit；baseline 记录）
      if (node.workspaceMode === 'main') {
        const label = node.kind === 'integrate' ? 'integrate' : node.kind === 'lead' ? 'lead' : 'implement'
        const c = await commitAll(workspace, `mycc: ${label} ${nodeId} (${node.agentId})`)
        nodeResult.commit = c.sha
        if (node.kind === 'integrate') nodeResult.integration_commit = c.sha
        if ((node.kind === 'implement' || node.kind === 'lead') && (node.dependsOn ?? []).length === 0) {
          baselineCommit = baselineCommit ?? c.sha
        }
      }

      // 语义判定：integrate/verify 的结果状态
      if (node.kind === 'integrate') {
        const hasConflict = (integrationMeta?.syntaxReset) ||
          (integrationMeta?.conflicts?.length > 0) ||
          (integrationMeta?.stalePatches?.length > 0)
        const testsFail = nodeResult.test_exit_codes.some(c => c !== 0)
        nodeResult.conflicts = integrationMeta?.conflicts ?? []
        nodeResult.stale_patches = integrationMeta?.stalePatches ?? []
        nodeResult.applied_patches = integrationMeta?.appliedPatches ?? []
        if (integrationMeta?.syntaxReset) {
          nodeResult.failure_reason = 'integration_conflict: patch failed syntax check, main reset to base'
          finish('failed')
          return nodeResult
        }
        if (testsFail) {
          nodeResult.failure_reason = `integration_tests_failed: exit codes ${JSON.stringify(nodeResult.test_exit_codes)}`
          finish('failed')
          return nodeResult
        }
        nodeResult.integration_conflict = hasConflict
      } else if (node.kind === 'verify') {
        if (nodeResult.test_exit_codes.length && nodeResult.test_exit_codes.some(c => c !== 0)) {
          nodeResult.failure_reason = `verification_failed: exit codes ${JSON.stringify(nodeResult.test_exit_codes)}`
          finish('failed')
          return nodeResult
        }
      }

      // agent 元数据（完整 transcript 只留在 trace）
      nodeResult.agent = {
        finalText: runResult.finalText,
        turns: runResult.turns,
        termination: runResult.termination,
        model: runResult.model,
        transcript: runResult.transcript,
      }

      finish('succeeded')
      return nodeResult
    } catch (error) {
      nodeResult.failure_reason = `node_error: ${error.message}`
      if (error instanceof ConcurrencyViolation) {
        emit({ event: 'node_failed', plan_id: planId, node_id: nodeId, status: 'failed', failure_reason: 'parallel main writer (runtime assertion)' })
      }
      finish('failed')
      return nodeResult
    } finally {
      activeNodes.delete(nodeId)
      if (worktree) {
        const res = await cleanupOps.remove({ mainRepo: workspace, worktreePath: worktree.path })
        if (res.ok) {
          nodeResult.cleanup = { status: 'ok' }
          emit({ event: 'node_cleanup_ok', plan_id: planId, node_id: nodeId })
        } else {
          // 保留路径与证据，绝不静默删除（Audit §3 不变量 5 / §5 cleanup 失败留痕）
          nodeResult.cleanup = { status: 'failed', reason: res.reason, path: worktree.path }
          cleanupFailures.push({ node_id: nodeId, reason: res.reason, path: worktree.path })
          emit({ event: 'node_cleanup_failed', plan_id: planId, node_id: nodeId, reason: res.reason, path: worktree.path })
        }
      }
      if (releaseMain) releaseMain()
    }
  }

  // ------------------------------------------------------------ 调度循环

  try {
    while (hasPending(validated, state)) {
      if (signal?.aborted) {
        runStatus = 'cancelled'
        break
      }
      const ready = computeReadySet(validated, state)
      if (ready.length === 0) {
        const pending = validated.nodes.filter(n => state.get(n.id) === 'pending').map(n => n.id)
        throw new PlanExecutionError('no ready node but plan has pending nodes (invalid dependency graph)', { pending })
      }
      const mains = ready.filter(n => n.workspaceMode === 'main')
      if (mains.length > 1) {
        throw new PlanExecutionError(`parallel main writers in one ready set: ${mains.map(n => n.id).join(', ')}`)
      }
      // 每批只取一次 main HEAD（并发节点共享同一基线，避免每 node 一次 git spawn）；
      // read_only 违规检测在本批有 main writer 时跳过（共享写入窗口，非误报）
      const batchHead = await headSha(workspace)
      const batchHadMainWriter = mains.length > 0
      const results = await Promise.all(
        ready.map(node => limiter.run(() => observer.track(() => runNode(node, { batchHead, batchHadMainWriter }))))
      )

      // read_only 违规检测（批级、node 关键路径之外）：单次 git status 检查。
      // 本批无 main writer 时，main 的唯一可能写者就是本批 read_only 节点，
      // 因此对所有 review/test_review 节点确定性归因（fail-safe，不放过违规）。
      // 放批级保证节点耗时贴近纯 agent 耗时（Audit §9 Phase 2 的 <260ms 观测）。
      const roNodes = ready.filter(n => n.workspaceMode === 'read_only' && (n.kind === 'review' || n.kind === 'test_review'))
      if (roNodes.length && !batchHadMainWriter) {
        const porcelain = await gitStatusPorcelain(workspace)
        const trackedChanged = porcelain.some(line => !line.startsWith('??'))
        if (trackedChanged) {
          for (const n of roNodes) {
            const nr = nodeResults.get(n.id)
            if (nr && nr.status === 'succeeded') {
              nr.status = 'failed'
              nr.failure_reason = 'read_only_violation: workspace tracked files changed by a read-only node'
              state.set(n.id, 'failed')
              emit({ event: 'node_readonly_violation', plan_id: planId, node_id: n.id })
              emit({ event: 'node_failed', plan_id: planId, node_id: n.id, status: 'failed', failure_reason: nr.failure_reason })
            }
          }
        }
      }

      // 修复回路（Audit §9 Phase 4）优先于 fail-fast：verifier 失败 -> 有上限的
      // patch -> integrate -> verify，而不是直接取消全部
      let repairScheduled = false
      for (const r of results) {
        if (r?.kind === 'verify' && r.status === 'failed' && !repairedNodes.has(r.node_id) && repairLoops > 0 && repairRound < repairLoops) {
          repairRound++
          const rid = {
            patch: `repair-${repairRound}-patch`,
            integrate: `repair-${repairRound}-integrate`,
            verify: `repair-${repairRound}-verify`,
          }
          validated.nodes.push(
            { id: rid.patch, agentId: repairAgentId, kind: 'patch', dependsOn: [r.node_id], workspaceMode: 'isolated', outputs: ['patch.json', 'patch.diff'] },
            { id: rid.integrate, agentId: repairAgentId, kind: 'integrate', dependsOn: [r.node_id, rid.patch], workspaceMode: 'main', outputs: ['integration.json'] },
            { id: rid.verify, agentId: repairAgentId, kind: 'verify', dependsOn: [rid.integrate], workspaceMode: 'read_only', outputs: ['verification.json'] },
          )
          for (const rn of validated.nodes.slice(-3)) validated.byId.set(rn.id, rn)
          for (const nid of Object.values(rid)) state.set(nid, 'pending')
          repairedNodes.add(r.node_id)
          state.set(r.node_id, 'repaired')
          repairScheduled = true
          emit({ event: 'repair_scheduled', plan_id: planId, round: repairRound, depends_on: r.node_id, nodes: Object.values(rid) })
        }
      }

      // 失败节点默认阻塞后继；continueOnFailure 只允许显式诊断 node（Audit §6）
      if (!repairScheduled) {
        for (const r of results) {
          if (r?.status === 'failed' && validated.byId.get(r.node_id)?.continueOnFailure) {
            state.set(r.node_id, 'repaired')
          }
        }
        const failed = results.find(r => r && (r.status === 'failed' || r.status === 'cancelled') &&
          !validated.byId.get(r.node_id)?.continueOnFailure)
        if (failed && validated.failFast !== false) {
          const aborted = signal?.aborted || failed.status === 'cancelled'
          for (const n of validated.nodes) {
            if (state.get(n.id) === 'pending') {
              state.set(n.id, 'cancelled')
              materializeCancelled(n, aborted
                ? 'cancelled (signal aborted)'
                : `fail-fast after ${failed.node_id} (${failed.failure_reason ?? 'unknown'})`)
            }
          }
          runStatus = aborted ? 'cancelled' : 'failed'
          break
        }
      }
    }

    if (signal?.aborted) {
      for (const n of validated.nodes) {
        if (state.get(n.id) === 'pending') {
          materializeCancelled(n, 'cancelled (signal aborted)')
        }
      }
    }

    await limiter.drain()
  } finally {
    // 取消后等待 in-flight cleanup（Audit §6 资源规则）
    await limiter.drain()
  }

  // ------------------------------------------------------------ 汇总

  const wallClockMs = Date.now() - startMs
  const sumAgentMs = [...nodeResults.values()].reduce((n, r) => n + (r.elapsed_ms ?? 0), 0)
  const topo = topologicalOrder(validated)
  const lastSucceeded = [...topo].reverse().map(id => nodeResults.get(id)).find(r => r && r.status === 'succeeded')
  const finalText = lastSucceeded?.agent?.finalText ?? ''
  let diff = ''
  try {
    if ((await isGitRepo(workspace)) && baselineCommit) {
      diff = (await collectPatch({ dir: workspace, baseRevision: baselineCommit })).diff
    }
  } catch { /* diff 非关键 */ }

  const integrates = [...nodeResults.values()].filter(r => r.kind === 'integrate')
  const verifies = [...nodeResults.values()].filter(r => r.kind === 'verify')
  let integrationStatus = 'not_applicable'
  if (integrates.length || verifies.length) {
    // 以最后一次 repair verify 的成败为准（多轮修复取最新证据）
    const repairVerifies = verifies
      .filter(r => r.node_id.startsWith('repair'))
      .sort((a, b) => (b.trace_index ?? 0) - (a.trace_index ?? 0))
    if (repairVerifies.length) {
      integrationStatus = repairVerifies[0].status === 'succeeded' ? 'passed_after_repair' : 'failed'
    } else if ([...integrates, ...verifies].some(r => r.status === 'failed')) {
      integrationStatus = 'failed'
    } else if (integrates.some(r => r.integration_conflict)) {
      integrationStatus = 'conflict'
    } else {
      integrationStatus = 'passed'
    }
  }

  return {
    graph,
    plan: validated,
    plan_id: planId,
    coordination_mode: coordinationMode,
    status: runStatus,
    nodes: [...nodeResults.values()],
    lifecycle,
    messages: bus.serialize(),
    messageList: bus.messages,
    finalText,
    diff,
    observed_max_concurrency: observer.observedMax,
    wall_clock_elapsed_ms: wallClockMs,
    sum_agent_elapsed_ms: sumAgentMs,
    team_messages: teamChannel.messages,
    team_message_count: teamChannel.messages.length,
    team_read_count: teamChannel.reads.length,
    main_write_max_concurrency: mainTracker.maxConcurrent,
    integration_status: integrationStatus,
    baseline_commit: baselineCommit,
    cleanup_failures: cleanupFailures,
  }
}

/** node 级超时（Audit §9 Phase 4）；超时抛 NodeTimeoutError。 */
function runWithTimeout(promise, timeoutMs, nodeId) {
  if (!timeoutMs || timeoutMs <= 0) return promise
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(Object.assign(new Error(`node ${nodeId} timeout after ${timeoutMs}ms`), { name: 'NodeTimeoutError' }))
      }, timeoutMs)
    }),
  ]).finally(() => clearTimeout(timer))
}