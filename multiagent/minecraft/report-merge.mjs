// multiagent/minecraft/report-merge.mjs
// 合并多个 run-mc 输出目录的 results.jsonl，生成单一组合 REPORT.md。
// 用法：node multiagent/minecraft/report-merge.mjs <outA> <outB> ... > REPORT.md
//       （或直接运行：合并 multiagent/out/minecraft/{solo,trio-serial,trio-parallel}）
import fs from 'node:fs'
import path from 'node:path'

const baseDir = path.resolve(process.argv[2] ?? path.join('multiagent', 'out', 'minecraft'))
const dirs = process.argv.slice(3).length
  ? process.argv.slice(3)
  : ['solo', 'trio-serial', 'trio-parallel'].filter(d => fs.existsSync(path.join(baseDir, d)))

const results = []
for (const d of dirs) {
  const f = path.join(baseDir, d, 'results.jsonl')
  if (!fs.existsSync(f)) continue
  for (const l of fs.readFileSync(f, 'utf8').trim().split('\n')) {
    if (l) results.push(JSON.parse(l))
  }
}

const ok = results.filter(r => !r.error)
const buckets = {}
for (const r of ok) {
  const k = `${r.agents_count}agent-${r.mode}`
  ;(buckets[k] ??= []).push(r)
}

const lines = ['# MultiAgentBench Minecraft 综合评测报告（MyCC headless harness）', '']
lines.push(`- 汇总来源：${dirs.join(', ')}（共 ${results.length} 次运行，${results.length - ok.length} 次失败）`)
lines.push('- 任务数据：MARBLE/multiagentbench/minecraft/minecraft_main.jsonl（官方发布，100 条同构 3 块蓝本：cut_sandstone / terracotta / torch 竖柱，graph 协调）')
lines.push('- 评分口径：官方 build_judger.block_hit_rate（坐标+名字+facing，facing=A 只看名字）+ precision（放置的非辅助方块中命中蓝本的比例）')
lines.push('')
lines.push('## 分配置汇总')
lines.push('')
lines.push('| 配置 | 任务数 | 平均 hit_rate | 平均 precision | 平均 rounds | 平均 wall(ms) | 平均 sum(ms) | 最大并发 | 全部完成 |')
lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |')
for (const [k, rs] of Object.entries(buckets).sort()) {
  const avg = f => (rs.reduce((s, r) => s + r[f], 0) / rs.length).toFixed(4)
  const avgWall = Math.round(rs.reduce((s, r) => s + r.wall_clock_elapsed_ms, 0) / rs.length)
  const avgSum = Math.round(rs.reduce((s, r) => s + r.sum_agent_elapsed_ms, 0) / rs.length)
  const conc = Math.max(...rs.map(r => r.observed_max_concurrency))
  const full = rs.every(r => r.block_hit_rate === 1 && r.aux_remaining === 0) ? '✅' : '❌'
  lines.push(`| ${k} | ${rs.length} | ${avg('block_hit_rate')} | ${avg('precision')} | ${avg('rounds')} | ${avgWall} | ${avgSum} | ${conc} | ${full} |`)
}
lines.push('')
lines.push('## 团队通信机制观测（重点）')
lines.push('')
lines.push('实现：共享黑板（bulletin）按轮广播各 agent 的动作 → 每轮注入“TEAMMATE UPDATES”给其他 agent；'
  + '物资通过 handoverBlock 显式交接；共享世界状态变更原子化，冲突（占位被拒/移除他人方块）被记录。')
lines.push('')
lines.push('| 配置 | 平均 bulletin 广播数 | 平均队友更新消费数 | 平均 handover 交接 | 平均冲突数 | 移除他人方块 |')
lines.push('| --- | --- | --- | --- | --- | --- |')
for (const [k, rs] of Object.entries(buckets).sort()) {
  const avg = f => (rs.reduce((s, r) => s + (r.communication?.[f] ?? 0), 0) / rs.length).toFixed(2)
  const avg2 = f => (rs.reduce((s, r) => s + (r.communication?.[f] ?? 0), 0) / rs.length).toFixed(2)
  lines.push(`| ${k} | ${avg('bulletin_events')} | ${avg('team_updates_consumed')} | ${avg('handovers')} | ${avg('conflicts')} | ${avg2('blocks_removed_by_others')} |`)
}
lines.push('')
lines.push('## 逐任务明细')
lines.push('')
lines.push('| task | 配置 | hit_rate | precision | placed | aux_left | rounds | wall(ms) | sum(ms) | 并发 | per-agent hits |')
lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
for (const r of [...ok].sort((a, b) => a.task_id - b.task_id || a.agents_count - b.agents_count || (a.mode < b.mode ? -1 : 1))) {
  const ph = Object.entries(r.per_agent).map(([id, v]) => `${id}:${v.hits}/${v.placed}`).join(' ')
  lines.push(`| ${r.task_id} | ${r.agents_count}agent-${r.mode} | ${r.block_hit_rate.toFixed(4)} | ${r.precision.toFixed(4)} | ${r.placed_non_aux} | ${r.aux_remaining} | ${r.rounds} | ${r.wall_clock_elapsed_ms} | ${r.sum_agent_elapsed_ms} | ${r.observed_max_concurrency} | ${ph} |`)
}
for (const r of results.filter(x => x.error)) {
  lines.push(`| ${r.task_id} | ${r.agents_count}agent-${r.mode} | FAILED: ${r.error} |`)
}
lines.push('')
lines.push('> wall=墙钟耗时（等待时间）；sum=各 agent 模型耗时之和（近似模型资源）。只有 observed_max_concurrency ≥ 2 才代表框架真正并行调度。')
process.stdout.write(lines.join('\n') + '\n')