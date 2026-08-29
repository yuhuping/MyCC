// multiagent/run-mab.mjs
// MultiAgentBench 评测主入口（MyCC 多智能体 harness）：
//   1. 从官方数据 (multiagentbench/coding/coding_main.jsonl) 读任务
//   2. 编排层驱动多个 MyCC agent：
//        - 默认 / --coordination relay：顺序接力（历史基线，格式兼容）
//        - --coordination parallel-review / dag 或 --plan <file>：
//          显式 execution plan（runPlannedTask：ready set 并发、worktree 隔离、
//          确定性集成、生命周期 trace）
//   3. 保存 solution 与 trace（新版 trace 保留旧字段，只追加）
//   4. 用官方口径 scorer 对 solution.py 打 4 维分数
//   5. 汇总 results.jsonl（旧字段不变，仅追加新观测字段；--rescore 兼容）
//
// 用法:
//   node multiagent/run-mab.mjs --task-ids 1 --max-turns 30 --out multiagent/out
//   node multiagent/run-mab.mjs --task-ids 1-3 --max-turns 20
//   node multiagent/run-mab.mjs --task-ids 1-5 --coordination parallel-review --max-parallel-agents 3
//   node multiagent/run-mab.mjs --task-ids 1-5 --coordination dag --plan plans/coding-dag-v1.json
// 断点续跑（跳过 results.jsonl 已存在的任务）:
//   node multiagent/run-mab.mjs --task-ids 1-100 --max-turns 25 --skip-existing
// 仅对已有 solution 但无分数的记录重新评分（不重跑 agent）:
//   node multiagent/run-mab.mjs --rescore
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { AgentGraph, runRelayTask, runPlannedTask } from './lib/coordinator.mjs'
import { defaultRelayPlan, parallelReviewPlan, validatePlan } from './lib/execution-plan.mjs'
import { initGitRepo } from './lib/worktree.mjs'
import { createProvider } from './lib/providers.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_DATA = path.join(ROOT, '..', 'MARBLE', 'multiagentbench', 'coding', 'coding_main.jsonl')

function parseArgs(argv) {
  const opts = {
    data: DEFAULT_DATA,
    taskIds: [],
    out: path.join(path.dirname(fileURLToPath(import.meta.url)), 'out'),
    maxTurns: 30,
    judgeModel: null,
    skipExisting: false,
    rescore: false,
    coordination: 'relay', // relay | parallel-review | dag
    plan: null, // --plan <path> 显式 execution plan JSON
    maxParallelAgents: null,
    repairLoops: 1, // verify 失败的修复回路轮数（仅 planned 模式生效）
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--data') opts.data = argv[++i]
    else if (a === '--task-ids') opts.taskIds = expandTaskIds(argv[++i])
    else if (a === '--out') opts.out = path.resolve(argv[++i])
    else if (a === '--max-turns') opts.maxTurns = Number(argv[++i])
    else if (a === '--judge-model') opts.judgeModel = argv[++i]
    else if (a === '--skip-existing') opts.skipExisting = true
    else if (a === '--rescore') opts.rescore = true
    else if (a === '--coordination') opts.coordination = argv[++i]
    else if (a === '--plan') opts.plan = argv[++i]
    else if (a === '--max-parallel-agents') opts.maxParallelAgents = Number(argv[++i])
    else if (a === '--repair-loops') opts.repairLoops = Number(argv[++i])
  }
  if (!['relay', 'parallel-review', 'dag'].includes(opts.coordination)) {
    throw new Error(`--coordination must be one of relay|parallel-review|dag (got ${opts.coordination})`)
  }
  return opts
}

function expandTaskIds(spec) {
  const out = []
  for (const part of String(spec).split(',')) {
    const m = part.match(/^(\d+)(?:-(\d+))?$/)
    if (!m) continue
    if (m[2]) {
      for (let i = Number(m[1]); i <= Number(m[2]); i++) out.push(i)
    } else {
      out.push(Number(m[1]))
    }
  }
  return [...new Set(out)]
}

function loadTasks(dataPath) {
  const tasks = new Map()
  for (const line of fs.readFileSync(dataPath, 'utf8').split('\n')) {
    if (!line.trim()) continue
    const t = JSON.parse(line)
    tasks.set(Number(t.task_id), t)
  }
  return tasks
}

