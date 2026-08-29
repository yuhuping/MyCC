// multiagent/lib/execution-plan.mjs
// Execution Plan：plan schema、校验、拓扑排序与 ready set 计算（Audit §4）。
//
// 设计要点：
//   - plan 是可落盘的 JSON，随 trace 保存；拓扑由显式 dependsOn 决定，
//     绝不从自然语言 / relationships（collaborates with）猜测。
//   - Validator 在 provider 调用前 fail-fast；所有非法形态都有确定错误。
//   - 默认（无 --plan 时）生成现有三步 relay plan：agent1(build, main) ->
//     agent2(revise, main) -> agent3(optimize, main)，保持与历史分数可比。
export const PLAN_VERSION = 1

/** 静态校验失败：在 provider 调用前抛出（Audit §4 fail-fast）。 */
export class PlanValidationError extends Error {
  constructor(message, errors = []) {
    super(message)
    this.name = 'PlanValidationError'
    this.errors = Array.isArray(errors) ? errors : [String(errors)]
  }
}

/** 运行时调度失败：无 ready node、并发断言失败等（Audit §6 调度伪代码）。 */
export class PlanExecutionError extends Error {
  constructor(message, detail = null) {
    super(message)
    this.name = 'PlanExecutionError'
    this.detail = detail
  }
}

export const NODE_KINDS = new Set(['lead', 'implement', 'review', 'test_review', 'patch', 'integrate', 'verify'])
export const WORKSPACE_MODES = new Set(['main', 'read_only', 'isolated'])

// kind 允许的 workspaceMode（Audit §5 Node 产物契约）
export const KIND_MODE_RULES = {
  lead: ['main'],
  implement: ['main', 'isolated'],
  review: ['read_only'],
  test_review: ['read_only'],
  patch: ['isolated'],
  integrate: ['main'],
  verify: ['read_only'],
}

// continueOnFailure 只允许显式诊断 node（Audit §6 资源和失败规则）
export const DIAGNOSTIC_KINDS = new Set(['review', 'test_review', 'verify'])

export const NODE_STATES = ['pending', 'running', 'succeeded', 'failed', 'cancelled', 'repaired']

/**
 * 校验 plan。不合法时抛 PlanValidationError（errors 数组给出全部原因），
 * 合法时返回规范化后的 plan（浅拷贝，nodes 带 id 索引）。
 * graph 需有 byId(agentId) 方法（AgentGraph）。
 */
