// multiagent/minecraft/run-mc.mjs
// MultiAgentBench Minecraft 场景评测入口（MyCC harness，headless）。
//
// 任务数据：官方 multiagentbench/minecraft/minecraft_main.jsonl（100 条，每条 3 个
// 蓝本方块：cut_sandstone / terracotta / torch 竖柱，graph 协调，3 个角色）。
// 评分口径：官方 build_judger 的 block_hit_rate + precision 等，见 sim.mjs。
//
// 用法：
//   node multiagent/minecraft/run-mc.mjs --task-ids 0-4 --agents 3 --mode serial
//   node multiagent/minecraft/run-mc.mjs --task-ids 0-4 --agents 3 --mode parallel
//   node multiagent/minecraft/run-mc.mjs --task-ids 0-2 --agents 1            # solo
//   node multiagent/minecraft/run-mc.mjs --task-ids 0-4 --skip-existing
//
// 模式：
//   serial   —— 每轮按 agent1→agent2→agent3 顺序各调度一次模型调用（并行度 1）
//   parallel —— 每轮对活跃 agent 并发发起模型调用（Promise.all），世界变更由
//               sim 的同步语义保证原子；观测 wall vs sum 耗时与并发度

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MineSim } from './sim.mjs'
import { createProvider } from '../lib/providers.mjs'
import { loadEnv, responsesConfig } from '../lib/env.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const DEFAULT_DATA = path.join(ROOT, '..', 'MARBLE', 'multiagentbench', 'minecraft', 'minecraft_main.jsonl')
const DEFAULT_OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'out', 'minecraft')

function expandTaskIds(spec) {
  const ids = []
  for (const part of spec.split(',')) {
    const m = part.match(/^(\d+)(?:-(\d+))?$/)
    if (!m) throw new Error(`bad task id spec: ${part}`)
    const a = Number(m[1])
    const b = m[2] ? Number(m[2]) : a
    for (let i = a; i <= b; i++) ids.push(i)
  }
  return ids
}

function parseArgs(argv) {
  const opts = {
    data: DEFAULT_DATA,
    taskIds: [0],
    out: DEFAULT_OUT,
    agents: 3,
    mode: 'serial',
    maxRounds: 6,
    maxToolCalls: 14,
    maxTokens: 4096,
    model: null,
    skipExisting: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--data') opts.data = argv[++i]
    else if (a === '--task-ids') opts.taskIds = expandTaskIds(argv[++i])
    else if (a === '--out') opts.out = argv[++i]
    else if (a === '--agents') opts.agents = Number(argv[++i])
    else if (a === '--mode') opts.mode = argv[++i]
    else if (a === '--max-rounds') opts.maxRounds = Number(argv[++i])
    else if (a === '--max-tool-calls') opts.maxToolCalls = Number(argv[++i])
    else if (a === '--max-tokens') opts.maxTokens = Number(argv[++i])
    else if (a === '--model') opts.model = argv[++i]
    else if (a === '--skip-existing') opts.skipExisting = true
  }
  if (!['serial', 'parallel'].includes(opts.mode)) throw new Error('--mode must be serial|parallel')
  if (opts.agents !== 1 && opts.agents !== 3) throw new Error('--agents must be 1|3')
  return opts
}

// ---- 11 个官方工具（minecraft_env.py 注册集） ----

const number = { type: 'number' }
const string = { type: 'string' }
const arr = { type: 'array', items: { type: 'number' } }