/** 解析执行模式：返回 { mode: 'relay' | 'planned', plan, planSource, planId } */
function resolveRunMode(opts, graph, taskId) {
  const maxParallelAgents = opts.maxParallelAgents ?? null
  if (opts.plan) {
    const raw = JSON.parse(fs.readFileSync(opts.plan, 'utf8'))
    return { mode: 'planned', plan: raw, planSource: `file:${opts.plan}`, planId: raw.id ?? path.basename(opts.plan, '.json') }
  }
  if (opts.coordination === 'parallel-review') {
    const plan = parallelReviewPlan(graph, { planId: `parallel-review-${taskId}`, maxParallelAgents: maxParallelAgents ?? 3 })
    return { mode: 'planned', plan, planSource: 'generated:parallel-review', planId: plan.id }
  }
  if (opts.coordination === 'dag') {
    // 无 --plan 的 dag 模式 = 默认三步 plan（Audit §4：这就是 relay，保持可比）；
    // 真实并行 DAG 必须带独立 --plan <file>。
    const plan = defaultRelayPlan(graph, { planId: `dag-${taskId}`, maxParallelAgents: maxParallelAgents ?? 1 })
    return { mode: 'planned', plan, planSource: 'generated:dag-default-relay', planId: plan.id }
  }
  return { mode: 'relay', plan: null, planSource: null, planId: null }
}

function scoreSolution(taskJsonPath, solutionPath, judgeModel) {
  return new Promise((resolve) => {
    // 不传 --out：scorer 会把紧凑 JSON 写到 stdout 末尾行，解析最稳（避免 /dev/stdout 双写竞态）
    const args = ['multiagent/scorer.mjs', '--task-json', taskJsonPath, '--solution', solutionPath]
    if (judgeModel) args.push('--judge-model', judgeModel)
    const child = spawn('node', args, { cwd: ROOT })
    let out = ''
    child.stdout.on('data', d => { out += d })
    child.stderr.on('data', () => {})
    child.on('close', code => {
      if (code !== 0) return resolve({ error: `scorer exit ${code}` })
      try {
        resolve(JSON.parse(out.trim().split('\n').at(-1)))
      } catch {
        resolve({ error: 'scorer output parse failed', raw: out.slice(0, 200) })
      }
    })
  })
}

