// multiagent/run-mab.mjs
// MultiAgentBench 评测主入口（MyCC 多智能体 harness）：
//   1. 从官方数据 (multiagentbench/coding/coding_main.jsonl) 读任务
//   2. 用编排层（AgentGraph + 顺序接力协调）驱动多个 MyCC agent 在共享工作区完成编程任务
//   3. 保存 solution 与 trace
//   4. 用官方口径 scorer 对 solution.py 打 4 维分数
//   5. 汇总 results.jsonl
//
// 用法:
//   node multiagent/run-mab.mjs --task-ids 1 --max-turns 30 --out multiagent/out
//   node multiagent/run-mab.mjs --task-ids 1-3 --max-turns 20
// 断点续跑（跳过 results.jsonl 已存在的任务）:
//   node multiagent/run-mab.mjs --task-ids 1-100 --max-turns 25 --skip-existing
// 仅对已有 solution 但无分数的记录重新评分（不重跑 agent）:
//   node multiagent/run-mab.mjs --rescore
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { AgentGraph, runRelayTask } from './lib/coordinator.mjs'
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
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--data') opts.data = argv[++i]
    else if (a === '--task-ids') opts.taskIds = expandTaskIds(argv[++i])
    else if (a === '--out') opts.out = argv[++i]
    else if (a === '--max-turns') opts.maxTurns = Number(argv[++i])
    else if (a === '--judge-model') opts.judgeModel = argv[++i]
    else if (a === '--skip-existing') opts.skipExisting = true
    else if (a === '--rescore') opts.rescore = true
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

// 准备共享工作区：git init + 初始 commit（让 agent 的 diff/patch 可收集）
function initGitRepo(dir) {
  const g = (args) => spawnSync('git', args, { cwd: dir, stdio: 'ignore' })
  g(['init', '-q'])
  g(['checkout', '-q', '-b', 'main'])
  g(['add', '-A'])
  g(['-c', 'user.email=mycc@local', '-c', 'user.name=mycc', 'commit', '-q', '-m', 'init'])
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

async function runOne({ task, taskId, opts, provider, outDir }) {
  const workDir = path.join(outDir, 'work', String(taskId))
  const solDir = path.join(outDir, 'solutions', String(taskId))
  fs.mkdirSync(workDir, { recursive: true })
  fs.mkdirSync(solDir, { recursive: true })
  // 干净起步：清空工作区再 git 初始化
  for (const e of fs.readdirSync(workDir)) {
    if (e === '.git') continue
    fs.rmSync(path.join(workDir, e), { recursive: true, force: true })
  }
  initGitRepo(workDir)

  const graph = AgentGraph.fromConfig(task.agents ?? [], task.relationships ?? [])
  const started = Date.now()
  const summary = await runRelayTask({
    graph,
    task: task.task?.content ?? '',
    workspace: workDir,
    provider,
    maxTurnsPerAgent: opts.maxTurns,
  })
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

  // trace
  const tracePath = path.join(outDir, 'traces', `${taskId}.trace.json`)
  fs.mkdirSync(path.dirname(tracePath), { recursive: true })
  fs.writeFileSync(tracePath, JSON.stringify({
    task_id: taskId,
    elapsed_ms: elapsedMs,
    stages: summary.stages.map(s => ({
      index: s.index,
      agentId: s.agentId,
      kind: s.kind,
      turns: s.result.turns,
      termination: s.result.termination,
      finalText: s.result.finalText,
      transcript: s.result.transcript,
      diff: s.result.diff,
    })),
    messages: summary.messageList,
  }, null, 2))

  // 评分
  const taskJsonPath = path.join(outDir, 'work', String(taskId), '_task.json')
  fs.writeFileSync(taskJsonPath, JSON.stringify(task))
  const scored = solutionPresent
    ? await scoreSolution(taskJsonPath, solutionSrc, opts.judgeModel)
    : { error: 'solution.py missing' }

  const record = {
    task_id: taskId,
    agents: task.agents?.map(a => a.agent_id) ?? [],
    coordinate_mode: task.coordinate_mode ?? 'relay',
    elapsed_ms: elapsedMs,
    total_turns: summary.stages.reduce((n, s) => n + (s.result.turns ?? 0), 0),
    per_agent_turns: summary.stages.map(s => ({ agent_id: s.agentId, turns: s.result.turns, termination: s.result.termination })),
    solution_present: solutionPresent,
    solution_path: solutionCopiedTo,
    scores: scored.scores ?? null,
    score_error: scored.error ?? null,
    judge_usage: scored.usage ?? null,
  }
  const resultsPath = path.join(outDir, 'results.jsonl')
  fs.appendFileSync(resultsPath, JSON.stringify(record) + '\n')

  console.log(`[task ${taskId}] agents=${record.agents.length} turns=${record.total_turns} elapsed=${(elapsedMs / 1000).toFixed(0)}s ` +
    `scores=${record.scores ? JSON.stringify(record.scores) : (record.score_error ?? 'n/a')} sol=${record.solution_present}`)
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
    console.error('usage: node multiagent/run-mab.mjs --task-ids 1-3 [--data PATH] [--out DIR] [--max-turns N] [--judge-model M] [--skip-existing]')
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
      records.push(await runOne({ task, taskId: id, opts, provider, outDir: opts.out }))
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

main().catch(e => { console.error('run-mab error:', e); process.exit(1) })