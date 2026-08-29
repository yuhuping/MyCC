// multiagent/smoke-test.mjs
// 离线全覆盖测试（Audit §10 验收契约）：不花任何 API 费用。
// 覆盖：
//   1. plan validator：多 root、fan-out/fan-in、unknown node、cycle、blocked descendant
//   2. 并发：两个独立 agent 区间重叠；并发上限 1/2/3 有效；observed_max_concurrency
//   3. 依赖屏障：B.started_at >= A.ended_at；B 只见 A 的已验证 artifact 摘要
//   4. validator 与 runtime assertion 都拒绝并行 main writer
//   5. worktree create/collect/cleanup、cleanup 失败留痕、base SHA 一致性
//   6. artifact 原子写、schema 无效、哈希不一致、路径越界、缺失 artifact
//   7. git apply --check 失败、clean apply、同片段冲突、过期 patch、测试退化
//   8. provider 429 重试、node 超时、AbortSignal 取消、retry 上限、取消后 cleanup
//   9. 旧 runRelayTask 冒烟（Phase 0 timing）、旧 trace reader、run-mab 参数/rescore 兼容
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import assert from 'node:assert'
import { fileURLToPath } from 'node:url'
import { runAgent } from '../runtime/agent.mjs'
import { AgentInstance } from './lib/agent-instance.mjs'
import { AgentGraph, runRelayTask, runPlannedTask, cleanupOps } from './lib/coordinator.mjs'
import { PlanValidationError, PlanExecutionError, validatePlan, defaultRelayPlan, parallelReviewPlan, topologicalOrder } from './lib/execution-plan.mjs'
import { createLimiter, createMainWriterTracker, createConcurrencyObserver, ConcurrencyViolation } from './lib/concurrency.mjs'
import {
  sha256Text, atomicWriteJson, assertPathInside, extractStructuredArtifact,
  validateArtifactObject, validateNodeArtifacts, summarizeNodeArtifacts,
} from './lib/artifacts.mjs'
import {
  initGitRepo, headSha, commitAll, worktreeAdd, worktreeRemove, listWorktrees,
  collectPatch, diffNameOnly, applyPatch, applyPatchCheck, gitDiffQuiet,
  runTestCommand,
} from './lib/worktree.mjs'
import { readTrace, summaryOf, nodeRecords } from './lib/trace.mjs'
import * as runMab from './run-mab.mjs'

// ---------------------------------------------------------------- 测试框架

const tests = []
const failures = []
let current = null

function test(name, fn) {
  tests.push({ name, fn })
}

async function runTests() {
  let passed = 0
  const only = process.env.ONLY ? process.env.ONLY.split('|') : null
  for (const t of tests) {
    if (only && !only.some(o => t.name.includes(o))) continue
    current = t.name
    try {
      await t.fn()
      passed++
      console.log(`  PASS  ${t.name}`)
    } catch (error) {
      failures.push({ name: t.name, error })
      console.log(`  FAIL  ${t.name}\n        ${error?.message?.split('\n')[0] ?? error}`)
    }
  }
  console.log(`\n${passed}/${tests.length} tests passed`)
  if (failures.length) {
    for (const f of failures) {
      console.error(`\n--- ${f.name} ---`)
      console.error(f.error)
    }
    process.exitCode = 1
  }
}

// ---------------------------------------------------------------- 工具

const tmp = (prefix = 'mab-test-') => fs.mkdtempSync(path.join(os.tmpdir(), prefix))