async function runOne({ task, taskId, opts, provider, outDir, runMode }) {
  const workDir = path.join(outDir, 'work', String(taskId))
  const solDir = path.join(outDir, 'solutions', String(taskId))
  fs.mkdirSync(workDir, { recursive: true })
  fs.mkdirSync(solDir, { recursive: true })
  // 干净起步：清空工作区再 git 初始化（initGitRepo 是异步实现，必须等待，
  // 否则 runPlannedTask 会对同一目录并发 git init 触发模板复制竞态）
  for (const e of fs.readdirSync(workDir)) {
    if (e === '.git') continue
    fs.rmSync(path.join(workDir, e), { recursive: true, force: true })
  }
  await initGitRepo(workDir)

  const graph = AgentGraph.fromConfig(task.agents ?? [], task.relationships ?? [])
  const started = Date.now()
  let summary
  if (runMode.mode === 'relay') {
    summary = await runRelayTask({
      graph,
      task: task.task?.content ?? '',
      workspace: workDir,
      provider,
      maxTurnsPerAgent: opts.maxTurns,
    })
  } else {
    // 显式执行 plan：worktree 隔离 + 确定性集成 + 生命周期 trace
    validatePlan(runMode.plan, graph) // provider 调用前 fail-fast
    summary = await runPlannedTask({
      graph,
      task: task.task?.content ?? '',
      workspace: workDir,
      provider,
      plan: runMode.plan,
      sessionDirBase: path.join(outDir, 'sessions', String(taskId)),
      artifactDirBase: path.join(outDir, 'artifacts', String(taskId)),
      worktreeDirBase: path.join(outDir, 'worktrees', String(taskId)),
      maxTurnsPerAgent: opts.maxTurns,
      maxParallelAgents: opts.maxParallelAgents ?? null,
      repairLoops: opts.repairLoops ?? 1,
      taskId,
    })
  }
  const elapsedMs = Date.now() - started

  // 保存 solution.py（可能不在根目录时记录清点结果）
  const solutionSrc = path.join(workDir, 'solution.py')
  const solutionPresent = fs.existsSync(solutionSrc)
  let solutionCopiedTo = null
  if (solutionPresent) {
    const dest = path.join(solDir, 'solution.py')
    fs.copyFileSync(solutionSrc, dest)
    solutionCopiedTo = dest
  }

  // trace（v2 追加字段，旧字段保留；relay 保持 v1 兼容）
  const tracePath = path.join(outDir, 'traces', `${taskId}.trace.json`)
  fs.mkdirSync(path.dirname(tracePath), { recursive: true })
  const stages = summary.stages
    ? summary.stages.map(s => ({
        index: s.index,
        agentId: s.agentId,
        kind: s.kind,
        startedAt: s.startedAt ?? null,
        endedAt: s.endedAt ?? null,
        elapsedMs: s.elapsedMs ?? null,
        turns: s.result.turns,
        termination: s.result.termination,
        finalText: s.result.finalText,
        transcript: s.result.transcript,
        diff: s.result.diff,
      }))
    : (summary.nodes ?? []).map(n => ({
        index: n.trace_index,
        nodeId: n.node_id,
        agentId: n.agent_id,
        kind: n.kind,
        status: n.status,
        startedAt: n.started_at,
        endedAt: n.ended_at,
        elapsedMs: n.elapsed_ms,
        turns: n.agent?.turns ?? null,
        termination: n.agent?.termination ?? null,
        finalText: n.agent?.finalText ?? '',
        transcript: n.agent?.transcript ?? [],
      }))
  const trace = summary.plan
    ? {
        version: 2,
        task_id: taskId,
        plan_id: summary.plan_id,
        plan: summary.plan,
        plan_source: runMode.planSource,
        coordination_mode: summary.coordination_mode,
        elapsed_ms: summary.wall_clock_elapsed_ms ?? elapsedMs,
        wall_clock_elapsed_ms: summary.wall_clock_elapsed_ms,
        sum_agent_elapsed_ms: summary.sum_agent_elapsed_ms,
        observed_max_concurrency: summary.observed_max_concurrency,
        main_write_max_concurrency: summary.main_write_max_concurrency,
        integration_status: summary.integration_status,
        baseline_commit: summary.baseline_commit,
        cleanup_failures: summary.cleanup_failures,
        stages,
        nodes: summary.nodes,
        lifecycle: summary.lifecycle,
        messages: summary.messageList,
      }
    : {
        task_id: taskId,
        elapsed_ms: elapsedMs,
        coordination_mode: summary.coordination_mode,
        observed_max_concurrency: summary.observed_max_concurrency,
        wall_clock_elapsed_ms: summary.wall_clock_elapsed_ms,
        sum_agent_elapsed_ms: summary.sum_agent_elapsed_ms,
        main_write_max_concurrency: summary.main_write_max_concurrency,
        stages,
        messages: summary.messageList,
      }
  fs.writeFileSync(tracePath, JSON.stringify(trace, null, 2))

  // 评分
  const taskJsonPath = path.join(outDir, 'work', String(taskId), '_task.json')
  fs.writeFileSync(taskJsonPath, JSON.stringify(task))
  const scored = solutionPresent
    ? await scoreSolution(taskJsonPath, solutionSrc, opts.judgeModel)
    : { error: 'solution.py missing' }

  const perAgent = summary.stages
    ? summary.stages.map(s => ({ agent_id: s.agentId, turns: s.result.turns, termination: s.result.termination }))
    : (summary.nodes ?? []).map(n => ({ node_id: n.node_id, agent_id: n.agent_id, turns: n.agent?.turns ?? null, termination: n.agent?.termination ?? null, status: n.status }))
  const record = {
    task_id: taskId,
    agents: task.agents?.map(a => a.agent_id) ?? [],
    coordinate_mode: task.coordinate_mode ?? 'relay',
    elapsed_ms: summary.wall_clock_elapsed_ms ?? elapsedMs,
    total_turns: perAgent.reduce((n, s) => n + (s.turns ?? 0), 0),
    per_agent_turns: perAgent,
    solution_present: solutionPresent,
    solution_path: solutionCopiedTo,
    scores: scored.scores ?? null,
    score_error: scored.error ?? null,
    judge_usage: scored.usage ?? null,
    // Phase 0+ 追加观测字段（旧字段不变，--rescore 兼容）
    coordination_mode: summary.coordination_mode,
    plan_id: summary.plan_id ?? null,
    plan_source: runMode.planSource ?? null,
    observed_max_concurrency: summary.observed_max_concurrency ?? 1,
    wall_clock_elapsed_ms: summary.wall_clock_elapsed_ms ?? elapsedMs,
    sum_agent_elapsed_ms: summary.sum_agent_elapsed_ms ?? null,
    main_write_max_concurrency: summary.main_write_max_concurrency ?? 1,
    integration_status: summary.integration_status ?? null,
    baseline_commit: summary.baseline_commit ?? null,
    cleanup_failures: summary.cleanup_failures ?? [],
    // 团队通信信道观测（Lead↔Worker / Worker↔Worker）
    team_message_count: summary.team_message_count ?? 0,
    team_read_count: summary.team_read_count ?? 0,
    team_messages: (summary.team_messages ?? []).map(m => ({ seq: m.seq, from: m.from, to: m.to, message: m.message })),
  }
  const resultsPath = path.join(outDir, 'results.jsonl')
  fs.appendFileSync(resultsPath, JSON.stringify(record) + '\n')

  console.log(`[task ${taskId}] mode=${runMode.mode} agents=${record.agents.length} turns=${record.total_turns} elapsed=${(record.elapsed_ms / 1000).toFixed(0)}s ` +
    `concurrency=${record.observed_max_concurrency} team_msgs=${record.team_message_count ?? 0} scores=${record.scores ? JSON.stringify(record.scores) : (record.score_error ?? 'n/a')} sol=${record.solution_present} integration=${record.integration_status ?? 'n/a'}`)
  return record
}