export const MINE_TOOLS = [
  {
    name: 'scanNearbyEntities',
    description: 'Find minecraft item blocks creatures in a radius. If item_name is empty, list all nearby blocks.',
    input_schema: {
      type: 'object',
      properties: { item_name: string, radius: number, item_num: number },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'navigateTo',
    description: 'Move to a specific position x y z.',
    input_schema: { type: 'object', properties: { x: number, y: number, z: number }, required: ['x', 'y', 'z'], additionalProperties: false },
  },
  {
    name: 'MineBlock',
    description: 'Dig block at specific position x y z.',
    input_schema: { type: 'object', properties: { x: number, y: number, z: number }, required: ['x', 'y', 'z'], additionalProperties: false },
  },
  {
    name: 'placeBlock',
    description: "Place a specific item at specific position x y z with specific facing in one of [W, E, S, N, x, y, z, A] default is 'A'. A block cannot be placed in the air: it needs a neighboring block.",
    input_schema: {
      type: 'object',
      properties: { item_name: string, x: number, y: number, z: number, facing: string },
      required: ['item_name', 'x', 'y', 'z', 'facing'],
      additionalProperties: false,
    },
  },
  {
    name: 'equipItem',
    description: 'Equip a specific item on a specific slot or to equip item on hand,head,torso,legs,feet,off-hand.',
    input_schema: { type: 'object', properties: { slot: string, item_name: string }, required: ['slot', 'item_name'], additionalProperties: false },
  },
  {
    name: 'handoverBlock',
    description: 'Hand item to a target player you work with.',
    input_schema: {
      type: 'object',
      properties: { target_player_name: string, item_name: string, item_count: number },
      required: ['target_player_name', 'item_name', 'item_count'],
      additionalProperties: false,
    },
  },
  {
    name: 'withdrawItem',
    description: "Take out item from nearest 'chest' | 'container' | 'furnace'. The chest with materials is at [-10, -60, 0].",
    input_schema: {
      type: 'object',
      properties: { item_name: string, from_name: string, item_count: number },
      required: ['item_name', 'from_name', 'item_count'],
      additionalProperties: false,
    },
  },
  {
    name: 'erectDirtLadder',
    description: 'Helpful to place item at higher place. Erect a dirt ladder structure at specific position x y z. Remember to dismantle it after use.',
    input_schema: { type: 'object', properties: { top_x: number, top_y: number, top_z: number }, required: ['top_x', 'top_y', 'top_z'], additionalProperties: false },
  },
  {
    name: 'dismantleDirtLadder',
    description: 'Dismantle a dirt ladder structure from ground to top at specific position x y z.',
    input_schema: { type: 'object', properties: { top_x: number, top_y: number, top_z: number }, required: ['top_x', 'top_y', 'top_z'], additionalProperties: false },
  },
  {
    name: 'fetchContainerContents',
    description: "Get the details of the 'chest' | 'container' | 'furnace'. Position x y z is optional.",
    input_schema: { type: 'object', properties: { item_name: string, position: arr }, required: [], additionalProperties: false },
  },
  {
    name: 'get_environment_info',
    description: 'Get the environment information (your position, inventory, held item, nearby blocks and other agents).',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
]

// ---- blueprint 解析（task.content 内的 “*** The blueprint ***” 段） ----

const BLUEPRINT_RE = /material:\s*(\S+)\s+facing:\s*(\S+)\s+position:\s*\[(-?\d+),\s*(-?\d+),\s*(-?\d+)\]/g

export function parseBlueprint(content) {
  const out = []
  for (const m of content.matchAll(BLUEPRINT_RE)) {
    out.push({ material: m[1], facing: m[2], position: [Number(m[3]), Number(m[4]), Number(m[5])] })
  }
  return out
}

// ---- agent 单步（一次模型调用，内部连续执行工具直到模型停） ----

async function stepAgent(provider, { model, maxTokens }, agentCtx, sim, maxToolCalls) {
  const { id, system, messages } = agentCtx
  let modelCalls = 0
  let toolCalls = 0
  let ended = false
  const t0 = Date.now()

  // 团队共享黑板：告诉该 agent 其他成员的最近动作
  const updates = sim.recentPeerActions(id, 3)
  if (updates.length) {
    const note = 'TEAMMATE UPDATES:\n' + updates.map(u => `- ${u.agent} ${u.action}: ${u.message}`).join('\n')
    messages.push({ role: 'user', content: note })
    agentCtx.commUpdates += updates.length
  }

  for (;;) {
    const trimmed = messages.slice(-40)
    const res = await provider({
      system,
      messages: trimmed,
      tools: MINE_TOOLS,
      maxTokens,
    })
    modelCalls++
    agentCtx.usage.input += res.usage?.input_tokens ?? 0
    agentCtx.usage.output += res.usage?.output_tokens ?? 0
    agentCtx.usage.calls++

    const calls = (res.content ?? []).filter(b => b.type === 'tool_use')
    if (!calls.length) {
      messages.push({ role: 'assistant', content: res.content?.find(b => b.type === 'text')?.text ?? '' })
      ended = true
      break
    }
    messages.push({ role: 'assistant', content: res.content })

    for (const call of calls) {
      toolCalls++
      if (toolCalls > maxToolCalls) break
      let result
      try {
        result = sim.applyAction(id, call.name, call.input ?? {})
      } catch (e) {
        result = { status: false, message: `error: ${e.message}` }
      }
      messages.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: call.id,
          content: `[${call.name} result: status=${result.status}] ${result.message}`,
        }],
      })
      agentCtx.toolCalls++
    }
    if (toolCalls > maxToolCalls) { ended = true; break }
  }
  agentCtx.elapsed = Date.now() - t0
  return { ended, modelCalls, toolCalls }
}