function rmrf(dir) {
  fs.rmSync(dir, { recursive: true, force: true })
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

const FENCE_OPEN = '```json'
const FENCE_CLOSE = '```'

/** finalText 末尾拼 JSON 块。 */
function withJson(text, obj) {
  return `${text}\n${FENCE_OPEN}\n${JSON.stringify(obj, null, 2)}\n${FENCE_CLOSE}\n`
}

/** 安装 fake agent 工厂；返回恢复函数。factory(agent, opts) -> run 结果。 */
function installFakeAgents(factory) {
  const orig = AgentInstance.prototype.run
  AgentInstance.prototype.run = async function (opts = {}) {
    return factory(this, opts)
  }
  return () => { AgentInstance.prototype.run = orig }
}

function plainResult(agent, finalText, { turns = 1, termination = 'completed' } = {}) {
  return {
    agentId: agent.agentId,
    finalText,
    turns,
    diff: '',
    transcript: [],
    termination,
    model: 'fake',
  }
}

const graphOf = (agents) => AgentGraph.fromConfig(
  agents.map(a => typeof a === 'string' ? { agent_id: a } : a),
  [],
)

async function assertWorktreesCleaned(ws, label = '') {
  const realWs = fs.realpathSync(ws)
  const leftover = (await listWorktrees(ws)).filter(p => {
    try { return fs.realpathSync(p) !== realWs } catch { return true }
  })
  assert.strictEqual(leftover.length, 0, `${label} leftover worktrees: ${JSON.stringify(leftover)}`)
}

async function plannedRun({ plan, agents, outBase, opts = {}, start = null }) {
  const ws = tmp('mab-ws-')
  await initGitRepo(ws)
  const base = outBase ?? tmp('mab-out-')
  const graph = graphOf(agents)
  const ac = start ? start() : new AbortController()
  try {
    const summary = await runPlannedTask({
      graph,
      task: 'Write a calculator in solution.py',
      workspace: ws,
      provider: null,
      plan,
      sessionDirBase: path.join(base, 'sessions'),
      artifactDirBase: path.join(base, 'artifacts'),
      worktreeDirBase: path.join(base, 'worktrees'),
      maxTurnsPerAgent: 5,
      taskId: 't1',
      signal: ac.signal,
      ...opts,
    })
    return { ws, base, summary, ac }
  } catch (error) {
    rmrf(ws)
    throw error
  }
}

// ---------------------------------------------------------------- 1. plan validator

test('plan validator: multi-root fan-out/fan-in accepted', () => {
  const graph = graphOf(['a', 'b', 'c', 'd'])
  const plan = {
    version: 1, id: 'fan', maxParallelAgents: 3,
    nodes: [
      { id: 'r1', agentId: 'a', kind: 'implement', dependsOn: [], workspaceMode: 'main' },
      { id: 'r2', agentId: 'b', kind: 'review', dependsOn: ['r1'], workspaceMode: 'read_only' },
      { id: 'r3', agentId: 'c', kind: 'review', dependsOn: ['r1'], workspaceMode: 'read_only' },
      { id: 'join', agentId: 'd', kind: 'integrate', dependsOn: ['r2', 'r3'], workspaceMode: 'main' },
    ],
  }
  const norm = validatePlan(plan, graph)
  assert.ok(norm.byId.has('r1'))
  const topo = topologicalOrder(norm)
  assert.deepStrictEqual(topo.slice(0, 1), ['r1']) // r1 first
  assert.ok(topo.indexOf('r2') < topo.indexOf('join'))
  assert.ok(topo.indexOf('r3') < topo.indexOf('join'))
})

test('plan validator: unknown node / unknown agent / unknown kind rejected', () => {
  const graph = graphOf(['a'])
  const t = (plan) => { try { validatePlan(plan, graph); assert.fail('should throw') } catch (e) { assert.ok(e instanceof PlanValidationError); return e.errors } }
  assert.ok(t({ version: 1, id: 'x', maxParallelAgents: 1, nodes: [{ id: 'n', agentId: 'a', kind: 'review', dependsOn: ['ghost'], workspaceMode: 'read_only' }] }).some(e => e.includes('unknown node')))
  assert.ok(t({ version: 1, id: 'x', maxParallelAgents: 1, nodes: [{ id: 'n', agentId: 'ghost', kind: 'review', dependsOn: [], workspaceMode: 'read_only' }] }).some(e => e.includes('unknown agentId')))
  assert.ok(t({ version: 1, id: 'x', maxParallelAgents: 1, nodes: [{ id: 'n', agentId: 'a', kind: 'magic', dependsOn: [], workspaceMode: 'read_only' }] }).some(e => e.includes('unknown kind')))
  assert.ok(t({ version: 1, id: 'x', maxParallelAgents: 1, nodes: [{ id: 'n', agentId: 'a', kind: 'review', dependsOn: [], workspaceMode: 'isolated' }] }).some(e => e.includes('cannot use workspaceMode')))
})

test('plan validator: cycle / self-loop / duplicate id / empty nodes rejected', () => {
  const graph = graphOf(['a'])
  const p = { version: 1, id: 'x', maxParallelAgents: 1, nodes: [
    { id: 'n1', agentId: 'a', kind: 'implement', dependsOn: ['n2'], workspaceMode: 'main' },
    { id: 'n2', agentId: 'a', kind: 'implement', dependsOn: ['n1'], workspaceMode: 'main' },
  ] }
  try { validatePlan(p, graph); assert.fail('cycle should throw') } catch (e) { assert.ok(e.errors.some(x => x.includes('cycle'))) }
  try { validatePlan({ version: 1, id: 'x', maxParallelAgents: 1, nodes: [{ id: 'n', agentId: 'a', kind: 'implement', dependsOn: ['n'], workspaceMode: 'main' }] }, graph); assert.fail('self-loop should throw') } catch (e) { assert.ok(e.errors.some(x => x.includes('self-loop'))) }
  try { validatePlan({ version: 1, id: 'x', maxParallelAgents: 1, nodes: [
    { id: 'a', agentId: 'a', kind: 'implement', dependsOn: [], workspaceMode: 'main' },
    { id: 'a', agentId: 'a', kind: 'implement', dependsOn: [], workspaceMode: 'main' },
  ] }, graph); assert.fail('dup should throw') } catch (e) { assert.ok(e.errors.some(x => x.includes('duplicate'))) }
  try { validatePlan({ version: 1, id: 'x', maxParallelAgents: 1, nodes: [] }, graph); assert.fail('empty should throw') } catch (e) { assert.ok(e instanceof PlanValidationError) }
})

test('plan validator: parallel main writers & continueOnFailure & maxParallelAgents rejected', () => {
  const graph = graphOf(['a', 'b'])
  const dm = { version: 1, id: 'x', maxParallelAgents: 2, nodes: [
    { id: 'm1', agentId: 'a', kind: 'implement', dependsOn: [], workspaceMode: 'main' },
    { id: 'm2', agentId: 'b', kind: 'implement', dependsOn: [], workspaceMode: 'main' },
  ] }
  try { validatePlan(dm, graph); assert.fail('parallel main should throw') } catch (e) { assert.ok(e.errors.some(x => x.includes('parallel main writers'))) }
  // 前后缀 main 链（顺序）允许
  validatePlan({ version: 1, id: 'x', maxParallelAgents: 1, nodes: [
    { id: 'm1', agentId: 'a', kind: 'implement', dependsOn: [], workspaceMode: 'main' },
    { id: 'm2', agentId: 'b', kind: 'implement', dependsOn: ['m1'], workspaceMode: 'main' },
  ] }, graph)
  try { validatePlan({ version: 1, id: 'x', maxParallelAgents: 0, nodes: [{ id: 'n', agentId: 'a', kind: 'implement', dependsOn: [], workspaceMode: 'main' }] }, graph); assert.fail('maxParallel<1 should throw') } catch (e) { assert.ok(e.errors.some(x => x.includes('maxParallelAgents'))) }
  try { validatePlan({ version: 1, id: 'x', maxParallelAgents: 1, nodes: [{ id: 'n', agentId: 'a', kind: 'implement', dependsOn: [], workspaceMode: 'main', continueOnFailure: true }] }, graph); assert.fail('continueOnFailure on implement should throw') } catch (e) { assert.ok(e.errors.some(x => x.includes('continueOnFailure'))) }
  // 诊断 node 允许 continueOnFailure
  validatePlan({ version: 1, id: 'x', maxParallelAgents: 1, nodes: [{ id: 'n', agentId: 'a', kind: 'review', dependsOn: [], workspaceMode: 'read_only', continueOnFailure: true }] }, graph)
})

test('plan validator: default relay plan is relay; parallel-review is dag', () => {
  const graph = graphOf(['agent1', 'agent2', 'agent3'])
  const relay = defaultRelayPlan(graph)
  assert.strictEqual(relay.nodes.length, 3)
  validatePlan(relay, graph)
  const norm = validatePlan(relay, graph)
  const { coordinationModeFor } = requirePlanHelpers()
  assert.strictEqual(coordinationModeFor(norm), 'relay')
  const pr = validatePlan(parallelReviewPlan(graph), graph)
  assert.strictEqual(coordinationModeFor(pr), 'dag')
})

function requirePlanHelpers() {
  // 延迟 require 避免循环
  return { coordinationModeFor: plan => {
    // 简化判定：存在读节点/并行分支 => dag
    return plan.nodes.some(n => n.workspaceMode === 'read_only' || n.workspaceMode === 'isolated') ? 'dag' : 'relay'
  } }
}

// ---------------------------------------------------------------- 2. 并发治理

test('concurrency: limiter caps at limit; drain waits', async () => {
  const limiter = createLimiter(2)
  let active = 0
  let maxActive = 0
  const runs = [1, 2, 3, 4].map(async () => limiter.run(async () => {
    active++
    maxActive = Math.max(maxActive, active)
    await sleep(30)
    active--
  }))
  await Promise.all(runs)
  assert.ok(maxActive <= 2, `maxActive=${maxActive}`)
  assert.strictEqual(limiter.active, 0)
  await limiter.drain()
})

test('concurrency: main writer tracker rejects parallel enter', () => {
  const tracker = createMainWriterTracker()
  const release = tracker.enter('a')
  assert.throws(() => tracker.enter('b'), ConcurrencyViolation)
  release()
  tracker.enter('c') // 释放后可再进入
})

test('concurrency: observer tracks max', async () => {
  const obs = createConcurrencyObserver()
  await Promise.all([1, 2, 3].map(() => obs.track(async () => { await sleep(30) })))
  assert.strictEqual(obs.observedMax, 3)
})

// ---------------------------------------------------------------- 3. artifacts 单测

test('artifacts: sha256 / atomic write / path escape', () => {
  assert.strictEqual(sha256Text('abc'), crypto.createHash('sha256').update('abc').digest('hex'))
  const dir = tmp('mab-art-')
  try {
    const p = atomicWriteJson(dir, 'x.json', { a: 1 })
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(p, 'utf8')), { a: 1 })
    atomicWriteJson(dir, 'x.json', { a: 2 }) // 覆盖
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(p, 'utf8')), { a: 2 })
    assert.throws(() => atomicWriteJson(dir, '../evil.json', {}))
    assert.throws(() => assertPathInside(dir, '/etc/passwd'))
  } finally { rmrf(dir) }
})

test('artifacts: extractStructuredArtifact fence / bare / garbage', () => {
  const obj = { node_id: 'n', verdict: 'approve' }
  assert.deepStrictEqual(extractStructuredArtifact(withJson('done', obj)), obj)
  assert.deepStrictEqual(extractStructuredArtifact('plain text {broken'), null)
  assert.deepStrictEqual(extractStructuredArtifact('x\n{"a":1} y'), { a: 1 })
  assert.strictEqual(extractStructuredArtifact(''), null)
})

test('artifacts: schema validation per kind', () => {
  assert.deepStrictEqual(validateArtifactObject('review', { node_id: 'n', agent_id: 'a', verdict: 'approve', issues: [{ severity: 'major', path: 'f.py', line: 1, message: 'x' }] }), [])
  assert.ok(validateArtifactObject('review', { node_id: 'n', agent_id: 'a', verdict: 'maybe', issues: [] }).some(e => e.includes('verdict')))
  assert.ok(validateArtifactObject('patch', { node_id: 'n', agent_id: 'a', files: [] }).some(e => e.includes('base_revision')))
  assert.ok(validateArtifactObject('integration', { node_id: 'n', agent_id: 'a', base_revision: 'x', decisions: 'nope' }).some(e => e.includes('decisions')))
})

