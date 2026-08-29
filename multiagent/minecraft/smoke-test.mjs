// multiagent/minecraft/smoke-test.mjs
// 离线冒烟测试：不调用 LLM，直接验证 sim 的物理/工具/评分口径。
// 运行：node multiagent/minecraft/smoke-test.mjs
import assert from 'node:assert/strict'
import { MineSim } from './sim.mjs'
import { parseBlueprint } from './run-mc.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DATA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'MARBLE', 'multiagentbench', 'minecraft', 'minecraft_main.jsonl')

let passed = 0
const ok = (name) => { passed++; console.log(`  ok - ${name}`) }

// 1) blueprint 解析与官方数据一致
const task = JSON.parse(fs.readFileSync(DATA, 'utf8').trim().split('\n')[0])
const bp = parseBlueprint(task.task.content)
assert.equal(bp.length, 3, 'blueprint has 3 blocks')
assert.deepEqual(bp.map(b => b.material), ['cut_sandstone', 'terracotta', 'torch'])
assert.deepEqual(bp[0].position, [-8, -60, 0])
ok('parse blueprint from official data')

// 2) 正确建造 → hit_rate = 1
{
  const sim = new MineSim({ blueprint: bp, agents: task.agents.slice(0, 1) })
  const A = task.agents[0].agent_id
  // 悬空放置被拒
  let r = sim.placeBlock(A, { item_name: 'terracotta', x: -8, y: -59, z: 0, facing: 'A' })
  assert.equal(r.status, false, 'placing in air without support fails')
  ok('physics: cannot place in the air')
  // 没有材料被拒
  r = sim.placeBlock(A, { item_name: 'cut_sandstone', x: -8, y: -60, z: 0, facing: 'A' })
  assert.equal(r.status, false, 'no material in hand fails')
  ok('physics: need material from chest first')
  // 拿材料（bottom-up 正确建造）
  assert.equal(sim.withdrawItem(A, { item_name: 'cut_sandstone', from_name: 'chest', item_count: 1 }).status, true)
  assert.equal(sim.withdrawItem(A, { item_name: 'terracotta', from_name: 'chest', item_count: 1 }).status, true)
  assert.equal(sim.withdrawItem(A, { item_name: 'torch', from_name: 'chest', item_count: 1 }).status, true)
  assert.equal(sim.placeBlock(A, { item_name: 'cut_sandstone', x: -8, y: -60, z: 0, facing: 'A' }).status, true)
  assert.equal(sim.placeBlock(A, { item_name: 'terracotta', x: -8, y: -59, z: 0, facing: 'A' }).status, true)
  assert.equal(sim.placeBlock(A, { item_name: 'torch', x: -8, y: -58, z: 0, facing: 'A' }).status, true)
  assert.equal(sim.blockHitRate(), 1, 'hit rate = 1')
  assert.equal(sim.precision().precision, 1)
  assert.deepEqual(sim.perAgentHits(), { [A]: 3 })
  ok('correct build → block_hit_rate = 1')
}

// 3) occupied 拒绝 + MineBlock 移除
{
  const sim = new MineSim({ blueprint: bp, agents: task.agents.slice(0, 1) })
  const A = task.agents[0].agent_id
  sim.withdrawItem(A, { item_name: 'cut_sandstone', from_name: 'chest', item_count: 1 })
  sim.placeBlock(A, { item_name: 'cut_sandstone', x: -8, y: -60, z: 0, facing: 'A' })
  sim.withdrawItem(A, { item_name: 'terracotta', from_name: 'chest', item_count: 1 })
  assert.equal(sim.placeBlock(A, { item_name: 'terracotta', x: -8, y: -60, z: 0, facing: 'A' }).status, false, 'occupied')
  assert.equal(sim.MineBlock(A, { x: -8, y: -60, z: 0 }).status, true)
  assert.equal(sim.cell(-8, -60, 0), null)
  ok('occupied rejection + MineBlock')
}