function buildSystem(agent, task) {
  const profile = agent.profile || `${agent.agent_id} is a team member.`
  const peerNames = (task.agents ?? []).filter(a => a.agent_id !== agent.agent_id).map(a => a.agent_id).join(', ')
  return `${task.task.content}

Your identity: ${agent.agent_id}
Your profile: ${profile}
Team members: ${peerNames || 'you are alone'}

RULES:
- You MUST take concrete actions via tools this round; do not just reply with text.
- Materials for the blueprint are in the chest at [-10, -60, 0]. Use fetchContainerContents/withdrawItem to inspect and get them.
- A block cannot be placed in the air: place bottom-up or use erectDirtLadder for auxiliary support and dismantleDirtLadder after use.
- Do not modify or remove blocks placed by other agents without permission.
- Mark the task complete (stop calling tools) only when every blueprint block is placed.`
}

function simFinished(sim) {
  if (sim.blockHitRate() !== 1) return false
  for (const [k, b] of sim.world) if (b.aux) return false
  return true
}

async function runTask(task, idx, opts, provider, cfgModel) {
  const blueprint = parseBlueprint(task.task.content)
  const agents = (opts.agents === 1 ? [task.agents[0]] : task.agents).slice(0, opts.agents)
  const sim = new MineSim({ blueprint, agents })

  const ctxs = new Map()
  for (const a of agents) {
    ctxs.set(a.agent_id, {
      id: a.agent_id,
      system: buildSystem(a, task),
      messages: [{ role: 'user', content: 'Begin now. Work toward completing the blueprint.' }],
      usage: { calls: 0, input: 0, output: 0 },
      toolCalls: 0,
      commUpdates: 0,
      elapsed: 0,
    })
  }

  let rounds = 0
  let wallStart = Date.now()
  let observedMaxConcurrency = 1
  const roundRecs = []

  for (let r = 0; r < opts.maxRounds; r++) {
    const active = agents.filter(a => !ctxs.get(a.agent_id).ended)
    if (!active.length) break
    rounds = r + 1
    const r0 = Date.now()
    let endedFlags
    if (opts.mode === 'parallel') {
      observedMaxConcurrency = Math.max(observedMaxConcurrency, active.length)
      const results = await Promise.all(active.map(a => stepAgent(provider, opts, ctxs.get(a.agent_id), sim, opts.maxToolCalls)))
      endedFlags = results
    } else {
      const results = []
      for (const a of active) results.push(await stepAgent(provider, opts, ctxs.get(a.agent_id), sim, opts.maxToolCalls))
      endedFlags = results
    }
    active.forEach((a, i) => { ctxs.get(a.agent_id).ended = endedFlags[i].ended })
    roundRecs.push({ round: r + 1, wallMs: Date.now() - r0, active: active.length, agents: active.map(a => a.agent_id) })

    if (simFinished(sim)) break
    // 全体结束且这一轮没有任何动作 → 直接停
    const acted = active.some(a => ctxs.get(a.agent_id).toolCalls > (ctxs.get(a.agent_id)._baseTool ?? 0))
    active.forEach(a => { ctxs.get(a.agent_id)._baseTool = ctxs.get(a.agent_id).toolCalls })
    if (endedFlags.every(f => f.ended) && !acted) break
  }

  const wallMs = Date.now() - wallStart
  const sumMs = Array.from(ctxs.values()).reduce((s, c) => s + c.elapsed, 0)
  const hit = sim.blockHitRate()
  const prec = sim.precision()
  const perAgentHits = sim.perAgentHits()
  const auxRemaining = Array.from(sim.world.values()).filter(b => b.aux).length

  const perAgent = {}
  for (const a of agents) {
    const c = ctxs.get(a.agent_id)
    perAgent[a.agent_id] = {
      rounds: rounds,
      model_calls: c.usage.calls,
      tool_calls: c.toolCalls,
      placed: sim.agents[a.agent_id].placed.length,
      hits: perAgentHits[a.agent_id] ?? 0,
      elapsed_ms: c.elapsed,
      tokens: c.usage.input + c.usage.output,
      comm_updates: c.commUpdates,
    }
  }

  const communication = {
    // 团队通信机制观测：黑板广播条数 / 各 agent 消费的队友更新 / 显式物资交接 /
    // 共享世界冲突（占位被拒、移除他人方块）
    bulletin_events: sim.bulletin.length,
    team_updates_consumed: Array.from(ctxs.values()).reduce((s, c) => s + c.commUpdates, 0),
    handovers: sim.stats.handovers,
    conflicts: sim.stats.conflicts,
    blocks_removed_by_others: sim.stats.blocksRemovedByOthers,
    comm_log: sim.bulletin.slice(-40).map(e => ({ agent: e.agent, action: e.action, message: e.message })),
  }

  return {
    task_id: idx,
    agents_count: agents.length,
    agents: agents.map(a => a.agent_id),
    mode: opts.mode,
    rounds,
    wall_clock_elapsed_ms: wallMs,
    sum_agent_elapsed_ms: sumMs,
    observed_max_concurrency: observedMaxConcurrency,
    block_hit_rate: hit,
    precision: prec.precision,
    placed_non_aux: prec.placedNonAux,
    aux_remaining: auxRemaining,
    blueprint_blocks: blueprint.length,
    blueprint: blueprint,
    per_agent: perAgent,
    communication,
    round_records: roundRecs,
    tokens: {
      calls: Array.from(ctxs.values()).reduce((s, c) => s + c.usage.calls, 0),
      total: Array.from(ctxs.values()).reduce((s, c) => s + c.usage.input + c.usage.output, 0),
    },
  }
}