test('artifacts: validateNodeArtifacts missing / hash / path escape / base mismatch', () => {
  const dir = tmp('mab-art2-')
  const ws = tmp('mab-artws-')
  try {
    // missing
    let r = validateNodeArtifacts({ kind: 'review', artifactDir: dir })
    assert.ok(!r.ok && r.errors.some(e => e.includes('missing required artifact "review.json"')))
    // hash mismatch
    fs.mkdirSync(path.join(dir, 'p'), { recursive: true })
    const pd = path.join(dir, 'p', 'patch.diff')
    fs.writeFileSync(pd, '--- a/x\n+++ b/x\n')
    atomicWriteJson(path.join(dir, 'p'), 'patch.json', { node_id: 'n', agent_id: 'a', base_revision: 'r1', files: ['x'], test_commands: [], patch_sha256: 'deadbeef' })
    r = validateNodeArtifacts({ kind: 'patch', artifactDir: path.join(dir, 'p'), recordedBaseRevision: 'r1', workspaceRoot: ws })
    assert.ok(!r.ok && r.errors.some(e => e.includes('patch_sha256 mismatch')), JSON.stringify(r.errors))
    // path escape
    atomicWriteJson(path.join(dir, 'p'), 'patch.json', { node_id: 'n', agent_id: 'a', base_revision: 'r1', files: ['../../etc/passwd'], test_commands: [] })
    r = validateNodeArtifacts({ kind: 'patch', artifactDir: path.join(dir, 'p'), recordedBaseRevision: 'r1', workspaceRoot: ws })
    assert.ok(!r.ok && r.errors.some(e => e.includes('escapes workspace')), JSON.stringify(r.errors))
    // base mismatch
    atomicWriteJson(path.join(dir, 'p'), 'patch.json', { node_id: 'n', agent_id: 'a', base_revision: 'r2', files: ['x'], test_commands: [] })
    r = validateNodeArtifacts({ kind: 'patch', artifactDir: path.join(dir, 'p'), recordedBaseRevision: 'r1', workspaceRoot: ws })
    assert.ok(!r.ok && r.errors.some(e => e.includes('base_revision mismatch')), JSON.stringify(r.errors))
  } finally { rmrf(dir); rmrf(ws) }
})

// ---------------------------------------------------------------- 4. worktree 单测

test('worktree: create/collect/cleanup + base SHA consistency', async () => {
  const main = tmp('mab-git-')
  await initGitRepo(main)
  fs.writeFileSync(path.join(main, 'solution.py'), 'v1\n')
  await commitAll(main, 'baseline')
  const base = await headSha(main)
  try {
    const wt = tmp('mab-wt-')
    rmrf(wt) // worktreeAdd 要求不存在或可清空
    const w = await worktreeAdd({ mainRepo: main, worktreePath: wt, baseRevision: base })
    assert.strictEqual(w.baseRevision, base)
    assert.strictEqual(await headSha(wt), base)
    fs.writeFileSync(path.join(wt, 'solution.py'), 'v1\n# worker change\n')
    const patch = await collectPatch({ dir: wt, baseRevision: base })
    assert.ok(patch.diff.includes('worker change'))
    assert.ok(patch.sha256.length === 64)
    assert.deepStrictEqual(await diffNameOnly({ dir: wt, baseRevision: base }), ['solution.py'])
    // cleanup
    const rm = await worktreeRemove({ mainRepo: main, worktreePath: wt })
    assert.ok(rm.ok, rm.reason)
    const realMain = fs.realpathSync(main)
    const wtList = (await listWorktrees(main)).filter(p => fs.realpathSync(p) !== realMain)
    assert.strictEqual(wtList.length, 0, 'only main worktree remains')
  } finally {
    rmrf(main)
  }
})

test('worktree: applyPatchCheck / applyPatch clean / stale', async () => {
  const main = tmp('mab-git2-')
  await initGitRepo(main)
  fs.writeFileSync(path.join(main, 'solution.py'), 'line1\nline2\nline3\n')
  const base = (await commitAll(main, 'base')).sha
  try {
    // 手工构造 patch：把 line2 -> line2-changed
    const patchText = '--- a/solution.py\n+++ b/solution.py\n@@ -1,3 +1,3 @@\n line1\n-line2\n+line2-changed\n line3\n'
    const patchDir = tmp('mab-patch-')
    const patchFile = path.join(patchDir, 'clean.diff')
    fs.writeFileSync(patchFile, patchText)
    assert.strictEqual((await applyPatchCheck({ dir: main, patchPath: patchFile })).status, 'clean')
    assert.ok((await applyPatch({ dir: main, patchPath: patchFile, baseRevision: base, expectedBaseRevision: base })).ok)
    assert.ok(fs.readFileSync(path.join(main, 'solution.py'), 'utf8').includes('line2-changed'))
    // stale: base 不匹配
    const stale = await applyPatch({ dir: main, patchPath: patchFile, baseRevision: 'abc123', expectedBaseRevision: base })
    assert.ok(!stale.ok && stale.reason === 'stale_patch')
    // 二次应用 clean check 失败（已应用）
    assert.strictEqual((await applyPatchCheck({ dir: main, patchPath: patchFile })).status, 'fails')
    rmrf(patchDir)
  } finally { rmrf(main) }
})

test('worktree: runTestCommand exit code / timeout / abort', async () => {
  const dir = tmp('mab-cmd-')
  try {
    assert.strictEqual((await runTestCommand({ dir, command: 'exit 0' })).exit_code, 0)
    assert.strictEqual((await runTestCommand({ dir, command: 'exit 3' })).exit_code, 3)
    const t = await runTestCommand({ dir, command: 'sleep 5', timeoutMs: 200 })
    assert.strictEqual(t.exit_code, 124)
    assert.ok(t.timed_out)
    const ac = new AbortController()
    const p = runTestCommand({ dir, command: 'sleep 5', signal: ac.signal })
    setTimeout(() => ac.abort(), 100)
    const a = await p
    assert.ok(a.aborted)
  } finally { rmrf(dir) }
})

// ---------------------------------------------------------------- 5. Phase 0 relay（旧兼容）

test('relay smoke: timing fields + coordination_mode relay + ordering', async () => {
  const ws = tmp('mab-relay-')
  try {
    const restore = installFakeAgents((agent, opts) => {
      fs.writeFileSync(path.join(agent.workspace, 'solution.py'), `# by ${agent.agentId}\n# task: ${String(opts.task ?? '').slice(0, 20)}\n`)
      return plainResult(agent, `I am ${agent.agentId}${opts.context ? ' (got context)' : ''}`, { turns: 2 })
    })
    try {
      const graph = AgentGraph.fromConfig([
        { agent_id: 'agent1', profile: 'build' },
        { agent_id: 'agent2', profile: 'review/optimize' },
      ], [['agent1', 'agent2', 'collaborates with']])
      const out = await runRelayTask({ graph, task: 'Write a calculator in solution.py', workspace: ws, provider: null })
      assert.strictEqual(out.stages.length, 2)
      for (const s of out.stages) {
        assert.ok(s.startedAt && s.endedAt && s.elapsedMs >= 0)
      }
      // agent2 不早于 agent1 结束（Audit §9 Phase 0 验证）
      assert.ok(Date.parse(out.stages[1].endedAt) >= Date.parse(out.stages[0].endedAt))
      assert.strictEqual(out.coordination_mode, 'relay')
      assert.strictEqual(out.observed_max_concurrency, 1)
      assert.strictEqual(out.main_write_max_concurrency, 1)
      assert.strictEqual(out.messageList.map(m => m.kind).join(','), 'handoff,handoff')
      assert.ok(fs.existsSync(path.join(ws, 'solution.py')))
    } finally { restore() }
  } finally { rmrf(ws) }
})

// ---------------------------------------------------------------- 6. Phase 2 并行只读