export function validatePlan(plan, graph) {
  const errors = []
  if (!plan || typeof plan !== 'object') {
    throw new PlanValidationError('plan must be an object', ['plan not an object'])
  }
  if (plan.version !== PLAN_VERSION) {
    errors.push(`unsupported plan.version ${JSON.stringify(plan.version)} (expected ${PLAN_VERSION})`)
  }
  if (typeof plan.id !== 'string' || !plan.id.trim()) {
    errors.push('plan.id must be a non-empty string')
  }
  if (!Number.isInteger(plan.maxParallelAgents) || plan.maxParallelAgents < 1) {
    errors.push(`plan.maxParallelAgents must be an integer >= 1 (got ${plan.maxParallelAgents})`)
  }
  const nodes = plan.nodes
  if (!Array.isArray(nodes) || nodes.length === 0) {
    errors.push('plan.nodes must be a non-empty array')
    throw new PlanValidationError('invalid plan', errors)
  }

  const seen = new Set()
  const byId = new Map()
  const modeCount = { main: 0, read_only: 0, isolated: 0 }
  for (const node of nodes) {
    const id = node?.id
    if (typeof id !== 'string' || !id.trim()) {
      errors.push(`node at index ${nodes.indexOf(node)}: id must be a non-empty string`)
      continue
    }
    if (seen.has(id)) errors.push(`duplicate node id "${id}"`)
    seen.add(id)
    byId.set(id, node)

    if (!graph || !graph.byId || !graph.byId(node.agentId)) {
      errors.push(`node ${id}: unknown agentId "${node.agentId}"`)
    }
    if (!NODE_KINDS.has(node.kind)) {
      errors.push(`node ${id}: unknown kind "${node.kind}" (expected one of ${[...NODE_KINDS].join(', ')})`)
    }
    if (!WORKSPACE_MODES.has(node.workspaceMode)) {
      errors.push(`node ${id}: unknown workspaceMode "${node.workspaceMode}" (expected ${[...WORKSPACE_MODES].join(' | ')})`)
    }
    const allowed = KIND_MODE_RULES[node.kind]
    if (allowed && !allowed.includes(node.workspaceMode)) {
      errors.push(`node ${id}: kind "${node.kind}" cannot use workspaceMode "${node.workspaceMode}" (allowed: ${allowed.join(', ')})`)
    }
    if (node.workspaceMode === 'main') modeCount.main++
    if (node.kind === 'patch' && node.workspaceMode !== 'isolated') {
      errors.push(`node ${id}: patch kind must be workspaceMode "isolated"`)
    }
    if (!Array.isArray(node.dependsOn)) {
      errors.push(`node ${id}: dependsOn must be an array`)
    }
    if (node.continueOnFailure && !DIAGNOSTIC_KINDS.has(node.kind)) {
      errors.push(`node ${id}: continueOnFailure is only allowed for diagnostic kinds (${[...DIAGNOSTIC_KINDS].join(', ')})`)
    }
  }

  // dependsOn 引用检查（依赖必须在同 plan 内、不依赖自身）
  for (const node of nodes) {
    const id = node.id
    if (!Array.isArray(node.dependsOn)) continue
    for (const dep of node.dependsOn) {
      if (dep === id) errors.push(`node ${id}: self-loop on dependsOn`)
      else if (!byId.has(dep)) errors.push(`node ${id}: dependsOn references unknown node "${dep}"`)
    }
  }

  // 任意环（拓扑排序会抛出；这里统一收集为错误）
  let topo = null
  try {
    topo = topologicalOrder(plan)
  } catch (error) {
    if (error instanceof PlanValidationError) errors.push(...error.errors)
    else errors.push(`node cycle: ${error.message}`)
  }

  // 同一可并发 ready set 中不允许两个 main writer（Audit §4 Validator 规则）。
  // 判据：任意两个 main 节点，其中一方必须在另一方的前驱链上（可顺序执行），
  // 否则它们可能同时 ready，违反不变量 1。
  const mainNodes = nodes.filter(n => n.workspaceMode === 'main')
  for (let i = 0; i < mainNodes.length; i++) {
    for (let j = i + 1; j < mainNodes.length; j++) {
      const a = mainNodes[i]
      const b = mainNodes[j]
      const aReachesB = reaches(a.id, b.id, byId)
      const bReachesA = reaches(b.id, a.id, byId)
      if (!aReachesB && !bReachesA) {
        errors.push(`nodes "${a.id}" and "${b.id}" are both workspaceMode "main" but neither depends on the other: they could run in the same ready set (parallel main writers forbidden)`)
      }
    }
  }

  // 无环且全部节点可达时检查「存在 pending 但无 ready」的静态形态：
  // 若有节点依赖链不完整（上面已查 unknown）；这里保证至少一个 entry node。
  const hasEntry = topo && nodes.some(n => (n.dependsOn?.length ?? 0) === 0)
  if (topo && !hasEntry) {
    errors.push('plan has no entry node (every node depends on something: unreachable graph)')
  }

  if (errors.length) {
    throw new PlanValidationError(`invalid execution plan "${plan.id || '(no id)'}"`, errors)
  }

  const normalized = {
    ...plan,
    nodes: nodes.map(n => ({ ...n, dependsOn: [...(n.dependsOn ?? [])] })),
  }
  normalized.byId = byId
  return normalized
}

/** a 是否（传递）依赖 b：沿着 dependsOn 反向可达性。 */
function reaches(fromId, targetId, byId) {
  const stack = [fromId]
  const visited = new Set()
  while (stack.length) {
    const cur = stack.pop()
    if (visited.has(cur)) continue
    visited.add(cur)
    const node = byId.get(cur)
    if (!node) continue
    for (const dep of node.dependsOn ?? []) {
      if (dep === targetId) return true
      stack.push(dep)
    }
  }
  return false
}

/**
 * Kahn 拓扑排序；存在环时抛 PlanValidationError。
 * 返回节点 id 的稳定顺序（同层按节点在 plan 中的顺序，保证确定性）。
 */
export function topologicalOrder(plan) {
  const nodes = plan.nodes
  const byId = new Map(nodes.map(n => [n.id, n]))
  const indegree = new Map(nodes.map(n => [n.id, (n.dependsOn ?? []).length]))
  const dependents = new Map(nodes.map(n => [n.id, []]))
  for (const node of nodes) {
    for (const dep of node.dependsOn ?? []) {
      dependents.get(dep)?.push(node.id)
    }
  }
  const queue = nodes.filter(n => (n.dependsOn ?? []).length === 0).map(n => n.id)
  const order = []
  while (queue.length) {
    const id = queue.shift()
    order.push(id)
    for (const child of dependents.get(id) ?? []) {
      const next = (indegree.get(child) ?? 0) - 1
      indegree.set(child, next)
      if (next === 0) queue.push(child)
    }
  }
  if (order.length !== nodes.length) {
    const cyclic = nodes.filter(n => !order.includes(n.id)).map(n => n.id)
    throw new PlanValidationError('execution plan contains a cycle', [`cycle involving nodes: ${cyclic.join(', ')}`])
  }
  return order
}