// ---- 汇总报告 ----

function summarize(results, outDir) {
  const buckets = {}
  for (const r of results) {
    const k = `${r.agents_count}agent-${r.mode}`
    ;(buckets[k] ??= []).push(r)
  }
  const lines = ['# MultiAgentBench Minecraft 评测报告（MyCC headless harness）', '']
  lines.push(`- 任务数据：${DEFAULT_DATA}`)
  lines.push(`- 模型：${responsesConfig(loadEnv()).model}`)
  lines.push(`- 评分口径：官方 build_judger.block_hit_rate（名字+facing，facing=A 只看名字）+ precision`)
  lines.push('')
  lines.push('| 配置 | 任务数 | 平均 hit_rate | 平均 precision | 平均 rounds | 平均 wall(ms) | 平均 sum(ms) | 最大并发 |')
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |')
  for (const [k, rs] of Object.entries(buckets)) {
    const avg = f => (rs.reduce((s, r) => s + r[f], 0) / rs.length).toFixed(4)
    const avgWall = Math.round(rs.reduce((s, r) => s + r.wall_clock_elapsed_ms, 0) / rs.length)
    const avgSum = Math.round(rs.reduce((s, r) => s + r.sum_agent_elapsed_ms, 0) / rs.length)
    const conc = Math.max(...rs.map(r => r.observed_max_concurrency))
    lines.push(`| ${k} | ${rs.length} | ${avg('block_hit_rate')} | ${avg('precision')} | ${avg('rounds')} | ${avgWall} | ${avgSum} | ${conc} |`)
  }
  lines.push('')
  lines.push('| task | 配置 | hit_rate | precision | placed | aux_left | rounds | wall(ms) | sum(ms) | 并发 | per-agent hits |')
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
  for (const r of results) {
    if (r.error || !r.per_agent) {
      lines.push(`| ${r.task_id} | ${r.agents_count}agent-${r.mode} | FAILED: ${r.error ?? '(no result)'} |`)
      continue
    }
    const ph = Object.entries(r.per_agent).map(([id, v]) => `${id}:${v.hits}/${v.placed}`).join(' ')
    lines.push(`| ${r.task_id} | ${r.agents_count}agent-${r.mode} | ${r.block_hit_rate.toFixed(4)} | ${r.precision.toFixed(4)} | ${r.placed_non_aux} | ${r.aux_remaining} | ${r.rounds} | ${r.wall_clock_elapsed_ms} | ${r.sum_agent_elapsed_ms} | ${r.observed_max_concurrency} | ${ph} |`)
  }
  lines.push('')
  return lines.join('\n')
}