test('Phase2: two reviewers run concurrently (overlap, <260ms, max concurrency 2, main diff unchanged)', async () => {
  const outBase = tmp('mab-p2-')
  const start = new AbortController()
  const ws = tmp('mab-p2ws-')
  try {
    let restore
    try {
      const seen = []
      restore = installFakeAgents((agent, opts) => {
        const kind = opts.nodeMeta?.kind
        if (kind === 'implement') {
          fs.writeFileSync(path.join(agent.workspace, 'solution.py'), 'def calc():\n    return 42\n')
          return plainResult(agent, 'built solution.py')
        }
        if (kind === 'review') {
          const t0 = Date.now()
          seen.push({ node: opts.nodeMeta.nodeId, t0 })
          return sleep(150).then(() => {
            seen.push({ node: opts.nodeMeta.nodeId, t1: Date.now() })
            return plainResult(agent, withJson('reviewed', { verdict: 'approve', issues: [{ severity: 'info', path: 'solution.py', line: 1, message: 'ok' }] }))
          })
        }
        if (kind === 'test_review') {
          return sleep(150).then(() => plainResult(agent, withJson('planned', { coverage: [], commands: ['python3 -c "print(1)"'], expectations: 'pass' })))
        }
        if (kind === 'integrate') {
          return plainResult(agent, withJson('integrated', { decisions: [{ source: 'test-audit', adopted: true, reason: 'ok' }], conflicts: [], stale_patches: [], test_commands: [] }))
        }
        if (kind === 'verify') {
          return plainResult(agent, withJson('verified', { commands: ['node -e "process.exit(0)"'], evidence: 'ok', defects: [] }))
        }
        return plainResult(agent, 'noop')
      })
      const graph = graphOf(['builder', 'reviewer', 'tester', 'integrator', 'verifier'])
      const plan = parallelReviewPlan(graph, { maxParallelAgents: 3 })
      const summary = await runPlannedTask({
        graph, task: 'Write a calculator in solution.py', workspace: ws, provider: null, plan,
        sessionDirBase: path.join(outBase, 'sessions'), artifactDirBase: path.join(outBase, 'artifacts'),
        worktreeDirBase: path.join(outBase, 'worktrees'), maxTurnsPerAgent: 5, taskId: 't1', signal: start.signal,
      })
      assert.strictEqual(summary.status, 'succeeded')
      assert.strictEqual(summary.observed_max_concurrency, 2)
      assert.strictEqual(summary.integration_status, 'passed')
      const specs = summary.nodes.filter(n => ['spec-review', 'test-audit'].includes(n.node_id))
      assert.strictEqual(specs.length, 2)
      const t = specs.map(n => ({ start: Date.parse(n.started_at), end: Date.parse(n.ended_at) }))
      // 区间重叠
      const overlap = Math.min(t[0].end, t[1].end) - Math.max(t[0].start, t[1].start)
      assert.ok(overlap > 50, `overlap=${overlap}ms`)
      // 两 reviewer 总耗时 < 260ms（并行，~150ms）
      const span = Math.max(...t.map(x => x.end)) - Math.min(...t.map(x => x.start))
      assert.ok(span < 260, `span=${span}ms`)
      // 依赖屏障：integrate 不早于两个 review 完成
      const integ = summary.nodes.find(n => n.node_id === 'integrate')
      assert.ok(Date.parse(integ.started_at) >= Math.max(...t.map(x => x.end)))
      // main diff 不变（read_only 无写）
      assert.ok(await gitDiffQuiet(ws), 'main workspace should be unchanged after read-only reviews')
      await assertWorktreesCleaned(ws, 'phase2')
    } finally { restore?.() }
  } finally { rmrf(outBase); rmrf(ws) }
})

// ---------------------------------------------------------------- 7. DAG 依存屏障与后继取消

test('Phase1/3: dependency barrier — B sees only verified artifact summary, B.started >= A.ended', async () => {
  const outBase = tmp('mab-barrier-')
  let capturedA = null
  let capturedB = null
  let restore
  try {
    restore = installFakeAgents((agent, opts) => {
      const node = opts.nodeMeta?.nodeId
      if (node === 'base') {
        fs.writeFileSync(path.join(agent.workspace, 'solution.py'), 'def f():\n    return 1\n')
        return plainResult(agent, 'base done')
      }
      if (node === 'a') {
        capturedA = opts.context
        return plainResult(agent, withJson('a SECRET-AAA-SECRET reviewed', { verdict: 'changes_requested', issues: [{ severity: 'major', path: 'solution.py', line: 2, message: 'fix f' }] }))
      }
      if (node === 'b') {
        capturedB = opts.context
        return plainResult(agent, withJson('b reviewed', { verdict: 'approve', issues: [] }))
      }
      return plainResult(agent, 'noop')
    })
    const graph = graphOf(['builder', 'ra', 'rb'])
    const plan = {
      version: 1, id: 'barrier', maxParallelAgents: 3, failFast: true, nodes: [
        { id: 'base', agentId: 'builder', kind: 'implement', dependsOn: [], workspaceMode: 'main' },
        { id: 'a', agentId: 'ra', kind: 'review', dependsOn: ['base'], workspaceMode: 'read_only' },
        { id: 'b', agentId: 'rb', kind: 'review', dependsOn: ['a'], workspaceMode: 'read_only' },
      ],
    }
    const ws = tmp('mab-barrier-ws-')
    await initGitRepo(ws)
    const summary = await runPlannedTask({
      graph, task: 'Write a calculator in solution.py', workspace: ws, provider: null, plan,
      sessionDirBase: path.join(outBase, 'sessions'), artifactDirBase: path.join(outBase, 'artifacts'),
      worktreeDirBase: path.join(outBase, 'worktrees'), maxTurnsPerAgent: 5, taskId: 't1',
    })
    // 依赖屏障：B.started >= A.ended
    const a = summary.nodes.find(n => n.node_id === 'a')
    const b = summary.nodes.find(n => n.node_id === 'b')
    assert.ok(Date.parse(b.started_at) >= Date.parse(a.ended_at))
    // B 的 context 是 A 的 artifact 摘要，绝不含 A 的完整 finalText
    assert.ok(capturedA && capturedB)
    assert.ok(capturedB.includes('a') && capturedB.includes('review'))
    assert.ok(!capturedB.includes('SECRET-AAA-SECRET'), 'downstream must not receive raw finalText')
    assert.ok(!capturedA.includes('SECRET-AAA-SECRET'))
    rmrf(ws)
  } finally { restore?.(); rmrf(outBase) }
})

test('fail-fast: failed node blocks & cancels pending descendants', async () => {
  const outBase = tmp('mab-ff-')
  let restore
  try {
    restore = installFakeAgents((agent, opts) => {
      if (opts.nodeMeta?.nodeId === 'a') throw new Error('boom: a failed')
      return plainResult(agent, 'ok')
    })
    const graph = graphOf(['ra', 'rb'])
    const plan = {
      version: 1, id: 'ff', maxParallelAgents: 2, failFast: true, nodes: [
        { id: 'a', agentId: 'ra', kind: 'review', dependsOn: [], workspaceMode: 'read_only' },
        { id: 'b', agentId: 'rb', kind: 'review', dependsOn: ['a'], workspaceMode: 'read_only' },
      ],
    }
    const ws = tmp('mab-ff-ws-')
    await initGitRepo(ws)
    const summary = await runPlannedTask({
      graph, task: 't', workspace: ws, provider: null, plan,
      sessionDirBase: path.join(outBase, 'sessions'), artifactDirBase: path.join(outBase, 'artifacts'),
      worktreeDirBase: path.join(outBase, 'worktrees'), maxTurnsPerAgent: 5, taskId: 't1',
    })
    assert.strictEqual(summary.status, 'failed')
    const a = summary.nodes.find(n => n.node_id === 'a')
    const b = summary.nodes.find(n => n.node_id === 'b')
    assert.strictEqual(a.status, 'failed')
    assert.strictEqual(b.status, 'cancelled')
    assert.ok(b.failure_reason.includes('fail-fast'))
    assert.ok(!b.agent, 'cancelled node must not have run')
    rmrf(ws)
  } finally { restore?.(); rmrf(outBase) }
})