// 仅重新评分：遍历 results.jsonl 里已有 solution 但无分数的记录，回填分数（不重跑 agent）。
// 同 task_id 的多条历史记录只评一次，统一回填。
async function rescoreExisting(outDir, judgeModel) {
  const resultsPath = path.join(outDir, 'results.jsonl')
  if (!fs.existsSync(resultsPath)) { console.error('no results.jsonl at', resultsPath); return }
  const rows = fs.readFileSync(resultsPath, 'utf8').split('\n').filter(Boolean).map(JSON.parse)
  const byId = new Map()
  for (const row of rows) {
    if (row.scores || !row.solution_present) continue
    if (!byId.has(row.task_id)) byId.set(row.task_id, [])
    byId.get(row.task_id).push(row)
  }
  if (byId.size === 0) { console.log('没有需要重评的记录（全部已有分数或无 solution）'); return }
  let ok = 0, fail = 0
  for (const [id, targets] of byId) {
    const taskJsonPath = path.join(outDir, 'work', String(id), '_task.json')
    const solutionPath = path.join(outDir, 'solutions', String(id), 'solution.py')
    if (!fs.existsSync(taskJsonPath) || !fs.existsSync(solutionPath)) {
      console.log(`[rescore ${id}] _task.json 或 solution.py 缺失,跳过（须重跑 agent）`)
      continue
    }
    const scored = await scoreSolution(taskJsonPath, solutionPath, judgeModel)
    if (scored.scores && !scored.error) {
      for (const t of targets) { t.scores = scored.scores; t.score_error = null; t.judge_usage = scored.usage }
      ok++
      console.log(`[rescore ${id}] -> ${JSON.stringify(scored.scores)}`)
    } else {
      fail++
      console.log(`[rescore ${id}] 仍失败: ${scored.error ?? 'scores=null'}`)
    }
  }
  fs.writeFileSync(resultsPath, rows.map(r => JSON.stringify(r)).join('\n') + '\n')
  console.log(`rescore 完成: ok=${ok} fail=${fail}`)
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.rescore) {
    await rescoreExisting(opts.out, opts.judgeModel)
    return
  }
  if (opts.taskIds.length === 0) {
    console.error('usage: node multiagent/run-mab.mjs --task-ids 1-3 [--data PATH] [--out DIR] [--max-turns N] [--judge-model M] [--skip-existing] [--coordination relay|parallel-review|dag] [--plan PATH] [--max-parallel-agents N]')
    process.exit(2)
  }
  fs.mkdirSync(opts.out, { recursive: true })
  const tasks = loadTasks(opts.data)
  const provider = createProvider()
  const records = []
  for (const id of opts.taskIds) {
    const task = tasks.get(id)
    if (!task) { console.error(`task ${id} not found in ${opts.data}`); continue }
    const resultsPath = path.join(opts.out, 'results.jsonl')
    if (opts.skipExisting && fs.existsSync(resultsPath)) {
      const existing = fs.readFileSync(resultsPath, 'utf8').split('\n').filter(Boolean).map(JSON.parse)
      if (existing.some(r => r.task_id === id)) { console.log(`[task ${id}] skip (existing)`); continue }
    }
    try {
      const graph = AgentGraph.fromConfig(task.agents ?? [], task.relationships ?? [])
      const runMode = resolveRunMode(opts, graph, id)
      records.push(await runOne({ task, taskId: id, opts, provider, outDir: opts.out, runMode }))
    } catch (e) {
      console.error(`[task ${id}] FAILED:`, e.message)
      const resultsPathTmp = path.join(opts.out, 'results.jsonl')
      fs.appendFileSync(resultsPathTmp, JSON.stringify({ task_id: id, error: e.message }) + '\n')
    }
  }

  // 汇总表
  const all = fs.existsSync(path.join(opts.out, 'results.jsonl'))
    ? fs.readFileSync(path.join(opts.out, 'results.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse)
    : []
  const scored = all.filter(r => r.scores)
  if (scored.length) {
    const avg = k => scored.reduce((s, r) => s + (r.scores[k] ?? 0), 0) / scored.length
    console.log('\n=== 汇总（judge=official code_quality prompt, via MyCC Responses 链路）===')
    console.log('tasks scored:', scored.length, '| 平均分: ' + Object.keys(scored[0].scores).map(k => `${k}=${avg(k).toFixed(2)}`).join(' '))
  }
  console.log('results:', path.join(opts.out, 'results.jsonl'))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error('run-mab error:', e); process.exit(1) })
}

export { parseArgs, resolveRunMode, rescoreExisting, runOne }