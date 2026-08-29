// multiagent/minecraft/sim.mjs
// MultiAgentBench Minecraft 场景的无头模拟器（headless）。
//
// 忠实复刻官方 MARBLE 环境的可打分部分：
//   - 世界网格：y = -61 为地面（stone_bricks），蓝本方块的坐标即世界坐标
//     （minecraft_main.jsonl 的 blueprint 已带 y_bias，如 [-8, -60, 0]）
//   - 容器：材质仓库 chest 位于 [-10, -60, 0]，含蓝本材质 + dirt/ladder 辅助块
//   - 物理：方块不能悬空放置（6 邻域或正下方必须有已存在方块），occupied 不可放
//   - 工具集：与 marble/environments/minecraft_env.py 注册的 11 个工具一致
//   - 计分：官方 build_judger.cal_block_hit_rate / check_block 口径
//     （名字匹配 + facing 匹配，facing=A 只看名字）
//
// 与官方（真 Minecraft server + mineflayer）的差异只在于“环境传感与动作执行”的
// 门控方式；世界状态转移、工具语义、评分口径保持一致。并发安全：全部为同步
// 状态变更（JS 单线程），任何时刻 world 变更都是原子的。

const FACINGS = ['W', 'E', 'S', 'N', 'x', 'y', 'z', 'A']

const key = (x, y, z) => `${x},${y},${z}`

function dist(pos, x, y, z) {
  return Math.max(Math.abs(pos.x - x), Math.abs(pos.y - y), Math.abs(pos.z - z))
}

export class MineSim {
  /**
   * @param {object} opts
   * @param {Array<{material:string,facing:string,position:[number,number,number]}>} opts.blueprint
   * @param {Array<{agent_id:string,profile:string}>} opts.agents
   */
  constructor({ blueprint, agents }) {
    this.blueprint = blueprint
    this.world = new Map() // key -> {name, facing, owner, aux}
    this.chest = new Map() // item -> count
    this.agents = {}
    this.bulletin = [] // 共享“黑板”：各 agent 最近动作，供模拟协作消息
    this.groundY = -61
    this.blockPlaced = 0
    this.stats = { handovers: 0, conflicts: 0, blocksRemovedByOthers: 0 }

    // ground plane（模仿 judge 的环境铺地；足够大覆盖建筑区）
    for (let x = -25; x <= 25; x++) {
      for (let z = -25; z <= 25; z++) {
        this.world.set(key(x, this.groundY, z), { name: 'stone_bricks', facing: 'A', owner: null, aux: false })
      }
    }

    // 材质仓库：蓝本每种材质给足数量 + 辅助用 dirt/ladder
    const needed = {}
    for (const b of blueprint) {
      needed[b.material] = (needed[b.material] ?? 0) + 1
    }
    for (const [mat, cnt] of Object.entries(needed)) {
      this.chest.set(mat, Math.max(cnt + 8, 16))
    }
    this.chest.set('dirt', 64)
    this.chest.set('ladder', 64)

    // 每个 agent：出生点 + 空背包
    const spawns = [
      [-12, -60, -4],
      [-12, -60, -3],
      [-12, -60, -2],
      [-13, -60, -2],
      [-13, -60, -3],
    ]
    agents.forEach((a, i) => {
      const [x, y, z] = spawns[i % spawns.length]
      this.agents[a.agent_id] = {
        id: a.agent_id,
        profile: a.profile,
        x, y, z,
        inventory: new Map(),
        heldItem: null,
        actions: 0,
        placed: [], // 该 agent 放置的方块 list
      }
    })
  }

  // ---------- 内部状态 ----------

  cell(x, y, z) {
    return this.world.get(key(x, y, z)) ?? null
  }

  isGround(y) {
    return y === this.groundY
  }