// ---- main ----

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  fs.mkdirSync(opts.out, { recursive: true })
  const data = fs.readFileSync(opts.data, 'utf8').trim().split('\n').map(JSON.parse)
  const resultsFile = path.join(opts.out, 'results.jsonl')
  const existing = new Set()
  if (fs.existsSync(resultsFile)) {
    for (const l of fs.readFileSync(resultsFile, 'utf8').trim().split('\n')) {
      if (l) { const r = JSON.parse(l); existing.add(`${r.task_id}|${r.agents_count}|${r.mode}`) }
    }
  }

  const cfg = responsesConfig(loadEnv())
  const provider = createProvider({ model: opts.model ?? null })
  const modelName = opts.model ?? cfg.model
  console.log(`[run-mc] model=${modelName} data=${opts.data}`)
  console.log(`[run-mc] tasks=[${opts.taskIds.join(',')}] agents=${opts.agents} mode=${opts.mode} maxRounds=${opts.maxRounds}`)

  const results = []
  for (const idx of opts.taskIds) {
    const recKey = `${idx}|${opts.agents}|${opts.mode}`
    if (opts.skipExisting && existing.has(recKey)) {
      console.log(`[run-mc] skip existing task ${idx} (${recKey})`)
      const l = fs.readFileSync(resultsFile, 'utf8').trim().split('\n').map(JSON.parse).find(r => `${r.task_id}|${r.agents_count}|${r.mode}` === recKey)
      results.push(l)
      continue
    }
    const task = data[idx]
    if (!task) throw new Error(`task ${idx} out of range (${data.length})`)
    console.log(`[run-mc] task ${idx}: ${task.agents.length} agents, coordinate=${task.coordinate_mode}, blueprint=${JSON.stringify(parseBlueprint(task.task.content).map(b => b.material))} ...`)
    const t0 = Date.now()
    try {
      const res = await runTask(task, idx, opts, provider, modelName)
      res.result_file = resultsFile
      results.push(res)
      fs.appendFileSync(resultsFile, JSON.stringify(res) + '\n')
      console.log(`  -> hit_rate=${res.block_hit_rate.toFixed(4)} precision=${res.precision.toFixed(4)} wall=${res.wall_clock_elapsed_ms}ms sum=${res.sum_agent_elapsed_ms}ms conc=${res.observed_max_concurrency} (${Date.now() - t0}ms total)`)
    } catch (e) {
      console.error(`  -> task ${idx} FAILED: ${e.stack ?? e}`)
      const fail = { task_id: idx, agents_count: opts.agents, mode: opts.mode, error: String(e?.message ?? e) }
      results.push(fail)
      fs.appendFileSync(resultsFile, JSON.stringify(fail) + '\n')
    }
  }

  const report = summarize(results, opts.out)
  fs.writeFileSync(path.join(opts.out, 'REPORT.md'), report)
  console.log('\n' + report)
  console.log(`\n[run-mc] results -> ${resultsFile}`)
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  main().catch(e => { console.error(e); process.exit(1) })
}