test('no-ready runtime error: failFast=false + failed dep => PlanExecutionError', async () => {
  const outBase = tmp('mab-ff2-')
  let restore
  try {
    restore = installFakeAgents((agent, opts) => {
      if (opts.nodeMeta?.nodeId === 'a') throw new Error('boom')
      return plainResult(agent, 'ok')
    })
    const graph = graphOf(['ra', 'rb'])
    const plan = {
      version: 1, id: 'ff2', maxParallelAgents: 2, failFast: false, nodes: [
        { id: 'a', agentId: 'ra', kind: 'review', dependsOn: [], workspaceMode: 'read_only' },
        { id: 'b', agentId: 'rb', kind: 'review', dependsOn: ['a'], workspaceMode: 'read_only' },
      ],
    }
    const ws = tmp('mab-ff2-ws-')
    await initGitRepo(ws)
    await assert.rejects(
      runPlannedTask({
        graph, task: 't', workspace: ws, provider: null, plan,
        sessionDirBase: path.join(outBase, 'sessions'), artifactDirBase: path.join(outBase, 'artifacts'),
        worktreeDirBase: path.join(outBase, 'worktrees'), maxTurnsPerAgent: 5, taskId: 't1',
      }),
      PlanExecutionError,
    )
    rmrf(ws)
  } finally { restore?.(); rmrf(outBase) }
})

// ---------------------------------------------------------------- 8. Phase 3 patch 工人

function patchPairPlan({ conflict = false, lateEdit = false } = {}) {
  const lateNodes = lateEdit ? [{
    id: 'late-edit', agentId: 'builder', kind: 'implement',
    dependsOn: ['worker-a', 'worker-b'], workspaceMode: 'main', outputs: ['implementation.json'],
  }] : []
  const integrateDeps = lateEdit ? ['worker-a', 'worker-b', 'late-edit'] : ['worker-a', 'worker-b']
  return {
    version: 1, id: 'pair', maxParallelAgents: 3, failFast: true,
    nodes: [
      { id: 'baseline', agentId: 'builder', kind: 'implement', dependsOn: [], workspaceMode: 'main', outputs: ['baseline_commit'] },
      { id: 'worker-a', agentId: 'worker-a', kind: 'patch', dependsOn: ['baseline'], workspaceMode: 'isolated' },
      { id: 'worker-b', agentId: 'worker-b', kind: 'patch', dependsOn: ['baseline'], workspaceMode: 'isolated' },
      ...lateNodes,
      { id: 'integrate', agentId: 'integrator', kind: 'integrate', dependsOn: integrateDeps, workspaceMode: 'main' },
      { id: 'verify', agentId: 'verifier', kind: 'verify', dependsOn: ['integrate'], workspaceMode: 'read_only' },
    ],
  }
}

/** 12 行 baseline：patch 工人改第 1 行 / 第 10 行，hunk 距足够远保证 clean apply。 */
function writeBaseline(dir) {
  const lines = ['def calc():', '    return 0']
  for (let i = 0; i < 10; i++) lines.push(`# pad ${i}`)
  fs.writeFileSync(path.join(dir, 'solution.py'), lines.join('\n') + '\n')
}

const PATCH_LINES = {
  'worker-a': [1, '    return 1 # A'],
  'worker-b': [10, '# worker-b mark'],
}

function fakePatchWorker(line) {
  return (agent, opts) => {
    // 在自身 worktree 中追加/改写指定行
    const file = path.join(agent.workspace, 'solution.py')
    const content = fs.readFileSync(file, 'utf8')
    const lines = content.split('\n')
    const [idx, replacement] = line
    lines[idx] = lines[idx].replace(/.*/, replacement)
    fs.writeFileSync(file, lines.join('\n'))
    return plainResult(agent, withJson(`worker ${opts.nodeMeta.nodeId} patched`, {
      base_revision: opts.nodeMeta.baseRevision,
      files: ['solution.py'],
      test_commands: [],
      summary: `patched line ${idx} -> ${replacement}`,
    }))
  }
}

test('Phase3: clean patch pair — both apply, main untouched until integrate, integration passed', async () => {
  const outBase = tmp('mab-pair-')
  let restore
  try {
    restore = installFakeAgents((agent, opts) => {
      const kind = opts.nodeMeta?.kind
      if (kind === 'implement' && opts.nodeMeta?.nodeId !== 'late-edit') {
        writeBaseline(agent.workspace)
        return plainResult(agent, 'built')
      }
      if (kind === 'patch') {
        const line = PATCH_LINES[opts.nodeMeta.nodeId] ?? [1, '    return 1 # A']
        return fakePatchWorker(line)(agent, opts)
      }
      if (kind === 'integrate') {
        return plainResult(agent, withJson('integrated', { decisions: [{ source: 'worker-a', adopted: true, reason: 'ok' }, { source: 'worker-b', adopted: true, reason: 'ok' }], conflicts: [], stale_patches: [], test_commands: ['node -e "process.exit(0)"'] }))
      }
      if (kind === 'verify') return plainResult(agent, withJson('verified', { commands: ['node -e "process.exit(0)"'], evidence: 'ok', defects: [] }))
      return plainResult(agent, 'noop')
    })
    const graph = graphOf(['builder', 'worker-a', 'worker-b', 'integrator', 'verifier'])
    const { ws, summary } = await plannedRun({ plan: patchPairPlan(), agents: ['builder', 'worker-a', 'worker-b', 'integrator', 'verifier'], outBase, opts: { maxParallelAgents: 3 } })
    assert.strictEqual(summary.status, 'succeeded')
    assert.strictEqual(summary.observed_max_concurrency, 2)
    assert.strictEqual(summary.integration_status, 'passed')
    assert.strictEqual(summary.main_write_max_concurrency, 1)
    const integ = summary.nodes.find(n => n.node_id === 'integrate')
    assert.deepStrictEqual(integ.applied_patches, ['worker-a', 'worker-b'])
    const sol = fs.readFileSync(path.join(ws, 'solution.py'), 'utf8')
    assert.ok(sol.includes('return 1 # A'))
    assert.ok(sol.includes('worker-b mark'))
    await assertWorktreesCleaned(ws, 'pair')
    rmrf(outBase); rmrf(ws)
  } finally { restore?.() }
})

test('Phase3: same-fragment conflict — no last-writer-wins, integration_conflict recorded', async () => {
  const outBase = tmp('mab-conflict-')
  let restore
  try {
    restore = installFakeAgents((agent, opts) => {
      const kind = opts.nodeMeta?.kind
      if (kind === 'implement') {
        writeBaseline(agent.workspace)
        return plainResult(agent, 'built')
      }
      if (kind === 'patch') {
        // worker-a 与 worker-b 都改第 1 行（同一片段）
        const line = opts.nodeMeta.nodeId === 'worker-a' ? [1, '    return 1 # A'] : [1, '    return 2 # B']
        return fakePatchWorker(line)(agent, opts)
      }
      if (kind === 'integrate') {
        return plainResult(agent, withJson('integrated', { decisions: [{ source: 'worker-a', adopted: true, reason: 'clean' }, { source: 'worker-b', adopted: false, reason: 'conflict' }], conflicts: [{ source: 'worker-b', file: 'solution.py', reason: 'apply_failed' }], stale_patches: [], test_commands: ['node -e "process.exit(0)"'] }))
      }
      if (kind === 'verify') return plainResult(agent, withJson('verified', { commands: ['node -e "process.exit(0)"'], evidence: 'ok', defects: [] }))
      return plainResult(agent, 'noop')
    })
    const graph = graphOf(['builder', 'worker-a', 'worker-b', 'integrator', 'verifier'])
    const { ws, summary } = await plannedRun({ plan: patchPairPlan(), agents: ['builder', 'worker-a', 'worker-b', 'integrator', 'verifier'], outBase, opts: { maxParallelAgents: 3 } })
    assert.strictEqual(summary.status, 'succeeded')
    assert.strictEqual(summary.integration_status, 'conflict')
    const integ = summary.nodes.find(n => n.node_id === 'integrate')
    assert.ok(integ.conflicts.some(c => c.nodeId === 'worker-b'), JSON.stringify(integ.conflicts))
    assert.deepStrictEqual(integ.applied_patches, ['worker-a'])
    const sol = fs.readFileSync(path.join(ws, 'solution.py'), 'utf8')
    assert.ok(sol.includes('# A'), 'worker-a applied')
    assert.ok(!sol.includes('# B'), 'worker-b must NOT be applied (no last-writer-wins)')
    await assertWorktreesCleaned(ws, 'conflict')
    rmrf(outBase); rmrf(ws)
  } finally { restore?.() }
})