  hasSupport(x, y, z) {
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
      if (this.cell(x + dx, y + dy, z + dz)) return true
    }
    return false
  }

  agent(id) {
    const a = this.agents[id]
    if (!a) throw new Error(`unknown agent ${id}`)
    return a
  }

  chestContents() {
    return Array.from(this.chest.entries()).map(([name, count]) => ({ name, count }))
  }

  record(agentId, action, message) {
    this.bulletin.push({ agent: agentId, action, message, t: Date.now() })
    if (this.bulletin.length > 200) this.bulletin.splice(0, this.bulletin.length - 200)
  }

  recentPeerActions(agentId, n = 3) {
    return this.bulletin.filter(b => b.agent !== agentId).slice(-n)
  }

  // ---------- 工具实现（与官方 11 工具同名同参） ----------

  scanNearbyEntities(playerId, { item_name = '', radius = 10, item_num = 20 } = {}) {
    const a = this.agent(playerId)
    const found = []
    for (const [k, b] of this.world) {
      const [x, y, z] = k.split(',').map(Number)
      if (dist(a, x, y, z) <= radius) {
        if (item_name && b.name !== item_name) continue
        found.push({ name: b.name, position: [x, y, z], facing: b.facing })
        if (found.length >= item_num) break
      }
    }
    return { status: true, message: `found ${found.length} block(s) match ${item_name || 'all'}`, data: found }
  }

  navigateTo(playerId, { x, y, z }) {
    const a = this.agent(playerId)
    if (this.cell(x, y, z) && this.cell(x, y, z).name !== 'air' && dist(a, x, y, z) > 4) {
      a.x = x; a.y = y + 1; a.z = z
    } else {
      a.x = x; a.y = y; a.z = z
    }
    return { status: true, message: `move to ${x} ${y} ${z}` }
  }

  MineBlock(playerId, { x, y, z }) {
    const a = this.agent(playerId)
    const c = this.cell(x, y, z)
    if (!c || this.isGround(y)) {
      return { status: false, message: `cannot mine block at ${x} ${y} ${z}, nothing there or it is terrain` }
    }
    this.world.delete(key(x, y, z))
    if (c.name === 'dirt' || c.name === 'ladder') {
      a.inventory.set(c.name, (a.inventory.get(c.name) ?? 0) + 1)
    }
    if (c.owner && c.owner !== playerId) this.stats.blocksRemovedByOthers++
    this.record(playerId, 'MineBlock', `mined ${c.name} at ${x} ${y} ${z}`)
    return { status: true, message: `mined ${c.name} at ${x} ${y} ${z}` }
  }

  placeBlock(playerId, { item_name, x, y, z, facing = 'A' }) {
    const a = this.agent(playerId)
    const raw = (facing || 'A').trim()
    // 轴朝向 x/y/z 保持小写（与官方 axis 语义一致），方向/任意朝向大写
    const f = (raw === 'x' || raw === 'y' || raw === 'z') ? raw : raw.toUpperCase()
    if (!FACINGS.includes(f)) {
      return { status: false, message: `facing is one of [W, E, S, N, x, y, z, A]` }
    }
    if (y <= this.groundY) {
      return { status: false, message: `cannot place block at ${x} ${y} ${z}: underground` }
    }
    const existing = this.cell(x, y, z)
    if (existing) {
      if (existing.owner && existing.owner !== playerId) this.stats.conflicts++
      return { status: false, message: `cannot place block, the position is occupied by ${existing.name}, you need to mine it first` }
    }
    if (!this.hasSupport(x, y, z)) {
      return { status: false, message: `cannot place the block at ${x} ${y} ${z}: a block cannot be placed in the air, place a support block first` }
    }
    const have = a.inventory.get(item_name) ?? 0
    if (have < 1 && a.heldItem !== item_name) {
      return { status: false, message: `can not place block, no ${item_name} in hand, you need to interact chest or other container to get item first` }
    }
    if (have >= 1) {
      a.inventory.set(item_name, have - 1)
      if (a.inventory.get(item_name) === 0) a.inventory.delete(item_name)
    }
    const isAux = item_name === 'dirt' || item_name === 'ladder' || item_name === 'scaffolding'
    this.world.set(key(x, y, z), { name: item_name, facing: f, owner: playerId, aux: isAux })
    a.actions++
    if (!isAux) {
      a.placed.push({ name: item_name, facing: f, position: [x, y, z] })
      this.blockPlaced++
    }
    this.record(playerId, 'placeBlock', `placed ${item_name} ${f} at ${x} ${y} ${z}`)
    return { status: true, message: ` place block at ${x} ${y} ${z}` }
  }

  equipItem(playerId, { slot = 'hand', item_name }) {
    const a = this.agent(playerId)
    if (!(a.inventory.get(item_name) ?? 0) && a.heldItem !== item_name) {
      return { status: false, message: `I don't have ${item_name} in my inventory` }
    }
    if (slot === 'hand' || slot === 'mainhand') a.heldItem = item_name
    this.record(playerId, 'equipItem', `equipped ${item_name} on ${slot}`)
    return { status: true, message: `equipped ${item_name} on ${slot}` }
  }

  handoverBlock(playerId, { target_player_name, item_name, item_count }) {
    const a = this.agent(playerId)
    const t = this.agent(target_player_name)
    const have = a.inventory.get(item_name) ?? 0
    if (have < item_count) {
      return { status: false, message: `${playerId} don't have enough ${item_name} in inventory` }
    }
    const n = Math.min(item_count, have)
    a.inventory.set(item_name, have - n)
    if (a.inventory.get(item_name) === 0) a.inventory.delete(item_name)
    t.inventory.set(item_name, (t.inventory.get(item_name) ?? 0) + n)
    this.stats.handovers++
    this.record(playerId, 'handoverBlock', `gave ${item_name} x${n} to ${target_player_name}`)
    return { status: true, message: `give ${item_name} from ${playerId} to ${target_player_name}` }
  }

  withdrawItem(playerId, { item_name, from_name = 'chest', item_count = 1 }) {
    const a = this.agent(playerId)
    if (from_name !== 'chest' && from_name !== 'container') {
      return { status: false, message: `available container: chest` }
    }
    const have = this.chest.get(item_name) ?? 0
    if (have < item_count) {
      return { status: false, message: `chest don't have enough ${item_name}, have ${have}, need ${item_count}` }
    }
    const n = Math.min(item_count, have)
    this.chest.set(item_name, have - n)
    a.inventory.set(item_name, (a.inventory.get(item_name) ?? 0) + n)
    this.record(playerId, 'withdrawItem', `took ${item_name} x${n} from ${from_name}`)
    return { status: true, message: `take out ${item_name} x${n} from ${from_name}` }
  }

  erectDirtLadder(playerId, { top_x, top_y, top_z }) {
    const a = this.agent(playerId)
    const dirt = a.inventory.get('dirt') ?? 0
    const need = top_y - this.groundY
    if (dirt < need) {
      return { status: false, message: `Don't have enough dirt in inventory, have ${dirt}, need ${need}` }
    }
    for (let y = this.groundY + 1; y <= top_y; y++) {
      if (!this.cell(top_x, y, top_z)) {
        this.world.set(key(top_x, y, top_z), { name: 'dirt', facing: 'A', owner: playerId, aux: true })
        a.inventory.set('dirt', dirt - 1)
      }
    }
    this.record(playerId, 'erectDirtLadder', `erected dirt ladder to ${top_x} ${top_y} ${top_z}`)
    return { status: true, message: `erect success at ${top_x} ${top_y} ${top_z}` }
  }

  dismantleDirtLadder(playerId, { top_x, top_y, top_z }) {
    let removed = 0
    for (let y = this.groundY + 1; y <= top_y; y++) {
      const c = this.cell(top_x, y, top_z)
      if (c && c.aux && (c.name === 'dirt' || c.name === 'ladder')) {
        this.world.delete(key(top_x, y, top_z))
        removed++
      }
    }
    this.record(playerId, 'dismantleDirtLadder', `dismantled dirt ladder at ${top_x} ${top_y} ${top_z} (${removed} blocks)`)
    return { status: true, message: `dismantle success, removed ${removed} blocks` }
  }

  fetchContainerContents(playerId, { item_name = '', position } = {}) {
    const contents = this.chestContents()
    if (item_name) {
      const c = this.chest.get(item_name) ?? 0
      return { status: true, message: `chest has ${item_name} x${c}`, data: [{ name: item_name, count: c }] }
    }
    return { status: true, message: `chest contents: ${JSON.stringify(contents)}`, data: contents }
  }

  get_environment_info(playerId) {
    const a = this.agent(playerId)
    const a2 = this.agent(playerId)
    const nearby = []
    for (const [k, b] of this.world) {
      const [x, y, z] = k.split(',').map(Number)
      if (dist(a, x, y, z) <= 6) nearby.push({ name: b.name, position: [x, y, z], facing: b.facing })
    }
    const others = Object.values(this.agents)
      .filter(o => o.id !== playerId)
      .map(o => `${o.id} at ${o.x} ${o.y} ${o.z} holding ${o.heldItem ?? 'nothing'}`)
    const inv = Array.from(a2.inventory.entries()).map(([n, c]) => `${n}(${c})`).join(' ') || 'empty'
    return {
      status: true,
      message: `my_position: ${a.x} ${a.y} ${a.z}, inventory: ${inv}, held: ${a.heldItem ?? 'nothing'}, nearby blocks: ${JSON.stringify(nearby.slice(0, 32))}, other agents: ${others.join('; ') || 'none'}`,
    }
  }

  // ---------- 统一入口 ----------

  /** 返回 {status, message, data?} 的可序列化结果 */
  applyAction(playerId, actionName, args = {}) {
    const handler = this[actionName]
    if (typeof handler !== 'function') {
      return { status: false, message: `unknown action ${actionName}` }
    }
    return handler.call(this, playerId, args)
  }

  // ---------- 官方评分口径（build_judger.cal_block_hit_rate / check_block） ----------

  facingMatch(worldFacing, bpFacing) {
    if (bpFacing === 'A') return true
    return worldFacing === bpFacing
  }

  /** 官方：蓝本每个方块在对应坐标被正确放置的比例 */
  blockHitRate() {
    let hit = 0
    let total = 0
    for (const b of this.blueprint) {
      if (b.material === 'air' || b.material === 'water' || b.material === 'lava') continue
      total++
      const c = this.cell(b.position[0], b.position[1], b.position[2])
      if (c && c.name === b.material && this.facingMatch(c.facing, b.facing)) hit++
    }
    return total === 0 ? 1 : hit / total
  }

  /** 补充口径：放置的（非辅助）方块中，位于蓝本坐标且材质匹配的比例（“不乱放”） */
  precision() {
    const bpAt = new Map(this.blueprint.map(b => [key(b.position[0], b.position[1], b.position[2]), b]))
    let correct = 0
    let placed = 0
    for (const [k, b] of this.world) {
      if (b.aux || b.owner === null) continue // 跳过地形与辅助块，只统计 agent 放置的方块
      placed++
      const target = bpAt.get(k)
      if (target && target.material === b.name && this.facingMatch(b.facing, target.facing)) correct++
    }
    return { precision: placed === 0 ? 1 : correct / placed, placedNonAux: placed }
  }

  /** 各 agent 放置命中蓝本的块列表 */
  perAgentHits() {
    const hits = {}
    for (const b of this.blueprint) {
      const c = this.cell(b.position[0], b.position[1], b.position[2])
      if (c && c.name === b.material && this.facingMatch(c.facing, b.facing) && c.owner) {
        hits[c.owner] = (hits[c.owner] ?? 0) + 1
      }
    }
    return hits
  }
}