/** 当前状态下的 ready set：pending 且全部 dependsOn 为 succeeded/repaired。 */
export function computeReadySet(plan, state) {
  return plan.nodes.filter(node =>
    state.get(node.id) === 'pending' &&
    (node.dependsOn ?? []).every(dep => {
      const s = state.get(dep)
      return s === 'succeeded' || s === 'repaired'
    })
  )
}

export function hasPending(plan, state) {
  return plan.nodes.some(n => state.get(n.id) === 'pending')
}

/** 该 plan 是否存在真实并行可能（>1 个节点可同时 ready）。 */
export function isDagPlan(plan) {
  return plan.nodes.some(node =>
    (node.dependsOn ?? []).length === 0 && plan.nodes.filter(n => (n.dependsOn ?? []).length === 0).length > 1
  ) || plan.nodes.some(node =>
    (node.dependsOn ?? []).length > 0 &&
    (node.dependsOn ?? []).some(dep => plan.byId.get(dep)?.workspaceMode !== 'main')
  )
}

/** 简单线性判据：所有 main 节点形成单链、无并行分支 => relay。 */
export function coordinationModeFor(plan) {
  const topo = topologicalOrder(plan) // 已校验过，不再抛
  const mainSeq = plan.nodes.filter(n => n.workspaceMode === 'main').map(n => topo.indexOf(n.id)).sort((a, b) => a - b)
  const fanout = plan.nodes.find(n => (n.dependsOn ?? []).length === 0 &&
    plan.nodes.filter(x => (x.dependsOn ?? []).length === 0).length > 1)
  if (!fanout && mainSeq.length === plan.nodes.length) return 'relay'
  return 'dag'
}

/**
 * 默认三步 relay plan（与 MultiAgentBench 兼容基线，Audit §4）：
 *   agent1(build, main) -> agent2(revise, main) -> agent3(optimize, main)
 */
export function defaultRelayPlan(graph, { planId = 'relay-default', maxParallelAgents = 1 } = {}) {
  const nodes = []
  for (let i = 0; i < graph.agents.length; i++) {
    const agentId = graph.agents[i].agentId
    nodes.push({
      id: `stage-${i + 1}`,
      agentId,
      kind: 'implement',
      dependsOn: i === 0 ? [] : [`stage-${i}`],
      workspaceMode: 'main',
      outputs: i === 0 ? ['baseline_commit', 'implementation.json'] : ['implementation.json'],
    })
  }
  return { version: PLAN_VERSION, id: planId, maxParallelAgents, failFast: true, nodes }
}

/**
 * parallel-review plan（Audit §9 Phase 2）：baseline 后 reviewer/tester 并行只读，
 * 集成节点确定性消费 review/test-plan，verify 做完整验证。不自动 patch/merge。
 */
export function parallelReviewPlan(graph, { planId = 'parallel-review-v1', maxParallelAgents = 3 } = {}) {
  const agents = graph.agents
  const pick = i => (agents.length ? agents[i % agents.length].agentId : null)
  const nodes = [
    { id: 'baseline', agentId: pick(0), kind: 'implement', dependsOn: [], workspaceMode: 'main', outputs: ['baseline_commit', 'implementation.json'] },
    { id: 'spec-review', agentId: pick(1), kind: 'review', dependsOn: ['baseline'], workspaceMode: 'read_only', outputs: ['review.json'] },
    { id: 'test-audit', agentId: pick(2), kind: 'test_review', dependsOn: ['baseline'], workspaceMode: 'read_only', outputs: ['test-plan.json'] },
    { id: 'integrate', agentId: pick(1), kind: 'integrate', dependsOn: ['spec-review', 'test-audit'], workspaceMode: 'main', outputs: ['integration.json'] },
    { id: 'verify', agentId: pick(2), kind: 'verify', dependsOn: ['integrate'], workspaceMode: 'read_only', outputs: ['verification.json'] },
  ]
  return { version: PLAN_VERSION, id: planId, maxParallelAgents, failFast: true, nodes }
}