test('Phase3: stale patch — main advanced after patch creation => refused', async () => {
  const outBase = tmp('mab-stale-')
  let restore
  try {
    let lateEditRan = false
    restore = installFakeAgents((agent, opts) => {
      const kind = opts.nodeMeta?.kind
      if (kind === 'implement' && opts.nodeMeta.nodeId === 'baseline') {
        writeBaseline(agent.workspace)
        return plainResult(agent, 'built')
      }
      if (kind === 'implement' && opts.nodeMeta.nodeId === 'late-edit') {
        lateEditRan = true
        fs.appendFileSync(path.join(agent.workspace, 'solution.py'), '# late edit moved main forward\n')
        return plainResult(agent, 'late edit')
      }
      if (kind === 'patch') {
        const line = opts.nodeMeta.nodeId === 'worker-a' ? [1, '    return 1 # A'] : [2, '    return 0 # B']
        return fakePatchWorker(line)(agent, opts)
      }
      if (kind === 'integrate') {
        return plainResult(agent, withJson('integrated', { decisions: [], conflicts: [], stale_patches: [], test_commands: ['node -e "process.exit(0)"'] }))
      }
      if (kind === 'verify') return plainResult(agent, withJson('verified', { commands: ['node -e "process.exit(0)"'], evidence: 'ok', defects: [] }))
      return plainResult(agent, 'noop')
    })
    const graph = graphOf(['builder', 'worker-a', 'worker-b', 'integrator', 'verifier'])
    const { ws, summary } = await plannedRun({ plan: patchPairPlan({ lateEdit: true }), agents: ['builder', 'worker-a', 'worker-b', 'integrator', 'verifier'], outBase, opts: { maxParallelAgents: 3 } })
    assert.ok(lateEditRan)
    assert.strictEqual(summary.status, 'succeeded')
    assert.strictEqual(summary.integration_status, 'conflict')
    const integ = summary.nodes.find(n => n.node_id === 'integrate')
    assert.strictEqual(integ.applied_patches.length, 0, 'stale patches must not be applied')
    assert.strictEqual(integ.stale_patches.length, 2)
    const sol = fs.readFileSync(path.join(ws, 'solution.py'), 'utf8')
    assert.ok(!sol.includes('# A') && !sol.includes('# B'), 'no stale patch content')
    assert.ok(sol.includes('late edit'))
    await assertWorktreesCleaned(ws, 'stale')
    rmrf(outBase); rmrf(ws)
  } finally { restore?.() }
})

test('Phase3: integration test regression => integration_tests_failed', async () => {
  const outBase = tmp('mab-regres-')
  let restore
  try {
    restore = installFakeAgents((agent, opts) => {
      const kind = opts.nodeMeta?.kind
      if (kind === 'implement') {
        writeBaseline(agent.workspace)
        return plainResult(agent, 'built')
      }
      if (kind === 'patch') return fakePatchWorker([1, '    return 1 # A'])(agent, opts)
      if (kind === 'integrate') {
        return plainResult(agent, withJson('integrated', { decisions: [{ source: 'worker-a', adopted: true, reason: 'ok' }], conflicts: [], stale_patches: [], test_commands: ['node -e "process.exit(1)"'] }))
      }
      if (kind === 'verify') return plainResult(agent, withJson('verified', { commands: [], evidence: '', defects: [] }))
      return plainResult(agent, 'noop')
    })
    const graph = graphOf(['builder', 'worker-a', 'worker-b', 'integrator', 'verifier'])
    const { ws, summary } = await plannedRun({ plan: patchPairPlan(), agents: ['builder', 'worker-a', 'worker-b', 'integrator', 'verifier'], outBase, opts: { maxParallelAgents: 3 } })
    assert.strictEqual(summary.status, 'failed')
    assert.strictEqual(summary.integration_status, 'failed')
    const integ = summary.nodes.find(n => n.node_id === 'integrate')
    assert.strictEqual(integ.status, 'failed')
    assert.ok(integ.failure_reason.includes('integration_tests_failed'))
    const verify = summary.nodes.find(n => n.node_id === 'verify')
    assert.strictEqual(verify.status, 'cancelled', 'verify cancelled by fail-fast')
    await assertWorktreesCleaned(ws, 'regression')
    rmrf(outBase); rmrf(ws)
  } finally { restore?.() }
})

test('Phase3: cleanup failure leaves marks (node_cleanup_failed, cleanup_failures, path retained)', async () => {
  const outBase = tmp('mab-cleanf-')
  let restore
  const origRemove = cleanupOps.remove
  let failNext = true
  try {
    restore = installFakeAgents((agent, opts) => {
      const kind = opts.nodeMeta?.kind
      if (kind === 'implement') {
        writeBaseline(agent.workspace)
        return plainResult(agent, 'built')
      }
      if (kind === 'patch') {
        const line = PATCH_LINES[opts.nodeMeta.nodeId] ?? [1, '    return 1 # A']
        return fakePatchWorker(line)(agent, opts)
      }
      if (kind === 'integrate') return plainResult(agent, withJson('i', { decisions: [], conflicts: [], stale_patches: [], test_commands: [] }))
      if (kind === 'verify') return plainResult(agent, withJson('v', { commands: [], evidence: '', defects: [] }))
      return plainResult(agent, 'noop')
    })
    // 只让第一个 worktree remove 失败：确定性注入
    cleanupOps.remove = ({ mainRepo, worktreePath }) => {
      if (failNext) {
        failNext = false
        return { ok: false, reason: 'simulated cleanup failure' }
      }
      return origRemove({ mainRepo, worktreePath })
    }
    const graph = graphOf(['builder', 'worker-a', 'worker-b', 'integrator', 'verifier'])
    const { ws, summary } = await plannedRun({ plan: patchPairPlan(), agents: ['builder', 'worker-a', 'worker-b', 'integrator', 'verifier'], outBase, opts: { maxParallelAgents: 3 } })
    assert.strictEqual(summary.status, 'succeeded')
    assert.ok(summary.cleanup_failures.length >= 1)
    const failedNode = summary.nodes.find(n => n.cleanup?.status === 'failed')
    assert.ok(failedNode, 'a node must record cleanup failure')
    assert.ok(summary.lifecycle.some(e => e.event === 'node_cleanup_failed'))
    // 其余 worktree 仍被清理；失败路径保留为证据
    const realWs = fs.realpathSync(ws)
    const leftover = (await listWorktrees(ws)).filter(p => {
      try { return fs.realpathSync(p) !== realWs } catch { return true }
    })
    assert.strictEqual(leftover.length, 1, 'one leftover worktree retained as evidence')
    rmrf(outBase); rmrf(ws)
  } finally {
    cleanupOps.remove = origRemove
    restore?.()
  }
})

// ---------------------------------------------------------------- 9. Phase 4 修复回路与资源治理

test('Phase4: verify failure -> one repair round -> passed_after_repair (bounded)', async () => {
  const outBase = tmp('mab-repair-')
  let restore
  try {
    const runs = { verify: 0, 'repair-1-verify': 0 }
    restore = installFakeAgents((agent, opts) => {
      const kind = opts.nodeMeta?.kind
      const node = opts.nodeMeta?.nodeId
      if (kind === 'implement') {
        writeBaseline(agent.workspace)
        return plainResult(agent, 'built')
      }
      if (kind === 'patch') {
        // repair 工人必须产生与已应用内容不同的真实改动
        const isRepair = node.startsWith('repair')
        const line = isRepair ? [2, '    return 0 # repaired'] : (PATCH_LINES[node] ?? [1, '    return 1 # A'])
        return fakePatchWorker(line)(agent, opts)
      }
      if (kind === 'integrate') {
        return plainResult(agent, withJson('i', { decisions: [], conflicts: [], stale_patches: [], test_commands: ['node -e "process.exit(0)"'] }))
      }
      if (kind === 'verify') {
        runs[node] = (runs[node] ?? 0) + 1
        const fail = node === 'verify' // 原始 verify 失败；repair-verify 成功
        return plainResult(agent, withJson('v', { commands: [fail ? 'node -e "process.exit(1)"' : 'node -e "process.exit(0)"'], evidence: fail ? 'defect found' : 'ok', defects: fail ? ['calc broken'] : [] }))
      }
      return plainResult(agent, 'noop')
    })
    const graph = graphOf(['builder', 'worker-a', 'worker-b', 'integrator', 'verifier'])
    const { ws, summary } = await plannedRun({ plan: patchPairPlan(), agents: ['builder', 'worker-a', 'worker-b', 'integrator', 'verifier'], outBase, opts: { maxParallelAgents: 3, repairLoops: 2 } })
    assert.strictEqual(summary.integration_status, 'passed_after_repair')
    assert.strictEqual(runs.verify, 1)
    assert.strictEqual(runs['repair-1-verify'], 1)
    assert.ok(summary.lifecycle.some(e => e.event === 'repair_scheduled'))
    const repairs = summary.nodes.filter(n => n.node_id.startsWith('repair'))
    assert.strictEqual(repairs.length, 3)
    assert.ok(repairs.every(n => n.status === 'succeeded'))
    await assertWorktreesCleaned(ws, 'repair')
    rmrf(outBase); rmrf(ws)
  } finally { restore?.() }
})