// 4) 辅助块：erect → dismantle 不留 aux；dirt 回到背包
{
  const sim = new MineSim({ blueprint: bp, agents: task.agents.slice(0, 1) })
  const A = task.agents[0].agent_id
  sim.withdrawItem(A, { item_name: 'dirt', from_name: 'chest', item_count: 64 })
  assert.equal(sim.erectDirtLadder(A, { top_x: -8, top_y: -57, top_z: 0 }).status, true)
  assert.equal(sim.cell(-8, -58, 0).name, 'dirt')
  assert.equal(sim.erectDirtLadder(A, { top_x: -8, top_y: -57, top_z: 1 }).status, true)
  assert.equal(sim.dismantleDirtLadder(A, { top_x: -8, top_y: -57, top_z: 0 }).status, true)
  assert.equal(sim.cell(-8, -58, 0), null)
  ok('aux dirt ladder erect/dismantle')
}

// 5) handoverBlock 物品转移
{
  const sim = new MineSim({ blueprint: bp, agents: task.agents })
  const [A, B] = task.agents.map(a => a.agent_id)
  sim.withdrawItem(A, { item_name: 'torch', from_name: 'chest', item_count: 1 })
  assert.equal(sim.handoverBlock(A, { target_player_name: B, item_name: 'torch', item_count: 1 }).status, true)
  assert.equal(sim.agent(B).inventory.get('torch'), 1)
  ok('handoverBlock item transfer')
}

// 6) 多 agent 协作建造：2 个 agent 各放一块，hit 归属正确
{
  const sim = new MineSim({ blueprint: bp, agents: task.agents })
  const [A, B] = [task.agents[0].agent_id, task.agents[1].agent_id]
  for (const id of [A, B]) {
    sim.withdrawItem(id, { item_name: 'cut_sandstone', from_name: 'chest', item_count: 1 })
    sim.withdrawItem(id, { item_name: 'terracotta', from_name: 'chest', item_count: 1 })
  }
  sim.placeBlock(A, { item_name: 'cut_sandstone', x: -8, y: -60, z: 0, facing: 'A' })
  sim.placeBlock(B, { item_name: 'terracotta', x: -8, y: -59, z: 0, facing: 'A' })
  assert.deepEqual(sim.perAgentHits(), { [A]: 1, [B]: 1 })
  ok('multi-agent hit attribution')
}

// 7) facing 匹配口径（check_block）
{
  const bp2 = [{ material: 'oak_log', facing: 'x', position: [-8, -60, 0] }]
  const sim = new MineSim({ blueprint: bp2, agents: task.agents.slice(0, 1) })
  const A = task.agents[0].agent_id
  sim.withdrawItem(A, { item_name: 'oak_log', from_name: 'chest', item_count: 3 })
  sim.placeBlock(A, { item_name: 'oak_log', x: -8, y: -60, z: 0, facing: 'A' })
  assert.equal(sim.blockHitRate(), 0, 'facing A does not match blueprint facing x')
  sim.placeBlock(A, { item_name: 'oak_log', x: -8, y: -59, z: 0, facing: 'x' })
  sim.navigateTo(A, { x: -8, y: -59, z: 0 })
  sim.MineBlock(A, { x: -8, y: -60, z: 0 })
  sim.placeBlock(A, { item_name: 'oak_log', x: -8, y: -60, z: 0, facing: 'x' })
  assert.equal(sim.blockHitRate(), 1, 'facing x matches')
  ok('facing match semantics (A vs x/y/z)')
}

// 8) precision：蓝本外乱放会拉低 precision 但不影响 hit_rate
{
  const sim = new MineSim({ blueprint: bp, agents: task.agents.slice(0, 1) })
  const A = task.agents[0].agent_id
  sim.withdrawItem(A, { item_name: 'dirt', from_name: 'chest', item_count: 1 })
  // dirt 是 aux，不计入 precision
  sim.placeBlock(A, { item_name: 'dirt', x: -5, y: -60, z: 0, facing: 'A' })
  assert.equal(sim.precision().placedNonAux, 0)
  sim.withdrawItem(A, { item_name: 'cut_sandstone', from_name: 'chest', item_count: 1 })
  sim.MineBlock(A, { x: -5, y: -60, z: 0 })
  assert.equal(sim.placeBlock(A, { item_name: 'cut_sandstone', x: -5, y: -60, z: 0, facing: 'A' }).status, true)
  const p = sim.precision()
  assert.equal(p.placedNonAux, 1)
  assert.equal(p.precision, 0, 'out-of-blueprint block lowers precision')
  ok('aux excluded from precision')
}

console.log(`\nsmoke: ${passed} checks passed`)