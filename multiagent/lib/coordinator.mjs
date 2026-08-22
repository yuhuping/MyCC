// multiagent/lib/coordinator.mjs
// 多智能体编排层（MultiAgentCoordinator）——本项目在 MultiAgentBench 上的核心卖点。
//
// 设计要点：
//   - AgentGraph：把任务配置里的 agents + relationships 建成协作图（节点=agent，边=协作关系）。
//   - MessageBus：记录 agent 间的任务/上下文传递（每棒的交接消息），可序列化为
//     communication 记录供评估与回放。
//   - 共享工作区：所有 agent 用同一个 workspace 目录（共享文件系统 = 共享内存），
//     接力者先读后写，避免覆盖队友产出。
//   - 协调模式：目前实现 'relay'（顺序接力：建码 → 审阅 → 优化），接口预留
//     'star'/'tree'/'graph'（并行分解与汇总）扩展点。
import path from 'node:path'
import { AgentInstance } from './agent-instance.mjs'

export class MessageBus {
  constructor() {
    this.messages = []
  }

  post({ from, to = null, kind, summary }) {
    this.messages.push({
      seq: this.messages.length + 1,
      from,
      to,
      kind,
      summary,
      ts: new Date().toISOString(),
    })
  }

  serialize() {
    return this.messages
      .map(m => `[#${m.seq}] ${m.from}${m.to ? ' -> ' + m.to : ''} (${m.kind})\n${m.summary}`)
      .join('\n')
  }
}

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

// 顺序接力的核心流程：每个 agent 看过前驱的产出（上下文）后在共享工作区继续工作。
// 第一棒通常是最能"从零建码"的角色，最后一棒负责收尾（优化/补测试）。
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

  for (let i = 0; i < graph.agents.length; i++) {
    const agent = graph.agents[i]
    // 每个 agent 实例绑定其工作区与 provider（运行时依赖在 run 时注入）
    agent.workspace = workspace
    if (agent.maxTurns == null) agent.maxTurns = maxTurnsPerAgent
    agent.provider = provider
    const sessionDir = sessionDirBase ? path.join(sessionDirBase, `${String(i + 1).padStart(2, '0')}-${agent.agentId}`) : null

    const stageMeta = { index: i, agentId: agent.agentId, kind: i === 0 ? 'build' : 'relay' }
    onStage({ ...stageMeta, phase: 'start' })
    const result = await agent.run({ task, context, sessionDir })
    const summary = agent.summarize(result, { maxContextChars })
    bus.post({ from: agent.agentId, kind: 'handoff', summary })
    stages.push({ ...stageMeta, result, summary })
    onStage({ ...stageMeta, phase: 'done', result })

    // 下一棒拿到本棒的总结作为上下文
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
  }
}