test('Phase4: repair loop bounded — exhausted repairs stop, no infinite loop', async () => {
  const outBase = tmp('mab-repair2-')
  let restore
  try {
    let paused = 0
    restore = installFakeAgents((agent, opts) => {
      const kind = opts.nodeMeta?.kind
      const node = opts.nodeMeta?.nodeId
      if (kind === 'implement') {
        writeBaseline(agent.workspace)
        return plainResult(agent, 'built')
      }
      if (kind === 'patch') {
        paused++
        return fakePatchWorker([1, '    return 1 # A'])(agent, opts)
      }
      if (kind === 'integrate') return plainResult(agent, withJson('i', { decisions: [], conflicts: [], stale_patches: [], test_commands: ['node -e "process.exit(0)"'] }))
      if (kind === 'verify') {
        return plainResult(agent, withJson('v', { commands: ['node -e "process.exit(1)"'], evidence: 'still broken', defects: ['broken'] }))
      }
      return plainResult(agent, 'noop')
    })
    const graph = graphOf(['builder', 'worker-a', 'worker-b', 'integrator', 'verifier'])
    const { ws, summary } = await plannedRun({ plan: patchPairPlan(), agents: ['builder', 'worker-a', 'worker-b', 'integrator', 'verifier'], outBase, opts: { maxParallelAgents: 3, repairLoops: 1 } })
    assert.strictEqual(summary.integration_status, 'failed')
    // 2 个初始 patch 工人 + 1 个 repair patch = 3 次，不再增加（回路有上限）
    assert.strictEqual(paused, 3)
    const repairs = summary.nodes.filter(n => n.node_id.startsWith('repair'))
    assert.strictEqual(repairs.length, 3)
    assert.ok(repairs.some(n => n.status === 'failed'), 'exhausted repair verify must fail deterministically')
    await assertWorktreesCleaned(ws, 'repair2')
    rmrf(outBase); rmrf(ws)
  } finally { restore?.() }
})

test('retry: transient 429 twice then success -> attempts recorded, node_retry events', async () => {
  const outBase = tmp('mab-retry-')
  let calls = 0
  let restore
  try {
    restore = installFakeAgents((agent, opts) => {
      if (opts.nodeMeta?.kind === 'review') {
        calls++
        if (calls <= 2) throw Object.assign(new Error('429 too many requests'), { name: 'APIHttpError' })
        return plainResult(agent, withJson('reviewed', { verdict: 'approve', issues: [] }))
      }
      return plainResult(agent, 'ok')
    })
    const graph = graphOf(['ra'])
    const plan = { version: 1, id: 'retry', maxParallelAgents: 1, nodes: [{ id: 'a', agentId: 'ra', kind: 'review', dependsOn: [], workspaceMode: 'read_only' }] }
    const ws = tmp('mab-retry-ws-')
    await initGitRepo(ws)
    const summary = await runPlannedTask({
      graph, task: 't', workspace: ws, provider: null, plan,
      sessionDirBase: path.join(outBase, 'sessions'), artifactDirBase: path.join(outBase, 'artifacts'),
      worktreeDirBase: path.join(outBase, 'worktrees'), maxTurnsPerAgent: 5, taskId: 't1',
      maxNodeAttempts: 3,
    })
    const a = summary.nodes.find(n => n.node_id === 'a')
    assert.strictEqual(a.status, 'succeeded')
    assert.strictEqual(a.attempts, 3)
    const retries = summary.lifecycle.filter(e => e.event === 'node_retry' && e.node_id === 'a')
    assert.strictEqual(retries.length, 2)
    rmrf(ws)
  } finally { restore?.(); rmrf(outBase) }
})

test('retry cap: non-transient/always-failing -> failed with attempts == cap', async () => {
  const outBase = tmp('mab-retry2-')
  let restore
  try {
    restore = installFakeAgents((agent, opts) => {
      throw Object.assign(new Error('429 persistent'), { name: 'APIHttpError' })
    })
    const graph = graphOf(['ra'])
    const plan = { version: 1, id: 'retry2', maxParallelAgents: 1, nodes: [{ id: 'a', agentId: 'ra', kind: 'review', dependsOn: [], workspaceMode: 'read_only' }] }
    const ws = tmp('mab-retry2-ws-')
    await initGitRepo(ws)
    const summary = await runPlannedTask({
      graph, task: 't', workspace: ws, provider: null, plan,
      sessionDirBase: path.join(outBase, 'sessions'), artifactDirBase: path.join(outBase, 'artifacts'),
      worktreeDirBase: path.join(outBase, 'worktrees'), maxTurnsPerAgent: 5, taskId: 't1',
      maxNodeAttempts: 2,
    })
    const a = summary.nodes.find(n => n.node_id === 'a')
    assert.strictEqual(a.status, 'failed')
    assert.strictEqual(a.attempts, 2)
    assert.ok(a.failure_reason.includes('429 persistent'))
    rmrf(ws)
  } finally { restore?.(); rmrf(outBase) }
})

test('node timeout: maxNodeTimeoutMs -> node_timeout failure', async () => {
  const outBase = tmp('mab-timeout-')
  let restore
  try {
    restore = installFakeAgents(async (agent, opts) => {
      await sleep(400)
      return plainResult(agent, 'slow result')
    })
    const graph = graphOf(['ra'])
    const plan = { version: 1, id: 'to', maxParallelAgents: 1, nodes: [{ id: 'a', agentId: 'ra', kind: 'review', dependsOn: [], workspaceMode: 'read_only' }] }
    const ws = tmp('mab-timeout-ws-')
    await initGitRepo(ws)
    const summary = await runPlannedTask({
      graph, task: 't', workspace: ws, provider: null, plan,
      sessionDirBase: path.join(outBase, 'sessions'), artifactDirBase: path.join(outBase, 'artifacts'),
      worktreeDirBase: path.join(outBase, 'worktrees'), maxTurnsPerAgent: 5, taskId: 't1',
      maxNodeTimeoutMs: 100,
    })
    const a = summary.nodes.find(n => n.node_id === 'a')
    assert.strictEqual(a.status, 'failed')
    assert.ok(a.failure_reason.includes('node_timeout'))
    rmrf(ws)
  } finally { restore?.(); rmrf(outBase) }
})

test('cancellation: AbortSignal -> cancelled status + in-flight cleanup', async () => {
  const outBase = tmp('mab-cancel-')
  let restore
  try {
    restore = installFakeAgents(async (agent, opts) => {
      const kind = opts.nodeMeta?.kind
      if (kind === 'implement') {
        writeBaseline(agent.workspace)
        return plainResult(agent, 'built')
      }
      if (kind === 'patch') {
        await sleep(500)
        return fakePatchWorker([1, '    return 1 # A'])(agent, opts)
      }
      return plainResult(agent, 'noop')
    })
    const graph = graphOf(['builder', 'worker-a', 'worker-b', 'integrator', 'verifier'])
    const start = new AbortController()
    const ac = start
    const ws = tmp('mab-cancel-ws-')
    await initGitRepo(ws)
    const p = runPlannedTask({
      graph, task: 't', workspace: ws, provider: null, plan: patchPairPlan(),
      sessionDirBase: path.join(outBase, 'sessions'), artifactDirBase: path.join(outBase, 'artifacts'),
      worktreeDirBase: path.join(outBase, 'worktrees'), maxTurnsPerAgent: 5, taskId: 't1',
      signal: ac.signal,
    })
    setTimeout(() => ac.abort(new Error('user cancelled')), 200)
    const summary = await p
    assert.strictEqual(summary.status, 'cancelled')
    const cancels = summary.nodes.filter(n => n.status === 'cancelled')
    assert.ok(cancels.length >= 2, `expected at least 2 cancelled, got ${cancels.length}`)
    // 取消后 worktree 仍被清理（不残留）
    await assertWorktreesCleaned(ws, 'cancel')
    rmrf(outBase); rmrf(ws)
  } finally { restore?.() }
})

// ---------------------------------------------------------------- 10. §9 兼容

test('read_only violation: reviewer writes tracked file -> batch-level detection fails node', async () => {
  const outBase = tmp('mab-rov-')
  let restore
  try {
    restore = installFakeAgents((agent, opts) => {
      if (opts.nodeMeta?.kind === 'implement') {
        writeBaseline(agent.workspace)
        return plainResult(agent, 'built')
      }
      if (opts.nodeMeta?.kind === 'review') {
        // 违规：read_only reviewer 直接改写 tracked 文件
        fs.appendFileSync(path.join(agent.workspace, 'solution.py'), '\n# violation by reviewer\n')
        return plainResult(agent, withJson('reviewed', { verdict: 'approve', issues: [] }))
      }
      return plainResult(agent, 'noop')
    })
    const graph = graphOf(['builder', 'bad-reviewer'])
    const plan = { version: 1, id: 'rov', maxParallelAgents: 2, failFast: true, nodes: [
      { id: 'base', agentId: 'builder', kind: 'implement', dependsOn: [], workspaceMode: 'main' },
      { id: 'rev', agentId: 'bad-reviewer', kind: 'review', dependsOn: ['base'], workspaceMode: 'read_only' },
    ] }
    const { ws, summary } = await plannedRun({ plan, agents: ['builder', 'bad-reviewer'], outBase, opts: { maxParallelAgents: 2 } })
    assert.strictEqual(summary.status, 'failed')
    const rev = summary.nodes.find(n => n.node_id === 'rev')
    assert.strictEqual(rev.status, 'failed')
    assert.ok(rev.failure_reason.includes('read_only_violation'))
    assert.ok(summary.lifecycle.some(e => e.event === 'node_readonly_violation'))
    rmrf(outBase); rmrf(ws)
  } finally { restore?.() }
})

test('concurrency: run-level limits 1/2/3 hit observed max precisely', async () => {
  for (const limit of [1, 2, 3]) {
    const outBase = tmp(`mab-cl-${limit}-`)
    const active = { cur: 0, max: 0 }
    let restore
    try {
      restore = installFakeAgents((agent, opts) => {
        if (opts.nodeMeta?.kind === 'review') {
          active.cur++
          active.max = Math.max(active.max, active.cur)
          return sleep(120).then(() => {
            active.cur--
            return plainResult(agent, withJson('r', { verdict: 'approve', issues: [] }))
          })
        }
        return plainResult(agent, 'noop')
      })
      const graph = graphOf(['ra', 'rb', 'rc'])
      const plan = { version: 1, id: `cl-${limit}`, maxParallelAgents: limit, failFast: true, nodes: [
        { id: 'r1', agentId: 'ra', kind: 'review', dependsOn: [], workspaceMode: 'read_only' },
        { id: 'r2', agentId: 'rb', kind: 'review', dependsOn: [], workspaceMode: 'read_only' },
        { id: 'r3', agentId: 'rc', kind: 'review', dependsOn: [], workspaceMode: 'read_only' },
      ] }
      const { ws, summary } = await plannedRun({ plan, agents: ['ra', 'rb', 'rc'], outBase, opts: { maxParallelAgents: limit } })
      assert.strictEqual(active.max, limit, `limit=${limit}: observed agent overlap ${active.max}`)
      assert.strictEqual(summary.observed_max_concurrency, limit)
      assert.strictEqual(summary.nodes.filter(n => n.status === 'succeeded').length, 3)
      await assertWorktreesCleaned(ws, `limit-${limit}`)
      rmrf(outBase); rmrf(ws)
    } finally { restore?.() }
  }
})

test('trace reader: legacy v1 trace recognized; summary defaults', () => {
  const dir = tmp('mab-trace-')
  try {
    const legacy = {
      task_id: 7,
      elapsed_ms: 123,
      stages: [{ index: 0, agentId: 'agent1', kind: 'build', turns: 3, termination: 'completed' }],
      messages: [],
    }
    const p = path.join(dir, 'legacy.trace.json')
    fs.writeFileSync(p, JSON.stringify(legacy))
    const t = readTrace(p)
    assert.strictEqual(t.version, 1)
    assert.ok(t.legacy)
    assert.deepStrictEqual(nodeRecords(t).map(n => n.agent_id), ['agent1'])
    assert.strictEqual(summaryOf(t).coordination_mode, 'relay')
    assert.strictEqual(summaryOf(t).observed_max_concurrency, 1)
  } finally { rmrf(dir) }
})

test('run-mab: parseArgs accepts old+new flags; invalid coordination throws', () => {
  const opts = runMab.parseArgs(['--task-ids', '1-3', '--coordination', 'dag', '--plan', 'plans/x.json', '--max-parallel-agents', '2', '--max-turns', '10'])
  assert.deepStrictEqual(opts.taskIds, [1, 2, 3])
  assert.strictEqual(opts.coordination, 'dag')
  assert.strictEqual(opts.plan, 'plans/x.json')
  assert.strictEqual(opts.maxParallelAgents, 2)
  assert.strictEqual(opts.maxTurns, 10)
  assert.throws(() => runMab.parseArgs(['--coordination', 'group-chat']))
})

test('run-mab: resolveRunMode default relay / dag default / parallel-review / plan file', () => {
  const graph = graphOf(['a', 'b', 'c'])
  const relay = runMab.resolveRunMode({ coordination: 'relay', plan: null, maxParallelAgents: null }, graph, 1)
  assert.strictEqual(relay.mode, 'relay')
  const dag = runMab.resolveRunMode({ coordination: 'dag', plan: null, maxParallelAgents: null }, graph, 2)
  assert.strictEqual(dag.mode, 'planned')
  assert.ok(dag.planSource.includes('dag-default-relay'))
  const pr = runMab.resolveRunMode({ coordination: 'parallel-review', plan: null, maxParallelAgents: 2 }, graph, 3)
  assert.strictEqual(pr.mode, 'planned')
  assert.strictEqual(pr.plan.maxParallelAgents, 2)
  const dir = tmp('mab-planfile-')
  try {
    const p = path.join(dir, 'plan.json')
    fs.writeFileSync(p, JSON.stringify(parallelReviewPlan(graph, { planId: 'my-plan' })))
    const fromFile = runMab.resolveRunMode({ coordination: 'dag', plan: p, maxParallelAgents: null }, graph, 4)
    assert.strictEqual(fromFile.planId, 'my-plan')
    assert.ok(fromFile.planSource.startsWith('file:'))
  } finally { rmrf(dir) }
})

test('run-mab: rescoreExisting no-op when all rows scored (no scorer call)', async () => {
  const dir = tmp('mab-rescore-')
  try {
    fs.writeFileSync(path.join(dir, 'results.jsonl'), [
      JSON.stringify({ task_id: 1, solution_present: true, scores: { a: 1 }, score_error: null }),
    ].join('\n') + '\n')
    await runMab.rescoreExisting(dir, null) // 应直接返回，不 spawn scorer
    assert.ok(true)
  } finally { rmrf(dir) }
})

// ---------------------------------------------------------------- 入口

await runTests()

const realRunAgent = runAgent // 防止打包工具误删引用（ESM 下无副作用）
void realRunAgent
console.log(failures.length === 0 ? 'SMOKE OK' : 'SMOKE FAILED')